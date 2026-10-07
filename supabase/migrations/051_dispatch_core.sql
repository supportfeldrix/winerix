-- ============================================================
-- WINERIX — P2M-2: Core Physical Dispatch Backend
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- Depends on: 001 (update_updated_at), 006 (organisations, is_org_member,
--             has_org_role, audit_log), 010 (prevent_owner_id_change),
--             021 (audit writer audit_log_row_change), 038 (finished_products),
--             039 (stock_locations), 040 (stock_items + stock_movements),
--             046 (sales_orders + sales_order_sequences + next_sales_order_number),
--             047 (sales_order_lines), 048 (stock_allocations + assert_sales_actor
--             + recompute_sales_order_allocation_status), 050 (cancel_sales_order).
--             After 048 the audit writer has 26 mappings; this migration -> 28.
--
-- PURPOSE:
--   Introduce PHYSICAL FULFILMENT. A dispatch records that reserved bottles have
--   physically left a location. It reduces physical stock, writes a stock_movement,
--   advances the allocation fulfilment, and advances the sales order dispatch
--   status — all atomically.
--
--     sales_orders -> sales_order_lines -> stock_allocations -> dispatches
--       -> dispatch_lines -> stock_movements
--
--   Physical stock remains authoritative in stock_items.qty_bottles.
--   Reservations remain authoritative in stock_allocations (qty_bottles immutable).
--   Physical history remains stock_movements (append-only).
--
--   P2M adds, per allocation, a monotonic fulfilled_qty (0 <= fulfilled_qty <=
--   qty_bottles). qty_bottles — the original reservation — is NEVER modified.
--
--   Writes happen ONLY through the SECURITY DEFINER RPC record_dispatch(). There
--   is NO client INSERT/UPDATE/DELETE policy on dispatches / dispatch_lines.
--
-- SCOPE — THIS MIGRATION ONLY:
--   dispatch_sequences (per org/year DISP counter) + dispatches + dispatch_lines
--   tables (+FKs/CHECKs/indexes) with append-only RLS (member SELECT only; NO
--   client write policy; SELECT grant only) + owner immutability (010) +
--   updated_at (001) + SECURITY DEFINER cross-org integrity triggers + audit
--   (add dispatch + dispatch_line mappings) + assert_dispatch_actor(uuid) guard +
--   next_dispatch_number(uuid) + recompute_sales_order_dispatch_status(uuid)
--   helper + record_dispatch(uuid, jsonb, text) RPC + the stock_allocations
--   fulfilment columns/CHECKs + the sales_orders status vocabulary extension +
--   post-validation. No seed data.
--
-- THIS MIGRATION DOES NOT:
--   * build any frontend / dispatch UI / dispatch reports
--   * implement void or correction dispatch (the 'voided' status VALUE exists for
--     forward-compat only; NO code path can set it, NO void RPC is created)
--   * implement Finance / invoices / customer payments / export-excise compliance
--   * modify unrelated P2L/P2K functionality or redesign existing architecture
--   * modify stock_allocations.qty_bottles, delete/recreate allocation rows, or
--     rewrite allocation history
--   * add reserved_qty / allocated_qty columns to stock_items
--   * change the stock_movements vocabulary ('dispatch' already exists, 040)
--   * create seed / test data
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
  IF to_regclass('public.stock_movements') IS NULL THEN RAISE EXCEPTION 'Pre-flight: stock_movements missing (040).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.sales_orders') IS NULL THEN RAISE EXCEPTION 'Pre-flight: sales_orders missing (046).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.sales_order_lines') IS NULL THEN RAISE EXCEPTION 'Pre-flight: sales_order_lines missing (047).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.stock_allocations') IS NULL THEN RAISE EXCEPTION 'Pre-flight: stock_allocations missing (048).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.audit_log') IS NULL THEN RAISE EXCEPTION 'Pre-flight: audit_log missing (006).' USING ERRCODE='undefined_table'; END IF;
  IF to_regprocedure('public.audit_log_row_change()') IS NULL THEN RAISE EXCEPTION 'Pre-flight: audit_log_row_change() missing (021).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.is_org_member(uuid)') IS NULL THEN RAISE EXCEPTION 'Pre-flight: is_org_member missing (006).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.has_org_role(uuid, text[])') IS NULL THEN RAISE EXCEPTION 'Pre-flight: has_org_role missing (006).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.prevent_owner_id_change()') IS NULL THEN RAISE EXCEPTION 'Pre-flight: prevent_owner_id_change missing (010).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.update_updated_at()') IS NULL THEN RAISE EXCEPTION 'Pre-flight: update_updated_at missing (001).' USING ERRCODE='undefined_function'; END IF;
  IF to_regclass('public.dispatches') IS NOT NULL THEN RAISE EXCEPTION 'Pre-flight: dispatches already exists.' USING ERRCODE='duplicate_table'; END IF;
  IF to_regclass('public.dispatch_lines') IS NOT NULL THEN RAISE EXCEPTION 'Pre-flight: dispatch_lines already exists.' USING ERRCODE='duplicate_table'; END IF;
  IF to_regclass('public.dispatch_sequences') IS NOT NULL THEN RAISE EXCEPTION 'Pre-flight: dispatch_sequences already exists.' USING ERRCODE='duplicate_table'; END IF;
  -- stock_items must never gain a reserved/allocated column (ledger-model guard).
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='stock_items'
             AND column_name IN ('reserved_qty','allocated_qty','reserved_bottles','allocated_bottles')) THEN
    RAISE EXCEPTION 'Pre-flight: stock_items must not have a reserved/allocated column.' USING ERRCODE='raise_exception';
  END IF;
END $$;

-- ============================================================
-- 1. DISPATCH_SEQUENCES — per (org, year) counter for DISP-YYYY-NNNN
-- Written only by next_dispatch_number() (no direct client write policy/grant).
-- Mirrors sales_order_sequences (046).
-- ============================================================
CREATE TABLE IF NOT EXISTS public.dispatch_sequences (
  org_id       UUID NOT NULL,
  order_year   INTEGER NOT NULL,
  last_number  INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT pk_dispatch_sequences PRIMARY KEY (org_id, order_year),
  CONSTRAINT fk_dispatch_seq_org FOREIGN KEY (org_id) REFERENCES public.organisations(id) ON DELETE RESTRICT,
  CONSTRAINT dispatch_seq_last_number_non_negative CHECK (last_number >= 0),
  CONSTRAINT dispatch_seq_year_sane CHECK (order_year >= 2000 AND order_year <= 2200)
);

ALTER TABLE public.dispatch_sequences ENABLE ROW LEVEL SECURITY;
-- Members may read their org's sequence counters; writes are RPC-only.
CREATE POLICY "Users can view organisation dispatch sequences"
  ON public.dispatch_sequences FOR SELECT
  USING (public.is_org_member(org_id));
GRANT SELECT ON public.dispatch_sequences TO authenticated;

DROP TRIGGER IF EXISTS dispatch_seq_updated_at ON public.dispatch_sequences;
CREATE TRIGGER dispatch_seq_updated_at BEFORE UPDATE ON public.dispatch_sequences
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ============================================================
-- 2. DISPATCHES — physical dispatch header. One per physical dispatch event
-- against a single sales order. address_snapshot is copied from the order's
-- shipping_address_snapshot at dispatch time (copy, not a live FK).
-- ============================================================
CREATE TABLE IF NOT EXISTS public.dispatches (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL,
  owner_id          UUID NOT NULL,
  sales_order_id    UUID NOT NULL,
  dispatch_number   TEXT NOT NULL,
  dispatched_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status            TEXT NOT NULL DEFAULT 'recorded',
  address_snapshot  JSONB,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_dispatch_org
    FOREIGN KEY (org_id) REFERENCES public.organisations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_dispatch_owner
    FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_dispatch_order
    FOREIGN KEY (sales_order_id) REFERENCES public.sales_orders(id) ON DELETE RESTRICT,

  -- 'voided' is a FORWARD-COMPAT value only. NO code path sets it; NO void RPC
  -- exists in this phase (per the approved scope).
  CONSTRAINT dispatch_status_check CHECK (status IN ('recorded','voided')),
  CONSTRAINT dispatch_number_not_blank CHECK (length(btrim(dispatch_number)) > 0),
  -- Dispatch number is unique WITHIN an organisation.
  CONSTRAINT uq_dispatch_number_per_org UNIQUE (org_id, dispatch_number)
);

CREATE INDEX IF NOT EXISTS idx_dispatch_org_id   ON public.dispatches(org_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_owner_id ON public.dispatches(owner_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_order_id ON public.dispatches(sales_order_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_status   ON public.dispatches(status);

-- ============================================================
-- 3. DISPATCH_LINES — one row per (dispatch, allocation) fulfilment of bottles.
-- stock_allocation_id is the AUTHORITATIVE fulfilment relationship; the derived
-- order/line/product/location columns are validated against the allocation by
-- the integrity trigger (and derived — never trusted from the client — in the
-- RPC). stock_movement_id is NULLABLE at the table level ONLY because the
-- dispatch_line row must be inserted first to obtain its id as the movement's
-- reference_id; record_dispatch ALWAYS sets it via UPDATE within the SAME
-- transaction (insert header -> insert line -> insert movement -> set id).
-- ============================================================
CREATE TABLE IF NOT EXISTS public.dispatch_lines (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               UUID NOT NULL,
  owner_id             UUID NOT NULL,
  dispatch_id          UUID NOT NULL,
  sales_order_id       UUID NOT NULL,
  sales_order_line_id  UUID NOT NULL,
  stock_allocation_id  UUID NOT NULL,
  finished_product_id  UUID NOT NULL,
  location_id          UUID NOT NULL,
  qty_bottles          INTEGER NOT NULL,
  stock_movement_id    UUID,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_dline_org
    FOREIGN KEY (org_id) REFERENCES public.organisations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_dline_owner
    FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE RESTRICT,
  -- The ONLY cascade: deleting a dispatch header removes its lines.
  CONSTRAINT fk_dline_dispatch
    FOREIGN KEY (dispatch_id) REFERENCES public.dispatches(id) ON DELETE CASCADE,
  CONSTRAINT fk_dline_order
    FOREIGN KEY (sales_order_id) REFERENCES public.sales_orders(id) ON DELETE RESTRICT,
  CONSTRAINT fk_dline_line
    FOREIGN KEY (sales_order_line_id) REFERENCES public.sales_order_lines(id) ON DELETE RESTRICT,
  CONSTRAINT fk_dline_allocation
    FOREIGN KEY (stock_allocation_id) REFERENCES public.stock_allocations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_dline_product
    FOREIGN KEY (finished_product_id) REFERENCES public.finished_products(id) ON DELETE RESTRICT,
  CONSTRAINT fk_dline_location
    FOREIGN KEY (location_id) REFERENCES public.stock_locations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_dline_movement
    FOREIGN KEY (stock_movement_id) REFERENCES public.stock_movements(id) ON DELETE RESTRICT,

  CONSTRAINT dline_qty_positive CHECK (qty_bottles > 0)
);

CREATE INDEX IF NOT EXISTS idx_dline_org_id        ON public.dispatch_lines(org_id);
CREATE INDEX IF NOT EXISTS idx_dline_owner_id      ON public.dispatch_lines(owner_id);
CREATE INDEX IF NOT EXISTS idx_dline_dispatch_id   ON public.dispatch_lines(dispatch_id);
CREATE INDEX IF NOT EXISTS idx_dline_order_id      ON public.dispatch_lines(sales_order_id);
CREATE INDEX IF NOT EXISTS idx_dline_line_id       ON public.dispatch_lines(sales_order_line_id);
CREATE INDEX IF NOT EXISTS idx_dline_allocation_id ON public.dispatch_lines(stock_allocation_id);
CREATE INDEX IF NOT EXISTS idx_dline_product_id    ON public.dispatch_lines(finished_product_id);
CREATE INDEX IF NOT EXISTS idx_dline_location_id   ON public.dispatch_lines(location_id);
CREATE INDEX IF NOT EXISTS idx_dline_movement_id   ON public.dispatch_lines(stock_movement_id);

-- ============================================================
-- 4. STOCK_ALLOCATIONS — add fulfilment tracking (BOTTLES).
-- The original reservation qty_bottles is NEVER modified. fulfilled_qty is a
-- new monotonic counter (0 <= fulfilled_qty <= qty_bottles). The status
-- vocabulary gains 'partially_fulfilled'. Existing rows default fulfilled_qty=0
-- and remain valid (status 'open' with fulfilled_qty=0 satisfies every CHECK).
--
--   open                 fulfilled_qty = 0, no released_at, no fulfilled_at
--   partially_fulfilled  0 < fulfilled_qty < qty_bottles, no released_at, no fulfilled_at
--   fulfilled            fulfilled_qty = qty_bottles, fulfilled_at set, no released_at
--   released / cancelled unchanged (P2L-6 release behaviour preserved)
-- ============================================================
ALTER TABLE public.stock_allocations
  ADD COLUMN IF NOT EXISTS fulfilled_qty INTEGER NOT NULL DEFAULT 0;

-- fulfilled_qty bounds (defence in depth alongside the lifecycle CHECKs below).
ALTER TABLE public.stock_allocations DROP CONSTRAINT IF EXISTS salloc_fulfilled_qty_non_negative;
ALTER TABLE public.stock_allocations
  ADD CONSTRAINT salloc_fulfilled_qty_non_negative CHECK (fulfilled_qty >= 0);
ALTER TABLE public.stock_allocations DROP CONSTRAINT IF EXISTS salloc_fulfilled_qty_le_qty;
ALTER TABLE public.stock_allocations
  ADD CONSTRAINT salloc_fulfilled_qty_le_qty CHECK (fulfilled_qty <= qty_bottles);

-- Extend the status vocabulary: add 'partially_fulfilled' while preserving ALL
-- existing values (open/released/fulfilled/cancelled). Existing rows only hold
-- values that remain in the new set, so the re-add never fails on current data.
ALTER TABLE public.stock_allocations DROP CONSTRAINT IF EXISTS salloc_status_check;
ALTER TABLE public.stock_allocations
  ADD CONSTRAINT salloc_status_check
  CHECK (status IN ('open','partially_fulfilled','released','fulfilled','cancelled'));

-- Terminal-timestamp rule now also covers 'partially_fulfilled' (no released_at /
-- fulfilled_at while still in flight). 'open' already satisfied this.
ALTER TABLE public.stock_allocations DROP CONSTRAINT IF EXISTS salloc_open_has_no_terminal_ts;
ALTER TABLE public.stock_allocations
  ADD CONSTRAINT salloc_open_has_no_terminal_ts
  CHECK (status NOT IN ('open','partially_fulfilled') OR (released_at IS NULL AND fulfilled_at IS NULL));

-- Quantity<->status consistency (new):
--   open                => fulfilled_qty = 0
--   partially_fulfilled => 0 < fulfilled_qty < qty_bottles
--   fulfilled           => fulfilled_qty = qty_bottles
ALTER TABLE public.stock_allocations DROP CONSTRAINT IF EXISTS salloc_open_qty_zero;
ALTER TABLE public.stock_allocations
  ADD CONSTRAINT salloc_open_qty_zero
  CHECK (status <> 'open' OR fulfilled_qty = 0);
ALTER TABLE public.stock_allocations DROP CONSTRAINT IF EXISTS salloc_partial_qty_consistent;
ALTER TABLE public.stock_allocations
  ADD CONSTRAINT salloc_partial_qty_consistent
  CHECK (status <> 'partially_fulfilled' OR (fulfilled_qty > 0 AND fulfilled_qty < qty_bottles));
ALTER TABLE public.stock_allocations DROP CONSTRAINT IF EXISTS salloc_fulfilled_qty_full;
ALTER TABLE public.stock_allocations
  ADD CONSTRAINT salloc_fulfilled_qty_full
  CHECK (status <> 'fulfilled' OR fulfilled_qty = qty_bottles);

-- salloc_released_has_released_ts and salloc_fulfilled_has_fulfilled_ts (048)
-- are intentionally UNCHANGED — P2L-6 release behaviour is preserved exactly.

-- ============================================================
-- 5. SALES_ORDERS — extend the status vocabulary with the two P2M dispatch
-- states. Preserves ALL existing values (incl. the vestigial 'allocated').
-- Does NOT add 'dispatched'. Existing rows only hold values that remain in the
-- new set, so the re-add never fails on current data.
-- ============================================================
ALTER TABLE public.sales_orders DROP CONSTRAINT IF EXISTS so_status_check;
ALTER TABLE public.sales_orders
  ADD CONSTRAINT so_status_check CHECK (status IN (
    'draft','confirmed','allocated','partially_allocated','ready_to_dispatch',
    'partially_dispatched','completed','cancelled'
  ));

-- ============================================================
-- 6. OWNER_ID IMMUTABILITY (010) + UPDATED_AT (001) on the new tables.
-- ============================================================
DROP TRIGGER IF EXISTS dispatch_owner_id_immutable ON public.dispatches;
CREATE TRIGGER dispatch_owner_id_immutable BEFORE UPDATE ON public.dispatches
  FOR EACH ROW EXECUTE FUNCTION public.prevent_owner_id_change();
DROP TRIGGER IF EXISTS dispatch_updated_at ON public.dispatches;
CREATE TRIGGER dispatch_updated_at BEFORE UPDATE ON public.dispatches
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS dline_owner_id_immutable ON public.dispatch_lines;
CREATE TRIGGER dline_owner_id_immutable BEFORE UPDATE ON public.dispatch_lines
  FOR EACH ROW EXECUTE FUNCTION public.prevent_owner_id_change();
DROP TRIGGER IF EXISTS dline_updated_at ON public.dispatch_lines;
CREATE TRIGGER dline_updated_at BEFORE UPDATE ON public.dispatch_lines
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ============================================================
-- 7. CROSS-ORG / CROSS-REFERENCE INTEGRITY (SECURITY DEFINER, pinned path).
-- Mirrors validate_stock_allocation_org_integrity() (048). Defence in depth —
-- record_dispatch is the primary enforcer and derives these values from the
-- locked allocation; these triggers independently reject any mismatch.
-- ============================================================

-- 7a. dispatches: the referenced sales order must exist and be the same org.
CREATE OR REPLACE FUNCTION public.validate_dispatch_org_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order_org UUID;
BEGIN
  SELECT so.org_id INTO v_order_org FROM public.sales_orders so WHERE so.id = NEW.sales_order_id;
  IF v_order_org IS NULL THEN
    RAISE EXCEPTION 'Invalid sales order: % does not exist.', NEW.sales_order_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF v_order_org <> NEW.org_id THEN
    RAISE EXCEPTION 'Cross-organisation reference: sales order % belongs to a different organisation.', NEW.sales_order_id USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS dispatch_org_integrity ON public.dispatches;
CREATE TRIGGER dispatch_org_integrity
  BEFORE INSERT OR UPDATE ON public.dispatches
  FOR EACH ROW EXECUTE FUNCTION public.validate_dispatch_org_integrity();

-- 7b. dispatch_lines: every referenced row must exist and be the SAME org; the
-- dispatch and the line must belong to NEW.sales_order_id; and the stock
-- allocation's identity must match the derived line/product/location columns
-- (the four allocation-identity invariants from the approved architecture).
CREATE OR REPLACE FUNCTION public.validate_dispatch_line_org_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_dispatch_org   UUID;
  v_dispatch_order UUID;
  v_line_org       UUID;
  v_line_order     UUID;
  v_alloc_org      UUID;
  v_alloc_order    UUID;
  v_alloc_line     UUID;
  v_alloc_product  UUID;
  v_alloc_location UUID;
  v_product_org    UUID;
  v_location_org   UUID;
  v_movement_org   UUID;
BEGIN
  -- Parent dispatch.
  SELECT d.org_id, d.sales_order_id INTO v_dispatch_org, v_dispatch_order
  FROM public.dispatches d WHERE d.id = NEW.dispatch_id;
  IF v_dispatch_org IS NULL THEN
    RAISE EXCEPTION 'Invalid dispatch: % does not exist.', NEW.dispatch_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF v_dispatch_org <> NEW.org_id THEN
    RAISE EXCEPTION 'Cross-organisation reference: dispatch % belongs to a different organisation.', NEW.dispatch_id USING ERRCODE = 'raise_exception';
  END IF;
  IF v_dispatch_order <> NEW.sales_order_id THEN
    RAISE EXCEPTION 'Dispatch % is not for sales order %.', NEW.dispatch_id, NEW.sales_order_id USING ERRCODE = 'raise_exception';
  END IF;

  -- Sales order line.
  SELECT l.org_id, l.sales_order_id INTO v_line_org, v_line_order
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

  -- Stock allocation — the authoritative fulfilment relationship. Its identity
  -- MUST match the derived line/product/location columns on the dispatch line.
  SELECT a.org_id, a.sales_order_id, a.sales_order_line_id, a.finished_product_id, a.location_id
    INTO v_alloc_org, v_alloc_order, v_alloc_line, v_alloc_product, v_alloc_location
  FROM public.stock_allocations a WHERE a.id = NEW.stock_allocation_id;
  IF v_alloc_org IS NULL THEN
    RAISE EXCEPTION 'Invalid stock allocation: % does not exist.', NEW.stock_allocation_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF v_alloc_org <> NEW.org_id THEN
    RAISE EXCEPTION 'Cross-organisation reference: stock allocation % belongs to a different organisation.', NEW.stock_allocation_id USING ERRCODE = 'raise_exception';
  END IF;
  IF v_alloc_order <> NEW.sales_order_id THEN
    RAISE EXCEPTION 'Allocation % does not belong to sales order %.', NEW.stock_allocation_id, NEW.sales_order_id USING ERRCODE = 'raise_exception';
  END IF;
  IF v_alloc_line <> NEW.sales_order_line_id THEN
    RAISE EXCEPTION 'Allocation % is for a different order line than the dispatch line.', NEW.stock_allocation_id USING ERRCODE = 'raise_exception';
  END IF;
  IF v_alloc_product <> NEW.finished_product_id THEN
    RAISE EXCEPTION 'Allocation % product does not match the dispatch line product.', NEW.stock_allocation_id USING ERRCODE = 'raise_exception';
  END IF;
  IF v_alloc_location <> NEW.location_id THEN
    RAISE EXCEPTION 'Allocation % location does not match the dispatch line location.', NEW.stock_allocation_id USING ERRCODE = 'raise_exception';
  END IF;

  -- Product and location same-org.
  SELECT fp.org_id INTO v_product_org FROM public.finished_products fp WHERE fp.id = NEW.finished_product_id;
  IF v_product_org IS NULL OR v_product_org <> NEW.org_id THEN
    RAISE EXCEPTION 'Cross-organisation reference: finished product % is invalid or belongs to a different organisation.', NEW.finished_product_id USING ERRCODE = 'raise_exception';
  END IF;
  SELECT sl.org_id INTO v_location_org FROM public.stock_locations sl WHERE sl.id = NEW.location_id;
  IF v_location_org IS NULL OR v_location_org <> NEW.org_id THEN
    RAISE EXCEPTION 'Cross-organisation reference: stock location % is invalid or belongs to a different organisation.', NEW.location_id USING ERRCODE = 'raise_exception';
  END IF;

  -- Stock movement (set in the same transaction) must be same-org when present.
  IF NEW.stock_movement_id IS NOT NULL THEN
    SELECT sm.org_id INTO v_movement_org FROM public.stock_movements sm WHERE sm.id = NEW.stock_movement_id;
    IF v_movement_org IS NULL THEN
      RAISE EXCEPTION 'Invalid stock movement: % does not exist.', NEW.stock_movement_id USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF v_movement_org <> NEW.org_id THEN
      RAISE EXCEPTION 'Cross-organisation reference: stock movement % belongs to a different organisation.', NEW.stock_movement_id USING ERRCODE = 'raise_exception';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS dline_org_integrity ON public.dispatch_lines;
CREATE TRIGGER dline_org_integrity
  BEFORE INSERT OR UPDATE ON public.dispatch_lines
  FOR EACH ROW EXECUTE FUNCTION public.validate_dispatch_line_org_integrity();

-- ============================================================
-- 8. ROW LEVEL SECURITY — append-only, RPC-controlled.
-- Organisation members may SELECT. There is NO client INSERT/UPDATE/DELETE
-- policy — both tables are written solely by record_dispatch() (same posture
-- as stock_items / stock_movements / stock_allocations).
-- ============================================================
ALTER TABLE public.dispatches ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view organisation dispatches"
  ON public.dispatches FOR SELECT
  USING (public.is_org_member(org_id));

ALTER TABLE public.dispatch_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view organisation dispatch lines"
  ON public.dispatch_lines FOR SELECT
  USING (public.is_org_member(org_id));

-- SELECT only to authenticated (NO INSERT/UPDATE/DELETE). The RPC writes with
-- the definer's rights.
GRANT SELECT ON public.dispatches TO authenticated;
GRANT SELECT ON public.dispatch_lines TO authenticated;

-- ============================================================
-- 9. EXTEND THE SINGLE AUDIT WRITER (reuse 021) + attach triggers.
-- Adds dispatch + dispatch_line, preserving all 26 existing mappings. Final = 28.
-- dispatches is audited on INSERT + UPDATE (status/notes mutable); dispatch_lines
-- on INSERT only (append-only facts; the transient stock_movement_id is set
-- within the creating transaction — same posture as stock_movements).
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

DROP TRIGGER IF EXISTS trg_audit_dispatches ON public.dispatches;
CREATE TRIGGER trg_audit_dispatches
  AFTER INSERT OR UPDATE ON public.dispatches
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_row_change();

DROP TRIGGER IF EXISTS trg_audit_dispatch_lines ON public.dispatch_lines;
CREATE TRIGGER trg_audit_dispatch_lines
  AFTER INSERT ON public.dispatch_lines
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_row_change();

-- ============================================================
-- 10. assert_dispatch_actor — resolve caller + verify membership + dispatch role
-- OWNER/ADMIN/CELLAR/SALES may record dispatches (FARM/VIEWER are excluded).
-- Mirrors assert_cellar_actor (022) / assert_sales_actor (048). Internal guard —
-- never granted to PUBLIC or authenticated.
-- ============================================================
CREATE OR REPLACE FUNCTION public.assert_dispatch_actor(target_org UUID)
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
  IF NOT public.has_org_role(target_org, ARRAY['OWNER','ADMIN','CELLAR','SALES']) THEN
    RAISE EXCEPTION 'This operation requires an Owner, Admin, Cellar or Sales role.' USING ERRCODE = 'raise_exception';
  END IF;
  RETURN uid;
END;
$$;
REVOKE ALL ON FUNCTION public.assert_dispatch_actor(UUID) FROM PUBLIC;

-- ============================================================
-- 11. next_dispatch_number — concurrency-safe DISP-YYYY-NNNN allocator.
-- SECURITY DEFINER; auth + membership checked; the (org, year) sequence row is
-- locked FOR UPDATE (created if missing) and incremented atomically. Gaps are
-- acceptable. Copies next_sales_order_number (046) exactly.
-- ============================================================
CREATE OR REPLACE FUNCTION public.next_dispatch_number(p_org_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid   UUID := auth.uid();
  v_year  INTEGER := EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER;
  v_next  INTEGER;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.' USING ERRCODE = 'raise_exception';
  END IF;
  IF NOT public.is_org_member(p_org_id) THEN
    RAISE EXCEPTION 'Not a member of the target organisation.' USING ERRCODE = 'raise_exception';
  END IF;

  -- Ensure the (org, year) row exists, then lock it and bump atomically. The
  -- ON CONFLICT upsert + FOR UPDATE serialises concurrent allocators.
  INSERT INTO public.dispatch_sequences (org_id, order_year, last_number)
  VALUES (p_org_id, v_year, 0)
  ON CONFLICT (org_id, order_year) DO NOTHING;

  SELECT last_number + 1 INTO v_next
  FROM public.dispatch_sequences
  WHERE org_id = p_org_id AND order_year = v_year
  FOR UPDATE;

  UPDATE public.dispatch_sequences
     SET last_number = v_next
   WHERE org_id = p_org_id AND order_year = v_year;

  RETURN format('DISP-%s-%s', v_year, lpad(v_next::text, 4, '0'));
END;
$$;
REVOKE ALL ON FUNCTION public.next_dispatch_number(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.next_dispatch_number(UUID) TO authenticated;

-- ============================================================
-- 12. recompute_sales_order_dispatch_status — internal, SECURITY DEFINER.
-- Derive the order DISPATCH status from ACTUAL FULFILLED QUANTITIES (never from
-- a count of dispatch rows):
--   every line fully fulfilled (SUM allocations' fulfilled_qty >= ordered) -> completed
--   at least one bottle fulfilled but not all                              -> partially_dispatched
--   no fulfilled bottles                                                   -> ready_to_dispatch
-- Only ever moves between ready_to_dispatch / partially_dispatched / completed.
-- Leaves draft/confirmed/allocated/partially_allocated/cancelled untouched.
-- The order row is assumed to be locked FOR UPDATE by the caller.
-- Mirrors recompute_sales_order_allocation_status (048).
-- ============================================================
CREATE OR REPLACE FUNCTION public.recompute_sales_order_dispatch_status(p_sales_order_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status      TEXT;
  v_line_count  INTEGER;
  v_full_lines  INTEGER;
  v_fulfilled_total BIGINT;
  v_new_status  TEXT;
BEGIN
  SELECT status INTO v_status FROM public.sales_orders WHERE id = p_sales_order_id;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Sales order % not found.', p_sales_order_id USING ERRCODE = 'raise_exception';
  END IF;

  -- Only recompute within the dispatch flow. Leave other states untouched.
  IF v_status NOT IN ('ready_to_dispatch','partially_dispatched','completed') THEN
    RETURN v_status;
  END IF;

  SELECT COUNT(*) INTO v_line_count FROM public.sales_order_lines WHERE sales_order_id = p_sales_order_id;

  -- Count lines whose fulfilled allocation total covers their ordered quantity.
  SELECT COUNT(*) INTO v_full_lines
  FROM public.sales_order_lines l
  WHERE l.sales_order_id = p_sales_order_id
    AND l.quantity_bottles <= COALESCE((
      SELECT SUM(a.fulfilled_qty) FROM public.stock_allocations a
      WHERE a.sales_order_line_id = l.id
    ), 0);

  -- Total fulfilled bottles across the whole order.
  SELECT COALESCE(SUM(a.fulfilled_qty), 0) INTO v_fulfilled_total
  FROM public.stock_allocations a
  WHERE a.sales_order_id = p_sales_order_id;

  IF v_line_count > 0 AND v_full_lines = v_line_count THEN
    v_new_status := 'completed';
  ELSIF v_fulfilled_total > 0 THEN
    v_new_status := 'partially_dispatched';
  ELSE
    v_new_status := 'ready_to_dispatch';
  END IF;

  IF v_new_status <> v_status THEN
    UPDATE public.sales_orders SET status = v_new_status WHERE id = p_sales_order_id;
  END IF;

  RETURN v_new_status;
END;
$$;
REVOKE ALL ON FUNCTION public.recompute_sales_order_dispatch_status(UUID) FROM PUBLIC;

-- ============================================================
-- 13. record_dispatch — the single atomic physical-dispatch operation.
-- p_lines is a JSONB array of { "stock_allocation_id": uuid, "qty_bottles": int }.
-- The client sends ONLY the allocation id + qty; every other value (org, line,
-- product, location) is DERIVED from the locked allocation and never trusted.
--
-- Lock order (deadlock-safe): sales_orders -> stock_allocations -> stock_items,
-- all FOR UPDATE. Allocations are processed in deterministic order (by id). A
-- concurrent 60+60 against a 100-bottle allocation makes the second txn fail on
-- the remaining-quantity check. No negative stock. One stock_movement per line.
-- ============================================================
DROP FUNCTION IF EXISTS public.record_dispatch(uuid, jsonb, text);

CREATE OR REPLACE FUNCTION public.record_dispatch(
  p_sales_order_id UUID,
  p_lines          JSONB,
  p_notes          TEXT DEFAULT NULL
)
RETURNS TABLE (
  dispatch_id          UUID,
  dispatch_number      TEXT,
  sales_order_id       UUID,
  dispatch_status      TEXT,
  dispatched_at        TIMESTAMPTZ,
  order_status         TEXT,
  dispatch_line_id     UUID,
  stock_allocation_id  UUID,
  sales_order_line_id  UUID,
  finished_product_id  UUID,
  location_id          UUID,
  qty_bottles          INTEGER,
  stock_movement_id    UUID,
  allocation_status    TEXT,
  allocation_fulfilled INTEGER,
  location_physical    INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid             UUID := auth.uid();
  v_owner           UUID;
  v_order           public.sales_orders;
  v_dispatch_number TEXT;
  v_address         JSONB;
  v_dispatch_id     UUID;
  v_dispatched_at   TIMESTAMPTZ := NOW();
  v_notes           TEXT;
  v_elem            JSONB;
  v_alloc_id        UUID;
  v_req_qty         INTEGER;
  v_alloc           public.stock_allocations;
  v_item            public.stock_items;
  v_remaining       INTEGER;
  v_new_fulfilled   INTEGER;
  v_new_alloc_status TEXT;
  v_line_id         UUID;
  v_move_id         UUID;
  v_order_status    TEXT;
  -- Per-line buffer so every returned row can carry the final order_status.
  v_results         JSONB := '[]'::JSONB;
  v_row             JSONB;
BEGIN
  -- (1) Authentication (fail closed).
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.' USING ERRCODE = 'raise_exception';
  END IF;

  -- (6) p_lines must be a non-empty JSONB array (cheap; validate early).
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'Dispatch lines must be a non-empty array.' USING ERRCODE = 'raise_exception';
  END IF;

  -- (2) Lock the sales order FOR UPDATE; derive org from the row (never client).
  SELECT * INTO v_order FROM public.sales_orders WHERE id = p_sales_order_id FOR UPDATE;
  IF v_order.id IS NULL THEN
    RAISE EXCEPTION 'Sales order % not found.', p_sales_order_id USING ERRCODE = 'raise_exception';
  END IF;

  -- (3) Authorisation: membership + OWNER/ADMIN/CELLAR/SALES for the order's org.
  v_owner := public.assert_dispatch_actor(v_order.org_id);

  -- (4) Order must be dispatchable. Reject every other lifecycle state.
  IF v_order.status NOT IN ('ready_to_dispatch','partially_dispatched') THEN
    RAISE EXCEPTION 'Dispatch requires a ready_to_dispatch or partially_dispatched order (status is "%").', v_order.status USING ERRCODE = 'raise_exception';
  END IF;

  -- (8-prep) Dispatch number + address snapshot (copy of the order's shipping
  -- snapshot — never a live FK; the order snapshot is never modified).
  v_dispatch_number := public.next_dispatch_number(v_order.org_id);
  v_address := v_order.shipping_address_snapshot;
  v_notes := NULLIF(btrim(COALESCE(p_notes, '')), '');

  -- (8) Create the dispatch header ONCE, before any lines.
  INSERT INTO public.dispatches
    (org_id, owner_id, sales_order_id, dispatch_number, dispatched_at, status, address_snapshot, notes)
  VALUES
    (v_order.org_id, v_owner, v_order.id, v_dispatch_number, v_dispatched_at, 'recorded', v_address, v_notes)
  RETURNING id INTO v_dispatch_id;

  -- (6+9+10) Process each requested allocation in DETERMINISTIC order (by
  -- stock_allocation_id) for a fixed lock order across concurrent dispatches.
  FOR v_elem IN
    SELECT elem.value
    FROM jsonb_array_elements(p_lines) AS elem(value)
    ORDER BY (elem.value ->> 'stock_allocation_id')
  LOOP
    -- Validate the element shape.
    IF jsonb_typeof(v_elem) <> 'object'
       OR NOT (v_elem ? 'stock_allocation_id')
       OR NOT (v_elem ? 'qty_bottles') THEN
      RAISE EXCEPTION 'Each dispatch line must be an object with stock_allocation_id and qty_bottles.' USING ERRCODE = 'raise_exception';
    END IF;

    BEGIN
      v_alloc_id := (v_elem ->> 'stock_allocation_id')::UUID;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'Invalid stock_allocation_id in dispatch line.' USING ERRCODE = 'raise_exception';
    END;

    IF jsonb_typeof(v_elem -> 'qty_bottles') <> 'number' THEN
      RAISE EXCEPTION 'qty_bottles must be an integer.' USING ERRCODE = 'raise_exception';
    END IF;
    v_req_qty := (v_elem ->> 'qty_bottles')::INTEGER;
    IF v_req_qty IS NULL OR v_req_qty <= 0 THEN
      RAISE EXCEPTION 'qty_bottles must be a positive integer (got %).', v_req_qty USING ERRCODE = 'raise_exception';
    END IF;

    -- Lock the allocation row FOR UPDATE.
    SELECT * INTO v_alloc FROM public.stock_allocations WHERE id = v_alloc_id FOR UPDATE;
    IF v_alloc.id IS NULL THEN
      RAISE EXCEPTION 'Stock allocation % not found.', v_alloc_id USING ERRCODE = 'raise_exception';
    END IF;

    -- The allocation must belong to this order.
    IF v_alloc.sales_order_id <> v_order.id THEN
      RAISE EXCEPTION 'Allocation % does not belong to sales order %.', v_alloc_id, v_order.id USING ERRCODE = 'raise_exception';
    END IF;

    -- Only open / partially_fulfilled allocations may be fulfilled further.
    IF v_alloc.status NOT IN ('open','partially_fulfilled') THEN
      RAISE EXCEPTION 'Allocation % cannot be dispatched (status is "%").', v_alloc_id, v_alloc.status USING ERRCODE = 'raise_exception';
    END IF;

    -- Remaining reservation = original qty minus already-fulfilled. The requested
    -- quantity must not exceed it (this is the duplicate-fulfilment / concurrency
    -- guard — a second concurrent txn sees the committed-under-lock fulfilled_qty).
    v_remaining := v_alloc.qty_bottles - v_alloc.fulfilled_qty;
    IF v_req_qty > v_remaining THEN
      RAISE EXCEPTION 'Dispatch exceeds the allocation remaining quantity: % remaining, % requested (allocation %).', v_remaining, v_req_qty, v_alloc_id USING ERRCODE = 'raise_exception';
    END IF;

    -- (7) Lock the physical stock_items balance (org + DERIVED product + DERIVED
    -- location) FOR UPDATE. Independent physical-sufficiency check — no negative
    -- stock. All identities are derived from the locked allocation, never trusted.
    SELECT * INTO v_item FROM public.stock_items
    WHERE org_id = v_order.org_id
      AND product_id = v_alloc.finished_product_id
      AND location_id = v_alloc.location_id
    FOR UPDATE;
    IF v_item.id IS NULL THEN
      RAISE EXCEPTION 'There is no physical stock of this product at the allocation location (allocation %).', v_alloc_id USING ERRCODE = 'raise_exception';
    END IF;
    IF v_item.qty_bottles < v_req_qty THEN
      RAISE EXCEPTION 'Insufficient physical stock: % available, % requested (allocation %).', v_item.qty_bottles, v_req_qty, v_alloc_id USING ERRCODE = 'raise_exception';
    END IF;

    -- Decrement physical stock.
    UPDATE public.stock_items
       SET qty_bottles = qty_bottles - v_req_qty
     WHERE id = v_item.id;

    -- (9) Insert the dispatch line FIRST (to obtain its id for the movement's
    -- reference_id), deriving line/product/location from the locked allocation.
    INSERT INTO public.dispatch_lines
      (org_id, owner_id, dispatch_id, sales_order_id, sales_order_line_id,
       stock_allocation_id, finished_product_id, location_id, qty_bottles, stock_movement_id)
    VALUES
      (v_order.org_id, v_owner, v_dispatch_id, v_order.id, v_alloc.sales_order_line_id,
       v_alloc.id, v_alloc.finished_product_id, v_alloc.location_id, v_req_qty, NULL)
    RETURNING id INTO v_line_id;

    -- Insert ONE stock_movement for this line/location (never aggregated).
    INSERT INTO public.stock_movements
      (org_id, owner_id, stock_item_id, product_id, location_id, movement_type,
       qty_bottles_delta, reference_type, reference_id, transfer_group_id, notes, occurred_at)
    VALUES
      (v_order.org_id, v_owner, v_item.id, v_alloc.finished_product_id, v_alloc.location_id, 'dispatch',
       -v_req_qty, 'dispatch_line', v_line_id, NULL, format('Dispatch %s', v_dispatch_number), NOW())
    RETURNING id INTO v_move_id;

    -- Back-fill the dispatch line's movement id (same transaction).
    UPDATE public.dispatch_lines SET stock_movement_id = v_move_id WHERE id = v_line_id;

    -- (10) Advance the allocation fulfilment. qty_bottles is NEVER modified.
    v_new_fulfilled := v_alloc.fulfilled_qty + v_req_qty;
    IF v_new_fulfilled = v_alloc.qty_bottles THEN
      v_new_alloc_status := 'fulfilled';
      UPDATE public.stock_allocations
         SET fulfilled_qty = v_new_fulfilled, status = 'fulfilled', fulfilled_at = NOW()
       WHERE id = v_alloc.id;
    ELSE
      v_new_alloc_status := 'partially_fulfilled';
      UPDATE public.stock_allocations
         SET fulfilled_qty = v_new_fulfilled, status = 'partially_fulfilled'
       WHERE id = v_alloc.id;
    END IF;

    -- Buffer the per-line result; order_status is appended after the recompute
    -- so every returned row carries the final order status.
    v_results := v_results || jsonb_build_object(
      'dispatch_line_id',     v_line_id,
      'stock_allocation_id',  v_alloc.id,
      'sales_order_line_id',  v_alloc.sales_order_line_id,
      'finished_product_id',  v_alloc.finished_product_id,
      'location_id',          v_alloc.location_id,
      'qty_bottles',          v_req_qty,
      'stock_movement_id',    v_move_id,
      'allocation_status',    v_new_alloc_status,
      'allocation_fulfilled', v_new_fulfilled,
      'location_physical',    v_item.qty_bottles - v_req_qty
    );
  END LOOP;

  -- (11) Recompute the order dispatch status from fulfilled quantities (order is
  -- already locked FOR UPDATE above).
  v_order_status := public.recompute_sales_order_dispatch_status(v_order.id);

  -- (12) Emit one row per dispatched line, each carrying the header context +
  -- the final order status.
  FOR v_row IN SELECT value FROM jsonb_array_elements(v_results) AS t(value)
  LOOP
    dispatch_id          := v_dispatch_id;
    dispatch_number      := v_dispatch_number;
    sales_order_id       := v_order.id;
    dispatch_status      := 'recorded';
    dispatched_at        := v_dispatched_at;
    order_status         := v_order_status;
    dispatch_line_id     := (v_row ->> 'dispatch_line_id')::UUID;
    stock_allocation_id  := (v_row ->> 'stock_allocation_id')::UUID;
    sales_order_line_id  := (v_row ->> 'sales_order_line_id')::UUID;
    finished_product_id  := (v_row ->> 'finished_product_id')::UUID;
    location_id          := (v_row ->> 'location_id')::UUID;
    qty_bottles          := (v_row ->> 'qty_bottles')::INTEGER;
    stock_movement_id    := (v_row ->> 'stock_movement_id')::UUID;
    allocation_status    := (v_row ->> 'allocation_status');
    allocation_fulfilled := (v_row ->> 'allocation_fulfilled')::INTEGER;
    location_physical    := (v_row ->> 'location_physical')::INTEGER;
    RETURN NEXT;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.record_dispatch(UUID, JSONB, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_dispatch(UUID, JSONB, TEXT) TO authenticated;

-- ============================================================
-- 14. POST-VALIDATION (catalog checks). RAISE => rollback.
-- ============================================================
DO $$
DECLARE n INTEGER; rls_on BOOLEAN; is_secdef BOOLEAN; cfg TEXT[]; sig TEXT;
BEGIN
  -- Tables exist.
  IF to_regclass('public.dispatches') IS NULL THEN RAISE EXCEPTION 'Post: dispatches missing.' USING ERRCODE='raise_exception'; END IF;
  IF to_regclass('public.dispatch_lines') IS NULL THEN RAISE EXCEPTION 'Post: dispatch_lines missing.' USING ERRCODE='raise_exception'; END IF;
  IF to_regclass('public.dispatch_sequences') IS NULL THEN RAISE EXCEPTION 'Post: dispatch_sequences missing.' USING ERRCODE='raise_exception'; END IF;

  -- dispatches column set (11).
  SELECT COUNT(*) INTO n FROM information_schema.columns WHERE table_schema='public' AND table_name='dispatches'
    AND column_name IN ('id','org_id','owner_id','sales_order_id','dispatch_number','dispatched_at','status','address_snapshot','notes','created_at','updated_at');
  IF n <> 11 THEN RAISE EXCEPTION 'Post: dispatches columns mismatch (%).', n USING ERRCODE='raise_exception'; END IF;

  -- dispatch_lines column set (13).
  SELECT COUNT(*) INTO n FROM information_schema.columns WHERE table_schema='public' AND table_name='dispatch_lines'
    AND column_name IN ('id','org_id','owner_id','dispatch_id','sales_order_id','sales_order_line_id','stock_allocation_id','finished_product_id','location_id','qty_bottles','stock_movement_id','created_at','updated_at');
  IF n <> 13 THEN RAISE EXCEPTION 'Post: dispatch_lines columns mismatch (%).', n USING ERRCODE='raise_exception'; END IF;

  -- dispatches: 3 FKs, all ON DELETE RESTRICT.
  SELECT COUNT(*) INTO n FROM information_schema.table_constraints WHERE table_schema='public' AND table_name='dispatches' AND constraint_type='FOREIGN KEY';
  IF n <> 3 THEN RAISE EXCEPTION 'Post: dispatches should have 3 FKs (%).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_constraint WHERE conrelid='public.dispatches'::regclass AND contype='f' AND confdeltype='r';
  IF n <> 3 THEN RAISE EXCEPTION 'Post: all dispatches FKs must be ON DELETE RESTRICT (% RESTRICT).', n USING ERRCODE='raise_exception'; END IF;

  -- dispatch_lines: 9 FKs; dispatch_id CASCADE ('c'), the other 8 RESTRICT ('r').
  SELECT COUNT(*) INTO n FROM information_schema.table_constraints WHERE table_schema='public' AND table_name='dispatch_lines' AND constraint_type='FOREIGN KEY';
  IF n <> 9 THEN RAISE EXCEPTION 'Post: dispatch_lines should have 9 FKs (%).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_constraint WHERE conrelid='public.dispatch_lines'::regclass AND contype='f' AND confdeltype='c';
  IF n <> 1 THEN RAISE EXCEPTION 'Post: exactly one dispatch_lines FK (dispatch_id) must be ON DELETE CASCADE (%).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_constraint WHERE conrelid='public.dispatch_lines'::regclass AND contype='f' AND confdeltype='r';
  IF n <> 8 THEN RAISE EXCEPTION 'Post: dispatch_lines must have 8 RESTRICT FKs (%).', n USING ERRCODE='raise_exception'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_dline_dispatch' AND confdeltype='c') THEN
    RAISE EXCEPTION 'Post: fk_dline_dispatch must be ON DELETE CASCADE.' USING ERRCODE='raise_exception'; END IF;

  -- dispatch status CHECK allows recorded + voided.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='dispatch_status_check'
      AND pg_get_constraintdef(oid) ILIKE '%recorded%' AND pg_get_constraintdef(oid) ILIKE '%voided%') THEN
    RAISE EXCEPTION 'Post: dispatch_status_check must allow recorded/voided.' USING ERRCODE='raise_exception';
  END IF;

  -- qty_bottles > 0 on dispatch_lines.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='dline_qty_positive' AND conrelid='public.dispatch_lines'::regclass) THEN
    RAISE EXCEPTION 'Post: dline_qty_positive CHECK missing.' USING ERRCODE='raise_exception'; END IF;

  -- Org-scoped unique dispatch number.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='uq_dispatch_number_per_org' AND contype='u') THEN
    RAISE EXCEPTION 'Post: uq_dispatch_number_per_org unique constraint missing.' USING ERRCODE='raise_exception';
  END IF;

  -- RLS on + exactly 1 SELECT policy, no write policy, on each new table.
  SELECT relrowsecurity INTO rls_on FROM pg_class WHERE oid='public.dispatches'::regclass;
  IF NOT COALESCE(rls_on,false) THEN RAISE EXCEPTION 'Post: RLS off on dispatches.' USING ERRCODE='raise_exception'; END IF;
  SELECT relrowsecurity INTO rls_on FROM pg_class WHERE oid='public.dispatch_lines'::regclass;
  IF NOT COALESCE(rls_on,false) THEN RAISE EXCEPTION 'Post: RLS off on dispatch_lines.' USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='dispatches';
  IF n <> 1 THEN RAISE EXCEPTION 'Post: dispatches must have exactly 1 policy (%).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='dispatch_lines';
  IF n <> 1 THEN RAISE EXCEPTION 'Post: dispatch_lines must have exactly 1 policy (%).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename IN ('dispatches','dispatch_lines') AND cmd IN ('INSERT','UPDATE','DELETE');
  IF n <> 0 THEN RAISE EXCEPTION 'Post: dispatch tables must have no write policy.' USING ERRCODE='raise_exception'; END IF;

  -- Grants: SELECT only; NO INSERT/UPDATE/DELETE to authenticated.
  SELECT COUNT(*) INTO n FROM information_schema.role_table_grants
  WHERE table_schema='public' AND table_name IN ('dispatches','dispatch_lines') AND grantee='authenticated' AND privilege_type IN ('INSERT','UPDATE','DELETE');
  IF n <> 0 THEN RAISE EXCEPTION 'Post: dispatch tables must not grant INSERT/UPDATE/DELETE to authenticated (%).', n USING ERRCODE='raise_exception'; END IF;

  -- Triggers on dispatches (owner immutability + updated_at + org integrity + audit).
  SELECT COUNT(*) INTO n FROM pg_trigger WHERE tgrelid='public.dispatches'::regclass AND NOT tgisinternal
    AND tgname IN ('dispatch_owner_id_immutable','dispatch_updated_at','dispatch_org_integrity','trg_audit_dispatches');
  IF n <> 4 THEN RAISE EXCEPTION 'Post: dispatches triggers mismatch (%).', n USING ERRCODE='raise_exception'; END IF;
  -- Triggers on dispatch_lines.
  SELECT COUNT(*) INTO n FROM pg_trigger WHERE tgrelid='public.dispatch_lines'::regclass AND NOT tgisinternal
    AND tgname IN ('dline_owner_id_immutable','dline_updated_at','dline_org_integrity','trg_audit_dispatch_lines');
  IF n <> 4 THEN RAISE EXCEPTION 'Post: dispatch_lines triggers mismatch (%).', n USING ERRCODE='raise_exception'; END IF;

  -- Integrity fns SECURITY DEFINER.
  IF to_regprocedure('public.validate_dispatch_org_integrity()') IS NULL THEN RAISE EXCEPTION 'Post: dispatch integrity fn missing.' USING ERRCODE='raise_exception'; END IF;
  SELECT prosecdef INTO is_secdef FROM pg_proc WHERE oid='public.validate_dispatch_org_integrity()'::regprocedure;
  IF NOT COALESCE(is_secdef,false) THEN RAISE EXCEPTION 'Post: dispatch integrity fn must be SECURITY DEFINER.' USING ERRCODE='raise_exception'; END IF;
  IF to_regprocedure('public.validate_dispatch_line_org_integrity()') IS NULL THEN RAISE EXCEPTION 'Post: dispatch_line integrity fn missing.' USING ERRCODE='raise_exception'; END IF;
  SELECT prosecdef INTO is_secdef FROM pg_proc WHERE oid='public.validate_dispatch_line_org_integrity()'::regprocedure;
  IF NOT COALESCE(is_secdef,false) THEN RAISE EXCEPTION 'Post: dispatch_line integrity fn must be SECURITY DEFINER.' USING ERRCODE='raise_exception'; END IF;

  -- Audit mappings: the two new ones + a sample of prior mappings preserved.
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.audit_log_row_change()'::regprocedure
      AND pg_get_functiondef(oid) ILIKE '%''dispatch''%'
      AND pg_get_functiondef(oid) ILIKE '%''dispatch_line''%'
      AND pg_get_functiondef(oid) ILIKE '%''stock_allocation''%'
      AND pg_get_functiondef(oid) ILIKE '%''sales_order''%'
      AND pg_get_functiondef(oid) ILIKE '%''stock_movement''%'
      AND pg_get_functiondef(oid) ILIKE '%''customer''%') THEN
    RAISE EXCEPTION 'Post: audit writer missing required mappings.' USING ERRCODE='raise_exception';
  END IF;

  -- stock_allocations: fulfilled_qty + its CHECKs + partially_fulfilled vocabulary.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='stock_allocations' AND column_name='fulfilled_qty') THEN
    RAISE EXCEPTION 'Post: stock_allocations.fulfilled_qty missing.' USING ERRCODE='raise_exception';
  END IF;
  SELECT COUNT(*) INTO n FROM pg_constraint WHERE conrelid='public.stock_allocations'::regclass AND contype='c'
    AND conname IN ('salloc_fulfilled_qty_non_negative','salloc_fulfilled_qty_le_qty','salloc_open_qty_zero','salloc_partial_qty_consistent','salloc_fulfilled_qty_full');
  IF n <> 5 THEN RAISE EXCEPTION 'Post: stock_allocations fulfilment CHECKs missing (%).', n USING ERRCODE='raise_exception'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='salloc_status_check'
      AND pg_get_constraintdef(oid) ILIKE '%open%' AND pg_get_constraintdef(oid) ILIKE '%partially_fulfilled%'
      AND pg_get_constraintdef(oid) ILIKE '%released%' AND pg_get_constraintdef(oid) ILIKE '%fulfilled%'
      AND pg_get_constraintdef(oid) ILIKE '%cancelled%') THEN
    RAISE EXCEPTION 'Post: salloc_status_check must allow open/partially_fulfilled/released/fulfilled/cancelled.' USING ERRCODE='raise_exception';
  END IF;

  -- sales_orders status CHECK: new P2M values + all originals (incl. allocated).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.sales_orders'::regclass AND contype='c' AND conname='so_status_check'
      AND pg_get_constraintdef(oid) ILIKE '%partially_dispatched%' AND pg_get_constraintdef(oid) ILIKE '%completed%'
      AND pg_get_constraintdef(oid) ILIKE '%draft%' AND pg_get_constraintdef(oid) ILIKE '%confirmed%'
      AND pg_get_constraintdef(oid) ILIKE '%allocated%' AND pg_get_constraintdef(oid) ILIKE '%partially_allocated%'
      AND pg_get_constraintdef(oid) ILIKE '%ready_to_dispatch%' AND pg_get_constraintdef(oid) ILIKE '%cancelled%') THEN
    RAISE EXCEPTION 'Post: so_status_check must allow all originals + partially_dispatched + completed.' USING ERRCODE='raise_exception';
  END IF;

  -- stock_movements vocabulary UNCHANGED (still contains dispatch).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='stock_movements_type_check'
      AND pg_get_constraintdef(oid) ILIKE '%dispatch%') THEN
    RAISE EXCEPTION 'Post: stock_movements_type_check must still contain dispatch.' USING ERRCODE='raise_exception';
  END IF;

  -- assert_dispatch_actor: SECURITY DEFINER + not PUBLIC-executable + not granted to authenticated.
  IF to_regprocedure('public.assert_dispatch_actor(uuid)') IS NULL THEN RAISE EXCEPTION 'Post: assert_dispatch_actor missing.' USING ERRCODE='raise_exception'; END IF;
  SELECT prosecdef INTO is_secdef FROM pg_proc WHERE oid='public.assert_dispatch_actor(uuid)'::regprocedure;
  IF NOT COALESCE(is_secdef,false) THEN RAISE EXCEPTION 'Post: assert_dispatch_actor must be SECURITY DEFINER.' USING ERRCODE='raise_exception'; END IF;
  IF has_function_privilege('public','public.assert_dispatch_actor(uuid)','EXECUTE') THEN RAISE EXCEPTION 'Post: PUBLIC must not EXECUTE assert_dispatch_actor.' USING ERRCODE='raise_exception'; END IF;
  IF has_function_privilege('authenticated','public.assert_dispatch_actor(uuid)','EXECUTE') THEN RAISE EXCEPTION 'Post: authenticated must not EXECUTE assert_dispatch_actor (internal guard).' USING ERRCODE='raise_exception'; END IF;

  -- recompute_sales_order_dispatch_status: SECURITY DEFINER + not PUBLIC + not authenticated.
  IF to_regprocedure('public.recompute_sales_order_dispatch_status(uuid)') IS NULL THEN RAISE EXCEPTION 'Post: recompute_sales_order_dispatch_status missing.' USING ERRCODE='raise_exception'; END IF;
  SELECT prosecdef INTO is_secdef FROM pg_proc WHERE oid='public.recompute_sales_order_dispatch_status(uuid)'::regprocedure;
  IF NOT COALESCE(is_secdef,false) THEN RAISE EXCEPTION 'Post: recompute dispatch helper must be SECURITY DEFINER.' USING ERRCODE='raise_exception'; END IF;
  IF has_function_privilege('public','public.recompute_sales_order_dispatch_status(uuid)','EXECUTE') THEN RAISE EXCEPTION 'Post: PUBLIC must not EXECUTE recompute dispatch helper.' USING ERRCODE='raise_exception'; END IF;

  -- next_dispatch_number + record_dispatch: SECURITY DEFINER + pinned path + authenticated-only.
  FOREACH sig IN ARRAY ARRAY[
    'public.next_dispatch_number(uuid)',
    'public.record_dispatch(uuid, jsonb, text)'
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

  -- Ledger-model guard: stock_items still has NO reserved/allocated column.
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='stock_items'
             AND column_name IN ('reserved_qty','allocated_qty','reserved_bottles','allocated_bottles')) THEN
    RAISE EXCEPTION 'Post: stock_items must not gain a reserved/allocated column.' USING ERRCODE='raise_exception';
  END IF;

  -- No seed data.
  SELECT COUNT(*) INTO n FROM public.dispatches;
  IF n <> 0 THEN RAISE EXCEPTION 'Post: dispatches must be empty (%).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM public.dispatch_lines;
  IF n <> 0 THEN RAISE EXCEPTION 'Post: dispatch_lines must be empty (%).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM public.dispatch_sequences;
  IF n <> 0 THEN RAISE EXCEPTION 'Post: dispatch_sequences must be empty (%).', n USING ERRCODE='raise_exception'; END IF;
END $$;

COMMIT;
