-- ============================================================
-- WINERIX — P2M-4: Dispatch Correction / Reversal
-- 053: Reverse a RECORDED dispatch via an atomic SECURITY DEFINER RPC using a
--      COMPENSATING-movement model. Preserves all history (never deletes/edits
--      the dispatch, its lines, or the original stock_movements).
-- Depends on: 040 (stock_items/stock_movements + stock_movements_type_check),
--             048 (stock_allocations fulfilment columns via 051),
--             050 (sales order lifecycle), 051 (dispatches/dispatch_lines +
--             recompute_sales_order_dispatch_status + has_org_role/is_org_member),
--             052 (record_dispatch ambiguity fix — unchanged here).
--
-- LOCKED DECISIONS (per approved P2M-4 architecture review):
--   1. Reversal movement_type = 'dispatch_reversal' (NOT a reused 'receipt').
--      The stock_movements_type_check vocabulary is extended, preserving ALL
--      existing values. reference_type = 'dispatch_reversal' (free TEXT, no
--      constraint change), reference_id = the ORIGINAL dispatch_line id.
--   2. Reversal roles = OWNER / ADMIN / CELLAR only. SALES is NOT permitted
--      (a dedicated guard assert_dispatch_reversal_actor; assert_dispatch_actor
--      from 051 — which includes SALES — is deliberately NOT reused).
--   3. dispatches gains nullable voided_at TIMESTAMPTZ + void_reason TEXT.
--      Both nullable so existing 'recorded' rows stay valid; void_reason is
--      REQUIRED (non-blank) by the RPC. A CHECK enforces the recorded/voided
--      coupling for NEW writes without invalidating existing recorded rows.
--   4. FULL dispatch reversal only. A dispatch is 'recorded' or 'voided'. A
--      voided dispatch cannot be reversed again (the status transition is the
--      idempotency guard).
--   5. Finance is NOT implemented. FUTURE: when Finance exists and posts on
--      dispatch/completion, voiding a completed dispatch MUST create a
--      compensating Finance entry (credit/reversal) traceable to
--      Customer -> Sales Order -> Dispatch. Documented, not built here.
--
-- THIS MIGRATION DOES NOT:
--   * modify record_dispatch, migration 051, or migration 052
--   * delete or edit any dispatch, dispatch_line, or existing stock_movement
--   * modify stock_allocations.qty_bottles or delete allocation rows
--   * add a reserved/allocated column to stock_items
--   * create a second audit system (reuses audit_log_row_change triggers)
--   * touch Finance, P2N compliance, or the P2M-3 UI
--   * create seed/test data or backfill historical reversals
-- ============================================================

BEGIN;

-- ============================================================
-- 0. PRE-FLIGHT (fail fast; never silently create dependencies)
-- ============================================================
DO $$
BEGIN
  IF to_regclass('public.dispatches') IS NULL THEN RAISE EXCEPTION 'Pre-flight: dispatches missing (051).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.dispatch_lines') IS NULL THEN RAISE EXCEPTION 'Pre-flight: dispatch_lines missing (051).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.stock_items') IS NULL THEN RAISE EXCEPTION 'Pre-flight: stock_items missing (040).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.stock_movements') IS NULL THEN RAISE EXCEPTION 'Pre-flight: stock_movements missing (040).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.stock_allocations') IS NULL THEN RAISE EXCEPTION 'Pre-flight: stock_allocations missing (048).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.sales_orders') IS NULL THEN RAISE EXCEPTION 'Pre-flight: sales_orders missing (046).' USING ERRCODE='undefined_table'; END IF;
  IF to_regprocedure('public.recompute_sales_order_dispatch_status(uuid)') IS NULL THEN RAISE EXCEPTION 'Pre-flight: recompute_sales_order_dispatch_status missing (051).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.is_org_member(uuid)') IS NULL THEN RAISE EXCEPTION 'Pre-flight: is_org_member missing (006).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.has_org_role(uuid, text[])') IS NULL THEN RAISE EXCEPTION 'Pre-flight: has_org_role missing (006).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.audit_log_row_change()') IS NULL THEN RAISE EXCEPTION 'Pre-flight: audit_log_row_change missing (021).' USING ERRCODE='undefined_function'; END IF;
  -- The movement vocabulary we are extending must be present and must already
  -- contain 'dispatch' (051 relies on it).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='stock_movements_type_check'
                 AND pg_get_constraintdef(oid) ILIKE '%dispatch%') THEN
    RAISE EXCEPTION 'Pre-flight: stock_movements_type_check (040) not found or missing dispatch.' USING ERRCODE='raise_exception';
  END IF;
  -- Reversal must not already exist (idempotent re-run guard at the DDL level).
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='stock_items'
             AND column_name IN ('reserved_qty','allocated_qty','reserved_bottles','allocated_bottles')) THEN
    RAISE EXCEPTION 'Pre-flight: stock_items must not have a reserved/allocated column.' USING ERRCODE='raise_exception';
  END IF;
END $$;

-- ============================================================
-- 1. STOCK_MOVEMENTS — extend the movement_type vocabulary with
-- 'dispatch_reversal'. Preserves ALL existing values. Existing rows only hold
-- values that remain in the new set, so the re-add never fails on current data.
-- ============================================================
ALTER TABLE public.stock_movements DROP CONSTRAINT IF EXISTS stock_movements_type_check;
ALTER TABLE public.stock_movements
  ADD CONSTRAINT stock_movements_type_check CHECK (movement_type IN (
    'receipt','transfer_in','transfer_out','adjustment','damage','sale','dispatch','dispatch_reversal'
  ));

-- ============================================================
-- 2. DISPATCHES — add nullable void metadata (backward-compatible).
-- Existing 'recorded' rows (voided_at/void_reason NULL) remain valid.
-- A CHECK couples status<->void metadata for correctness going forward:
--   recorded => voided_at IS NULL  AND void_reason IS NULL
--   voided   => voided_at IS NOT NULL AND void_reason is non-blank
-- ============================================================
ALTER TABLE public.dispatches ADD COLUMN IF NOT EXISTS voided_at   TIMESTAMPTZ;
ALTER TABLE public.dispatches ADD COLUMN IF NOT EXISTS void_reason TEXT;

ALTER TABLE public.dispatches DROP CONSTRAINT IF EXISTS dispatch_void_consistency;
ALTER TABLE public.dispatches
  ADD CONSTRAINT dispatch_void_consistency CHECK (
    (status = 'recorded' AND voided_at IS NULL AND void_reason IS NULL)
    OR
    (status = 'voided'   AND voided_at IS NOT NULL AND void_reason IS NOT NULL AND length(btrim(void_reason)) > 0)
  );

-- ============================================================
-- 3. assert_dispatch_reversal_actor — resolve caller + membership + REVERSAL
-- role (OWNER/ADMIN/CELLAR only — SALES is deliberately excluded, stricter than
-- assert_dispatch_actor). Internal guard: never granted to PUBLIC or authenticated.
-- Mirrors assert_dispatch_actor (051) / assert_stock_admin_actor (043).
-- ============================================================
CREATE OR REPLACE FUNCTION public.assert_dispatch_reversal_actor(target_org UUID)
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
  IF NOT public.has_org_role(target_org, ARRAY['OWNER','ADMIN','CELLAR']) THEN
    RAISE EXCEPTION 'Reversing a dispatch requires an Owner, Admin or Cellar role.' USING ERRCODE = 'raise_exception';
  END IF;
  RETURN uid;
END;
$$;
REVOKE ALL ON FUNCTION public.assert_dispatch_reversal_actor(UUID) FROM PUBLIC;

-- ============================================================
-- 4. reverse_dispatch — the single atomic physical-reversal operation.
-- Voids a 'recorded' dispatch: restores physical stock via compensating
-- 'dispatch_reversal' movements (one per line, positive delta), walks the
-- allocation fulfilment back down, recomputes the sales order dispatch status
-- (reusing recompute_sales_order_dispatch_status — NOT duplicated), and flips
-- the header to 'voided' with a required reason. Everything historical is
-- preserved; the original dispatch, lines, and stock_movements are untouched.
--
-- Lock order (identical to record_dispatch, deadlock-safe):
--   sales_orders -> stock_allocations -> stock_items (all FOR UPDATE).
-- Dispatch lines are processed in deterministic order (by id).
--
-- Idempotency: the recorded -> voided transition is the guard. A second attempt
-- finds status 'voided' (committed under the dispatch-row lock) and fails
-- cleanly: no stock added, no movement, no allocation change, no status change.
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
  -- (1) Authentication (fail closed).
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.' USING ERRCODE = 'raise_exception';
  END IF;

  -- (6) Reason is required; trim and reject blank.
  v_reason := btrim(COALESCE(p_reason, ''));
  IF v_reason = '' THEN
    RAISE EXCEPTION 'A reversal reason is required.' USING ERRCODE = 'raise_exception';
  END IF;

  -- (2,3) Lock the dispatch row FOR UPDATE; verify it exists. Org is derived
  -- from the row — never trusted from the client.
  SELECT * INTO v_dispatch FROM public.dispatches WHERE id = p_dispatch_id FOR UPDATE;
  IF v_dispatch.id IS NULL THEN
    RAISE EXCEPTION 'Dispatch % not found.', p_dispatch_id USING ERRCODE = 'raise_exception';
  END IF;

  -- (4) Authorisation: membership + OWNER/ADMIN/CELLAR for the dispatch's org.
  v_actor := public.assert_dispatch_reversal_actor(v_dispatch.org_id);

  -- (5) Must be a RECORDED dispatch. If already voided, reject cleanly — this is
  -- the idempotency guard (status committed under the row lock above).
  IF v_dispatch.status <> 'recorded' THEN
    RAISE EXCEPTION 'Dispatch % cannot be reversed (status is "%").', v_dispatch.dispatch_number, v_dispatch.status USING ERRCODE = 'raise_exception';
  END IF;

  -- (7) Lock the parent sales order FOR UPDATE (next in the fixed lock order).
  SELECT * INTO v_order FROM public.sales_orders WHERE id = v_dispatch.sales_order_id FOR UPDATE;
  IF v_order.id IS NULL THEN
    RAISE EXCEPTION 'Sales order for dispatch % not found.', v_dispatch.dispatch_number USING ERRCODE = 'raise_exception';
  END IF;

  -- (8,9,10,11,12,13) Process each original dispatch line in deterministic order.
  -- The lines are READ ONLY here (never modified). For each: lock the allocation,
  -- lock the stock item, add stock back, write ONE compensating movement, and
  -- walk the allocation fulfilment down.
  FOR v_line IN
    SELECT * FROM public.dispatch_lines
    WHERE dispatch_id = v_dispatch.id
    ORDER BY stock_allocation_id, id
  LOOP
    -- Lock the allocation this line fulfilled.
    SELECT * INTO v_alloc FROM public.stock_allocations WHERE id = v_line.stock_allocation_id FOR UPDATE;
    IF v_alloc.id IS NULL THEN
      RAISE EXCEPTION 'Stock allocation % for dispatch line % not found.', v_line.stock_allocation_id, v_line.id USING ERRCODE = 'raise_exception';
    END IF;

    -- The allocation must currently reflect this fulfilment (defence in depth):
    -- it must be fulfilled/partially_fulfilled and have enough fulfilled_qty to
    -- unwind this line. A released/cancelled/open allocation here is a corrupt
    -- state we refuse rather than silently drive fulfilled_qty negative.
    IF v_alloc.status NOT IN ('fulfilled','partially_fulfilled') THEN
      RAISE EXCEPTION 'Allocation % is not in a fulfilled state (status "%") and cannot be reversed.', v_alloc.id, v_alloc.status USING ERRCODE = 'raise_exception';
    END IF;
    IF v_alloc.fulfilled_qty < v_line.qty_bottles THEN
      RAISE EXCEPTION 'Allocation % has fulfilled_qty % but dispatch line reversed % — refusing to go negative.', v_alloc.id, v_alloc.fulfilled_qty, v_line.qty_bottles USING ERRCODE = 'raise_exception';
    END IF;

    -- (11) Lock the physical stock_items row (org + line product + line location)
    -- FOR UPDATE and add the dispatched quantity back. Identities come from the
    -- immutable dispatch line (which record_dispatch derived from the allocation).
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

    -- (11) ONE compensating movement per line: positive delta, explicitly typed
    -- 'dispatch_reversal', linked back to the ORIGINAL dispatch_line id. The
    -- original 'dispatch' movement is left untouched.
    INSERT INTO public.stock_movements
      (org_id, owner_id, stock_item_id, product_id, location_id, movement_type,
       qty_bottles_delta, reference_type, reference_id, transfer_group_id, notes, occurred_at)
    VALUES
      (v_dispatch.org_id, v_actor, v_item.id, v_line.finished_product_id, v_line.location_id, 'dispatch_reversal',
       v_line.qty_bottles, 'dispatch_reversal', v_line.id, NULL,
       format('Reversal of dispatch %s', v_dispatch.dispatch_number), v_voided_at);

    -- (12,13) Walk the allocation fulfilment down. qty_bottles is NEVER modified.
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

  -- A recorded dispatch always has at least one line; guard anyway.
  IF v_reversed_lines = 0 THEN
    RAISE EXCEPTION 'Dispatch % has no lines to reverse.', v_dispatch.dispatch_number USING ERRCODE = 'raise_exception';
  END IF;

  -- (15) Flip the header to voided with the required reason. Dispatch + lines +
  -- original movements are preserved (status/voided_at/void_reason only).
  UPDATE public.dispatches
     SET status = 'voided', voided_at = v_voided_at, void_reason = v_reason
   WHERE id = v_dispatch.id;

  -- (14) Recompute the order dispatch status from fulfilled quantities (order is
  -- locked). Reuses the existing helper — logic is NOT duplicated here. Walks
  -- completed -> partially_dispatched -> ready_to_dispatch as fulfilment drops.
  v_order_status := public.recompute_sales_order_dispatch_status(v_order.id);

  -- Audit is produced by the EXISTING triggers: trg_audit_dispatches (UPDATE),
  -- trg_audit_stock_movements (INSERT), trg_audit_stock_allocations (UPDATE),
  -- trg_audit_stock_items (UPDATE). No manual audit insert here.

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
-- 5. POST-VALIDATION (catalog checks). RAISE => rollback.
-- ============================================================
DO $$
DECLARE
  v_oid       OID;
  v_secdef    BOOLEAN;
  v_cfg       TEXT[];
  v_has_path  BOOLEAN;
BEGIN
  -- movement_type vocabulary extended (and preserved).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='stock_movements_type_check'
      AND pg_get_constraintdef(oid) ILIKE '%dispatch_reversal%') THEN
    RAISE EXCEPTION 'Post: stock_movements_type_check must allow dispatch_reversal.' USING ERRCODE='raise_exception';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='stock_movements_type_check'
      AND pg_get_constraintdef(oid) ILIKE '%receipt%'
      AND pg_get_constraintdef(oid) ILIKE '%dispatch%'
      AND pg_get_constraintdef(oid) ILIKE '%adjustment%'
      AND pg_get_constraintdef(oid) ILIKE '%damage%') THEN
    RAISE EXCEPTION 'Post: stock_movements_type_check lost a pre-existing value.' USING ERRCODE='raise_exception';
  END IF;

  -- dispatches void columns exist.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='dispatches' AND column_name='voided_at') THEN
    RAISE EXCEPTION 'Post: dispatches.voided_at missing.' USING ERRCODE='raise_exception'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='dispatches' AND column_name='void_reason') THEN
    RAISE EXCEPTION 'Post: dispatches.void_reason missing.' USING ERRCODE='raise_exception'; END IF;

  -- void-consistency CHECK present.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='dispatch_void_consistency' AND conrelid='public.dispatches'::regclass) THEN
    RAISE EXCEPTION 'Post: dispatch_void_consistency CHECK missing.' USING ERRCODE='raise_exception'; END IF;

  -- Existing 'recorded' rows remain valid under the new CHECK (voided_at/
  -- void_reason default NULL). Confirm none violate it.
  IF EXISTS (SELECT 1 FROM public.dispatches WHERE status='recorded' AND (voided_at IS NOT NULL OR void_reason IS NOT NULL)) THEN
    RAISE EXCEPTION 'Post: a recorded dispatch unexpectedly has void metadata.' USING ERRCODE='raise_exception'; END IF;

  -- dispatch status CHECK still allows recorded + voided (unchanged from 051).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='dispatch_status_check'
      AND pg_get_constraintdef(oid) ILIKE '%recorded%' AND pg_get_constraintdef(oid) ILIKE '%voided%') THEN
    RAISE EXCEPTION 'Post: dispatch_status_check must still allow recorded/voided.' USING ERRCODE='raise_exception'; END IF;

  -- assert_dispatch_reversal_actor: SECURITY DEFINER, not PUBLIC, not authenticated.
  v_oid := to_regprocedure('public.assert_dispatch_reversal_actor(uuid)');
  IF v_oid IS NULL THEN RAISE EXCEPTION 'Post: assert_dispatch_reversal_actor missing.' USING ERRCODE='raise_exception'; END IF;
  SELECT prosecdef INTO v_secdef FROM pg_proc WHERE oid=v_oid;
  IF NOT v_secdef THEN RAISE EXCEPTION 'Post: assert_dispatch_reversal_actor must be SECURITY DEFINER.' USING ERRCODE='raise_exception'; END IF;
  IF has_function_privilege('public', v_oid, 'EXECUTE') THEN RAISE EXCEPTION 'Post: PUBLIC must not execute assert_dispatch_reversal_actor.' USING ERRCODE='raise_exception'; END IF;
  IF has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN RAISE EXCEPTION 'Post: authenticated must not execute assert_dispatch_reversal_actor (internal guard).' USING ERRCODE='raise_exception'; END IF;

  -- reverse_dispatch: exists, SECURITY DEFINER, search_path pinned, PUBLIC
  -- revoked, authenticated granted.
  v_oid := to_regprocedure('public.reverse_dispatch(uuid, text)');
  IF v_oid IS NULL THEN RAISE EXCEPTION 'Post: reverse_dispatch(uuid, text) missing.' USING ERRCODE='raise_exception'; END IF;
  SELECT prosecdef INTO v_secdef FROM pg_proc WHERE oid=v_oid;
  IF NOT v_secdef THEN RAISE EXCEPTION 'Post: reverse_dispatch must be SECURITY DEFINER.' USING ERRCODE='raise_exception'; END IF;
  SELECT proconfig INTO v_cfg FROM pg_proc WHERE oid=v_oid;
  v_has_path := EXISTS (SELECT 1 FROM unnest(COALESCE(v_cfg, ARRAY[]::TEXT[])) c
                        WHERE c LIKE 'search_path=%' AND position('public' IN c)>0 AND position('pg_temp' IN c)>0);
  IF NOT v_has_path THEN RAISE EXCEPTION 'Post: reverse_dispatch must pin search_path = public, pg_temp.' USING ERRCODE='raise_exception'; END IF;
  IF has_function_privilege('public', v_oid, 'EXECUTE') THEN RAISE EXCEPTION 'Post: PUBLIC must not execute reverse_dispatch.' USING ERRCODE='raise_exception'; END IF;
  IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN RAISE EXCEPTION 'Post: authenticated must execute reverse_dispatch.' USING ERRCODE='raise_exception'; END IF;

  -- Dispatch tables keep SELECT-only RLS (no write policy introduced here).
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename IN ('dispatches','dispatch_lines') AND cmd IN ('INSERT','UPDATE','DELETE')) THEN
    RAISE EXCEPTION 'Post: no direct write policy may exist on dispatch tables.' USING ERRCODE='raise_exception';
  END IF;

  -- stock_items still has no reserved/allocated column.
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='stock_items'
             AND column_name IN ('reserved_qty','allocated_qty','reserved_bottles','allocated_bottles')) THEN
    RAISE EXCEPTION 'Post: stock_items must not have a reserved/allocated column.' USING ERRCODE='raise_exception';
  END IF;

  RAISE NOTICE 'Post: P2M-4 dispatch reversal installed — reverse_dispatch ready (OWNER/ADMIN/CELLAR, dispatch_reversal movements, compensating model).';
END $$;

COMMIT;
