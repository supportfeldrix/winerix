-- ============================================================
-- WINERIX — P2M-6a: Returns / Returned Finished Goods (backend)
-- 056: A physical-receipt + attestation layer AFTER delivery, mirroring how
--      P2M-5 (delivery, 055) sat after dispatch (051). Returns are purely
--      ADDITIVE: they never mutate delivered_qty, dispatch lines, allocation
--      fulfilled_qty, or sales-order status. Returned goods first enter a
--      QUARANTINE location (return_in), then are separately RESTOCKED
--      (transfer_out+transfer_in) or WRITTEN OFF (return_writeoff).
--
-- Depends on: 001 (update_updated_at), 006 (organisations, is_org_member,
--             has_org_role, audit_log, prevent_owner_id_change — via 010),
--             021 (audit_log_row_change single writer), 040 (stock_items,
--             stock_movements + stock_movements_type_check), 044 (customers),
--             046 (sales_orders), 047 (sales_order_lines), 048 (stock_allocations),
--             051 (dispatches, dispatch_lines, next_dispatch_number pattern,
--             recompute_sales_order_dispatch_status), 053/054/055 (reverse_dispatch
--             — RE-CREATED here with ONE added guard), 055 (delivery_confirmations,
--             delivery_confirmation_lines, delivery number pattern).
--             After 055 the audit writer has 30 mappings; this migration -> 32.
--
-- LOCKED DECISIONS (approved P2M-6 architecture — A..L):
--   A. Tables: returns / return_lines / return_sequences; numbering RET-YYYY-NNNN.
--   B. Two-phase: receive -> quarantine, then restock OR write-off.
--   C. Header lifecycle pending -> received -> closed, plus cancelled (from
--      pending only). Disposition tracked at the LINE level.
--   D. Failed deliveries use reverse_dispatch (P2M-4), NOT returns. A return
--      exists only against a CONFIRMED delivery (delivered / delivered_with_variance).
--   E. A return requires an EXISTING in-org quarantine stock_locations.id. No
--      system location is auto-seeded.
--   F. SALES may create/cancel paperwork but may NEVER move stock. Physical ops
--      (receive/inspect/restock/writeoff/close) require OWNER/ADMIN/CELLAR.
--      Cancel requires OWNER/ADMIN.
--   G. New movement types: return_in (+quarantine), return_writeoff (-quarantine).
--      Restock reuses transfer_out + transfer_in sharing ONE transfer_group_id,
--      both carrying reference_type='return_line' + reference_id = return_line.id.
--   H. Over-return ceiling per dispatch line =
--        delivery_confirmation_lines.delivered_qty
--        - COALESCE(SUM(return_lines.returned_qty WHERE parent return.status <> 'cancelled'), 0)
--      Enforced in-RPC under FOR UPDATE locks; partial unique index prevents two
--      ACTIVE (pending/received) returns per delivery.
--   I. Returns never mutate delivered_qty / dispatch lines / fulfilled_qty /
--      sales-order status. "Net held by customer" is a DERIVED read.
--   J. Cancel is pending-only; a received return must be worked to closed.
--      "Undo receive" is DEFERRED (future compensating-movement RPC).
--   K. Fixed reason/condition code lists (see return_lines CHECKs).
--   L. 6a disposition is WHOLE-LINE; disposition_qty column reserved for future
--      partial disposition (CHECK forbids partial now).
--
-- CANONICAL LOCK ORDER (deadlock-safe; dispatch row is the mutual-exclusion
-- boundary between returns and reverse_dispatch — ALWAYS locked first):
--   dispatches -> sales_orders -> returns -> return_lines
--     -> delivery_confirmation_lines -> stock_allocations -> stock_items(by id)
--   Identifiers are resolved with a NON-LOCKING read first (to discover the
--   dispatch_id), then every FOR UPDATE lock is taken strictly in this order,
--   and all decisions are made only AFTER re-reading rows under their locks.
--
-- THIS MIGRATION DOES NOT: build UI / services / navigation; implement Finance,
--   Storage/document/photo uploads, or SAWIS/SARS/compliance; allow partial-line
--   disposition; implement "undo receive"; seed or backfill any data; change
--   record_dispatch, the delivery RPCs, or any P2M-5 behaviour other than adding
--   ONE guard to reverse_dispatch; weaken any existing security.
-- ============================================================

BEGIN;

-- ============================================================
-- 0. PRE-FLIGHT (fail-fast; never silently create dependencies)
-- ============================================================
DO $$
BEGIN
  IF to_regclass('public.organisations') IS NULL THEN RAISE EXCEPTION 'Pre-flight: organisations missing (006).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.customers') IS NULL THEN RAISE EXCEPTION 'Pre-flight: customers missing (044).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.finished_products') IS NULL THEN RAISE EXCEPTION 'Pre-flight: finished_products missing (038).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.stock_locations') IS NULL THEN RAISE EXCEPTION 'Pre-flight: stock_locations missing (039).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.stock_items') IS NULL THEN RAISE EXCEPTION 'Pre-flight: stock_items missing (040).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.stock_movements') IS NULL THEN RAISE EXCEPTION 'Pre-flight: stock_movements missing (040).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.sales_orders') IS NULL THEN RAISE EXCEPTION 'Pre-flight: sales_orders missing (046).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.stock_allocations') IS NULL THEN RAISE EXCEPTION 'Pre-flight: stock_allocations missing (048).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.dispatches') IS NULL THEN RAISE EXCEPTION 'Pre-flight: dispatches missing (051).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.dispatch_lines') IS NULL THEN RAISE EXCEPTION 'Pre-flight: dispatch_lines missing (051).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.delivery_confirmations') IS NULL THEN RAISE EXCEPTION 'Pre-flight: delivery_confirmations missing (055).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.delivery_confirmation_lines') IS NULL THEN RAISE EXCEPTION 'Pre-flight: delivery_confirmation_lines missing (055).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.audit_log') IS NULL THEN RAISE EXCEPTION 'Pre-flight: audit_log missing (006).' USING ERRCODE='undefined_table'; END IF;

  IF to_regprocedure('public.is_org_member(uuid)') IS NULL THEN RAISE EXCEPTION 'Pre-flight: is_org_member missing (006).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.has_org_role(uuid, text[])') IS NULL THEN RAISE EXCEPTION 'Pre-flight: has_org_role missing (006).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.audit_log_row_change()') IS NULL THEN RAISE EXCEPTION 'Pre-flight: audit_log_row_change() missing (021).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.prevent_owner_id_change()') IS NULL THEN RAISE EXCEPTION 'Pre-flight: prevent_owner_id_change missing (010).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.update_updated_at()') IS NULL THEN RAISE EXCEPTION 'Pre-flight: update_updated_at missing (001).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.reverse_dispatch(uuid, text)') IS NULL THEN RAISE EXCEPTION 'Pre-flight: reverse_dispatch missing (055).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.assert_dispatch_reversal_actor(uuid)') IS NULL THEN RAISE EXCEPTION 'Pre-flight: assert_dispatch_reversal_actor missing (053).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.recompute_sales_order_dispatch_status(uuid)') IS NULL THEN RAISE EXCEPTION 'Pre-flight: recompute_sales_order_dispatch_status missing (051).' USING ERRCODE='undefined_function'; END IF;

  -- The movement vocabulary we extend must exist and already contain 'dispatch'.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='stock_movements_type_check'
                 AND pg_get_constraintdef(oid) ILIKE '%dispatch%') THEN
    RAISE EXCEPTION 'Pre-flight: stock_movements_type_check (040) not found or missing dispatch.' USING ERRCODE='raise_exception';
  END IF;

  -- stock_items must never gain a reserved/allocated column (ledger-model guard).
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='stock_items'
             AND column_name IN ('reserved_qty','allocated_qty','reserved_bottles','allocated_bottles')) THEN
    RAISE EXCEPTION 'Pre-flight: stock_items must not have a reserved/allocated column.' USING ERRCODE='raise_exception';
  END IF;

  -- Return tables must not already exist (idempotent re-run guard at DDL level).
  IF to_regclass('public.returns') IS NOT NULL THEN RAISE EXCEPTION 'Pre-flight: public.returns already exists.' USING ERRCODE='duplicate_table'; END IF;
  IF to_regclass('public.return_lines') IS NOT NULL THEN RAISE EXCEPTION 'Pre-flight: public.return_lines already exists.' USING ERRCODE='duplicate_table'; END IF;
  IF to_regclass('public.return_sequences') IS NOT NULL THEN RAISE EXCEPTION 'Pre-flight: public.return_sequences already exists.' USING ERRCODE='duplicate_table'; END IF;
END $$;

-- ============================================================
-- 1. STOCK_MOVEMENTS — extend the movement_type vocabulary with 'return_in' and
-- 'return_writeoff'. Preserves ALL existing values. Existing rows only hold
-- values that remain in the new set, so the re-add never fails on current data.
-- (Restock reuses the existing transfer_in / transfer_out — not added here.)
-- ============================================================
ALTER TABLE public.stock_movements DROP CONSTRAINT IF EXISTS stock_movements_type_check;
ALTER TABLE public.stock_movements
  ADD CONSTRAINT stock_movements_type_check CHECK (movement_type IN (
    'receipt','transfer_in','transfer_out','adjustment','damage','sale','dispatch',
    'dispatch_reversal','return_in','return_writeoff'
  ));

-- ============================================================
-- 2. RETURN_SEQUENCES — per (org, year) RET-YYYY-NNNN counter.
-- Written only by next_return_number(). Mirrors delivery_sequences (055).
-- ============================================================
CREATE TABLE IF NOT EXISTS public.return_sequences (
  org_id       UUID NOT NULL,
  order_year   INTEGER NOT NULL,
  last_number  INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pk_return_sequences PRIMARY KEY (org_id, order_year),
  CONSTRAINT fk_return_seq_org FOREIGN KEY (org_id) REFERENCES public.organisations(id) ON DELETE RESTRICT,
  CONSTRAINT return_seq_last_number_non_negative CHECK (last_number >= 0),
  CONSTRAINT return_seq_year_sane CHECK (order_year >= 2000 AND order_year <= 2200)
);
ALTER TABLE public.return_sequences ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view organisation return sequences"
  ON public.return_sequences FOR SELECT USING (public.is_org_member(org_id));
GRANT SELECT ON public.return_sequences TO authenticated;
DROP TRIGGER IF EXISTS return_seq_updated_at ON public.return_sequences;
CREATE TRIGGER return_seq_updated_at BEFORE UPDATE ON public.return_sequences
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ============================================================
-- 3. RETURNS — one return event against ONE confirmed delivery.
-- delivery_confirmation_id is the authoritative link; dispatch/order/customer
-- are immutable denormalised snapshots for query convenience + traceability.
-- quarantine_location_id is the Decision-E holding location (receive target).
-- ============================================================
CREATE TABLE IF NOT EXISTS public.returns (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                        UUID NOT NULL,
  owner_id                      UUID NOT NULL,
  return_number                 TEXT NOT NULL,
  status                        TEXT NOT NULL DEFAULT 'pending',
  delivery_confirmation_id      UUID NOT NULL,
  dispatch_id                   UUID NOT NULL,
  sales_order_id                UUID NOT NULL,
  customer_id                   UUID NOT NULL,
  quarantine_location_id        UUID NOT NULL,
  reason_summary                TEXT,
  received_at                   TIMESTAMPTZ,
  closed_at                     TIMESTAMPTZ,
  cancelled_at                  TIMESTAMPTZ,
  cancel_reason                 TEXT,
  return_document_storage_path  TEXT,   -- reserved for future use (no Storage in 6a)
  return_photo_storage_path     TEXT,   -- reserved for future use (no Storage in 6a)
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_return_org      FOREIGN KEY (org_id) REFERENCES public.organisations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_return_owner    FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_return_delivery FOREIGN KEY (delivery_confirmation_id) REFERENCES public.delivery_confirmations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_return_dispatch FOREIGN KEY (dispatch_id) REFERENCES public.dispatches(id) ON DELETE RESTRICT,
  CONSTRAINT fk_return_order    FOREIGN KEY (sales_order_id) REFERENCES public.sales_orders(id) ON DELETE RESTRICT,
  CONSTRAINT fk_return_customer FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE RESTRICT,
  CONSTRAINT fk_return_location FOREIGN KEY (quarantine_location_id) REFERENCES public.stock_locations(id) ON DELETE RESTRICT,

  CONSTRAINT return_number_not_blank CHECK (length(btrim(return_number)) > 0),
  CONSTRAINT uq_return_number_per_org UNIQUE (org_id, return_number),
  CONSTRAINT return_status_check CHECK (status IN ('pending','received','closed','cancelled')),

  -- Status <-> timestamp/reason coupling (mirrors dispatch_void_consistency, 053).
  CONSTRAINT return_status_timestamp_rule CHECK (
    (status = 'pending'
       AND received_at IS NULL AND closed_at IS NULL
       AND cancelled_at IS NULL AND cancel_reason IS NULL)
    OR
    (status = 'received'
       AND received_at IS NOT NULL AND closed_at IS NULL
       AND cancelled_at IS NULL AND cancel_reason IS NULL)
    OR
    (status = 'closed'
       AND received_at IS NOT NULL AND closed_at IS NOT NULL
       AND cancelled_at IS NULL AND cancel_reason IS NULL)
    OR
    (status = 'cancelled'
       AND cancelled_at IS NOT NULL
       AND cancel_reason IS NOT NULL AND length(btrim(cancel_reason)) > 0
       AND received_at IS NULL AND closed_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_return_org_id       ON public.returns(org_id);
CREATE INDEX IF NOT EXISTS idx_return_owner_id     ON public.returns(owner_id);
CREATE INDEX IF NOT EXISTS idx_return_delivery_id  ON public.returns(delivery_confirmation_id);
CREATE INDEX IF NOT EXISTS idx_return_dispatch_id  ON public.returns(dispatch_id);
CREATE INDEX IF NOT EXISTS idx_return_order_id     ON public.returns(sales_order_id);
CREATE INDEX IF NOT EXISTS idx_return_customer_id  ON public.returns(customer_id);
CREATE INDEX IF NOT EXISTS idx_return_location_id  ON public.returns(quarantine_location_id);
CREATE INDEX IF NOT EXISTS idx_return_status       ON public.returns(status);
CREATE INDEX IF NOT EXISTS idx_return_number       ON public.returns(return_number);

-- At most ONE ACTIVE (pending/received) return per delivery. Many closed/
-- cancelled historical returns are allowed. This is the structural guard against
-- two concurrent active returns racing the same delivery (safeguard #1).
CREATE UNIQUE INDEX IF NOT EXISTS uq_return_active_per_delivery
  ON public.returns(delivery_confirmation_id)
  WHERE status IN ('pending','received');

-- ============================================================
-- 4. RETURN_LINES — one row per returned dispatch line within a return.
-- dispatch_line_id is the authoritative spine; delivery_confirmation_line_id is
-- the delivered_qty authority for the over-return ceiling (Decision H).
-- reason_code + condition_code are fixed CHECK-enforced lists (Decision K).
-- disposition is WHOLE-LINE in 6a (Decision L); disposition_qty reserved.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.return_lines (
  id                             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                         UUID NOT NULL,
  owner_id                       UUID NOT NULL,
  return_id                      UUID NOT NULL,
  dispatch_line_id               UUID NOT NULL,
  delivery_confirmation_line_id  UUID NOT NULL,
  finished_product_id            UUID NOT NULL,
  returned_qty                   INTEGER NOT NULL,
  reason_code                    TEXT NOT NULL,
  condition_code                 TEXT NOT NULL,
  disposition                    TEXT NOT NULL DEFAULT 'awaiting_inspection',
  disposition_qty                INTEGER NOT NULL DEFAULT 0,
  restock_location_id            UUID,
  restock_transfer_group_id      UUID,
  notes                          TEXT,
  created_at                     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_rline_org   FOREIGN KEY (org_id) REFERENCES public.organisations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_rline_owner FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE RESTRICT,
  -- The ONLY cascade: deleting a return header removes its lines (a pending
  -- header has emitted no stock movements, so no ledger history is ever lost).
  CONSTRAINT fk_rline_return FOREIGN KEY (return_id) REFERENCES public.returns(id) ON DELETE CASCADE,
  CONSTRAINT fk_rline_dispatch_line FOREIGN KEY (dispatch_line_id) REFERENCES public.dispatch_lines(id) ON DELETE RESTRICT,
  CONSTRAINT fk_rline_delivery_line FOREIGN KEY (delivery_confirmation_line_id) REFERENCES public.delivery_confirmation_lines(id) ON DELETE RESTRICT,
  CONSTRAINT fk_rline_product FOREIGN KEY (finished_product_id) REFERENCES public.finished_products(id) ON DELETE RESTRICT,
  CONSTRAINT fk_rline_restock_location FOREIGN KEY (restock_location_id) REFERENCES public.stock_locations(id) ON DELETE RESTRICT,

  CONSTRAINT rline_returned_qty_positive CHECK (returned_qty > 0),
  CONSTRAINT rline_disposition_qty_bounds CHECK (disposition_qty >= 0 AND disposition_qty <= returned_qty),

  -- Decision K — exactly seven reason codes.
  CONSTRAINT rline_reason_code_check CHECK (reason_code IN (
    'CUSTOMER_CANCELLED','ORDER_ERROR','DAMAGED_IN_TRANSIT','QUALITY_COMPLAINT',
    'LABELLING_ERROR','EXPIRED_OR_AGED','OTHER'
  )),
  -- Decision K — exactly six condition codes.
  CONSTRAINT rline_condition_code_check CHECK (condition_code IN (
    'SELLABLE','DAMAGED','LABEL_DAMAGED','OPENED','SUSPECT_QUALITY','UNKNOWN'
  )),
  -- Disposition vocabulary.
  CONSTRAINT rline_disposition_check CHECK (disposition IN (
    'awaiting_inspection','restocked','written_off'
  )),

  -- Decision L — WHOLE-LINE disposition coupling. Partial disposition forbidden
  -- now (disposition_qty must be 0 or the full returned_qty). The column exists
  -- only so a future phase can relax this without a schema change.
  CONSTRAINT rline_disposition_coupling CHECK (
    (disposition = 'awaiting_inspection'
       AND disposition_qty = 0
       AND restock_location_id IS NULL
       AND restock_transfer_group_id IS NULL)
    OR
    (disposition = 'restocked'
       AND disposition_qty = returned_qty
       AND restock_location_id IS NOT NULL
       AND restock_transfer_group_id IS NOT NULL)
    OR
    (disposition = 'written_off'
       AND disposition_qty = returned_qty
       AND restock_location_id IS NULL
       AND restock_transfer_group_id IS NULL)
  ),

  -- One return line per (return, dispatch_line) (mirrors uq_dcline_per_dispatch_line, 055).
  CONSTRAINT uq_rline_per_dispatch_line UNIQUE (return_id, dispatch_line_id)
);

CREATE INDEX IF NOT EXISTS idx_rline_org_id             ON public.return_lines(org_id);
CREATE INDEX IF NOT EXISTS idx_rline_owner_id           ON public.return_lines(owner_id);
CREATE INDEX IF NOT EXISTS idx_rline_return_id          ON public.return_lines(return_id);
CREATE INDEX IF NOT EXISTS idx_rline_dispatch_line_id   ON public.return_lines(dispatch_line_id);
CREATE INDEX IF NOT EXISTS idx_rline_delivery_line_id   ON public.return_lines(delivery_confirmation_line_id);
CREATE INDEX IF NOT EXISTS idx_rline_product_id         ON public.return_lines(finished_product_id);
CREATE INDEX IF NOT EXISTS idx_rline_disposition        ON public.return_lines(disposition);
CREATE INDEX IF NOT EXISTS idx_rline_restock_group      ON public.return_lines(restock_transfer_group_id);

-- ============================================================
-- 5. OWNER IMMUTABILITY (010) + UPDATED_AT (001) on both tables.
-- ============================================================
DROP TRIGGER IF EXISTS return_owner_id_immutable ON public.returns;
CREATE TRIGGER return_owner_id_immutable BEFORE UPDATE ON public.returns
  FOR EACH ROW EXECUTE FUNCTION public.prevent_owner_id_change();
DROP TRIGGER IF EXISTS return_updated_at ON public.returns;
CREATE TRIGGER return_updated_at BEFORE UPDATE ON public.returns
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS rline_owner_id_immutable ON public.return_lines;
CREATE TRIGGER rline_owner_id_immutable BEFORE UPDATE ON public.return_lines
  FOR EACH ROW EXECUTE FUNCTION public.prevent_owner_id_change();
DROP TRIGGER IF EXISTS rline_updated_at ON public.return_lines;
CREATE TRIGGER rline_updated_at BEFORE UPDATE ON public.return_lines
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ============================================================
-- 6. CROSS-ORG / CROSS-REFERENCE INTEGRITY (SECURITY DEFINER, pinned path).
-- Defence in depth: the RPCs are the primary enforcers and derive these values
-- from locked parent rows; these triggers independently reject any mismatch.
-- They perform READ-ONLY lookups (no FOR UPDATE) and therefore introduce NO
-- lock acquisition — the canonical lock order is owned solely by the RPCs.
-- ============================================================

-- 6a. returns: delivery + dispatch + order + customer + quarantine location all
-- exist, are the SAME org as the return, and are mutually consistent (the
-- delivery's dispatch == returns.dispatch_id, the dispatch's order ==
-- returns.sales_order_id, and the order's customer == returns.customer_id).
CREATE OR REPLACE FUNCTION public.validate_return_org_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_dc_org       UUID;
  v_dc_dispatch  UUID;
  v_dc_order     UUID;
  v_disp_org     UUID;
  v_disp_order   UUID;
  v_order_org    UUID;
  v_order_cust   UUID;
  v_cust_org     UUID;
  v_loc_org      UUID;
  v_loc_active   BOOLEAN;
BEGIN
  -- Delivery confirmation (authoritative link).
  SELECT dc.org_id, dc.dispatch_id, dc.sales_order_id
    INTO v_dc_org, v_dc_dispatch, v_dc_order
  FROM public.delivery_confirmations dc WHERE dc.id = NEW.delivery_confirmation_id;
  IF v_dc_org IS NULL THEN
    RAISE EXCEPTION 'Invalid delivery confirmation: % does not exist.', NEW.delivery_confirmation_id USING ERRCODE='foreign_key_violation';
  END IF;
  IF v_dc_org <> NEW.org_id THEN
    RAISE EXCEPTION 'Cross-organisation reference: delivery confirmation % belongs to a different organisation.', NEW.delivery_confirmation_id USING ERRCODE='raise_exception';
  END IF;
  IF v_dc_dispatch <> NEW.dispatch_id THEN
    RAISE EXCEPTION 'Return dispatch % does not match the delivery confirmation''s dispatch %.', NEW.dispatch_id, v_dc_dispatch USING ERRCODE='raise_exception';
  END IF;
  IF v_dc_order <> NEW.sales_order_id THEN
    RAISE EXCEPTION 'Return sales order % does not match the delivery confirmation''s order %.', NEW.sales_order_id, v_dc_order USING ERRCODE='raise_exception';
  END IF;

  -- Dispatch same-org and belongs to the stated order.
  SELECT d.org_id, d.sales_order_id INTO v_disp_org, v_disp_order
  FROM public.dispatches d WHERE d.id = NEW.dispatch_id;
  IF v_disp_org IS NULL THEN
    RAISE EXCEPTION 'Invalid dispatch: % does not exist.', NEW.dispatch_id USING ERRCODE='foreign_key_violation';
  END IF;
  IF v_disp_org <> NEW.org_id THEN
    RAISE EXCEPTION 'Cross-organisation reference: dispatch % belongs to a different organisation.', NEW.dispatch_id USING ERRCODE='raise_exception';
  END IF;
  IF v_disp_order <> NEW.sales_order_id THEN
    RAISE EXCEPTION 'Dispatch % is not for sales order %.', NEW.dispatch_id, NEW.sales_order_id USING ERRCODE='raise_exception';
  END IF;

  -- Sales order same-org and belongs to the stated customer.
  SELECT so.org_id, so.customer_id INTO v_order_org, v_order_cust
  FROM public.sales_orders so WHERE so.id = NEW.sales_order_id;
  IF v_order_org IS NULL THEN
    RAISE EXCEPTION 'Invalid sales order: % does not exist.', NEW.sales_order_id USING ERRCODE='foreign_key_violation';
  END IF;
  IF v_order_org <> NEW.org_id THEN
    RAISE EXCEPTION 'Cross-organisation reference: sales order % belongs to a different organisation.', NEW.sales_order_id USING ERRCODE='raise_exception';
  END IF;
  IF v_order_cust <> NEW.customer_id THEN
    RAISE EXCEPTION 'Return customer % does not match the sales order''s customer %.', NEW.customer_id, v_order_cust USING ERRCODE='raise_exception';
  END IF;

  -- Customer same-org.
  SELECT c.org_id INTO v_cust_org FROM public.customers c WHERE c.id = NEW.customer_id;
  IF v_cust_org IS NULL OR v_cust_org <> NEW.org_id THEN
    RAISE EXCEPTION 'Cross-organisation reference: customer % is invalid or belongs to a different organisation.', NEW.customer_id USING ERRCODE='raise_exception';
  END IF;

  -- Quarantine location same-org (Decision E — must be a real in-org location)
  -- AND active (defence-in-depth for the inactive-location hardening).
  SELECT sl.org_id, sl.is_active INTO v_loc_org, v_loc_active FROM public.stock_locations sl WHERE sl.id = NEW.quarantine_location_id;
  IF v_loc_org IS NULL OR v_loc_org <> NEW.org_id THEN
    RAISE EXCEPTION 'Cross-organisation reference: quarantine location % is invalid or belongs to a different organisation.', NEW.quarantine_location_id USING ERRCODE='raise_exception';
  END IF;
  IF NOT COALESCE(v_loc_active, FALSE) THEN
    RAISE EXCEPTION 'The quarantine stock location is inactive and cannot be used.' USING ERRCODE='raise_exception';
  END IF;

  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS return_org_integrity ON public.returns;
CREATE TRIGGER return_org_integrity BEFORE INSERT OR UPDATE ON public.returns
  FOR EACH ROW EXECUTE FUNCTION public.validate_return_org_integrity();

-- 6b. return_lines: header + dispatch_line + delivery_confirmation_line + product
-- all same-org and consistent. The dispatch_line must belong to the return's
-- dispatch; the delivery_confirmation_line must belong to the return's delivery
-- AND reference the SAME dispatch_line; the product must match the dispatch line.
CREATE OR REPLACE FUNCTION public.validate_return_line_org_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_header_org       UUID;
  v_header_dispatch  UUID;
  v_header_delivery  UUID;
  v_dl_org           UUID;
  v_dl_dispatch      UUID;
  v_dl_product       UUID;
  v_dcl_org          UUID;
  v_dcl_delivery     UUID;
  v_dcl_displine     UUID;
  v_prod_org         UUID;
  v_restock_loc_org  UUID;
  v_restock_loc_active BOOLEAN;
BEGIN
  -- Parent return.
  SELECT r.org_id, r.dispatch_id, r.delivery_confirmation_id
    INTO v_header_org, v_header_dispatch, v_header_delivery
  FROM public.returns r WHERE r.id = NEW.return_id;
  IF v_header_org IS NULL THEN
    RAISE EXCEPTION 'Invalid return: % does not exist.', NEW.return_id USING ERRCODE='foreign_key_violation';
  END IF;
  IF v_header_org <> NEW.org_id THEN
    RAISE EXCEPTION 'Cross-organisation reference: return % belongs to a different organisation.', NEW.return_id USING ERRCODE='raise_exception';
  END IF;

  -- Dispatch line: same-org, belongs to the return's dispatch.
  SELECT dl.org_id, dl.dispatch_id, dl.finished_product_id
    INTO v_dl_org, v_dl_dispatch, v_dl_product
  FROM public.dispatch_lines dl WHERE dl.id = NEW.dispatch_line_id;
  IF v_dl_org IS NULL THEN
    RAISE EXCEPTION 'Invalid dispatch line: % does not exist.', NEW.dispatch_line_id USING ERRCODE='foreign_key_violation';
  END IF;
  IF v_dl_org <> NEW.org_id THEN
    RAISE EXCEPTION 'Cross-organisation reference: dispatch line % belongs to a different organisation.', NEW.dispatch_line_id USING ERRCODE='raise_exception';
  END IF;
  IF v_dl_dispatch <> v_header_dispatch THEN
    RAISE EXCEPTION 'Dispatch line % does not belong to the return''s dispatch.', NEW.dispatch_line_id USING ERRCODE='raise_exception';
  END IF;

  -- Product must match the dispatch line's product.
  IF NEW.finished_product_id <> v_dl_product THEN
    RAISE EXCEPTION 'Return line product % does not match the dispatch line product %.', NEW.finished_product_id, v_dl_product USING ERRCODE='raise_exception';
  END IF;

  -- Delivery confirmation line: same-org, belongs to the return's delivery, and
  -- references the SAME dispatch line.
  SELECT dcl.org_id, dcl.delivery_confirmation_id, dcl.dispatch_line_id
    INTO v_dcl_org, v_dcl_delivery, v_dcl_displine
  FROM public.delivery_confirmation_lines dcl WHERE dcl.id = NEW.delivery_confirmation_line_id;
  IF v_dcl_org IS NULL THEN
    RAISE EXCEPTION 'Invalid delivery confirmation line: % does not exist.', NEW.delivery_confirmation_line_id USING ERRCODE='foreign_key_violation';
  END IF;
  IF v_dcl_org <> NEW.org_id THEN
    RAISE EXCEPTION 'Cross-organisation reference: delivery confirmation line % belongs to a different organisation.', NEW.delivery_confirmation_line_id USING ERRCODE='raise_exception';
  END IF;
  IF v_dcl_delivery <> v_header_delivery THEN
    RAISE EXCEPTION 'Delivery confirmation line % does not belong to the return''s delivery.', NEW.delivery_confirmation_line_id USING ERRCODE='raise_exception';
  END IF;
  IF v_dcl_displine <> NEW.dispatch_line_id THEN
    RAISE EXCEPTION 'Delivery confirmation line % is for a different dispatch line than the return line.', NEW.delivery_confirmation_line_id USING ERRCODE='raise_exception';
  END IF;

  -- Product same-org.
  SELECT fp.org_id INTO v_prod_org FROM public.finished_products fp WHERE fp.id = NEW.finished_product_id;
  IF v_prod_org IS NULL OR v_prod_org <> NEW.org_id THEN
    RAISE EXCEPTION 'Cross-organisation reference: finished product % is invalid or belongs to a different organisation.', NEW.finished_product_id USING ERRCODE='raise_exception';
  END IF;

  -- Restock location (when present) must be same-org AND active (defence-in-depth
  -- for the inactive-location hardening). NULL restock_location_id is unaffected.
  IF NEW.restock_location_id IS NOT NULL THEN
    SELECT sl.org_id, sl.is_active INTO v_restock_loc_org, v_restock_loc_active FROM public.stock_locations sl WHERE sl.id = NEW.restock_location_id;
    IF v_restock_loc_org IS NULL OR v_restock_loc_org <> NEW.org_id THEN
      RAISE EXCEPTION 'Cross-organisation reference: restock location % is invalid or belongs to a different organisation.', NEW.restock_location_id USING ERRCODE='raise_exception';
    END IF;
    IF NOT COALESCE(v_restock_loc_active, FALSE) THEN
      RAISE EXCEPTION 'The destination stock location is inactive and cannot be used.' USING ERRCODE='raise_exception';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS rline_org_integrity ON public.return_lines;
CREATE TRIGGER rline_org_integrity BEFORE INSERT OR UPDATE ON public.return_lines
  FOR EACH ROW EXECUTE FUNCTION public.validate_return_line_org_integrity();

-- ============================================================
-- 7. ROW LEVEL SECURITY — append/attest-only, RPC-controlled.
-- Members may SELECT. NO client INSERT/UPDATE/DELETE policy (RPC writes only).
-- ============================================================
ALTER TABLE public.returns ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view organisation returns"
  ON public.returns FOR SELECT USING (public.is_org_member(org_id));
ALTER TABLE public.return_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view organisation return lines"
  ON public.return_lines FOR SELECT USING (public.is_org_member(org_id));
GRANT SELECT ON public.returns TO authenticated;
GRANT SELECT ON public.return_lines TO authenticated;

-- ============================================================
-- 8. EXTEND THE SINGLE AUDIT WRITER (reuse 021) + attach triggers.
-- Adds 'return' + 'return_line' preserving ALL thirty prior mappings. Final=32.
-- Both audited INSERT + UPDATE (status + disposition transitions are meaningful).
-- return_sequences is NOT audited (counter table, same as *_sequences today).
-- The resulting stock_items (UPDATE) + stock_movements (INSERT) rows are audited
-- by their existing 040 triggers — no new audit path.
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
    WHEN 'returns'              THEN 'return'
    WHEN 'return_lines'         THEN 'return_line'
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

DROP TRIGGER IF EXISTS trg_audit_returns ON public.returns;
CREATE TRIGGER trg_audit_returns
  AFTER INSERT OR UPDATE ON public.returns
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_row_change();
DROP TRIGGER IF EXISTS trg_audit_return_lines ON public.return_lines;
CREATE TRIGGER trg_audit_return_lines
  AFTER INSERT OR UPDATE ON public.return_lines
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_row_change();

-- ============================================================
-- 9. ROLE GUARDS (SECURITY DEFINER, pinned path; internal — not granted).
-- Decision F. Mirrors assert_delivery_actor / assert_delivery_admin_actor (055).
-- ============================================================
-- Create/cancel-paperwork actor: OWNER/ADMIN/SALES/CELLAR.
CREATE OR REPLACE FUNCTION public.assert_return_create_actor(target_org UUID)
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
REVOKE ALL ON FUNCTION public.assert_return_create_actor(UUID) FROM PUBLIC;

-- Physical actor (receive/inspect/restock/writeoff/close): OWNER/ADMIN/CELLAR.
-- SALES is deliberately EXCLUDED (Decision F).
CREATE OR REPLACE FUNCTION public.assert_return_physical_actor(target_org UUID)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE uid UUID := auth.uid();
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'Not authenticated.' USING ERRCODE='raise_exception'; END IF;
  IF NOT public.is_org_member(target_org) THEN RAISE EXCEPTION 'Not a member of the target organisation.' USING ERRCODE='raise_exception'; END IF;
  IF NOT public.has_org_role(target_org, ARRAY['OWNER','ADMIN','CELLAR']) THEN
    RAISE EXCEPTION 'This operation requires an Owner, Admin or Cellar role.' USING ERRCODE='raise_exception';
  END IF;
  RETURN uid;
END;
$$;
REVOKE ALL ON FUNCTION public.assert_return_physical_actor(UUID) FROM PUBLIC;

-- Cancel actor: OWNER/ADMIN only.
CREATE OR REPLACE FUNCTION public.assert_return_admin_actor(target_org UUID)
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
REVOKE ALL ON FUNCTION public.assert_return_admin_actor(UUID) FROM PUBLIC;

-- ============================================================
-- 10. next_return_number — concurrency-safe RET-YYYY-NNNN allocator.
-- Mirrors next_delivery_number (055) / next_dispatch_number (051).
-- ============================================================
CREATE OR REPLACE FUNCTION public.next_return_number(p_org_id UUID)
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

  INSERT INTO public.return_sequences (org_id, order_year, last_number)
  VALUES (p_org_id, v_year, 0)
  ON CONFLICT (org_id, order_year) DO NOTHING;

  SELECT last_number + 1 INTO v_next
  FROM public.return_sequences
  WHERE org_id = p_org_id AND order_year = v_year
  FOR UPDATE;

  UPDATE public.return_sequences SET last_number = v_next
  WHERE org_id = p_org_id AND order_year = v_year;

  RETURN format('RET-%s-%s', v_year, lpad(v_next::text, 4, '0'));
END;
$$;
REVOKE ALL ON FUNCTION public.next_return_number(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.next_return_number(UUID) TO authenticated;

-- ============================================================
-- 11. create_return — atomic. Creates a PENDING return header + one return_line
-- per supplied dispatch line. NO stock movement (pending only reserves ceiling).
-- p_lines: JSONB array of
--   { dispatch_line_id, returned_qty, reason_code, condition_code, notes? }
--
-- Lock order (canonical): dispatches (first; mutual-exclusion boundary) ->
--   [insert header: uq_return_active_per_delivery serialises active returns] ->
--   per line: delivery_confirmation_lines FOR UPDATE (ceiling computed here).
-- Direction-2 exclusion: dispatch must be 'recorded' (not voided).
-- ============================================================
CREATE OR REPLACE FUNCTION public.create_return(
  p_delivery_confirmation_id UUID,
  p_quarantine_location_id   UUID,
  p_lines                    JSONB,
  p_reason_summary           TEXT DEFAULT NULL
)
RETURNS public.returns
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid        UUID := auth.uid();
  v_actor      UUID;
  v_delivery   public.delivery_confirmations;
  v_dispatch   public.dispatches;
  v_order      public.sales_orders;
  v_number     TEXT;
  v_header     public.returns;
  v_elem       JSONB;
  v_dline_id   UUID;
  v_qty        INTEGER;
  v_reason     TEXT;
  v_condition  TEXT;
  v_dcl        public.delivery_confirmation_lines;
  v_dline      public.dispatch_lines;
  v_prev       INTEGER;
  v_ceiling    INTEGER;
BEGIN
  -- (auth)
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated.' USING ERRCODE='raise_exception'; END IF;

  -- p_lines must be a non-empty array.
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'Return lines must be a non-empty array.' USING ERRCODE='raise_exception';
  END IF;

  -- NON-LOCKING resolve: read the delivery to discover the dispatch_id.
  SELECT * INTO v_delivery FROM public.delivery_confirmations WHERE id = p_delivery_confirmation_id;
  IF v_delivery.id IS NULL THEN
    RAISE EXCEPTION 'Delivery confirmation % not found.', p_delivery_confirmation_id USING ERRCODE='raise_exception';
  END IF;

  -- LOCK 1 (canonical first): the dispatch row — mutual-exclusion boundary.
  SELECT * INTO v_dispatch FROM public.dispatches WHERE id = v_delivery.dispatch_id FOR UPDATE;
  IF v_dispatch.id IS NULL THEN
    RAISE EXCEPTION 'Dispatch for delivery % not found.', p_delivery_confirmation_id USING ERRCODE='raise_exception';
  END IF;

  -- Authorisation (org derived from the locked dispatch row).
  v_actor := public.assert_return_create_actor(v_dispatch.org_id);

  -- Re-read the delivery (state may have changed before we held the lock) and
  -- assert it is a CONFIRMED delivery (Decision D).
  SELECT * INTO v_delivery FROM public.delivery_confirmations WHERE id = p_delivery_confirmation_id;
  IF v_delivery.status NOT IN ('delivered','delivered_with_variance') THEN
    RAISE EXCEPTION 'A return can only be created against a confirmed delivery (status is "%").', v_delivery.status USING ERRCODE='raise_exception';
  END IF;

  -- Direction-2 mutual exclusion: a voided dispatch has already had its stock
  -- restored by reversal; a return against it would double-credit.
  IF v_dispatch.status <> 'recorded' THEN
    RAISE EXCEPTION 'Dispatch % is not in a recorded state (status "%") and cannot accept a return.', v_dispatch.dispatch_number, v_dispatch.status USING ERRCODE='raise_exception';
  END IF;

  -- Quarantine location must exist, be same-org, and be ACTIVE (Decision E +
  -- inactive-location hardening, matching 041/042/043/048). Trigger also enforces
  -- this; the friendly check comes first.
  IF NOT EXISTS (SELECT 1 FROM public.stock_locations sl
                 WHERE sl.id = p_quarantine_location_id AND sl.org_id = v_dispatch.org_id) THEN
    RAISE EXCEPTION 'Quarantine location % is invalid or not in this organisation.', p_quarantine_location_id USING ERRCODE='raise_exception';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.stock_locations sl
                 WHERE sl.id = p_quarantine_location_id AND sl.org_id = v_dispatch.org_id AND sl.is_active) THEN
    RAISE EXCEPTION 'The quarantine stock location is inactive and cannot be used.' USING ERRCODE='raise_exception';
  END IF;

  -- Resolve the order (for the customer snapshot).
  SELECT * INTO v_order FROM public.sales_orders WHERE id = v_dispatch.sales_order_id;
  IF v_order.id IS NULL THEN
    RAISE EXCEPTION 'Sales order for dispatch % not found.', v_dispatch.dispatch_number USING ERRCODE='raise_exception';
  END IF;

  -- Friendly pre-check for an existing ACTIVE return (the partial unique index
  -- is the hard guard against races).
  IF EXISTS (SELECT 1 FROM public.returns
             WHERE delivery_confirmation_id = v_delivery.id
               AND status IN ('pending','received')) THEN
    RAISE EXCEPTION 'This delivery already has an active return.' USING ERRCODE='raise_exception';
  END IF;

  v_number := public.next_return_number(v_dispatch.org_id);

  -- Insert the header (status pending). The partial unique index enforces
  -- at-most-one active return per delivery even under a concurrent race.
  INSERT INTO public.returns
    (org_id, owner_id, return_number, status, delivery_confirmation_id, dispatch_id,
     sales_order_id, customer_id, quarantine_location_id, reason_summary)
  VALUES
    (v_dispatch.org_id, v_actor, v_number, 'pending', v_delivery.id, v_dispatch.id,
     v_order.id, v_order.customer_id, p_quarantine_location_id,
     NULLIF(btrim(COALESCE(p_reason_summary,'')), ''))
  RETURNING * INTO v_header;

  -- One return_line per supplied dispatch line, in deterministic order.
  FOR v_elem IN
    SELECT value FROM jsonb_array_elements(p_lines) AS t(value)
    ORDER BY (value ->> 'dispatch_line_id')
  LOOP
    IF jsonb_typeof(v_elem) <> 'object'
       OR NOT (v_elem ? 'dispatch_line_id') OR NOT (v_elem ? 'returned_qty')
       OR NOT (v_elem ? 'reason_code') OR NOT (v_elem ? 'condition_code') THEN
      RAISE EXCEPTION 'Each return line needs dispatch_line_id, returned_qty, reason_code and condition_code.' USING ERRCODE='raise_exception';
    END IF;

    v_dline_id := (v_elem ->> 'dispatch_line_id')::UUID;
    IF jsonb_typeof(v_elem -> 'returned_qty') <> 'number' THEN
      RAISE EXCEPTION 'returned_qty must be an integer.' USING ERRCODE='raise_exception';
    END IF;
    v_qty := (v_elem ->> 'returned_qty')::INTEGER;
    IF v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'returned_qty must be a positive integer (got %).', v_qty USING ERRCODE='raise_exception';
    END IF;
    v_reason    := upper(btrim(COALESCE(v_elem ->> 'reason_code','')));
    v_condition := upper(btrim(COALESCE(v_elem ->> 'condition_code','')));
    IF v_reason = '' OR v_reason NOT IN ('CUSTOMER_CANCELLED','ORDER_ERROR','DAMAGED_IN_TRANSIT','QUALITY_COMPLAINT','LABELLING_ERROR','EXPIRED_OR_AGED','OTHER') THEN
      RAISE EXCEPTION 'Invalid reason_code "%".', v_reason USING ERRCODE='raise_exception';
    END IF;
    IF v_condition = '' OR v_condition NOT IN ('SELLABLE','DAMAGED','LABEL_DAMAGED','OPENED','SUSPECT_QUALITY','UNKNOWN') THEN
      RAISE EXCEPTION 'Invalid condition_code "%".', v_condition USING ERRCODE='raise_exception';
    END IF;

    -- Dispatch line must belong to this dispatch.
    SELECT * INTO v_dline FROM public.dispatch_lines WHERE id = v_dline_id;
    IF v_dline.id IS NULL OR v_dline.dispatch_id <> v_dispatch.id THEN
      RAISE EXCEPTION 'Dispatch line % is not part of this delivery''s dispatch.', v_dline_id USING ERRCODE='raise_exception';
    END IF;

    -- LOCK: the delivery confirmation line for this dispatch line (ceiling authority).
    SELECT * INTO v_dcl FROM public.delivery_confirmation_lines
    WHERE delivery_confirmation_id = v_delivery.id AND dispatch_line_id = v_dline_id
    FOR UPDATE;
    IF v_dcl.id IS NULL THEN
      RAISE EXCEPTION 'No delivery confirmation line for dispatch line % in this delivery.', v_dline_id USING ERRCODE='raise_exception';
    END IF;
    IF v_dcl.delivered_qty <= 0 THEN
      RAISE EXCEPTION 'Nothing was delivered for dispatch line % — nothing can be returned.', v_dline_id USING ERRCODE='raise_exception';
    END IF;

    -- Decision H — cumulative over-return ceiling across all NON-CANCELLED returns.
    SELECT COALESCE(SUM(rl.returned_qty), 0) INTO v_prev
    FROM public.return_lines rl
    JOIN public.returns r ON r.id = rl.return_id
    WHERE rl.dispatch_line_id = v_dline_id
      AND r.status <> 'cancelled'
      AND rl.return_id <> v_header.id;   -- exclude the line we are about to add
    v_ceiling := v_dcl.delivered_qty - v_prev;
    IF v_qty > v_ceiling THEN
      RAISE EXCEPTION 'Return exceeds the returnable quantity for dispatch line %: % returnable, % requested.', v_dline_id, v_ceiling, v_qty USING ERRCODE='raise_exception';
    END IF;

    INSERT INTO public.return_lines
      (org_id, owner_id, return_id, dispatch_line_id, delivery_confirmation_line_id,
       finished_product_id, returned_qty, reason_code, condition_code, disposition,
       disposition_qty, notes)
    VALUES
      (v_dispatch.org_id, v_actor, v_header.id, v_dline_id, v_dcl.id,
       v_dline.finished_product_id, v_qty, v_reason, v_condition, 'awaiting_inspection',
       0, NULLIF(btrim(COALESCE(v_elem ->> 'notes','')), ''));
  END LOOP;

  RETURN v_header;
END;
$$;
REVOKE ALL ON FUNCTION public.create_return(UUID, UUID, JSONB, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_return(UUID, UUID, JSONB, TEXT) TO authenticated;

-- ============================================================
-- 12. receive_return — atomic + idempotent. Moves pending -> received, emits one
-- return_in per line into the quarantine location, and adds that quantity to the
-- quarantine stock_items row. Idempotency guard: the pending->received transition
-- (committed under the return-row lock). A retry sees 'received' and fails cleanly
-- WITHOUT a second return_in.
--
-- Lock order: dispatches (first) -> returns -> per line (ORDER BY id):
--   delivery_confirmation_lines (re-assert ceiling) -> stock_items (quarantine).
-- ============================================================
CREATE OR REPLACE FUNCTION public.receive_return(p_return_id UUID)
RETURNS public.returns
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid       UUID := auth.uid();
  v_actor     UUID;
  v_header    public.returns;
  v_dispatch  public.dispatches;
  v_line      public.return_lines;
  v_dcl       public.delivery_confirmation_lines;
  v_prev      INTEGER;
  v_ceiling   INTEGER;
  v_item      public.stock_items;
  v_received  TIMESTAMPTZ := NOW();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated.' USING ERRCODE='raise_exception'; END IF;

  -- NON-LOCKING resolve: read the return to discover the dispatch_id.
  SELECT * INTO v_header FROM public.returns WHERE id = p_return_id;
  IF v_header.id IS NULL THEN
    RAISE EXCEPTION 'Return % not found.', p_return_id USING ERRCODE='raise_exception';
  END IF;

  -- LOCK 1 (canonical first): dispatch row.
  SELECT * INTO v_dispatch FROM public.dispatches WHERE id = v_header.dispatch_id FOR UPDATE;
  IF v_dispatch.id IS NULL THEN
    RAISE EXCEPTION 'Dispatch for return % not found.', p_return_id USING ERRCODE='raise_exception';
  END IF;

  v_actor := public.assert_return_physical_actor(v_dispatch.org_id);

  -- LOCK 2: the return header; re-read under the lock (idempotency guard).
  SELECT * INTO v_header FROM public.returns WHERE id = p_return_id FOR UPDATE;
  IF v_header.status <> 'pending' THEN
    RAISE EXCEPTION 'Only a pending return can be received (status is "%").', v_header.status USING ERRCODE='raise_exception';
  END IF;

  -- The dispatch must still be recorded (defence against a concurrent reversal).
  IF v_dispatch.status <> 'recorded' THEN
    RAISE EXCEPTION 'Dispatch % is not in a recorded state and the return cannot be received.', v_dispatch.dispatch_number USING ERRCODE='raise_exception';
  END IF;

  -- Must have at least one line.
  IF NOT EXISTS (SELECT 1 FROM public.return_lines WHERE return_id = v_header.id) THEN
    RAISE EXCEPTION 'This return has no lines.' USING ERRCODE='raise_exception';
  END IF;

  FOR v_line IN
    SELECT * FROM public.return_lines WHERE return_id = v_header.id ORDER BY id
  LOOP
    -- Re-assert the ceiling under lock (defence-in-depth against any change
    -- since create). Exclude THIS return's own lines from the prior sum.
    SELECT * INTO v_dcl FROM public.delivery_confirmation_lines
    WHERE id = v_line.delivery_confirmation_line_id FOR UPDATE;
    IF v_dcl.id IS NULL THEN
      RAISE EXCEPTION 'Delivery confirmation line % not found.', v_line.delivery_confirmation_line_id USING ERRCODE='raise_exception';
    END IF;
    SELECT COALESCE(SUM(rl.returned_qty), 0) INTO v_prev
    FROM public.return_lines rl
    JOIN public.returns r ON r.id = rl.return_id
    WHERE rl.dispatch_line_id = v_line.dispatch_line_id
      AND r.status <> 'cancelled'
      AND rl.return_id <> v_header.id;
    v_ceiling := v_dcl.delivered_qty - v_prev;
    IF v_line.returned_qty > v_ceiling THEN
      RAISE EXCEPTION 'Return line for dispatch line % exceeds the returnable quantity (% returnable, % on this return).', v_line.dispatch_line_id, v_ceiling, v_line.returned_qty USING ERRCODE='raise_exception';
    END IF;

    -- Lock/upsert the quarantine stock_items row and add the returned quantity.
    SELECT * INTO v_item FROM public.stock_items
    WHERE org_id = v_header.org_id
      AND product_id = v_line.finished_product_id
      AND location_id = v_header.quarantine_location_id
    FOR UPDATE;
    IF v_item.id IS NULL THEN
      INSERT INTO public.stock_items (org_id, owner_id, product_id, location_id, qty_bottles)
      VALUES (v_header.org_id, v_actor, v_line.finished_product_id, v_header.quarantine_location_id, 0)
      RETURNING * INTO v_item;
      -- Re-lock the freshly-created row to keep a consistent lock discipline.
      SELECT * INTO v_item FROM public.stock_items WHERE id = v_item.id FOR UPDATE;
    END IF;

    UPDATE public.stock_items
       SET qty_bottles = qty_bottles + v_line.returned_qty
     WHERE id = v_item.id;

    INSERT INTO public.stock_movements
      (org_id, owner_id, stock_item_id, product_id, location_id, movement_type,
       qty_bottles_delta, reference_type, reference_id, transfer_group_id, notes, occurred_at)
    VALUES
      (v_header.org_id, v_actor, v_item.id, v_line.finished_product_id, v_header.quarantine_location_id, 'return_in',
       v_line.returned_qty, 'return_line', v_line.id, NULL,
       format('Return %s received into quarantine', v_header.return_number), v_received);
  END LOOP;

  UPDATE public.returns
     SET status = 'received', received_at = v_received
   WHERE id = v_header.id
   RETURNING * INTO v_header;

  RETURN v_header;
END;
$$;
REVOKE ALL ON FUNCTION public.receive_return(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.receive_return(UUID) TO authenticated;

-- ============================================================
-- 13. inspect_return_line — optional attestation step. Updates condition_code
-- and/or notes on a line of a RECEIVED return that is still awaiting_inspection.
-- No stock change, no disposition.
-- Lock order: dispatches -> returns -> return_lines.
-- ============================================================
CREATE OR REPLACE FUNCTION public.inspect_return_line(
  p_return_line_id UUID,
  p_condition_code TEXT DEFAULT NULL,
  p_notes          TEXT DEFAULT NULL
)
RETURNS public.return_lines
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid      UUID := auth.uid();
  v_actor    UUID;
  v_line     public.return_lines;
  v_header   public.returns;
  v_dispatch public.dispatches;
  v_cond     TEXT;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated.' USING ERRCODE='raise_exception'; END IF;

  -- NON-LOCKING resolve: line -> return -> dispatch_id.
  SELECT * INTO v_line FROM public.return_lines WHERE id = p_return_line_id;
  IF v_line.id IS NULL THEN RAISE EXCEPTION 'Return line % not found.', p_return_line_id USING ERRCODE='raise_exception'; END IF;
  SELECT * INTO v_header FROM public.returns WHERE id = v_line.return_id;

  -- LOCK 1: dispatch.
  SELECT * INTO v_dispatch FROM public.dispatches WHERE id = v_header.dispatch_id FOR UPDATE;
  v_actor := public.assert_return_physical_actor(v_dispatch.org_id);

  -- LOCK 2: return header; LOCK 3: the line.
  SELECT * INTO v_header FROM public.returns WHERE id = v_line.return_id FOR UPDATE;
  IF v_header.status <> 'received' THEN
    RAISE EXCEPTION 'Lines can only be inspected on a received return (status is "%").', v_header.status USING ERRCODE='raise_exception';
  END IF;
  SELECT * INTO v_line FROM public.return_lines WHERE id = p_return_line_id FOR UPDATE;
  IF v_line.disposition <> 'awaiting_inspection' THEN
    RAISE EXCEPTION 'This line already has a disposition (%); it cannot be inspected.', v_line.disposition USING ERRCODE='raise_exception';
  END IF;

  v_cond := upper(btrim(COALESCE(p_condition_code,'')));
  IF v_cond <> '' AND v_cond NOT IN ('SELLABLE','DAMAGED','LABEL_DAMAGED','OPENED','SUSPECT_QUALITY','UNKNOWN') THEN
    RAISE EXCEPTION 'Invalid condition_code "%".', v_cond USING ERRCODE='raise_exception';
  END IF;

  UPDATE public.return_lines
     SET condition_code = CASE WHEN v_cond = '' THEN condition_code ELSE v_cond END,
         notes = COALESCE(NULLIF(btrim(COALESCE(p_notes,'')), ''), notes)
   WHERE id = v_line.id
   RETURNING * INTO v_line;

  RETURN v_line;
END;
$$;
REVOKE ALL ON FUNCTION public.inspect_return_line(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.inspect_return_line(UUID, TEXT, TEXT) TO authenticated;

-- ============================================================
-- 14. restock_return_line — atomic + idempotent. Moves bottles from quarantine
-- back to a sellable location via the EXISTING transfer_out + transfer_in pair
-- (Decision G), both sharing ONE transfer_group_id and both referencing the
-- return line. Idempotency guard: disposition awaiting_inspection -> restocked.
--
-- Lock order: dispatches -> returns -> return_lines -> stock_items x2
--   (quarantine + destination, locked in ascending id order to avoid cross-deadlock).
-- Whole-line only (Decision L): disposition_qty = returned_qty.
-- ============================================================
CREATE OR REPLACE FUNCTION public.restock_return_line(
  p_return_line_id    UUID,
  p_restock_location_id UUID
)
RETURNS public.return_lines
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid       UUID := auth.uid();
  v_actor     UUID;
  v_line      public.return_lines;
  v_header    public.returns;
  v_dispatch  public.dispatches;
  v_group     UUID := gen_random_uuid();
  v_q_item    public.stock_items;   -- quarantine source
  v_d_item    public.stock_items;   -- destination
  v_first_id  UUID;
  v_second_id UUID;
  v_moved_at  TIMESTAMPTZ := NOW();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated.' USING ERRCODE='raise_exception'; END IF;

  -- NON-LOCKING resolve.
  SELECT * INTO v_line FROM public.return_lines WHERE id = p_return_line_id;
  IF v_line.id IS NULL THEN RAISE EXCEPTION 'Return line % not found.', p_return_line_id USING ERRCODE='raise_exception'; END IF;
  SELECT * INTO v_header FROM public.returns WHERE id = v_line.return_id;

  -- LOCK 1: dispatch.
  SELECT * INTO v_dispatch FROM public.dispatches WHERE id = v_header.dispatch_id FOR UPDATE;
  v_actor := public.assert_return_physical_actor(v_dispatch.org_id);

  -- LOCK 2: return; LOCK 3: line (idempotency guard).
  SELECT * INTO v_header FROM public.returns WHERE id = v_line.return_id FOR UPDATE;
  IF v_header.status <> 'received' THEN
    RAISE EXCEPTION 'Lines can only be restocked on a received return (status is "%").', v_header.status USING ERRCODE='raise_exception';
  END IF;
  SELECT * INTO v_line FROM public.return_lines WHERE id = p_return_line_id FOR UPDATE;
  IF v_line.disposition <> 'awaiting_inspection' THEN
    RAISE EXCEPTION 'This line already has a disposition (%).', v_line.disposition USING ERRCODE='raise_exception';
  END IF;

  -- Destination location must exist + be same-org, and must NOT be the quarantine
  -- location (restock moves goods OUT of quarantine).
  IF NOT EXISTS (SELECT 1 FROM public.stock_locations sl WHERE sl.id = p_restock_location_id AND sl.org_id = v_header.org_id) THEN
    RAISE EXCEPTION 'Restock location % is invalid or not in this organisation.', p_restock_location_id USING ERRCODE='raise_exception';
  END IF;
  -- Destination must be ACTIVE (inactive-location hardening, matching 041/042/043/048).
  IF NOT EXISTS (SELECT 1 FROM public.stock_locations sl WHERE sl.id = p_restock_location_id AND sl.org_id = v_header.org_id AND sl.is_active) THEN
    RAISE EXCEPTION 'The destination stock location is inactive and cannot be used.' USING ERRCODE='raise_exception';
  END IF;
  IF p_restock_location_id = v_header.quarantine_location_id THEN
    RAISE EXCEPTION 'Restock location must differ from the quarantine location.' USING ERRCODE='raise_exception';
  END IF;

  -- Ensure both stock_items rows exist, then lock them in ascending id order.
  SELECT * INTO v_q_item FROM public.stock_items
   WHERE org_id = v_header.org_id AND product_id = v_line.finished_product_id
     AND location_id = v_header.quarantine_location_id;
  IF v_q_item.id IS NULL THEN
    RAISE EXCEPTION 'No quarantine stock exists for this product — the return was not received.' USING ERRCODE='raise_exception';
  END IF;
  SELECT * INTO v_d_item FROM public.stock_items
   WHERE org_id = v_header.org_id AND product_id = v_line.finished_product_id
     AND location_id = p_restock_location_id;
  IF v_d_item.id IS NULL THEN
    INSERT INTO public.stock_items (org_id, owner_id, product_id, location_id, qty_bottles)
    VALUES (v_header.org_id, v_actor, v_line.finished_product_id, p_restock_location_id, 0)
    RETURNING * INTO v_d_item;
  END IF;

  -- Deterministic lock order on the two stock_items rows (ascending id).
  IF v_q_item.id <= v_d_item.id THEN v_first_id := v_q_item.id; v_second_id := v_d_item.id;
  ELSE v_first_id := v_d_item.id; v_second_id := v_q_item.id; END IF;
  PERFORM 1 FROM public.stock_items WHERE id = v_first_id FOR UPDATE;
  PERFORM 1 FROM public.stock_items WHERE id = v_second_id FOR UPDATE;
  -- Refresh row snapshots after locking.
  SELECT * INTO v_q_item FROM public.stock_items WHERE id = v_q_item.id;
  SELECT * INTO v_d_item FROM public.stock_items WHERE id = v_d_item.id;

  IF v_q_item.qty_bottles < v_line.returned_qty THEN
    RAISE EXCEPTION 'Insufficient quarantine stock to restock (% available, % required).', v_q_item.qty_bottles, v_line.returned_qty USING ERRCODE='raise_exception';
  END IF;

  -- transfer_out from quarantine.
  UPDATE public.stock_items SET qty_bottles = qty_bottles - v_line.returned_qty WHERE id = v_q_item.id;
  INSERT INTO public.stock_movements
    (org_id, owner_id, stock_item_id, product_id, location_id, movement_type,
     qty_bottles_delta, reference_type, reference_id, transfer_group_id, notes, occurred_at)
  VALUES
    (v_header.org_id, v_actor, v_q_item.id, v_line.finished_product_id, v_header.quarantine_location_id, 'transfer_out',
     -v_line.returned_qty, 'return_line', v_line.id, v_group,
     format('Return %s restock out of quarantine', v_header.return_number), v_moved_at);

  -- transfer_in to destination (same transfer_group_id, same reference).
  UPDATE public.stock_items SET qty_bottles = qty_bottles + v_line.returned_qty WHERE id = v_d_item.id;
  INSERT INTO public.stock_movements
    (org_id, owner_id, stock_item_id, product_id, location_id, movement_type,
     qty_bottles_delta, reference_type, reference_id, transfer_group_id, notes, occurred_at)
  VALUES
    (v_header.org_id, v_actor, v_d_item.id, v_line.finished_product_id, p_restock_location_id, 'transfer_in',
     v_line.returned_qty, 'return_line', v_line.id, v_group,
     format('Return %s restock into sellable location', v_header.return_number), v_moved_at);

  UPDATE public.return_lines
     SET disposition = 'restocked',
         disposition_qty = returned_qty,
         restock_location_id = p_restock_location_id,
         restock_transfer_group_id = v_group
   WHERE id = v_line.id
   RETURNING * INTO v_line;

  RETURN v_line;
END;
$$;
REVOKE ALL ON FUNCTION public.restock_return_line(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.restock_return_line(UUID, UUID) TO authenticated;

-- ============================================================
-- 15. writeoff_return_line — atomic + idempotent. Removes bottles from physical
-- inventory via ONE return_writeoff movement from quarantine. Idempotency guard:
-- disposition awaiting_inspection -> written_off.
-- Lock order: dispatches -> returns -> return_lines -> stock_items (quarantine).
-- ============================================================
CREATE OR REPLACE FUNCTION public.writeoff_return_line(
  p_return_line_id UUID,
  p_reason         TEXT DEFAULT NULL
)
RETURNS public.return_lines
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid      UUID := auth.uid();
  v_actor    UUID;
  v_line     public.return_lines;
  v_header   public.returns;
  v_dispatch public.dispatches;
  v_item     public.stock_items;
  v_at       TIMESTAMPTZ := NOW();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated.' USING ERRCODE='raise_exception'; END IF;

  SELECT * INTO v_line FROM public.return_lines WHERE id = p_return_line_id;
  IF v_line.id IS NULL THEN RAISE EXCEPTION 'Return line % not found.', p_return_line_id USING ERRCODE='raise_exception'; END IF;
  SELECT * INTO v_header FROM public.returns WHERE id = v_line.return_id;

  SELECT * INTO v_dispatch FROM public.dispatches WHERE id = v_header.dispatch_id FOR UPDATE;
  v_actor := public.assert_return_physical_actor(v_dispatch.org_id);

  SELECT * INTO v_header FROM public.returns WHERE id = v_line.return_id FOR UPDATE;
  IF v_header.status <> 'received' THEN
    RAISE EXCEPTION 'Lines can only be written off on a received return (status is "%").', v_header.status USING ERRCODE='raise_exception';
  END IF;
  SELECT * INTO v_line FROM public.return_lines WHERE id = p_return_line_id FOR UPDATE;
  IF v_line.disposition <> 'awaiting_inspection' THEN
    RAISE EXCEPTION 'This line already has a disposition (%).', v_line.disposition USING ERRCODE='raise_exception';
  END IF;

  SELECT * INTO v_item FROM public.stock_items
   WHERE org_id = v_header.org_id AND product_id = v_line.finished_product_id
     AND location_id = v_header.quarantine_location_id
   FOR UPDATE;
  IF v_item.id IS NULL THEN
    RAISE EXCEPTION 'No quarantine stock exists for this product — the return was not received.' USING ERRCODE='raise_exception';
  END IF;
  IF v_item.qty_bottles < v_line.returned_qty THEN
    RAISE EXCEPTION 'Insufficient quarantine stock to write off (% available, % required).', v_item.qty_bottles, v_line.returned_qty USING ERRCODE='raise_exception';
  END IF;

  UPDATE public.stock_items SET qty_bottles = qty_bottles - v_line.returned_qty WHERE id = v_item.id;
  INSERT INTO public.stock_movements
    (org_id, owner_id, stock_item_id, product_id, location_id, movement_type,
     qty_bottles_delta, reference_type, reference_id, transfer_group_id, notes, occurred_at)
  VALUES
    (v_header.org_id, v_actor, v_item.id, v_line.finished_product_id, v_header.quarantine_location_id, 'return_writeoff',
     -v_line.returned_qty, 'return_line', v_line.id, NULL,
     format('Return %s write-off%s', v_header.return_number,
            COALESCE(': ' || NULLIF(btrim(COALESCE(p_reason,'')), ''), '')), v_at);

  UPDATE public.return_lines
     SET disposition = 'written_off',
         disposition_qty = returned_qty,
         notes = COALESCE(NULLIF(btrim(COALESCE(p_reason,'')), ''), notes)
   WHERE id = v_line.id
   RETURNING * INTO v_line;

  RETURN v_line;
END;
$$;
REVOKE ALL ON FUNCTION public.writeoff_return_line(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.writeoff_return_line(UUID, TEXT) TO authenticated;

-- ============================================================
-- 16. close_return — atomic + idempotent. Moves received -> closed once EVERY
-- line has a terminal disposition (restocked / written_off). No stock change.
-- Lock order: dispatches -> returns.
-- ============================================================
CREATE OR REPLACE FUNCTION public.close_return(p_return_id UUID)
RETURNS public.returns
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid       UUID := auth.uid();
  v_actor     UUID;
  v_header    public.returns;
  v_dispatch  public.dispatches;
  v_open      INTEGER;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated.' USING ERRCODE='raise_exception'; END IF;

  SELECT * INTO v_header FROM public.returns WHERE id = p_return_id;
  IF v_header.id IS NULL THEN RAISE EXCEPTION 'Return % not found.', p_return_id USING ERRCODE='raise_exception'; END IF;

  SELECT * INTO v_dispatch FROM public.dispatches WHERE id = v_header.dispatch_id FOR UPDATE;
  v_actor := public.assert_return_physical_actor(v_dispatch.org_id);

  SELECT * INTO v_header FROM public.returns WHERE id = p_return_id FOR UPDATE;
  IF v_header.status <> 'received' THEN
    RAISE EXCEPTION 'Only a received return can be closed (status is "%").', v_header.status USING ERRCODE='raise_exception';
  END IF;

  SELECT COUNT(*) INTO v_open FROM public.return_lines
   WHERE return_id = v_header.id AND disposition = 'awaiting_inspection';
  IF v_open > 0 THEN
    RAISE EXCEPTION 'Cannot close: % line(s) still awaiting disposition.', v_open USING ERRCODE='raise_exception';
  END IF;

  UPDATE public.returns SET status = 'closed', closed_at = NOW()
   WHERE id = v_header.id RETURNING * INTO v_header;
  RETURN v_header;
END;
$$;
REVOKE ALL ON FUNCTION public.close_return(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.close_return(UUID) TO authenticated;

-- ============================================================
-- 17. cancel_return — atomic. PENDING only (Decision J): no return_in has run,
-- so there is nothing to compensate; cancelling simply drops this return's lines
-- out of every future ceiling sum (the sum excludes status='cancelled'). A
-- received return cannot be cancelled — it must be worked to closed. OWNER/ADMIN.
-- Lock order: dispatches -> returns.
-- ============================================================
CREATE OR REPLACE FUNCTION public.cancel_return(
  p_return_id UUID,
  p_reason    TEXT
)
RETURNS public.returns
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid       UUID := auth.uid();
  v_actor     UUID;
  v_header    public.returns;
  v_dispatch  public.dispatches;
  v_reason    TEXT;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated.' USING ERRCODE='raise_exception'; END IF;

  v_reason := btrim(COALESCE(p_reason,''));
  IF v_reason = '' THEN RAISE EXCEPTION 'A cancellation reason is required.' USING ERRCODE='raise_exception'; END IF;

  SELECT * INTO v_header FROM public.returns WHERE id = p_return_id;
  IF v_header.id IS NULL THEN RAISE EXCEPTION 'Return % not found.', p_return_id USING ERRCODE='raise_exception'; END IF;

  SELECT * INTO v_dispatch FROM public.dispatches WHERE id = v_header.dispatch_id FOR UPDATE;
  v_actor := public.assert_return_admin_actor(v_dispatch.org_id);

  SELECT * INTO v_header FROM public.returns WHERE id = p_return_id FOR UPDATE;
  IF v_header.status <> 'pending' THEN
    RAISE EXCEPTION 'Only a pending return can be cancelled (status is "%"). A received return must be processed to closure.', v_header.status USING ERRCODE='raise_exception';
  END IF;

  UPDATE public.returns
     SET status = 'cancelled', cancelled_at = NOW(), cancel_reason = v_reason
   WHERE id = v_header.id RETURNING * INTO v_header;
  RETURN v_header;
END;
$$;
REVOKE ALL ON FUNCTION public.cancel_return(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_return(UUID, TEXT) TO authenticated;

-- ============================================================
-- 18. reverse_dispatch — RE-CREATED with ONE added guard (Direction-1 mutual
-- exclusion): a NON-CANCELLED return (pending/received/closed) against the
-- dispatch blocks reversal. Everything else is IDENTICAL to the 055 version:
-- signature, return columns, SECURITY DEFINER, pinned search_path, roles
-- (OWNER/ADMIN/CELLAR via assert_dispatch_reversal_actor), lock order
-- (dispatches -> sales_orders -> stock_allocations -> stock_items), stock/
-- allocation/order behaviour, the existing P2M-5 confirmed-delivery guard, audit,
-- and idempotency (recorded -> voided). The dispatch row is locked FIRST, which
-- is the shared mutual-exclusion boundary with the return RPCs.
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

  -- P2M-5 GUARD (preserved from 055): a CONFIRMED delivery blocks reversal.
  -- failed / cancelled deliveries do NOT block it.
  IF EXISTS (
    SELECT 1 FROM public.delivery_confirmations dc
    WHERE dc.dispatch_id = v_dispatch.id
      AND dc.status IN ('delivered','delivered_with_variance')
  ) THEN
    RAISE EXCEPTION 'Dispatch % has a confirmed delivery and cannot be reversed.', v_dispatch.dispatch_number USING ERRCODE = 'raise_exception';
  END IF;

  -- P2M-6 GUARD (the ONLY addition vs 055): a NON-CANCELLED return blocks
  -- reversal. pending/received/closed block; cancelled does NOT. Read under the
  -- dispatch-row lock held above, so it is race-free against create_return /
  -- receive_return (which take the same dispatch lock first).
  IF EXISTS (
    SELECT 1 FROM public.returns r
    WHERE r.dispatch_id = v_dispatch.id
      AND r.status IN ('pending','received','closed')
  ) THEN
    RAISE EXCEPTION 'Dispatch % has an active or completed return and cannot be reversed.', v_dispatch.dispatch_number USING ERRCODE = 'raise_exception';
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
-- 19. POST-VALIDATION (catalog checks). RAISE => rollback. No seed data.
-- ============================================================
DO $$
DECLARE
  n INTEGER; rls_on BOOLEAN; v_oid OID; v_secdef BOOLEAN; v_cfg TEXT[]; v_path BOOLEAN;
BEGIN
  -- Tables exist.
  IF to_regclass('public.returns') IS NULL THEN RAISE EXCEPTION 'Post: returns missing.' USING ERRCODE='raise_exception'; END IF;
  IF to_regclass('public.return_lines') IS NULL THEN RAISE EXCEPTION 'Post: return_lines missing.' USING ERRCODE='raise_exception'; END IF;
  IF to_regclass('public.return_sequences') IS NULL THEN RAISE EXCEPTION 'Post: return_sequences missing.' USING ERRCODE='raise_exception'; END IF;

  -- Movement vocabulary extended + nothing lost.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='stock_movements_type_check'
      AND pg_get_constraintdef(oid) ILIKE '%return_in%' AND pg_get_constraintdef(oid) ILIKE '%return_writeoff%') THEN
    RAISE EXCEPTION 'Post: stock_movements_type_check must allow return_in + return_writeoff.' USING ERRCODE='raise_exception'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='stock_movements_type_check'
      AND pg_get_constraintdef(oid) ILIKE '%receipt%' AND pg_get_constraintdef(oid) ILIKE '%dispatch%'
      AND pg_get_constraintdef(oid) ILIKE '%dispatch_reversal%' AND pg_get_constraintdef(oid) ILIKE '%transfer_in%'
      AND pg_get_constraintdef(oid) ILIKE '%transfer_out%' AND pg_get_constraintdef(oid) ILIKE '%adjustment%'
      AND pg_get_constraintdef(oid) ILIKE '%damage%' AND pg_get_constraintdef(oid) ILIKE '%sale%') THEN
    RAISE EXCEPTION 'Post: stock_movements_type_check lost a pre-existing value.' USING ERRCODE='raise_exception'; END IF;

  -- returns: status CHECK vocabulary.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='return_status_check'
      AND pg_get_constraintdef(oid) ILIKE '%pending%' AND pg_get_constraintdef(oid) ILIKE '%received%'
      AND pg_get_constraintdef(oid) ILIKE '%closed%' AND pg_get_constraintdef(oid) ILIKE '%cancelled%') THEN
    RAISE EXCEPTION 'Post: return_status_check vocabulary incomplete.' USING ERRCODE='raise_exception'; END IF;

  -- returns: unique number + partial active-return index.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='uq_return_number_per_org' AND contype='u') THEN
    RAISE EXCEPTION 'Post: uq_return_number_per_org missing.' USING ERRCODE='raise_exception'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='uq_return_active_per_delivery') THEN
    RAISE EXCEPTION 'Post: uq_return_active_per_delivery partial unique index missing.' USING ERRCODE='raise_exception'; END IF;

  -- returns: 7 FKs, all RESTRICT.
  SELECT COUNT(*) INTO n FROM information_schema.table_constraints WHERE table_schema='public' AND table_name='returns' AND constraint_type='FOREIGN KEY';
  IF n <> 7 THEN RAISE EXCEPTION 'Post: returns should have 7 FKs (%).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_constraint WHERE conrelid='public.returns'::regclass AND contype='f' AND confdeltype='r';
  IF n <> 7 THEN RAISE EXCEPTION 'Post: all returns FKs must be ON DELETE RESTRICT (% RESTRICT).', n USING ERRCODE='raise_exception'; END IF;

  -- return_lines: 7 FKs (org, owner, return, dispatch_line, delivery_line,
  -- product, restock_location); return_id CASCADE, the other 6 RESTRICT.
  SELECT COUNT(*) INTO n FROM information_schema.table_constraints WHERE table_schema='public' AND table_name='return_lines' AND constraint_type='FOREIGN KEY';
  IF n <> 7 THEN RAISE EXCEPTION 'Post: return_lines should have 7 FKs (%).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_constraint WHERE conrelid='public.return_lines'::regclass AND contype='f' AND confdeltype='c';
  IF n <> 1 THEN RAISE EXCEPTION 'Post: exactly one return_lines FK (return_id) must be ON DELETE CASCADE (%).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_constraint WHERE conrelid='public.return_lines'::regclass AND contype='f' AND confdeltype='r';
  IF n <> 6 THEN RAISE EXCEPTION 'Post: return_lines must have 6 RESTRICT FKs (%).', n USING ERRCODE='raise_exception'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_rline_return' AND confdeltype='c') THEN
    RAISE EXCEPTION 'Post: fk_rline_return must be ON DELETE CASCADE.' USING ERRCODE='raise_exception'; END IF;

  -- return_lines: code lists + disposition + coupling + bounds + unique present.
  SELECT COUNT(*) INTO n FROM pg_constraint WHERE conrelid='public.return_lines'::regclass AND contype='c'
    AND conname IN ('rline_returned_qty_positive','rline_disposition_qty_bounds','rline_reason_code_check',
                    'rline_condition_code_check','rline_disposition_check','rline_disposition_coupling');
  IF n <> 6 THEN RAISE EXCEPTION 'Post: return_lines CHECK constraints missing (%).', n USING ERRCODE='raise_exception'; END IF;
  -- Exactly the seven reason codes + six condition codes.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='rline_reason_code_check'
      AND pg_get_constraintdef(oid) ILIKE '%CUSTOMER_CANCELLED%' AND pg_get_constraintdef(oid) ILIKE '%ORDER_ERROR%'
      AND pg_get_constraintdef(oid) ILIKE '%DAMAGED_IN_TRANSIT%' AND pg_get_constraintdef(oid) ILIKE '%QUALITY_COMPLAINT%'
      AND pg_get_constraintdef(oid) ILIKE '%LABELLING_ERROR%' AND pg_get_constraintdef(oid) ILIKE '%EXPIRED_OR_AGED%'
      AND pg_get_constraintdef(oid) ILIKE '%OTHER%') THEN
    RAISE EXCEPTION 'Post: rline_reason_code_check must list the seven reason codes.' USING ERRCODE='raise_exception'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='rline_condition_code_check'
      AND pg_get_constraintdef(oid) ILIKE '%SELLABLE%' AND pg_get_constraintdef(oid) ILIKE '%DAMAGED%'
      AND pg_get_constraintdef(oid) ILIKE '%LABEL_DAMAGED%' AND pg_get_constraintdef(oid) ILIKE '%OPENED%'
      AND pg_get_constraintdef(oid) ILIKE '%SUSPECT_QUALITY%' AND pg_get_constraintdef(oid) ILIKE '%UNKNOWN%') THEN
    RAISE EXCEPTION 'Post: rline_condition_code_check must list the six condition codes.' USING ERRCODE='raise_exception'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='uq_rline_per_dispatch_line' AND contype='u') THEN
    RAISE EXCEPTION 'Post: uq_rline_per_dispatch_line missing.' USING ERRCODE='raise_exception'; END IF;

  -- RLS enabled + exactly one SELECT policy + no write policy on both tables.
  SELECT relrowsecurity INTO rls_on FROM pg_class WHERE oid='public.returns'::regclass;
  IF NOT COALESCE(rls_on,false) THEN RAISE EXCEPTION 'Post: RLS off on returns.' USING ERRCODE='raise_exception'; END IF;
  SELECT relrowsecurity INTO rls_on FROM pg_class WHERE oid='public.return_lines'::regclass;
  IF NOT COALESCE(rls_on,false) THEN RAISE EXCEPTION 'Post: RLS off on return_lines.' USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='returns';
  IF n <> 1 THEN RAISE EXCEPTION 'Post: returns must have exactly 1 policy (%).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='return_lines';
  IF n <> 1 THEN RAISE EXCEPTION 'Post: return_lines must have exactly 1 policy (%).', n USING ERRCODE='raise_exception'; END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
      AND tablename IN ('returns','return_lines','return_sequences') AND cmd IN ('INSERT','UPDATE','DELETE','ALL')) THEN
    RAISE EXCEPTION 'Post: no write policy may exist on return tables.' USING ERRCODE='raise_exception'; END IF;

  -- No direct write grants to authenticated on any return table.
  SELECT COUNT(*) INTO n FROM information_schema.role_table_grants
   WHERE table_schema='public' AND table_name IN ('returns','return_lines','return_sequences')
     AND grantee='authenticated' AND privilege_type IN ('INSERT','UPDATE','DELETE');
  IF n <> 0 THEN RAISE EXCEPTION 'Post: no direct write grant may exist on return tables (% found).', n USING ERRCODE='raise_exception'; END IF;

  -- No direct write grant to authenticated on stock tables (040 posture intact).
  SELECT COUNT(*) INTO n FROM information_schema.role_table_grants
   WHERE table_schema='public' AND table_name IN ('stock_items','stock_movements')
     AND grantee='authenticated' AND privilege_type IN ('INSERT','UPDATE','DELETE');
  IF n <> 0 THEN RAISE EXCEPTION 'Post: stock tables must not grant write to authenticated (%).', n USING ERRCODE='raise_exception'; END IF;

  -- Triggers on returns (owner immut + updated_at + org integrity + audit).
  SELECT COUNT(*) INTO n FROM pg_trigger WHERE tgrelid='public.returns'::regclass AND NOT tgisinternal
    AND tgname IN ('return_owner_id_immutable','return_updated_at','return_org_integrity','trg_audit_returns');
  IF n <> 4 THEN RAISE EXCEPTION 'Post: returns triggers mismatch (%).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_trigger WHERE tgrelid='public.return_lines'::regclass AND NOT tgisinternal
    AND tgname IN ('rline_owner_id_immutable','rline_updated_at','rline_org_integrity','trg_audit_return_lines');
  IF n <> 4 THEN RAISE EXCEPTION 'Post: return_lines triggers mismatch (%).', n USING ERRCODE='raise_exception'; END IF;

  -- Integrity fns SECURITY DEFINER + pinned path.
  FOR v_oid IN SELECT unnest(ARRAY[to_regprocedure('public.validate_return_org_integrity()'), to_regprocedure('public.validate_return_line_org_integrity()')])
  LOOP
    IF v_oid IS NULL THEN RAISE EXCEPTION 'Post: a return integrity fn is missing.' USING ERRCODE='raise_exception'; END IF;
    SELECT prosecdef INTO v_secdef FROM pg_proc WHERE oid=v_oid;
    IF NOT v_secdef THEN RAISE EXCEPTION 'Post: return integrity fn % must be SECURITY DEFINER.', v_oid::regprocedure USING ERRCODE='raise_exception'; END IF;
    SELECT proconfig INTO v_cfg FROM pg_proc WHERE oid=v_oid;
    v_path := EXISTS (SELECT 1 FROM unnest(COALESCE(v_cfg, ARRAY[]::TEXT[])) c WHERE c LIKE 'search_path=%' AND position('public' IN c)>0 AND position('pg_temp' IN c)>0);
    IF NOT v_path THEN RAISE EXCEPTION 'Post: return integrity fn % must pin search_path.', v_oid::regprocedure USING ERRCODE='raise_exception'; END IF;
  END LOOP;

  -- Audit mappings present + prior preserved.
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.audit_log_row_change()'::regprocedure
      AND pg_get_functiondef(oid) ILIKE '%''return''%'
      AND pg_get_functiondef(oid) ILIKE '%''return_line''%'
      AND pg_get_functiondef(oid) ILIKE '%''delivery_confirmation''%'
      AND pg_get_functiondef(oid) ILIKE '%''dispatch''%'
      AND pg_get_functiondef(oid) ILIKE '%''stock_movement''%'
      AND pg_get_functiondef(oid) ILIKE '%''stock_allocation''%') THEN
    RAISE EXCEPTION 'Post: audit writer missing return mappings or lost a prior mapping.' USING ERRCODE='raise_exception'; END IF;

  -- Each public RPC: SECURITY DEFINER, pinned path, PUBLIC revoked, authenticated granted.
  FOR v_oid IN
    SELECT unnest(ARRAY[
      to_regprocedure('public.next_return_number(uuid)'),
      to_regprocedure('public.create_return(uuid, uuid, jsonb, text)'),
      to_regprocedure('public.receive_return(uuid)'),
      to_regprocedure('public.inspect_return_line(uuid, text, text)'),
      to_regprocedure('public.restock_return_line(uuid, uuid)'),
      to_regprocedure('public.writeoff_return_line(uuid, text)'),
      to_regprocedure('public.close_return(uuid)'),
      to_regprocedure('public.cancel_return(uuid, text)')
    ])
  LOOP
    IF v_oid IS NULL THEN RAISE EXCEPTION 'Post: a return RPC is missing.' USING ERRCODE='raise_exception'; END IF;
    SELECT prosecdef INTO v_secdef FROM pg_proc WHERE oid=v_oid;
    IF NOT v_secdef THEN RAISE EXCEPTION 'Post: return RPC % must be SECURITY DEFINER.', v_oid::regprocedure USING ERRCODE='raise_exception'; END IF;
    SELECT proconfig INTO v_cfg FROM pg_proc WHERE oid=v_oid;
    v_path := EXISTS (SELECT 1 FROM unnest(COALESCE(v_cfg, ARRAY[]::TEXT[])) c WHERE c LIKE 'search_path=%' AND position('public' IN c)>0 AND position('pg_temp' IN c)>0);
    IF NOT v_path THEN RAISE EXCEPTION 'Post: return RPC % must pin search_path.', v_oid::regprocedure USING ERRCODE='raise_exception'; END IF;
    IF has_function_privilege('public', v_oid, 'EXECUTE') THEN RAISE EXCEPTION 'Post: PUBLIC must not execute %.', v_oid::regprocedure USING ERRCODE='raise_exception'; END IF;
    IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN RAISE EXCEPTION 'Post: authenticated must execute %.', v_oid::regprocedure USING ERRCODE='raise_exception'; END IF;
  END LOOP;

  -- Role guards internal (not granted to PUBLIC/authenticated).
  FOR v_oid IN SELECT unnest(ARRAY[
      to_regprocedure('public.assert_return_create_actor(uuid)'),
      to_regprocedure('public.assert_return_physical_actor(uuid)'),
      to_regprocedure('public.assert_return_admin_actor(uuid)')])
  LOOP
    IF v_oid IS NULL THEN RAISE EXCEPTION 'Post: a return role guard is missing.' USING ERRCODE='raise_exception'; END IF;
    IF has_function_privilege('public', v_oid, 'EXECUTE') OR has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'Post: return role guard % must be internal.', v_oid::regprocedure USING ERRCODE='raise_exception'; END IF;
  END LOOP;

  -- reverse_dispatch: unchanged signature + security + BOTH guards present.
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
    RAISE EXCEPTION 'Post: reverse_dispatch lost the P2M-5 confirmed-delivery guard.' USING ERRCODE='raise_exception'; END IF;
  IF pg_get_functiondef(v_oid) NOT ILIKE '%has an active or completed return and cannot be reversed%' THEN
    RAISE EXCEPTION 'Post: reverse_dispatch missing the P2M-6 return guard.' USING ERRCODE='raise_exception'; END IF;

  -- Inactive-location hardening present in all four locations (two RPCs + two
  -- integrity triggers). NOTE: this verifies the safeguard TEXT is present in the
  -- function definitions; it does NOT prove the runtime rejection behaviour — see
  -- the scratch-DB runtime tests.
  IF pg_get_functiondef('public.create_return(uuid, uuid, jsonb, text)'::regprocedure) NOT ILIKE '%quarantine stock location is inactive and cannot be used%' THEN
    RAISE EXCEPTION 'Post: create_return missing the inactive quarantine-location guard.' USING ERRCODE='raise_exception'; END IF;
  IF pg_get_functiondef('public.restock_return_line(uuid, uuid)'::regprocedure) NOT ILIKE '%destination stock location is inactive and cannot be used%' THEN
    RAISE EXCEPTION 'Post: restock_return_line missing the inactive destination-location guard.' USING ERRCODE='raise_exception'; END IF;
  IF pg_get_functiondef('public.validate_return_org_integrity()'::regprocedure) NOT ILIKE '%quarantine stock location is inactive and cannot be used%' THEN
    RAISE EXCEPTION 'Post: validate_return_org_integrity missing the inactive quarantine-location guard.' USING ERRCODE='raise_exception'; END IF;
  IF pg_get_functiondef('public.validate_return_line_org_integrity()'::regprocedure) NOT ILIKE '%destination stock location is inactive and cannot be used%' THEN
    RAISE EXCEPTION 'Post: validate_return_line_org_integrity missing the inactive restock-location guard.' USING ERRCODE='raise_exception'; END IF;

  -- No seed data in any new table.
  SELECT COUNT(*) INTO n FROM public.returns;          IF n <> 0 THEN RAISE EXCEPTION 'Post: returns must be empty (%).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM public.return_lines;     IF n <> 0 THEN RAISE EXCEPTION 'Post: return_lines must be empty (%).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM public.return_sequences; IF n <> 0 THEN RAISE EXCEPTION 'Post: return_sequences must be empty (%).', n USING ERRCODE='raise_exception'; END IF;

  -- stock_items still has no reserved/allocated column.
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='stock_items'
             AND column_name IN ('reserved_qty','allocated_qty','reserved_bottles','allocated_bottles')) THEN
    RAISE EXCEPTION 'Post: stock_items must not have a reserved/allocated column.' USING ERRCODE='raise_exception'; END IF;

  RAISE NOTICE 'Post: P2M-6a returns installed — tables, RPCs, RLS, audit, movement vocabulary, and reverse_dispatch dual guards verified.';
END $$;

COMMIT;
