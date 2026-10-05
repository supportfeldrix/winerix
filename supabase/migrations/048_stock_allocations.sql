-- ============================================================
-- WINERIX — P2L-6: Stock Allocation (soft reservation) for Confirmed Sales Orders
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- Depends on: 001 (update_updated_at), 006 (organisations, is_org_member,
--             has_org_role), 010 (prevent_owner_id_change), 021 (audit writer),
--             038 (finished_products), 039 (stock_locations), 040 (stock_items +
--             stock_movements), 046 (sales_orders), 047 (sales_order_lines).
--             After 047 the audit writer has 25 mappings; this migration -> 26.
--
-- PURPOSE:
--   Reserve finished-goods stock against CONFIRMED sales orders WITHOUT reducing
--   physical stock. The reservation lives in a dedicated APPEND-ONLY ledger:
--
--     stock_allocations — one row per (order line, location, qty) reservation,
--       with a lifecycle: open -> released | cancelled (and open -> fulfilled,
--       set later by P2M dispatch — NOT in this migration).
--
--   Physical stock remains authoritative in stock_items.qty_bottles. This
--   migration NEVER mutates stock_items.qty_bottles and creates NO stock_movement.
--
--     physical  = stock_items.qty_bottles            (same org/product/location)
--     reserved  = SUM(stock_allocations.qty_bottles)  WHERE status='open'
--     available = physical - reserved                 (never allowed < 0)
--
--   Writes happen ONLY through two SECURITY DEFINER RPCs:
--     allocate_stock_for_sales_order_line(line, location, qty, notes) — atomic;
--       locks the stock_items row FOR UPDATE, recomputes available under the
--       lock, enforces order-line remaining and per-location availability, then
--       inserts the allocation and recomputes the order status.
--     release_stock_allocation(allocation, reason) — flips an OPEN allocation to
--       'released' (returns the bottles to AVAILABLE), never deletes, recomputes
--       the order status.
--
--   Order status is recomputed from the lines + their OPEN allocations:
--     every line fully allocated  -> ready_to_dispatch
--     some allocation, not all    -> partially_allocated
--     no open allocation          -> confirmed
--   (dispatched / partially_dispatched / completed are P2M — not set here.)
--
-- SCOPE — THIS MIGRATION ONLY:
--   stock_allocations table (+FKs/CHECKs/indexes) + append-only RLS (member
--   SELECT only; NO client INSERT/UPDATE/DELETE policy; SELECT grant only) +
--   owner immutability (010) + updated_at (001) + SECURITY DEFINER cross-org
--   integrity trigger + audit (add stock_allocation; audit INSERT + UPDATE) +
--   assert_sales_actor(uuid) guard + the two RPCs + an internal status-recompute
--   helper + post-validation. No seed data.
--
-- THIS MIGRATION DOES NOT:
--   * reduce stock_items.qty_bottles or create any stock_movement
--   * implement dispatch / fulfilment transitions (open->fulfilled is P2M)
--   * implement invoices / payments / finance entries
--   * add reserved_qty / allocated_qty columns to stock_items
--   * change the stock ledger model or create a second stock truth
--   * add a top-level Allocation navigation item
--   * modify sales_orders / sales_order_lines / stock_items / stock_movements
--     schema (status is updated by the SECURITY DEFINER RPCs, which bypass RLS)
-- ============================================================

BEGIN;

-- ============================================================
-- 0. PRE-FLIGHT (fail-fast; never silently create dependencies)
-- ============================================================
DO $$
BEGIN
  IF to_regclass('public.organisations') IS NULL THEN RAISE EXCEPTION 'Pre-flight: organisations missing (006).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.finished_products') IS NULL THEN RAISE EXCEPTION 'Pre-flight: finished_products missing (038).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.stock_locations') IS NULL THEN RAISE EXCEPTION 'Pre-flight: stock_locations missing (039).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.stock_items') IS NULL THEN RAISE EXCEPTION 'Pre-flight: stock_items missing (040).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.sales_orders') IS NULL THEN RAISE EXCEPTION 'Pre-flight: sales_orders missing (046).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.sales_order_lines') IS NULL THEN RAISE EXCEPTION 'Pre-flight: sales_order_lines missing (047).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.audit_log') IS NULL THEN RAISE EXCEPTION 'Pre-flight: audit_log missing (006).' USING ERRCODE='undefined_table'; END IF;
  IF to_regprocedure('public.audit_log_row_change()') IS NULL THEN RAISE EXCEPTION 'Pre-flight: audit_log_row_change() missing (021).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.is_org_member(uuid)') IS NULL THEN RAISE EXCEPTION 'Pre-flight: is_org_member missing (006).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.has_org_role(uuid, text[])') IS NULL THEN RAISE EXCEPTION 'Pre-flight: has_org_role missing (006).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.prevent_owner_id_change()') IS NULL THEN RAISE EXCEPTION 'Pre-flight: prevent_owner_id_change missing (010).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.update_updated_at()') IS NULL THEN RAISE EXCEPTION 'Pre-flight: update_updated_at missing (001).' USING ERRCODE='undefined_function'; END IF;
  IF to_regclass('public.stock_allocations') IS NOT NULL THEN RAISE EXCEPTION 'Pre-flight: stock_allocations already exists.' USING ERRCODE='duplicate_table'; END IF;
END $$;

-- ============================================================
-- 1. STOCK_ALLOCATIONS — append-only soft-reservation ledger (BOTTLES)
-- One row per (sales order line, location, qty) reservation. Traceable to the
-- exact order + line + product + location. qty_bottles > 0. status is tightly
-- constrained. released_at / fulfilled_at are set when leaving 'open'.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.stock_allocations (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               UUID NOT NULL,
  owner_id             UUID NOT NULL,
  sales_order_id       UUID NOT NULL,
  sales_order_line_id  UUID NOT NULL,
  finished_product_id  UUID NOT NULL,
  location_id          UUID NOT NULL,
  qty_bottles          INTEGER NOT NULL,
  status               TEXT NOT NULL DEFAULT 'open',
  allocated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  released_at          TIMESTAMPTZ,
  fulfilled_at         TIMESTAMPTZ,
  notes                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_salloc_org
    FOREIGN KEY (org_id) REFERENCES public.organisations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_salloc_owner
    FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_salloc_order
    FOREIGN KEY (sales_order_id) REFERENCES public.sales_orders(id) ON DELETE RESTRICT,
  CONSTRAINT fk_salloc_line
    FOREIGN KEY (sales_order_line_id) REFERENCES public.sales_order_lines(id) ON DELETE RESTRICT,
  CONSTRAINT fk_salloc_product
    FOREIGN KEY (finished_product_id) REFERENCES public.finished_products(id) ON DELETE RESTRICT,
  CONSTRAINT fk_salloc_location
    FOREIGN KEY (location_id) REFERENCES public.stock_locations(id) ON DELETE RESTRICT,

  -- A reservation is always for a positive number of bottles.
  CONSTRAINT salloc_qty_positive CHECK (qty_bottles > 0),
  -- Tightly constrained lifecycle (do NOT add states until technically needed).
  CONSTRAINT salloc_status_check CHECK (status IN ('open','released','fulfilled','cancelled')),
  -- Lifecycle timestamp consistency: an OPEN allocation has neither released_at
  -- nor fulfilled_at; released/cancelled sets released_at; fulfilled sets
  -- fulfilled_at. (open->fulfilled is P2M; the shape is supported here.)
  CONSTRAINT salloc_open_has_no_terminal_ts
    CHECK (status <> 'open' OR (released_at IS NULL AND fulfilled_at IS NULL)),
  CONSTRAINT salloc_released_has_released_ts
    CHECK (status NOT IN ('released','cancelled') OR released_at IS NOT NULL),
  CONSTRAINT salloc_fulfilled_has_fulfilled_ts
    CHECK (status <> 'fulfilled' OR fulfilled_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_salloc_org_id      ON public.stock_allocations(org_id);
CREATE INDEX IF NOT EXISTS idx_salloc_owner_id    ON public.stock_allocations(owner_id);
CREATE INDEX IF NOT EXISTS idx_salloc_order_id    ON public.stock_allocations(sales_order_id);
CREATE INDEX IF NOT EXISTS idx_salloc_line_id     ON public.stock_allocations(sales_order_line_id);
CREATE INDEX IF NOT EXISTS idx_salloc_product_id  ON public.stock_allocations(finished_product_id);
CREATE INDEX IF NOT EXISTS idx_salloc_location_id ON public.stock_allocations(location_id);
CREATE INDEX IF NOT EXISTS idx_salloc_status      ON public.stock_allocations(status);
-- Fast "open reserved per product/location" and "open per line" lookups.
CREATE INDEX IF NOT EXISTS idx_salloc_open_product_location
  ON public.stock_allocations(org_id, finished_product_id, location_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_salloc_open_line
  ON public.stock_allocations(sales_order_line_id) WHERE status = 'open';

-- ============================================================
-- 2. OWNER_ID IMMUTABILITY (010) + UPDATED_AT (001)
-- ============================================================
DROP TRIGGER IF EXISTS salloc_owner_id_immutable ON public.stock_allocations;
CREATE TRIGGER salloc_owner_id_immutable BEFORE UPDATE ON public.stock_allocations
  FOR EACH ROW EXECUTE FUNCTION public.prevent_owner_id_change();
DROP TRIGGER IF EXISTS salloc_updated_at ON public.stock_allocations;
CREATE TRIGGER salloc_updated_at BEFORE UPDATE ON public.stock_allocations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ============================================================
-- 3. CROSS-ORG / CROSS-REFERENCE INTEGRITY (SECURITY DEFINER, pinned path)
-- The order, line, product and location must all exist and be the SAME org as
-- the allocation; the line must belong to the order; the line product must match
-- the allocation product. Mirrors the 040/047 integrity trigger pattern.
-- ============================================================
CREATE OR REPLACE FUNCTION public.validate_stock_allocation_org_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order_org    UUID;
  v_line_org     UUID;
  v_line_order   UUID;
  v_line_product UUID;
  v_product_org  UUID;
  v_location_org UUID;
BEGIN
  SELECT so.org_id INTO v_order_org FROM public.sales_orders so WHERE so.id = NEW.sales_order_id;
  IF v_order_org IS NULL THEN
    RAISE EXCEPTION 'Invalid sales order: % does not exist.', NEW.sales_order_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF v_order_org <> NEW.org_id THEN
    RAISE EXCEPTION 'Cross-organisation reference: sales order % belongs to a different organisation.', NEW.sales_order_id USING ERRCODE = 'raise_exception';
  END IF;

  SELECT l.org_id, l.sales_order_id, l.finished_product_id
    INTO v_line_org, v_line_order, v_line_product
  FROM public.sales_order_lines l WHERE l.id = NEW.sales_order_line_id;
  IF v_line_org IS NULL THEN
    RAISE EXCEPTION 'Invalid sales order line: % does not exist.', NEW.sales_order_line_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF v_line_org <> NEW.org_id THEN
    RAISE EXCEPTION 'Cross-organisation reference: sales order line % belongs to a different organisation.', NEW.sales_order_line_id USING ERRCODE = 'raise_exception';
  END IF;
  IF v_line_order <> NEW.sales_order_id THEN
    RAISE EXCEPTION 'Order line % does not belong to sales order %.', NEW.sales_order_line_id, NEW.sales_order_id USING ERRCODE = 'raise_exception';
  END IF;
  IF v_line_product <> NEW.finished_product_id THEN
    RAISE EXCEPTION 'Allocation product % does not match the order line product %.', NEW.finished_product_id, v_line_product USING ERRCODE = 'raise_exception';
  END IF;

  SELECT fp.org_id INTO v_product_org FROM public.finished_products fp WHERE fp.id = NEW.finished_product_id;
  IF v_product_org IS NULL OR v_product_org <> NEW.org_id THEN
    RAISE EXCEPTION 'Cross-organisation reference: finished product % is invalid or belongs to a different organisation.', NEW.finished_product_id USING ERRCODE = 'raise_exception';
  END IF;

  SELECT sl.org_id INTO v_location_org FROM public.stock_locations sl WHERE sl.id = NEW.location_id;
  IF v_location_org IS NULL OR v_location_org <> NEW.org_id THEN
    RAISE EXCEPTION 'Cross-organisation reference: stock location % is invalid or belongs to a different organisation.', NEW.location_id USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS salloc_org_integrity ON public.stock_allocations;
CREATE TRIGGER salloc_org_integrity
  BEFORE INSERT OR UPDATE ON public.stock_allocations
  FOR EACH ROW EXECUTE FUNCTION public.validate_stock_allocation_org_integrity();

-- ============================================================
-- 4. ROW LEVEL SECURITY — append-only, RPC-controlled
-- Organisation members may SELECT. There is NO client INSERT/UPDATE/DELETE
-- policy — the ledger is written solely by the SECURITY DEFINER RPCs below
-- (same posture as stock_items / stock_movements in 040).
-- ============================================================
ALTER TABLE public.stock_allocations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view organisation stock allocations"
  ON public.stock_allocations FOR SELECT
  USING (public.is_org_member(org_id));

-- No INSERT/UPDATE/DELETE policy (controlled via RPCs).

-- ============================================================
-- 5. GRANTS — SELECT only to authenticated (NO INSERT/UPDATE/DELETE).
-- The RPCs perform writes with the definer's rights.
-- ============================================================
GRANT SELECT ON public.stock_allocations TO authenticated;

-- ============================================================
-- 6. EXTEND THE SINGLE AUDIT WRITER (reuse 021) + attach trigger
-- Adds stock_allocation, preserving all 25 existing mappings. Final CASE = 26.
-- stock_allocations is audited on INSERT + UPDATE (status lifecycle changes).
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

DROP TRIGGER IF EXISTS trg_audit_stock_allocations ON public.stock_allocations;
CREATE TRIGGER trg_audit_stock_allocations
  AFTER INSERT OR UPDATE ON public.stock_allocations
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_row_change();

-- ============================================================
-- 7. assert_sales_actor — resolve caller + verify membership + sales write role
-- OWNER/ADMIN/SALES may write allocations (CELLAR/FARM/VIEWER are read-only).
-- Mirrors assert_cellar_actor (022). Internal guard — never granted to PUBLIC.
-- ============================================================
CREATE OR REPLACE FUNCTION public.assert_sales_actor(target_org UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  uid UUID := auth.uid();
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.' USING ERRCODE = 'raise_exception';
  END IF;
  IF NOT public.is_org_member(target_org) THEN
    RAISE EXCEPTION 'Not a member of the target organisation.' USING ERRCODE = 'raise_exception';
  END IF;
  IF NOT public.has_org_role(target_org, ARRAY['OWNER','ADMIN','SALES']) THEN
    RAISE EXCEPTION 'This operation requires an Owner, Admin or Sales role.' USING ERRCODE = 'raise_exception';
  END IF;
  RETURN uid;
END;
$$;
REVOKE ALL ON FUNCTION public.assert_sales_actor(UUID) FROM PUBLIC;

-- ============================================================
-- 8. recompute_sales_order_allocation_status — internal, SECURITY DEFINER
-- Derive the order status from its lines + their OPEN allocations:
--   every line fully allocated (open allocations >= ordered) -> ready_to_dispatch
--   some open allocation but not all lines full              -> partially_allocated
--   no open allocation                                       -> confirmed
-- Only ever moves between confirmed / partially_allocated / ready_to_dispatch.
-- Never touches draft / cancelled / dispatched (P2M) orders. The order row is
-- assumed to be locked FOR UPDATE by the caller.
-- ============================================================
CREATE OR REPLACE FUNCTION public.recompute_sales_order_allocation_status(p_sales_order_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status       TEXT;
  v_line_count   INTEGER;
  v_full_lines   INTEGER;
  v_open_total   BIGINT;
  v_new_status   TEXT;
BEGIN
  SELECT status INTO v_status FROM public.sales_orders WHERE id = p_sales_order_id;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Sales order % not found.', p_sales_order_id USING ERRCODE = 'raise_exception';
  END IF;

  -- Only recompute within the allocation flow. Leave other states untouched.
  IF v_status NOT IN ('confirmed','partially_allocated','ready_to_dispatch') THEN
    RETURN v_status;
  END IF;

  SELECT COUNT(*) INTO v_line_count FROM public.sales_order_lines WHERE sales_order_id = p_sales_order_id;

  -- Count lines whose OPEN allocation total covers their ordered quantity.
  SELECT COUNT(*) INTO v_full_lines
  FROM public.sales_order_lines l
  WHERE l.sales_order_id = p_sales_order_id
    AND l.quantity_bottles <= COALESCE((
      SELECT SUM(a.qty_bottles) FROM public.stock_allocations a
      WHERE a.sales_order_line_id = l.id AND a.status = 'open'
    ), 0);

  SELECT COALESCE(SUM(a.qty_bottles), 0) INTO v_open_total
  FROM public.stock_allocations a
  WHERE a.sales_order_id = p_sales_order_id AND a.status = 'open';

  IF v_line_count > 0 AND v_full_lines = v_line_count THEN
    v_new_status := 'ready_to_dispatch';
  ELSIF v_open_total > 0 THEN
    v_new_status := 'partially_allocated';
  ELSE
    v_new_status := 'confirmed';
  END IF;

  IF v_new_status <> v_status THEN
    UPDATE public.sales_orders SET status = v_new_status WHERE id = p_sales_order_id;
  END IF;

  RETURN v_new_status;
END;
$$;
REVOKE ALL ON FUNCTION public.recompute_sales_order_allocation_status(UUID) FROM PUBLIC;

-- ============================================================
-- 9. allocate_stock_for_sales_order_line — the atomic reservation operation
-- Locks the relevant stock_items row FOR UPDATE, recomputes available stock
-- under the lock, enforces order-line remaining and per-location availability,
-- inserts the allocation, recomputes the order status. Returns the created
-- allocation plus useful availability figures.
-- ============================================================
DROP FUNCTION IF EXISTS public.allocate_stock_for_sales_order_line(uuid, uuid, integer, text);

CREATE OR REPLACE FUNCTION public.allocate_stock_for_sales_order_line(
  p_sales_order_line_id UUID,
  p_location_id         UUID,
  p_qty_bottles         INTEGER,
  p_notes               TEXT DEFAULT NULL
)
RETURNS TABLE (
  allocation_id       UUID,
  sales_order_id      UUID,
  sales_order_line_id UUID,
  finished_product_id UUID,
  location_id         UUID,
  qty_bottles         INTEGER,
  order_status        TEXT,
  line_ordered        INTEGER,
  line_allocated_open INTEGER,
  line_remaining      INTEGER,
  location_physical   INTEGER,
  location_reserved   INTEGER,
  location_available  INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid          UUID := auth.uid();
  v_owner        UUID;
  v_line         public.sales_order_lines;
  v_order        public.sales_orders;
  v_loc_org      UUID;
  v_loc_active   BOOLEAN;
  v_item         public.stock_items;
  v_physical     INTEGER;
  v_reserved     INTEGER;
  v_available    INTEGER;
  v_open_line    INTEGER;
  v_remaining    INTEGER;
  v_new_status   TEXT;
  v_new_id       UUID;
BEGIN
  -- 1. Authentication (fail closed).
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.' USING ERRCODE = 'raise_exception';
  END IF;

  -- 9. Quantity validation (cheap; do it early).
  IF p_qty_bottles IS NULL OR p_qty_bottles <= 0 THEN
    RAISE EXCEPTION 'Allocation quantity must be a positive number of bottles.' USING ERRCODE = 'raise_exception';
  END IF;

  -- Resolve the order line (the org is derived from it, never from the client).
  SELECT * INTO v_line FROM public.sales_order_lines WHERE id = p_sales_order_line_id;
  IF v_line.id IS NULL THEN
    RAISE EXCEPTION 'Sales order line % not found.', p_sales_order_line_id USING ERRCODE = 'raise_exception';
  END IF;

  -- 2+3. Authorisation: active membership + OWNER/ADMIN/SALES for the line's org.
  v_owner := public.assert_sales_actor(v_line.org_id);

  -- 4. Lock the parent sales order FOR UPDATE (serialises status transitions and
  -- concurrent allocations against the same order).
  SELECT * INTO v_order FROM public.sales_orders WHERE id = v_line.sales_order_id FOR UPDATE;
  IF v_order.id IS NULL THEN
    RAISE EXCEPTION 'Sales order % not found.', v_line.sales_order_id USING ERRCODE = 'raise_exception';
  END IF;

  -- 5. Order must be in an allocatable lifecycle state. Starting state is
  -- 'confirmed'; also allow top-ups while partially_allocated / ready_to_dispatch.
  -- Draft and cancelled (and any P2M state) are rejected.
  IF v_order.status NOT IN ('confirmed','partially_allocated','ready_to_dispatch') THEN
    RAISE EXCEPTION 'Stock can only be allocated to a confirmed sales order (status is "%").', v_order.status USING ERRCODE = 'raise_exception';
  END IF;

  -- 6. Line must belong to the order (defence in depth; FK + integrity trigger
  -- also enforce this).
  IF v_line.sales_order_id <> v_order.id THEN
    RAISE EXCEPTION 'Order line % does not belong to sales order %.', p_sales_order_line_id, v_order.id USING ERRCODE = 'raise_exception';
  END IF;

  -- Location must exist, be ACTIVE, and be same-org.
  SELECT org_id, is_active INTO v_loc_org, v_loc_active FROM public.stock_locations WHERE id = p_location_id;
  IF v_loc_org IS NULL THEN
    RAISE EXCEPTION 'Stock location % not found.', p_location_id USING ERRCODE = 'raise_exception';
  END IF;
  IF v_loc_org <> v_line.org_id THEN
    RAISE EXCEPTION 'Cross-organisation reference: stock location % belongs to a different organisation.', p_location_id USING ERRCODE = 'raise_exception';
  END IF;
  IF NOT COALESCE(v_loc_active, FALSE) THEN
    RAISE EXCEPTION 'The selected stock location is inactive and cannot be used.' USING ERRCODE = 'raise_exception';
  END IF;

  -- 13. Remaining order-line quantity (ordered minus already OPEN allocations
  -- across ALL locations). Requested qty must not exceed it.
  SELECT COALESCE(SUM(a.qty_bottles), 0) INTO v_open_line
  FROM public.stock_allocations a
  WHERE a.sales_order_line_id = v_line.id AND a.status = 'open';
  v_remaining := v_line.quantity_bottles - v_open_line;
  IF p_qty_bottles > v_remaining THEN
    RAISE EXCEPTION 'Allocation exceeds the remaining order-line quantity: % remaining, % requested.', v_remaining, p_qty_bottles USING ERRCODE = 'raise_exception';
  END IF;

  -- 8. Lock the stock_items row for (org, product, location) FOR UPDATE. It MUST
  -- exist (we never allocate from a non-existent balance — there is nothing to
  -- reserve). This is the oversale-protection point: all availability maths and
  -- the INSERT happen while this row is locked.
  SELECT * INTO v_item FROM public.stock_items
  WHERE org_id = v_line.org_id AND product_id = v_line.finished_product_id AND location_id = p_location_id
  FOR UPDATE;
  IF v_item.id IS NULL THEN
    RAISE EXCEPTION 'There is no stock of this product at the selected location.' USING ERRCODE = 'raise_exception';
  END IF;

  -- 9+10+11. Physical, reserved (OPEN allocations at this product/location),
  -- available = physical - reserved. Never let available go negative.
  v_physical := v_item.qty_bottles;
  SELECT COALESCE(SUM(a.qty_bottles), 0) INTO v_reserved
  FROM public.stock_allocations a
  WHERE a.org_id = v_line.org_id
    AND a.finished_product_id = v_line.finished_product_id
    AND a.location_id = p_location_id
    AND a.status = 'open';
  v_available := v_physical - v_reserved;

  -- 12. Requested allocation must fit available stock.
  IF p_qty_bottles > v_available THEN
    RAISE EXCEPTION 'Insufficient available stock at the location: % available (physical % − reserved %), % requested.',
      v_available, v_physical, v_reserved, p_qty_bottles USING ERRCODE = 'raise_exception';
  END IF;

  -- 14. Insert the allocation (owner = caller; org from the line). Status 'open'.
  INSERT INTO public.stock_allocations
    (org_id, owner_id, sales_order_id, sales_order_line_id, finished_product_id,
     location_id, qty_bottles, status, notes)
  VALUES
    (v_line.org_id, v_owner, v_line.sales_order_id, v_line.id, v_line.finished_product_id,
     p_location_id, p_qty_bottles, 'open',
     NULLIF(btrim(COALESCE(p_notes, '')), ''))
  RETURNING id INTO v_new_id;

  -- Recompute the order status from lines + open allocations.
  v_new_status := public.recompute_sales_order_allocation_status(v_order.id);

  -- 15. Return the created allocation + useful availability figures (recomputed
  -- post-insert so the UI can refresh without a second query).
  allocation_id       := v_new_id;
  sales_order_id      := v_line.sales_order_id;
  sales_order_line_id := v_line.id;
  finished_product_id := v_line.finished_product_id;
  location_id         := p_location_id;
  qty_bottles         := p_qty_bottles;
  order_status        := v_new_status;
  line_ordered        := v_line.quantity_bottles;
  line_allocated_open := v_open_line + p_qty_bottles;
  line_remaining      := v_remaining - p_qty_bottles;
  location_physical   := v_physical;
  location_reserved   := v_reserved + p_qty_bottles;
  location_available  := v_available - p_qty_bottles;
  RETURN NEXT;
END;
$$;
REVOKE ALL ON FUNCTION public.allocate_stock_for_sales_order_line(UUID, UUID, INTEGER, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.allocate_stock_for_sales_order_line(UUID, UUID, INTEGER, TEXT) TO authenticated;

-- ============================================================
-- 10. release_stock_allocation — return an OPEN reservation to AVAILABLE
-- OWNER/ADMIN/SALES only; same-org; only OPEN allocations may be released. Does
-- NOT touch stock_items.qty_bottles. Marks the row 'released' + records
-- released_at (history preserved — never deleted). Recomputes the order status.
-- ============================================================
DROP FUNCTION IF EXISTS public.release_stock_allocation(uuid, text);

CREATE OR REPLACE FUNCTION public.release_stock_allocation(
  p_allocation_id UUID,
  p_reason        TEXT DEFAULT NULL
)
RETURNS public.stock_allocations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid        UUID := auth.uid();
  v_owner      UUID;
  v_alloc      public.stock_allocations;
  v_order      public.sales_orders;
  v_note       TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.' USING ERRCODE = 'raise_exception';
  END IF;

  -- Lock the allocation row.
  SELECT * INTO v_alloc FROM public.stock_allocations WHERE id = p_allocation_id FOR UPDATE;
  IF v_alloc.id IS NULL THEN
    RAISE EXCEPTION 'Stock allocation % not found.', p_allocation_id USING ERRCODE = 'raise_exception';
  END IF;

  -- Authorisation: membership + OWNER/ADMIN/SALES for the allocation's org.
  v_owner := public.assert_sales_actor(v_alloc.org_id);

  -- Only OPEN allocations can be released.
  IF v_alloc.status <> 'open' THEN
    RAISE EXCEPTION 'Only an open allocation can be released (status is "%").', v_alloc.status USING ERRCODE = 'raise_exception';
  END IF;

  -- Lock the parent order so the subsequent status recompute is serialised.
  SELECT * INTO v_order FROM public.sales_orders WHERE id = v_alloc.sales_order_id FOR UPDATE;

  -- Append the reason (if any) to the notes; keep the historical record.
  v_note := NULLIF(btrim(COALESCE(p_reason, '')), '');

  UPDATE public.stock_allocations
     SET status = 'released',
         released_at = NOW(),
         notes = CASE
                   WHEN v_note IS NULL THEN notes
                   WHEN notes IS NULL OR btrim(notes) = '' THEN format('Released: %s', v_note)
                   ELSE format('%s | Released: %s', notes, v_note)
                 END
   WHERE id = v_alloc.id
   RETURNING * INTO v_alloc;

  -- Returning the bottles to AVAILABLE is implicit (the row is no longer 'open').
  PERFORM public.recompute_sales_order_allocation_status(v_alloc.sales_order_id);

  RETURN v_alloc;
END;
$$;
REVOKE ALL ON FUNCTION public.release_stock_allocation(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.release_stock_allocation(UUID, TEXT) TO authenticated;

-- ============================================================
-- 11. POST-VALIDATION (catalog checks). RAISE => rollback.
-- ============================================================
DO $$
DECLARE n INTEGER; rls_on BOOLEAN; is_secdef BOOLEAN; cfg TEXT[]; sig TEXT;
BEGIN
  IF to_regclass('public.stock_allocations') IS NULL THEN RAISE EXCEPTION 'Post: stock_allocations missing.' USING ERRCODE='raise_exception'; END IF;

  -- Column set (15).
  SELECT COUNT(*) INTO n FROM information_schema.columns WHERE table_schema='public' AND table_name='stock_allocations'
    AND column_name IN ('id','org_id','owner_id','sales_order_id','sales_order_line_id','finished_product_id','location_id','qty_bottles','status','allocated_at','released_at','fulfilled_at','notes','created_at','updated_at');
  IF n <> 15 THEN RAISE EXCEPTION 'Post: stock_allocations columns mismatch (%).', n USING ERRCODE='raise_exception'; END IF;

  -- 6 FKs, all ON DELETE RESTRICT.
  SELECT COUNT(*) INTO n FROM information_schema.table_constraints WHERE table_schema='public' AND table_name='stock_allocations' AND constraint_type='FOREIGN KEY';
  IF n <> 6 THEN RAISE EXCEPTION 'Post: stock_allocations should have 6 FKs (%).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_constraint WHERE conrelid='public.stock_allocations'::regclass AND contype='f' AND confdeltype='r';
  IF n <> 6 THEN RAISE EXCEPTION 'Post: all stock_allocations FKs must be ON DELETE RESTRICT (% RESTRICT).', n USING ERRCODE='raise_exception'; END IF;

  -- CHECKs (qty>0 + status vocabulary + 3 lifecycle-timestamp checks).
  SELECT COUNT(*) INTO n FROM pg_constraint WHERE conrelid='public.stock_allocations'::regclass AND contype='c'
    AND conname IN ('salloc_qty_positive','salloc_status_check','salloc_open_has_no_terminal_ts','salloc_released_has_released_ts','salloc_fulfilled_has_fulfilled_ts');
  IF n <> 5 THEN RAISE EXCEPTION 'Post: stock_allocations CHECKs missing (%).', n USING ERRCODE='raise_exception'; END IF;
  -- Status vocabulary must be exactly the four approved states.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='salloc_status_check'
      AND pg_get_constraintdef(oid) ILIKE '%open%' AND pg_get_constraintdef(oid) ILIKE '%released%'
      AND pg_get_constraintdef(oid) ILIKE '%fulfilled%' AND pg_get_constraintdef(oid) ILIKE '%cancelled%') THEN
    RAISE EXCEPTION 'Post: salloc_status_check must allow open/released/fulfilled/cancelled.' USING ERRCODE='raise_exception';
  END IF;

  -- Partial open indexes present.
  IF to_regclass('public.idx_salloc_open_product_location') IS NULL THEN RAISE EXCEPTION 'Post: idx_salloc_open_product_location missing.' USING ERRCODE='raise_exception'; END IF;
  IF to_regclass('public.idx_salloc_open_line') IS NULL THEN RAISE EXCEPTION 'Post: idx_salloc_open_line missing.' USING ERRCODE='raise_exception'; END IF;

  -- RLS on + exactly 1 policy (SELECT only); NO write policy.
  SELECT relrowsecurity INTO rls_on FROM pg_class WHERE oid='public.stock_allocations'::regclass;
  IF NOT COALESCE(rls_on,false) THEN RAISE EXCEPTION 'Post: RLS off on stock_allocations.' USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='stock_allocations';
  IF n <> 1 THEN RAISE EXCEPTION 'Post: stock_allocations must have exactly 1 policy (%).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='stock_allocations' AND cmd IN ('INSERT','UPDATE','DELETE');
  IF n <> 0 THEN RAISE EXCEPTION 'Post: stock_allocations must have no write policy.' USING ERRCODE='raise_exception'; END IF;

  -- Grants: SELECT only; NO INSERT/UPDATE/DELETE to authenticated.
  SELECT COUNT(*) INTO n FROM information_schema.role_table_grants
  WHERE table_schema='public' AND table_name='stock_allocations' AND grantee='authenticated' AND privilege_type IN ('INSERT','UPDATE','DELETE');
  IF n <> 0 THEN RAISE EXCEPTION 'Post: stock_allocations must not grant INSERT/UPDATE/DELETE to authenticated (%).', n USING ERRCODE='raise_exception'; END IF;

  -- Triggers (owner immutability + updated_at + org integrity + audit).
  SELECT COUNT(*) INTO n FROM pg_trigger WHERE tgrelid='public.stock_allocations'::regclass AND NOT tgisinternal
    AND tgname IN ('salloc_owner_id_immutable','salloc_updated_at','salloc_org_integrity','trg_audit_stock_allocations');
  IF n <> 4 THEN RAISE EXCEPTION 'Post: stock_allocations triggers mismatch (%).', n USING ERRCODE='raise_exception'; END IF;

  -- Integrity trigger fn SECURITY DEFINER + pinned path.
  IF to_regprocedure('public.validate_stock_allocation_org_integrity()') IS NULL THEN RAISE EXCEPTION 'Post: integrity fn missing.' USING ERRCODE='raise_exception'; END IF;
  SELECT prosecdef INTO is_secdef FROM pg_proc WHERE oid='public.validate_stock_allocation_org_integrity()'::regprocedure;
  IF NOT COALESCE(is_secdef,false) THEN RAISE EXCEPTION 'Post: integrity fn must be SECURITY DEFINER.' USING ERRCODE='raise_exception'; END IF;

  -- Audit mapping present + prior preserved.
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.audit_log_row_change()'::regprocedure
      AND pg_get_functiondef(oid) ILIKE '%''stock_allocation''%'
      AND pg_get_functiondef(oid) ILIKE '%''sales_order_line''%'
      AND pg_get_functiondef(oid) ILIKE '%''stock_item''%'
      AND pg_get_functiondef(oid) ILIKE '%''customer''%') THEN
    RAISE EXCEPTION 'Post: audit writer missing required mappings.' USING ERRCODE='raise_exception';
  END IF;

  -- assert_sales_actor exists + SECURITY DEFINER + not PUBLIC-executable.
  IF to_regprocedure('public.assert_sales_actor(uuid)') IS NULL THEN RAISE EXCEPTION 'Post: assert_sales_actor missing.' USING ERRCODE='raise_exception'; END IF;
  SELECT prosecdef INTO is_secdef FROM pg_proc WHERE oid='public.assert_sales_actor(uuid)'::regprocedure;
  IF NOT COALESCE(is_secdef,false) THEN RAISE EXCEPTION 'Post: assert_sales_actor must be SECURITY DEFINER.' USING ERRCODE='raise_exception'; END IF;
  IF has_function_privilege('public','public.assert_sales_actor(uuid)','EXECUTE') THEN RAISE EXCEPTION 'Post: PUBLIC must not EXECUTE assert_sales_actor.' USING ERRCODE='raise_exception'; END IF;

  -- Status recompute helper exists + SECURITY DEFINER.
  IF to_regprocedure('public.recompute_sales_order_allocation_status(uuid)') IS NULL THEN RAISE EXCEPTION 'Post: recompute_sales_order_allocation_status missing.' USING ERRCODE='raise_exception'; END IF;
  SELECT prosecdef INTO is_secdef FROM pg_proc WHERE oid='public.recompute_sales_order_allocation_status(uuid)'::regprocedure;
  IF NOT COALESCE(is_secdef,false) THEN RAISE EXCEPTION 'Post: recompute helper must be SECURITY DEFINER.' USING ERRCODE='raise_exception'; END IF;

  -- The two public RPCs: SECURITY DEFINER + pinned search_path + authenticated-only.
  FOREACH sig IN ARRAY ARRAY[
    'public.allocate_stock_for_sales_order_line(uuid, uuid, integer, text)',
    'public.release_stock_allocation(uuid, text)'
  ] LOOP
    IF to_regprocedure(sig) IS NULL THEN RAISE EXCEPTION 'Post: % missing.', sig USING ERRCODE='raise_exception'; END IF;
    SELECT prosecdef INTO is_secdef FROM pg_proc WHERE oid=to_regprocedure(sig);
    IF NOT COALESCE(is_secdef,false) THEN RAISE EXCEPTION 'Post: % must be SECURITY DEFINER.', sig USING ERRCODE='raise_exception'; END IF;
    SELECT proconfig INTO cfg FROM pg_proc WHERE oid=to_regprocedure(sig);
    IF NOT EXISTS (SELECT 1 FROM unnest(COALESCE(cfg,ARRAY[]::TEXT[])) c WHERE c LIKE 'search_path=%' AND position('public' IN c)>0 AND position('pg_temp' IN c)>0) THEN
      RAISE EXCEPTION 'Post: % must pin search_path.', sig USING ERRCODE='raise_exception';
    END IF;
    IF has_function_privilege('public', to_regprocedure(sig), 'EXECUTE') THEN
      RAISE EXCEPTION 'Post: PUBLIC must not EXECUTE %.', sig USING ERRCODE='raise_exception'; END IF;
    IF NOT has_function_privilege('authenticated', to_regprocedure(sig), 'EXECUTE') THEN
      RAISE EXCEPTION 'Post: authenticated must EXECUTE %.', sig USING ERRCODE='raise_exception'; END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') AND has_function_privilege('anon', to_regprocedure(sig), 'EXECUTE') THEN
      RAISE EXCEPTION 'Post: anon must not EXECUTE %.', sig USING ERRCODE='raise_exception'; END IF;
  END LOOP;

  -- Did NOT change the stock ledger model: stock_items has no reserved/allocated
  -- column, and the movement vocabulary is unchanged.
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='stock_items'
             AND column_name IN ('reserved_qty','allocated_qty','reserved_bottles','allocated_bottles')) THEN
    RAISE EXCEPTION 'Post: stock_items must not gain a reserved/allocated column.' USING ERRCODE='raise_exception';
  END IF;

  -- No seed data.
  SELECT COUNT(*) INTO n FROM public.stock_allocations;
  IF n <> 0 THEN RAISE EXCEPTION 'Post: stock_allocations must be empty (%).', n USING ERRCODE='raise_exception'; END IF;
END $$;

COMMIT;
