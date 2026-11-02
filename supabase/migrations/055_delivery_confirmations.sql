-- ============================================================
-- WINERIX — P2M-5: Delivery Confirmation / Proof of Delivery
-- 055: An ATTESTATION layer on top of physical dispatch. Records what the
--      customer actually received (delivered_qty) + proof-of-delivery metadata.
--      It NEVER moves stock, never changes dispatch/allocation/order status, and
--      never creates a second inventory or dispatch truth.
--
-- Depends on: 006 (orgs/is_org_member/has_org_role/audit_log/prevent_owner_id_change),
--             001 (update_updated_at), 021 (audit_log_row_change),
--             046 (sales_orders + next_sales_order_number pattern),
--             051 (dispatches/dispatch_lines + audit wiring + sequence pattern),
--             053/054 (reverse_dispatch — re-created here with ONE added guard).
--
-- LOCKED DECISIONS (approved P2M-5 architecture):
--   * One delivery confirmation per dispatch; at most ONE active/confirmed at a
--     time; multiple failed/cancelled historical attempts allowed (partial
--     unique index). A confirmation never spans multiple dispatches.
--   * Lifecycle: pending / delivered / delivered_with_variance / failed /
--     cancelled. Dispatch + order + stock + allocations are UNCHANGED by P2M-5.
--   * delivered_qty defaults to 0 on create; mutable only while pending via RPC.
--     dispatched_qty is DERIVED from dispatch_lines.qty_bottles (never stored as
--     an independently editable authoritative value). variance = dispatched -
--     delivered (descriptive only; NO stock movement, NO returns).
--   * variance_reason in (SHORT_DELIVERY,DAMAGED,REJECTED,MISSING,OTHER);
--     failure_reason in (CUSTOMER_UNAVAILABLE,VEHICLE_ISSUE,DAMAGED_IN_TRANSIT,
--     WRONG_ADDRESS,CUSTOMER_REJECTED,OTHER).
--   * POD = metadata + nullable Storage PATH references only. No Storage upload,
--     no signed URLs, no PDF generation.
--   * POD-YYYY-NNNN numbering via delivery_sequences + next_delivery_number RPC
--     (concurrency-safe, mirrors next_dispatch_number). Gaps acceptable.
--   * Roles: create/update-pending/confirm/fail = OWNER/ADMIN/SALES/CELLAR;
--     cancel/correct = OWNER/ADMIN only. (NOT the P2M-4 reversal role set.)
--   * SELECT-only RLS; all writes RPC-controlled; no direct browser DML.
--   * reverse_dispatch gains ONE guard: a dispatch with a CONFIRMED delivery
--     (delivered / delivered_with_variance) cannot be reversed. Everything else
--     about reverse_dispatch is preserved exactly.
--
-- THIS MIGRATION DOES NOT: move stock, create stock_movements, change
--   allocations/dispatch/order status, implement returns/Finance/Storage/PDF,
--   seed data, or weaken any existing security.
-- ============================================================

BEGIN;

-- ============================================================
-- 0. PRE-FLIGHT
-- ============================================================
DO $$
BEGIN
  IF to_regclass('public.dispatches') IS NULL THEN RAISE EXCEPTION 'Pre-flight: dispatches missing (051).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.dispatch_lines') IS NULL THEN RAISE EXCEPTION 'Pre-flight: dispatch_lines missing (051).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.sales_orders') IS NULL THEN RAISE EXCEPTION 'Pre-flight: sales_orders missing (046).' USING ERRCODE='undefined_table'; END IF;
  IF to_regprocedure('public.is_org_member(uuid)') IS NULL THEN RAISE EXCEPTION 'Pre-flight: is_org_member missing (006).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.has_org_role(uuid, text[])') IS NULL THEN RAISE EXCEPTION 'Pre-flight: has_org_role missing (006).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.audit_log_row_change()') IS NULL THEN RAISE EXCEPTION 'Pre-flight: audit_log_row_change missing (021).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.prevent_owner_id_change()') IS NULL THEN RAISE EXCEPTION 'Pre-flight: prevent_owner_id_change missing (010).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.update_updated_at()') IS NULL THEN RAISE EXCEPTION 'Pre-flight: update_updated_at missing (001).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.reverse_dispatch(uuid, text)') IS NULL THEN RAISE EXCEPTION 'Pre-flight: reverse_dispatch missing (053/054).' USING ERRCODE='undefined_function'; END IF;
  IF to_regclass('public.delivery_confirmations') IS NOT NULL THEN RAISE EXCEPTION 'Pre-flight: delivery_confirmations already exists.' USING ERRCODE='duplicate_table'; END IF;
  IF to_regclass('public.delivery_confirmation_lines') IS NOT NULL THEN RAISE EXCEPTION 'Pre-flight: delivery_confirmation_lines already exists.' USING ERRCODE='duplicate_table'; END IF;
  IF to_regclass('public.delivery_sequences') IS NOT NULL THEN RAISE EXCEPTION 'Pre-flight: delivery_sequences already exists.' USING ERRCODE='duplicate_table'; END IF;
END $$;

-- ============================================================
-- 1. DELIVERY_SEQUENCES — per (org, year) POD-YYYY-NNNN counter.
-- Written only by next_delivery_number(). Mirrors dispatch_sequences (051).
-- ============================================================
CREATE TABLE IF NOT EXISTS public.delivery_sequences (
  org_id       UUID NOT NULL,
  order_year   INTEGER NOT NULL,
  last_number  INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pk_delivery_sequences PRIMARY KEY (org_id, order_year),
  CONSTRAINT fk_delivery_seq_org FOREIGN KEY (org_id) REFERENCES public.organisations(id) ON DELETE RESTRICT,
  CONSTRAINT delivery_seq_last_number_non_negative CHECK (last_number >= 0),
  CONSTRAINT delivery_seq_year_sane CHECK (order_year >= 2000 AND order_year <= 2200)
);
ALTER TABLE public.delivery_sequences ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view organisation delivery sequences"
  ON public.delivery_sequences FOR SELECT USING (public.is_org_member(org_id));
GRANT SELECT ON public.delivery_sequences TO authenticated;
DROP TRIGGER IF EXISTS delivery_seq_updated_at ON public.delivery_sequences;
CREATE TRIGGER delivery_seq_updated_at BEFORE UPDATE ON public.delivery_sequences
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ============================================================
-- 2. DELIVERY_CONFIRMATIONS — one delivery attempt/outcome for one dispatch.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.delivery_confirmations (
  id                           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                       UUID NOT NULL,
  owner_id                     UUID NOT NULL,
  dispatch_id                  UUID NOT NULL,
  sales_order_id               UUID NOT NULL,  -- denormalised immutable copy (query convenience)
  delivery_number              TEXT NOT NULL,
  status                       TEXT NOT NULL DEFAULT 'pending',
  recipient_name               TEXT,
  recipient_role               TEXT,
  delivered_at                 TIMESTAMPTZ,
  delivery_notes               TEXT,
  variance_reason              TEXT,
  failure_reason               TEXT,
  signature_storage_path       TEXT,
  proof_document_storage_path  TEXT,
  proof_photo_storage_path     TEXT,
  address_snapshot             JSONB,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_delivery_org   FOREIGN KEY (org_id) REFERENCES public.organisations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_delivery_owner FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_delivery_dispatch FOREIGN KEY (dispatch_id) REFERENCES public.dispatches(id) ON DELETE RESTRICT,
  CONSTRAINT fk_delivery_order FOREIGN KEY (sales_order_id) REFERENCES public.sales_orders(id) ON DELETE RESTRICT,

  CONSTRAINT delivery_number_not_blank CHECK (length(btrim(delivery_number)) > 0),
  CONSTRAINT uq_delivery_number_per_org UNIQUE (org_id, delivery_number),
  CONSTRAINT delivery_status_check CHECK (status IN ('pending','delivered','delivered_with_variance','failed','cancelled')),

  -- variance_reason only for delivered_with_variance (non-blank there, else NULL)
  CONSTRAINT delivery_variance_reason_rule CHECK (
    (status = 'delivered_with_variance' AND variance_reason IS NOT NULL
       AND variance_reason IN ('SHORT_DELIVERY','DAMAGED','REJECTED','MISSING','OTHER'))
    OR (status <> 'delivered_with_variance' AND variance_reason IS NULL)
  ),
  -- failure_reason only for failed (non-blank there, else NULL)
  CONSTRAINT delivery_failure_reason_rule CHECK (
    (status = 'failed' AND failure_reason IS NOT NULL
       AND failure_reason IN ('CUSTOMER_UNAVAILABLE','VEHICLE_ISSUE','DAMAGED_IN_TRANSIT','WRONG_ADDRESS','CUSTOMER_REJECTED','OTHER'))
    OR (status <> 'failed' AND failure_reason IS NULL)
  ),
  -- delivered_at required for delivered/variance; must be NULL while pending.
  CONSTRAINT delivery_delivered_at_rule CHECK (
    (status IN ('delivered','delivered_with_variance') AND delivered_at IS NOT NULL)
    OR (status = 'pending' AND delivered_at IS NULL)
    OR (status IN ('failed','cancelled'))
  )
);

CREATE INDEX IF NOT EXISTS idx_delivery_org_id       ON public.delivery_confirmations(org_id);
CREATE INDEX IF NOT EXISTS idx_delivery_dispatch_id  ON public.delivery_confirmations(dispatch_id);
CREATE INDEX IF NOT EXISTS idx_delivery_order_id     ON public.delivery_confirmations(sales_order_id);
CREATE INDEX IF NOT EXISTS idx_delivery_status       ON public.delivery_confirmations(status);
CREATE INDEX IF NOT EXISTS idx_delivery_number       ON public.delivery_confirmations(delivery_number);

-- At most ONE active/confirmed delivery per dispatch (pending/delivered/variance).
-- Multiple failed/cancelled historical attempts are allowed.
CREATE UNIQUE INDEX IF NOT EXISTS uq_delivery_active_per_dispatch
  ON public.delivery_confirmations(dispatch_id)
  WHERE status IN ('pending','delivered','delivered_with_variance');

-- ============================================================
-- 3. DELIVERY_CONFIRMATION_LINES — delivered qty per dispatch line.
-- dispatched qty is DERIVED from dispatch_lines (not stored editable here).
-- ============================================================
CREATE TABLE IF NOT EXISTS public.delivery_confirmation_lines (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                    UUID NOT NULL,
  owner_id                  UUID NOT NULL,
  delivery_confirmation_id  UUID NOT NULL,
  dispatch_line_id          UUID NOT NULL,
  delivered_qty             INTEGER NOT NULL DEFAULT 0,
  notes                     TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_dcline_org   FOREIGN KEY (org_id) REFERENCES public.organisations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_dcline_owner FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE RESTRICT,
  -- The ONLY cascade: deleting a delivery header removes its lines.
  CONSTRAINT fk_dcline_delivery FOREIGN KEY (delivery_confirmation_id) REFERENCES public.delivery_confirmations(id) ON DELETE CASCADE,
  CONSTRAINT fk_dcline_dispatch_line FOREIGN KEY (dispatch_line_id) REFERENCES public.dispatch_lines(id) ON DELETE RESTRICT,

  CONSTRAINT dcline_delivered_qty_non_negative CHECK (delivered_qty >= 0),
  -- one line per (delivery, dispatch_line)
  CONSTRAINT uq_dcline_per_dispatch_line UNIQUE (delivery_confirmation_id, dispatch_line_id)
);

CREATE INDEX IF NOT EXISTS idx_dcline_org_id            ON public.delivery_confirmation_lines(org_id);
CREATE INDEX IF NOT EXISTS idx_dcline_delivery_id       ON public.delivery_confirmation_lines(delivery_confirmation_id);
CREATE INDEX IF NOT EXISTS idx_dcline_dispatch_line_id  ON public.delivery_confirmation_lines(dispatch_line_id);

-- ============================================================
-- 4. OWNER IMMUTABILITY (010) + UPDATED_AT (001)
-- ============================================================
DROP TRIGGER IF EXISTS delivery_owner_id_immutable ON public.delivery_confirmations;
CREATE TRIGGER delivery_owner_id_immutable BEFORE UPDATE ON public.delivery_confirmations
  FOR EACH ROW EXECUTE FUNCTION public.prevent_owner_id_change();
DROP TRIGGER IF EXISTS delivery_updated_at ON public.delivery_confirmations;
CREATE TRIGGER delivery_updated_at BEFORE UPDATE ON public.delivery_confirmations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS dcline_owner_id_immutable ON public.delivery_confirmation_lines;
CREATE TRIGGER dcline_owner_id_immutable BEFORE UPDATE ON public.delivery_confirmation_lines
  FOR EACH ROW EXECUTE FUNCTION public.prevent_owner_id_change();
DROP TRIGGER IF EXISTS dcline_updated_at ON public.delivery_confirmation_lines;
CREATE TRIGGER dcline_updated_at BEFORE UPDATE ON public.delivery_confirmation_lines
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ============================================================
-- 5. CROSS-ORG / CROSS-REFERENCE INTEGRITY (SECURITY DEFINER, pinned path).
-- Mirrors validate_dispatch_*_org_integrity (051).
-- ============================================================
-- 5a. delivery_confirmations: dispatch + order exist, same org, and the
-- dispatch actually belongs to the stated sales order.
CREATE OR REPLACE FUNCTION public.validate_delivery_org_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_disp_org   UUID;
  v_disp_order UUID;
  v_order_org  UUID;
BEGIN
  SELECT d.org_id, d.sales_order_id INTO v_disp_org, v_disp_order
  FROM public.dispatches d WHERE d.id = NEW.dispatch_id;
  IF v_disp_org IS NULL THEN
    RAISE EXCEPTION 'Invalid dispatch: % does not exist.', NEW.dispatch_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF v_disp_org <> NEW.org_id THEN
    RAISE EXCEPTION 'Cross-organisation reference: dispatch % belongs to a different organisation.', NEW.dispatch_id USING ERRCODE = 'raise_exception';
  END IF;
  IF v_disp_order <> NEW.sales_order_id THEN
    RAISE EXCEPTION 'Dispatch % is not for sales order %.', NEW.dispatch_id, NEW.sales_order_id USING ERRCODE = 'raise_exception';
  END IF;
  SELECT so.org_id INTO v_order_org FROM public.sales_orders so WHERE so.id = NEW.sales_order_id;
  IF v_order_org IS NULL OR v_order_org <> NEW.org_id THEN
    RAISE EXCEPTION 'Cross-organisation reference: sales order % is invalid or belongs to a different organisation.', NEW.sales_order_id USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS delivery_org_integrity ON public.delivery_confirmations;
CREATE TRIGGER delivery_org_integrity BEFORE INSERT OR UPDATE ON public.delivery_confirmations
  FOR EACH ROW EXECUTE FUNCTION public.validate_delivery_org_integrity();

-- 5b. delivery_confirmation_lines: header + dispatch_line same org; the
-- dispatch_line must belong to the delivery's dispatch.
CREATE OR REPLACE FUNCTION public.validate_delivery_line_org_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_header_org      UUID;
  v_header_dispatch UUID;
  v_dline_org       UUID;
  v_dline_dispatch  UUID;
BEGIN
  SELECT dc.org_id, dc.dispatch_id INTO v_header_org, v_header_dispatch
  FROM public.delivery_confirmations dc WHERE dc.id = NEW.delivery_confirmation_id;
  IF v_header_org IS NULL THEN
    RAISE EXCEPTION 'Invalid delivery confirmation: % does not exist.', NEW.delivery_confirmation_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF v_header_org <> NEW.org_id THEN
    RAISE EXCEPTION 'Cross-organisation reference: delivery confirmation % belongs to a different organisation.', NEW.delivery_confirmation_id USING ERRCODE = 'raise_exception';
  END IF;

  SELECT dl.org_id, dl.dispatch_id INTO v_dline_org, v_dline_dispatch
  FROM public.dispatch_lines dl WHERE dl.id = NEW.dispatch_line_id;
  IF v_dline_org IS NULL THEN
    RAISE EXCEPTION 'Invalid dispatch line: % does not exist.', NEW.dispatch_line_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF v_dline_org <> NEW.org_id THEN
    RAISE EXCEPTION 'Cross-organisation reference: dispatch line % belongs to a different organisation.', NEW.dispatch_line_id USING ERRCODE = 'raise_exception';
  END IF;
  IF v_dline_dispatch <> v_header_dispatch THEN
    RAISE EXCEPTION 'Dispatch line % does not belong to the delivery confirmation''s dispatch.', NEW.dispatch_line_id USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS dcline_org_integrity ON public.delivery_confirmation_lines;
CREATE TRIGGER dcline_org_integrity BEFORE INSERT OR UPDATE ON public.delivery_confirmation_lines
  FOR EACH ROW EXECUTE FUNCTION public.validate_delivery_line_org_integrity();

-- ============================================================
-- 6. ROW LEVEL SECURITY — append/attest-only, RPC-controlled.
-- Members may SELECT. NO client INSERT/UPDATE/DELETE policy (RPC writes only).
-- ============================================================
ALTER TABLE public.delivery_confirmations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view organisation delivery confirmations"
  ON public.delivery_confirmations FOR SELECT USING (public.is_org_member(org_id));
ALTER TABLE public.delivery_confirmation_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view organisation delivery confirmation lines"
  ON public.delivery_confirmation_lines FOR SELECT USING (public.is_org_member(org_id));
GRANT SELECT ON public.delivery_confirmations TO authenticated;
GRANT SELECT ON public.delivery_confirmation_lines TO authenticated;

-- ============================================================
-- 7. EXTEND THE SINGLE AUDIT WRITER (reuse 021) + attach triggers.
-- Adds delivery_confirmation + delivery_confirmation_line (preserving all prior
-- mappings). Headers audited INSERT+UPDATE; lines INSERT+UPDATE (delivered_qty
-- is editable while pending).
-- ============================================================
CREATE OR REPLACE FUNCTION public.audit_log_row_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_entity_type TEXT;
  v_org_id      UUID;
  v_entity_id   UUID;
  v_old         JSONB;
  v_new         JSONB;
BEGIN
  v_entity_type := CASE TG_TABLE_NAME
    WHEN 'wine_batches'         THEN 'wine_batch'
    WHEN 'batch_grape_intakes'  THEN 'batch_grape_intake'
    WHEN 'wine_lots'            THEN 'wine_lot'
    WHEN 'vessels'              THEN 'vessel'
    WHEN 'vessel_placements'    THEN 'vessel_placement'
    WHEN 'production_events'    THEN 'production_event'
    WHEN 'lot_lineage'          THEN 'lot_lineage'
    WHEN 'lot_volume_movements' THEN 'lot_volume_movement'
    WHEN 'lab_analytes'         THEN 'lab_analyte'
    WHEN 'lab_samples'          THEN 'lab_sample'
    WHEN 'lab_measurements'     THEN 'lab_measurement'
    WHEN 'lab_specifications'   THEN 'lab_specification'
    WHEN 'lab_alerts'           THEN 'lab_alert'
    WHEN 'bottling_runs'        THEN 'bottling_run'
    WHEN 'bottling_run_lots'    THEN 'bottling_run_lot'
    WHEN 'bottling_outputs'     THEN 'bottling_output'
    WHEN 'finished_products'    THEN 'finished_product'
    WHEN 'stock_locations'      THEN 'stock_location'
    WHEN 'stock_items'          THEN 'stock_item'
    WHEN 'stock_movements'      THEN 'stock_movement'
    WHEN 'customers'            THEN 'customer'
    WHEN 'customer_contacts'    THEN 'customer_contact'
    WHEN 'customer_addresses'   THEN 'customer_address'
    WHEN 'sales_orders'         THEN 'sales_order'
    WHEN 'sales_order_lines'    THEN 'sales_order_line'
    WHEN 'stock_allocations'    THEN 'stock_allocation'
    WHEN 'dispatches'           THEN 'dispatch'
    WHEN 'dispatch_lines'       THEN 'dispatch_line'
    WHEN 'delivery_confirmations'      THEN 'delivery_confirmation'
    WHEN 'delivery_confirmation_lines' THEN 'delivery_confirmation_line'
    ELSE NULL
  END;

  IF v_entity_type IS NULL THEN
    RAISE EXCEPTION 'audit_log_row_change: unexpected table % — refusing to write an audit row.', TG_TABLE_NAME
      USING ERRCODE = 'raise_exception';
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_org_id := NEW.org_id; v_entity_id := NEW.id; v_old := NULL; v_new := to_jsonb(NEW);
  ELSIF TG_OP = 'UPDATE' THEN
    v_org_id := NEW.org_id; v_entity_id := NEW.id; v_old := to_jsonb(OLD); v_new := to_jsonb(NEW);
  ELSIF TG_OP = 'DELETE' THEN
    v_org_id := OLD.org_id; v_entity_id := OLD.id; v_old := to_jsonb(OLD); v_new := NULL;
  ELSE
    RAISE EXCEPTION 'audit_log_row_change: unsupported operation %.', TG_OP USING ERRCODE = 'raise_exception';
  END IF;

  INSERT INTO public.audit_log
    (org_id, actor_user_id, action, entity_type, entity_id, old_data, new_data, metadata)
  VALUES
    (v_org_id, auth.uid(), TG_OP, v_entity_type, v_entity_id, v_old, v_new, NULL);

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.audit_log_row_change() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_audit_delivery_confirmations ON public.delivery_confirmations;
CREATE TRIGGER trg_audit_delivery_confirmations
  AFTER INSERT OR UPDATE ON public.delivery_confirmations
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_row_change();
DROP TRIGGER IF EXISTS trg_audit_delivery_confirmation_lines ON public.delivery_confirmation_lines;
CREATE TRIGGER trg_audit_delivery_confirmation_lines
  AFTER INSERT OR UPDATE ON public.delivery_confirmation_lines
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_row_change();

-- ============================================================
-- 8. ROLE GUARDS (SECURITY DEFINER, pinned path; internal — not granted).
-- ============================================================
-- Create/update-pending/confirm/fail: OWNER/ADMIN/SALES/CELLAR.
CREATE OR REPLACE FUNCTION public.assert_delivery_actor(target_org UUID)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE uid UUID := auth.uid();
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'Not authenticated.' USING ERRCODE='raise_exception'; END IF;
  IF NOT public.is_org_member(target_org) THEN RAISE EXCEPTION 'Not a member of the target organisation.' USING ERRCODE='raise_exception'; END IF;
  IF NOT public.has_org_role(target_org, ARRAY['OWNER','ADMIN','SALES','CELLAR']) THEN
    RAISE EXCEPTION 'This operation requires an Owner, Admin, Sales or Cellar role.' USING ERRCODE='raise_exception';
  END IF;
  RETURN uid;
END;
$$;
REVOKE ALL ON FUNCTION public.assert_delivery_actor(UUID) FROM PUBLIC;

-- Cancel/correct: OWNER/ADMIN only.
CREATE OR REPLACE FUNCTION public.assert_delivery_admin_actor(target_org UUID)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE uid UUID := auth.uid();
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'Not authenticated.' USING ERRCODE='raise_exception'; END IF;
  IF NOT public.is_org_member(target_org) THEN RAISE EXCEPTION 'Not a member of the target organisation.' USING ERRCODE='raise_exception'; END IF;
  IF NOT public.has_org_role(target_org, ARRAY['OWNER','ADMIN']) THEN
    RAISE EXCEPTION 'This operation requires an Owner or Admin role.' USING ERRCODE='raise_exception';
  END IF;
  RETURN uid;
END;
$$;
REVOKE ALL ON FUNCTION public.assert_delivery_admin_actor(UUID) FROM PUBLIC;

-- ============================================================
-- 9. next_delivery_number — concurrency-safe POD-YYYY-NNNN allocator.
-- Mirrors next_dispatch_number (051).
-- ============================================================
CREATE OR REPLACE FUNCTION public.next_delivery_number(p_org_id UUID)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid  UUID := auth.uid();
  v_year INTEGER := EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER;
  v_next INTEGER;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated.' USING ERRCODE='raise_exception'; END IF;
  IF NOT public.is_org_member(p_org_id) THEN RAISE EXCEPTION 'Not a member of the target organisation.' USING ERRCODE='raise_exception'; END IF;

  INSERT INTO public.delivery_sequences (org_id, order_year, last_number)
  VALUES (p_org_id, v_year, 0)
  ON CONFLICT (org_id, order_year) DO NOTHING;

  SELECT last_number + 1 INTO v_next
  FROM public.delivery_sequences
  WHERE org_id = p_org_id AND order_year = v_year
  FOR UPDATE;

  UPDATE public.delivery_sequences SET last_number = v_next
  WHERE org_id = p_org_id AND order_year = v_year;

  RETURN format('POD-%s-%s', v_year, lpad(v_next::text, 4, '0'));
END;
$$;
REVOKE ALL ON FUNCTION public.next_delivery_number(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.next_delivery_number(UUID) TO authenticated;

-- ============================================================
-- 10. create_delivery_confirmation — atomic. Locks + validates the dispatch,
-- mints POD number, creates header (pending) + one line per dispatch_line with
-- delivered_qty = 0. No stock/allocation/order change.
-- ============================================================
CREATE OR REPLACE FUNCTION public.create_delivery_confirmation(p_dispatch_id UUID)
RETURNS public.delivery_confirmations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor    UUID;
  v_dispatch public.dispatches;
  v_number   TEXT;
  v_header   public.delivery_confirmations;
  v_dline    public.dispatch_lines;
BEGIN
  SELECT * INTO v_dispatch FROM public.dispatches WHERE id = p_dispatch_id FOR UPDATE;
  IF v_dispatch.id IS NULL THEN
    RAISE EXCEPTION 'Dispatch % not found.', p_dispatch_id USING ERRCODE='raise_exception';
  END IF;

  v_actor := public.assert_delivery_actor(v_dispatch.org_id);

  IF v_dispatch.status <> 'recorded' THEN
    RAISE EXCEPTION 'A delivery confirmation can only be created for a recorded dispatch (status is "%").', v_dispatch.status USING ERRCODE='raise_exception';
  END IF;

  -- Prevent another ACTIVE/confirmed delivery for the same dispatch. The partial
  -- unique index is the hard guard; this gives a friendly error first.
  IF EXISTS (
    SELECT 1 FROM public.delivery_confirmations
    WHERE dispatch_id = v_dispatch.id
      AND status IN ('pending','delivered','delivered_with_variance')
  ) THEN
    RAISE EXCEPTION 'This dispatch already has an active or confirmed delivery confirmation.' USING ERRCODE='raise_exception';
  END IF;

  v_number := public.next_delivery_number(v_dispatch.org_id);

  INSERT INTO public.delivery_confirmations
    (org_id, owner_id, dispatch_id, sales_order_id, delivery_number, status, address_snapshot)
  VALUES
    (v_dispatch.org_id, v_actor, v_dispatch.id, v_dispatch.sales_order_id, v_number, 'pending', v_dispatch.address_snapshot)
  RETURNING * INTO v_header;

  -- One line per dispatch_line, delivered_qty = 0.
  FOR v_dline IN
    SELECT dl.* FROM public.dispatch_lines AS dl WHERE dl.dispatch_id = v_dispatch.id ORDER BY dl.id
  LOOP
    INSERT INTO public.delivery_confirmation_lines
      (org_id, owner_id, delivery_confirmation_id, dispatch_line_id, delivered_qty)
    VALUES
      (v_dispatch.org_id, v_actor, v_header.id, v_dline.id, 0);
  END LOOP;

  RETURN v_header;
END;
$$;
REVOKE ALL ON FUNCTION public.create_delivery_confirmation(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_delivery_confirmation(UUID) TO authenticated;

-- ============================================================
-- 11. update_delivery_confirmation_pending — set per-line delivered quantities
-- and optional notes/recipient while PENDING. Atomic. No status change here.
-- p_lines: JSONB array of { delivery_confirmation_line_id, delivered_qty, notes? }
-- ============================================================
CREATE OR REPLACE FUNCTION public.update_delivery_confirmation_pending(
  p_delivery_id    UUID,
  p_lines          JSONB,
  p_recipient_name TEXT DEFAULT NULL,
  p_recipient_role TEXT DEFAULT NULL,
  p_delivery_notes TEXT DEFAULT NULL
)
RETURNS public.delivery_confirmations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor     UUID;
  v_header    public.delivery_confirmations;
  v_elem      JSONB;
  v_line_id   UUID;
  v_qty       INTEGER;
  v_dc_line   public.delivery_confirmation_lines;
  v_dispatched INTEGER;
BEGIN
  SELECT * INTO v_header FROM public.delivery_confirmations WHERE id = p_delivery_id FOR UPDATE;
  IF v_header.id IS NULL THEN
    RAISE EXCEPTION 'Delivery confirmation % not found.', p_delivery_id USING ERRCODE='raise_exception';
  END IF;
  v_actor := public.assert_delivery_actor(v_header.org_id);
  IF v_header.status <> 'pending' THEN
    RAISE EXCEPTION 'Only a pending delivery confirmation can be edited (status is "%").', v_header.status USING ERRCODE='raise_exception';
  END IF;

  IF p_lines IS NOT NULL AND jsonb_typeof(p_lines) = 'array' THEN
    FOR v_elem IN SELECT value FROM jsonb_array_elements(p_lines) AS t(value)
    LOOP
      IF NOT (v_elem ? 'delivery_confirmation_line_id') OR NOT (v_elem ? 'delivered_qty') THEN
        RAISE EXCEPTION 'Each line must have delivery_confirmation_line_id and delivered_qty.' USING ERRCODE='raise_exception';
      END IF;
      v_line_id := (v_elem ->> 'delivery_confirmation_line_id')::UUID;
      IF jsonb_typeof(v_elem -> 'delivered_qty') <> 'number' THEN
        RAISE EXCEPTION 'delivered_qty must be an integer.' USING ERRCODE='raise_exception';
      END IF;
      v_qty := (v_elem ->> 'delivered_qty')::INTEGER;
      IF v_qty IS NULL OR v_qty < 0 THEN
        RAISE EXCEPTION 'delivered_qty must be zero or a positive integer.' USING ERRCODE='raise_exception';
      END IF;

      -- Lock the line; it must belong to this header.
      SELECT * INTO v_dc_line FROM public.delivery_confirmation_lines
      WHERE id = v_line_id AND delivery_confirmation_id = v_header.id FOR UPDATE;
      IF v_dc_line.id IS NULL THEN
        RAISE EXCEPTION 'Delivery line % is not part of this delivery confirmation.', v_line_id USING ERRCODE='raise_exception';
      END IF;

      -- delivered_qty must not exceed the dispatched qty (derived from dispatch_lines).
      SELECT dl.qty_bottles INTO v_dispatched FROM public.dispatch_lines dl WHERE dl.id = v_dc_line.dispatch_line_id;
      IF v_qty > v_dispatched THEN
        RAISE EXCEPTION 'Delivered quantity % exceeds the dispatched quantity % for this line.', v_qty, v_dispatched USING ERRCODE='raise_exception';
      END IF;

      UPDATE public.delivery_confirmation_lines
         SET delivered_qty = v_qty,
             notes = COALESCE(NULLIF(btrim(COALESCE(v_elem ->> 'notes','')), ''), notes)
       WHERE id = v_dc_line.id;
    END LOOP;
  END IF;

  UPDATE public.delivery_confirmations
     SET recipient_name = COALESCE(NULLIF(btrim(COALESCE(p_recipient_name,'')), ''), recipient_name),
         recipient_role = COALESCE(NULLIF(btrim(COALESCE(p_recipient_role,'')), ''), recipient_role),
         delivery_notes = COALESCE(NULLIF(btrim(COALESCE(p_delivery_notes,'')), ''), delivery_notes)
   WHERE id = v_header.id
   RETURNING * INTO v_header;

  RETURN v_header;
END;
$$;
REVOKE ALL ON FUNCTION public.update_delivery_confirmation_pending(UUID, JSONB, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_delivery_confirmation_pending(UUID, JSONB, TEXT, TEXT, TEXT) TO authenticated;

-- ============================================================
-- 12. confirm_delivery_confirmation — atomic. Determines delivered vs
-- delivered_with_variance from the delivered quantities vs dispatched quantities.
-- Requires variance_reason when any shortfall exists. No stock/allocation/order
-- change. POD metadata (recipient/notes/storage paths) accepted here.
-- ============================================================
CREATE OR REPLACE FUNCTION public.confirm_delivery_confirmation(
  p_delivery_id                   UUID,
  p_variance_reason               TEXT DEFAULT NULL,
  p_recipient_name                TEXT DEFAULT NULL,
  p_recipient_role                TEXT DEFAULT NULL,
  p_delivery_notes                TEXT DEFAULT NULL,
  p_signature_storage_path        TEXT DEFAULT NULL,
  p_proof_document_storage_path   TEXT DEFAULT NULL,
  p_proof_photo_storage_path      TEXT DEFAULT NULL
)
RETURNS public.delivery_confirmations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor      UUID;
  v_header     public.delivery_confirmations;
  v_dispatch   public.dispatches;
  v_line_count INTEGER;
  v_short_count INTEGER;
  v_new_status TEXT;
  v_variance   TEXT;
BEGIN
  SELECT * INTO v_header FROM public.delivery_confirmations WHERE id = p_delivery_id FOR UPDATE;
  IF v_header.id IS NULL THEN
    RAISE EXCEPTION 'Delivery confirmation % not found.', p_delivery_id USING ERRCODE='raise_exception';
  END IF;
  v_actor := public.assert_delivery_actor(v_header.org_id);
  IF v_header.status <> 'pending' THEN
    RAISE EXCEPTION 'Only a pending delivery confirmation can be confirmed (status is "%").', v_header.status USING ERRCODE='raise_exception';
  END IF;

  -- The dispatch must still be recorded (not voided) at confirmation time.
  SELECT * INTO v_dispatch FROM public.dispatches WHERE id = v_header.dispatch_id FOR UPDATE;
  IF v_dispatch.id IS NULL OR v_dispatch.status <> 'recorded' THEN
    RAISE EXCEPTION 'The dispatch for this delivery is not in a recorded state and cannot be confirmed.' USING ERRCODE='raise_exception';
  END IF;

  -- Lines must exist.
  SELECT COUNT(*) INTO v_line_count FROM public.delivery_confirmation_lines WHERE delivery_confirmation_id = v_header.id;
  IF v_line_count = 0 THEN
    RAISE EXCEPTION 'This delivery confirmation has no lines.' USING ERRCODE='raise_exception';
  END IF;

  -- Guard: no delivered_qty may exceed its dispatched qty (defence in depth).
  IF EXISTS (
    SELECT 1 FROM public.delivery_confirmation_lines dcl
    JOIN public.dispatch_lines dl ON dl.id = dcl.dispatch_line_id
    WHERE dcl.delivery_confirmation_id = v_header.id AND dcl.delivered_qty > dl.qty_bottles
  ) THEN
    RAISE EXCEPTION 'A delivered quantity exceeds the dispatched quantity.' USING ERRCODE='raise_exception';
  END IF;

  -- Count lines where delivered < dispatched (a shortfall / variance).
  SELECT COUNT(*) INTO v_short_count
  FROM public.delivery_confirmation_lines dcl
  JOIN public.dispatch_lines dl ON dl.id = dcl.dispatch_line_id
  WHERE dcl.delivery_confirmation_id = v_header.id AND dcl.delivered_qty < dl.qty_bottles;

  IF v_short_count > 0 THEN
    v_new_status := 'delivered_with_variance';
    v_variance := upper(btrim(COALESCE(p_variance_reason, '')));
    IF v_variance = '' THEN
      RAISE EXCEPTION 'A variance reason is required when the delivery is short.' USING ERRCODE='raise_exception';
    END IF;
    IF v_variance NOT IN ('SHORT_DELIVERY','DAMAGED','REJECTED','MISSING','OTHER') THEN
      RAISE EXCEPTION 'Invalid variance reason "%".', v_variance USING ERRCODE='raise_exception';
    END IF;
  ELSE
    v_new_status := 'delivered';
    v_variance := NULL;
  END IF;

  UPDATE public.delivery_confirmations
     SET status = v_new_status,
         variance_reason = v_variance,
         delivered_at = NOW(),
         recipient_name = COALESCE(NULLIF(btrim(COALESCE(p_recipient_name,'')), ''), recipient_name),
         recipient_role = COALESCE(NULLIF(btrim(COALESCE(p_recipient_role,'')), ''), recipient_role),
         delivery_notes = COALESCE(NULLIF(btrim(COALESCE(p_delivery_notes,'')), ''), delivery_notes),
         signature_storage_path = COALESCE(NULLIF(btrim(COALESCE(p_signature_storage_path,'')), ''), signature_storage_path),
         proof_document_storage_path = COALESCE(NULLIF(btrim(COALESCE(p_proof_document_storage_path,'')), ''), proof_document_storage_path),
         proof_photo_storage_path = COALESCE(NULLIF(btrim(COALESCE(p_proof_photo_storage_path,'')), ''), proof_photo_storage_path)
   WHERE id = v_header.id
   RETURNING * INTO v_header;

  RETURN v_header;
END;
$$;
REVOKE ALL ON FUNCTION public.confirm_delivery_confirmation(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.confirm_delivery_confirmation(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;

-- ============================================================
-- 13. fail_delivery_confirmation — mark a pending confirmation failed.
-- Requires failure_reason + role. No stock change.
-- ============================================================
CREATE OR REPLACE FUNCTION public.fail_delivery_confirmation(
  p_delivery_id    UUID,
  p_failure_reason TEXT,
  p_delivery_notes TEXT DEFAULT NULL
)
RETURNS public.delivery_confirmations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor  UUID;
  v_header public.delivery_confirmations;
  v_reason TEXT;
BEGIN
  SELECT * INTO v_header FROM public.delivery_confirmations WHERE id = p_delivery_id FOR UPDATE;
  IF v_header.id IS NULL THEN
    RAISE EXCEPTION 'Delivery confirmation % not found.', p_delivery_id USING ERRCODE='raise_exception';
  END IF;
  v_actor := public.assert_delivery_actor(v_header.org_id);
  IF v_header.status <> 'pending' THEN
    RAISE EXCEPTION 'Only a pending delivery confirmation can be marked failed (status is "%").', v_header.status USING ERRCODE='raise_exception';
  END IF;

  v_reason := upper(btrim(COALESCE(p_failure_reason, '')));
  IF v_reason = '' THEN
    RAISE EXCEPTION 'A failure reason is required.' USING ERRCODE='raise_exception';
  END IF;
  IF v_reason NOT IN ('CUSTOMER_UNAVAILABLE','VEHICLE_ISSUE','DAMAGED_IN_TRANSIT','WRONG_ADDRESS','CUSTOMER_REJECTED','OTHER') THEN
    RAISE EXCEPTION 'Invalid failure reason "%".', v_reason USING ERRCODE='raise_exception';
  END IF;

  UPDATE public.delivery_confirmations
     SET status = 'failed',
         failure_reason = v_reason,
         delivery_notes = COALESCE(NULLIF(btrim(COALESCE(p_delivery_notes,'')), ''), delivery_notes)
   WHERE id = v_header.id
   RETURNING * INTO v_header;

  RETURN v_header;
END;
$$;
REVOKE ALL ON FUNCTION public.fail_delivery_confirmation(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fail_delivery_confirmation(UUID, TEXT, TEXT) TO authenticated;

-- ============================================================
-- 14. cancel_delivery_confirmation — cancel a PENDING confirmation.
-- OWNER/ADMIN only. No stock change. Confirmed/failed are historical and may
-- NOT be cancelled here (correction of a confirmed delivery is deferred).
-- ============================================================
CREATE OR REPLACE FUNCTION public.cancel_delivery_confirmation(
  p_delivery_id UUID,
  p_reason      TEXT DEFAULT NULL
)
RETURNS public.delivery_confirmations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor  UUID;
  v_header public.delivery_confirmations;
BEGIN
  SELECT * INTO v_header FROM public.delivery_confirmations WHERE id = p_delivery_id FOR UPDATE;
  IF v_header.id IS NULL THEN
    RAISE EXCEPTION 'Delivery confirmation % not found.', p_delivery_id USING ERRCODE='raise_exception';
  END IF;
  v_actor := public.assert_delivery_admin_actor(v_header.org_id);
  IF v_header.status <> 'pending' THEN
    RAISE EXCEPTION 'Only a pending delivery confirmation can be cancelled (status is "%").', v_header.status USING ERRCODE='raise_exception';
  END IF;

  UPDATE public.delivery_confirmations
     SET status = 'cancelled',
         delivery_notes = COALESCE(NULLIF(btrim(COALESCE(p_reason,'')), ''), delivery_notes)
   WHERE id = v_header.id
   RETURNING * INTO v_header;

  RETURN v_header;
END;
$$;
REVOKE ALL ON FUNCTION public.cancel_delivery_confirmation(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_delivery_confirmation(UUID, TEXT) TO authenticated;

-- ============================================================
-- 15. reverse_dispatch — RE-CREATE with ONE added guard: a dispatch with a
-- CONFIRMED delivery (delivered / delivered_with_variance) cannot be reversed.
-- Everything else is IDENTICAL to 054 (signature, return columns, SECURITY
-- DEFINER, pinned search_path, roles OWNER/ADMIN/CELLAR, locking, stock/
-- allocation/order behaviour, audit, idempotency). failed/cancelled deliveries
-- do NOT block reversal.
-- ============================================================
CREATE OR REPLACE FUNCTION public.reverse_dispatch(
  p_dispatch_id UUID,
  p_reason      TEXT
)
RETURNS TABLE (
  dispatch_id         UUID,
  dispatch_number     TEXT,
  sales_order_id      UUID,
  dispatch_status     TEXT,
  voided_at           TIMESTAMPTZ,
  order_status        TEXT,
  reversed_lines      INTEGER,
  reversed_bottles    INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid           UUID := auth.uid();
  v_actor         UUID;
  v_dispatch      public.dispatches;
  v_order         public.sales_orders;
  v_reason        TEXT;
  v_voided_at     TIMESTAMPTZ := NOW();
  v_order_status  TEXT;
  v_line          public.dispatch_lines;
  v_alloc         public.stock_allocations;
  v_item          public.stock_items;
  v_new_fulfilled INTEGER;
  v_new_alloc_status TEXT;
  v_reversed_lines   INTEGER := 0;
  v_reversed_bottles INTEGER := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.' USING ERRCODE = 'raise_exception';
  END IF;

  v_reason := btrim(COALESCE(p_reason, ''));
  IF v_reason = '' THEN
    RAISE EXCEPTION 'A reversal reason is required.' USING ERRCODE = 'raise_exception';
  END IF;

  SELECT * INTO v_dispatch FROM public.dispatches WHERE id = p_dispatch_id FOR UPDATE;
  IF v_dispatch.id IS NULL THEN
    RAISE EXCEPTION 'Dispatch % not found.', p_dispatch_id USING ERRCODE = 'raise_exception';
  END IF;

  v_actor := public.assert_dispatch_reversal_actor(v_dispatch.org_id);

  IF v_dispatch.status <> 'recorded' THEN
    RAISE EXCEPTION 'Dispatch % cannot be reversed (status is "%").', v_dispatch.dispatch_number, v_dispatch.status USING ERRCODE = 'raise_exception';
  END IF;

  -- P2M-5 GUARD (the only addition vs 054): a CONFIRMED delivery blocks reversal.
  -- failed / cancelled deliveries do NOT block it.
  IF EXISTS (
    SELECT 1 FROM public.delivery_confirmations dc
    WHERE dc.dispatch_id = v_dispatch.id
      AND dc.status IN ('delivered','delivered_with_variance')
  ) THEN
    RAISE EXCEPTION 'Dispatch % has a confirmed delivery and cannot be reversed.', v_dispatch.dispatch_number USING ERRCODE = 'raise_exception';
  END IF;

  SELECT * INTO v_order FROM public.sales_orders WHERE id = v_dispatch.sales_order_id FOR UPDATE;
  IF v_order.id IS NULL THEN
    RAISE EXCEPTION 'Sales order for dispatch % not found.', v_dispatch.dispatch_number USING ERRCODE = 'raise_exception';
  END IF;

  FOR v_line IN
    SELECT dl.* FROM public.dispatch_lines AS dl
    WHERE dl.dispatch_id = v_dispatch.id
    ORDER BY dl.stock_allocation_id, dl.id
  LOOP
    SELECT * INTO v_alloc FROM public.stock_allocations WHERE id = v_line.stock_allocation_id FOR UPDATE;
    IF v_alloc.id IS NULL THEN
      RAISE EXCEPTION 'Stock allocation % for dispatch line % not found.', v_line.stock_allocation_id, v_line.id USING ERRCODE = 'raise_exception';
    END IF;

    IF v_alloc.status NOT IN ('fulfilled','partially_fulfilled') THEN
      RAISE EXCEPTION 'Allocation % is not in a fulfilled state (status "%") and cannot be reversed.', v_alloc.id, v_alloc.status USING ERRCODE = 'raise_exception';
    END IF;
    IF v_alloc.fulfilled_qty < v_line.qty_bottles THEN
      RAISE EXCEPTION 'Allocation % has fulfilled_qty % but dispatch line reversed % — refusing to go negative.', v_alloc.id, v_alloc.fulfilled_qty, v_line.qty_bottles USING ERRCODE = 'raise_exception';
    END IF;

    SELECT si.* INTO v_item
    FROM public.stock_items AS si
    WHERE si.org_id = v_dispatch.org_id
      AND si.product_id = v_line.finished_product_id
      AND si.location_id = v_line.location_id
    FOR UPDATE;
    IF v_item.id IS NULL THEN
      RAISE EXCEPTION 'No physical stock row for product % at location % (dispatch line %).', v_line.finished_product_id, v_line.location_id, v_line.id USING ERRCODE = 'raise_exception';
    END IF;

    UPDATE public.stock_items AS si
       SET qty_bottles = si.qty_bottles + v_line.qty_bottles
     WHERE si.id = v_item.id;

    INSERT INTO public.stock_movements
      (org_id, owner_id, stock_item_id, product_id, location_id, movement_type,
       qty_bottles_delta, reference_type, reference_id, transfer_group_id, notes, occurred_at)
    VALUES
      (v_dispatch.org_id, v_actor, v_item.id, v_line.finished_product_id, v_line.location_id, 'dispatch_reversal',
       v_line.qty_bottles, 'dispatch_reversal', v_line.id, NULL,
       format('Reversal of dispatch %s', v_dispatch.dispatch_number), v_voided_at);

    v_new_fulfilled := v_alloc.fulfilled_qty - v_line.qty_bottles;
    IF v_new_fulfilled = v_alloc.qty_bottles THEN
      v_new_alloc_status := 'fulfilled';
      UPDATE public.stock_allocations
         SET fulfilled_qty = v_new_fulfilled, status = 'fulfilled', fulfilled_at = NOW()
       WHERE id = v_alloc.id;
    ELSIF v_new_fulfilled > 0 THEN
      v_new_alloc_status := 'partially_fulfilled';
      UPDATE public.stock_allocations
         SET fulfilled_qty = v_new_fulfilled, status = 'partially_fulfilled', fulfilled_at = NULL
       WHERE id = v_alloc.id;
    ELSE
      v_new_alloc_status := 'open';
      UPDATE public.stock_allocations
         SET fulfilled_qty = 0, status = 'open', fulfilled_at = NULL
       WHERE id = v_alloc.id;
    END IF;

    v_reversed_lines := v_reversed_lines + 1;
    v_reversed_bottles := v_reversed_bottles + v_line.qty_bottles;
  END LOOP;

  IF v_reversed_lines = 0 THEN
    RAISE EXCEPTION 'Dispatch % has no lines to reverse.', v_dispatch.dispatch_number USING ERRCODE = 'raise_exception';
  END IF;

  UPDATE public.dispatches
     SET status = 'voided', voided_at = v_voided_at, void_reason = v_reason
   WHERE id = v_dispatch.id;

  v_order_status := public.recompute_sales_order_dispatch_status(v_order.id);

  dispatch_id      := v_dispatch.id;
  dispatch_number  := v_dispatch.dispatch_number;
  sales_order_id   := v_order.id;
  dispatch_status  := 'voided';
  voided_at        := v_voided_at;
  order_status     := v_order_status;
  reversed_lines   := v_reversed_lines;
  reversed_bottles := v_reversed_bottles;
  RETURN NEXT;
END;
$$;
REVOKE ALL ON FUNCTION public.reverse_dispatch(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reverse_dispatch(UUID, TEXT) TO authenticated;

-- ============================================================
-- 16. POST-VALIDATION (catalog checks). RAISE => rollback.
-- ============================================================
DO $$
DECLARE n INTEGER; rls_on BOOLEAN; v_oid OID; v_secdef BOOLEAN; v_cfg TEXT[]; v_path BOOLEAN;
BEGIN
  -- Tables.
  IF to_regclass('public.delivery_confirmations') IS NULL THEN RAISE EXCEPTION 'Post: delivery_confirmations missing.' USING ERRCODE='raise_exception'; END IF;
  IF to_regclass('public.delivery_confirmation_lines') IS NULL THEN RAISE EXCEPTION 'Post: delivery_confirmation_lines missing.' USING ERRCODE='raise_exception'; END IF;
  IF to_regclass('public.delivery_sequences') IS NULL THEN RAISE EXCEPTION 'Post: delivery_sequences missing.' USING ERRCODE='raise_exception'; END IF;

  -- Status CHECK vocabulary.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='delivery_status_check'
      AND pg_get_constraintdef(oid) ILIKE '%pending%' AND pg_get_constraintdef(oid) ILIKE '%delivered%'
      AND pg_get_constraintdef(oid) ILIKE '%delivered_with_variance%' AND pg_get_constraintdef(oid) ILIKE '%failed%'
      AND pg_get_constraintdef(oid) ILIKE '%cancelled%') THEN
    RAISE EXCEPTION 'Post: delivery_status_check vocabulary incomplete.' USING ERRCODE='raise_exception'; END IF;

  -- Unique number + partial-active unique index.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='uq_delivery_number_per_org' AND contype='u') THEN
    RAISE EXCEPTION 'Post: uq_delivery_number_per_org missing.' USING ERRCODE='raise_exception'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='uq_delivery_active_per_dispatch') THEN
    RAISE EXCEPTION 'Post: uq_delivery_active_per_dispatch partial unique index missing.' USING ERRCODE='raise_exception'; END IF;

  -- RLS enabled + exactly one SELECT policy + no write policy on both tables.
  SELECT relrowsecurity INTO rls_on FROM pg_class WHERE oid='public.delivery_confirmations'::regclass;
  IF NOT COALESCE(rls_on,false) THEN RAISE EXCEPTION 'Post: RLS off on delivery_confirmations.' USING ERRCODE='raise_exception'; END IF;
  SELECT relrowsecurity INTO rls_on FROM pg_class WHERE oid='public.delivery_confirmation_lines'::regclass;
  IF NOT COALESCE(rls_on,false) THEN RAISE EXCEPTION 'Post: RLS off on delivery_confirmation_lines.' USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='delivery_confirmations';
  IF n <> 1 THEN RAISE EXCEPTION 'Post: delivery_confirmations must have exactly 1 policy (%).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='delivery_confirmation_lines';
  IF n <> 1 THEN RAISE EXCEPTION 'Post: delivery_confirmation_lines must have exactly 1 policy (%).', n USING ERRCODE='raise_exception'; END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
      AND tablename IN ('delivery_confirmations','delivery_confirmation_lines') AND cmd IN ('INSERT','UPDATE','DELETE','ALL')) THEN
    RAISE EXCEPTION 'Post: no write policy may exist on delivery tables.' USING ERRCODE='raise_exception'; END IF;

  -- No direct write grants to authenticated.
  SELECT COUNT(*) INTO n FROM information_schema.role_table_grants
   WHERE table_schema='public' AND table_name IN ('delivery_confirmations','delivery_confirmation_lines')
     AND grantee='authenticated' AND privilege_type IN ('INSERT','UPDATE','DELETE');
  IF n <> 0 THEN RAISE EXCEPTION 'Post: no direct write grant may exist on delivery tables (% found).', n USING ERRCODE='raise_exception'; END IF;

  -- Audit mappings present.
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.audit_log_row_change()'::regprocedure
      AND pg_get_functiondef(oid) ILIKE '%''delivery_confirmation''%'
      AND pg_get_functiondef(oid) ILIKE '%''delivery_confirmation_line''%') THEN
    RAISE EXCEPTION 'Post: audit writer missing delivery mappings.' USING ERRCODE='raise_exception'; END IF;

  -- Each RPC: SECURITY DEFINER, search_path pinned, PUBLIC revoked, authenticated granted.
  FOR v_oid IN
    SELECT unnest(ARRAY[
      to_regprocedure('public.next_delivery_number(uuid)'),
      to_regprocedure('public.create_delivery_confirmation(uuid)'),
      to_regprocedure('public.update_delivery_confirmation_pending(uuid, jsonb, text, text, text)'),
      to_regprocedure('public.confirm_delivery_confirmation(uuid, text, text, text, text, text, text, text)'),
      to_regprocedure('public.fail_delivery_confirmation(uuid, text, text)'),
      to_regprocedure('public.cancel_delivery_confirmation(uuid, text)')
    ])
  LOOP
    IF v_oid IS NULL THEN RAISE EXCEPTION 'Post: a delivery RPC is missing.' USING ERRCODE='raise_exception'; END IF;
    SELECT prosecdef INTO v_secdef FROM pg_proc WHERE oid=v_oid;
    IF NOT v_secdef THEN RAISE EXCEPTION 'Post: delivery RPC % must be SECURITY DEFINER.', v_oid::regprocedure USING ERRCODE='raise_exception'; END IF;
    SELECT proconfig INTO v_cfg FROM pg_proc WHERE oid=v_oid;
    v_path := EXISTS (SELECT 1 FROM unnest(COALESCE(v_cfg, ARRAY[]::TEXT[])) c WHERE c LIKE 'search_path=%' AND position('public' IN c)>0 AND position('pg_temp' IN c)>0);
    IF NOT v_path THEN RAISE EXCEPTION 'Post: delivery RPC % must pin search_path.', v_oid::regprocedure USING ERRCODE='raise_exception'; END IF;
    IF has_function_privilege('public', v_oid, 'EXECUTE') THEN RAISE EXCEPTION 'Post: PUBLIC must not execute %.', v_oid::regprocedure USING ERRCODE='raise_exception'; END IF;
    IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN RAISE EXCEPTION 'Post: authenticated must execute %.', v_oid::regprocedure USING ERRCODE='raise_exception'; END IF;
  END LOOP;

  -- Role guards internal (not granted).
  FOR v_oid IN SELECT unnest(ARRAY[to_regprocedure('public.assert_delivery_actor(uuid)'), to_regprocedure('public.assert_delivery_admin_actor(uuid)')])
  LOOP
    IF v_oid IS NULL THEN RAISE EXCEPTION 'Post: a delivery role guard is missing.' USING ERRCODE='raise_exception'; END IF;
    IF has_function_privilege('public', v_oid, 'EXECUTE') OR has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'Post: delivery role guard % must be internal.', v_oid::regprocedure USING ERRCODE='raise_exception'; END IF;
  END LOOP;

  -- reverse_dispatch unchanged security + still present with the delivery guard.
  v_oid := to_regprocedure('public.reverse_dispatch(uuid, text)');
  IF v_oid IS NULL THEN RAISE EXCEPTION 'Post: reverse_dispatch missing.' USING ERRCODE='raise_exception'; END IF;
  SELECT prosecdef INTO v_secdef FROM pg_proc WHERE oid=v_oid;
  IF NOT v_secdef THEN RAISE EXCEPTION 'Post: reverse_dispatch must remain SECURITY DEFINER.' USING ERRCODE='raise_exception'; END IF;
  SELECT proconfig INTO v_cfg FROM pg_proc WHERE oid=v_oid;
  v_path := EXISTS (SELECT 1 FROM unnest(COALESCE(v_cfg, ARRAY[]::TEXT[])) c WHERE c LIKE 'search_path=%' AND position('public' IN c)>0 AND position('pg_temp' IN c)>0);
  IF NOT v_path THEN RAISE EXCEPTION 'Post: reverse_dispatch must keep pinned search_path.' USING ERRCODE='raise_exception'; END IF;
  IF has_function_privilege('public', v_oid, 'EXECUTE') THEN RAISE EXCEPTION 'Post: PUBLIC must not execute reverse_dispatch.' USING ERRCODE='raise_exception'; END IF;
  IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN RAISE EXCEPTION 'Post: authenticated must execute reverse_dispatch.' USING ERRCODE='raise_exception'; END IF;
  IF pg_get_function_identity_arguments(v_oid) <> 'p_dispatch_id uuid, p_reason text' THEN
    RAISE EXCEPTION 'Post: reverse_dispatch signature changed.' USING ERRCODE='raise_exception'; END IF;
  IF pg_get_functiondef(v_oid) NOT ILIKE '%has a confirmed delivery and cannot be reversed%' THEN
    RAISE EXCEPTION 'Post: reverse_dispatch is missing the P2M-5 confirmed-delivery guard.' USING ERRCODE='raise_exception'; END IF;

  RAISE NOTICE 'Post: P2M-5 delivery confirmation installed — tables, RPCs, RLS, audit, and reverse_dispatch delivery guard verified.';
END $$;

COMMIT;
