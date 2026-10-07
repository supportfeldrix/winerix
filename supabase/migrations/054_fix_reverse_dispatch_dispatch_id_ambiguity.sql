-- ============================================================
-- WINERIX — P2M-4 CORRECTIVE FIX
-- 054: Resolve "column reference dispatch_id is ambiguous" (SQLSTATE 42702)
--      in public.reverse_dispatch(uuid, text).
-- Depends on: 053_dispatch_reversal.sql (creates reverse_dispatch).
--
-- DIAGNOSIS
--   reverse_dispatch RETURNS TABLE (dispatch_id uuid, ... sales_order_id uuid, ...).
--   Every RETURNS TABLE output column is an implicitly-declared PL/pgSQL variable
--   in the function body. The per-line cursor loop referenced the dispatch_lines
--   column `dispatch_id` UNQUALIFIED:
--
--       FOR v_line IN
--         SELECT * FROM public.dispatch_lines
--         WHERE dispatch_id = v_dispatch.id          -- dispatch_id ambiguous (42702)
--         ORDER BY stock_allocation_id, id
--       LOOP
--
--   PostgreSQL cannot tell the OUT variable `dispatch_id` from the
--   dispatch_lines column `dispatch_id`, so it raises 42702 the moment the loop
--   query is planned — before any row is touched (no business data was changed).
--
--   This is the only genuine ambiguity in the function. Every other reference is
--   already qualified via a row variable (v_dispatch./v_line./v_alloc./v_item.),
--   uses the aliased stock_items (si.) form, or is an UPDATE SET-target (which is
--   not subject to this ambiguity). `sales_order_id` is also an OUT variable but
--   is never referenced as an unqualified column in the body.
--
-- FIX (minimal, behaviour-preserving)
--   Alias public.dispatch_lines AS dl in the loop query and fully-qualify its
--   columns (dl.dispatch_id, dl.stock_allocation_id, dl.id) so none can collide
--   with a RETURNS TABLE output variable. No variable renamed, no business logic
--   changed. Mirrors the 052 fix for record_dispatch (stock_items AS si).
--
--   This migration ONLY re-creates the function. It does not touch any table,
--   constraint, policy, grant posture (re-asserted identically below), the test
--   data, the RPC signature, the result columns, authentication, authorisation,
--   roles (OWNER/ADMIN/CELLAR only; SALES excluded), locking order, atomicity,
--   idempotency, audit behaviour, or the allocation/stock/order logic.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- PRE-FLIGHT: the function we are correcting must already exist (053 applied).
-- ------------------------------------------------------------
DO $$
BEGIN
  IF to_regprocedure('public.reverse_dispatch(uuid, text)') IS NULL THEN
    RAISE EXCEPTION 'Pre: public.reverse_dispatch(uuid, text) not found — apply 053 first.'
      USING ERRCODE = 'raise_exception';
  END IF;
  IF to_regprocedure('public.assert_dispatch_reversal_actor(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Pre: public.assert_dispatch_reversal_actor(uuid) not found — apply 053 first.'
      USING ERRCODE = 'raise_exception';
  END IF;
  IF to_regprocedure('public.recompute_sales_order_dispatch_status(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Pre: recompute_sales_order_dispatch_status missing (051).'
      USING ERRCODE = 'raise_exception';
  END IF;
END $$;

-- ------------------------------------------------------------
-- Re-create reverse_dispatch with the loop query's dispatch_lines columns
-- qualified. Body is identical to 053 except for that aliased/qualified SELECT.
-- ------------------------------------------------------------
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
  -- FIX 054: alias dispatch_lines AS dl and qualify its columns so dispatch_id
  -- (a RETURNS TABLE output variable of the same name) cannot be ambiguous.
  FOR v_line IN
    SELECT dl.* FROM public.dispatch_lines AS dl
    WHERE dl.dispatch_id = v_dispatch.id
    ORDER BY dl.stock_allocation_id, dl.id
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

-- Re-assert the identical security posture (idempotent): PUBLIC cannot execute,
-- authenticated can. CREATE OR REPLACE preserves existing grants, but we restate
-- them so this migration is self-contained and the posture is explicit.
REVOKE ALL ON FUNCTION public.reverse_dispatch(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reverse_dispatch(UUID, TEXT) TO authenticated;

-- ============================================================
-- POST-VALIDATION (catalog checks). RAISE => rollback.
-- ============================================================
DO $$
DECLARE
  v_oid       OID := to_regprocedure('public.reverse_dispatch(uuid, text)');
  v_secdef    BOOLEAN;
  v_cfg       TEXT[];
  v_has_path  BOOLEAN;
  v_argtypes  TEXT;
  v_rettype   TEXT;
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'Post: reverse_dispatch(uuid, text) missing after replace.' USING ERRCODE='raise_exception';
  END IF;

  -- Signature unchanged: (uuid, text).
  SELECT pg_get_function_identity_arguments(v_oid) INTO v_argtypes;
  IF v_argtypes <> 'p_dispatch_id uuid, p_reason text' THEN
    RAISE EXCEPTION 'Post: reverse_dispatch signature changed (got "%").', v_argtypes USING ERRCODE='raise_exception';
  END IF;

  -- Still a set-returning (RETURNS TABLE) function.
  SELECT p.proretset::text INTO v_rettype FROM pg_proc p WHERE p.oid = v_oid;
  IF v_rettype <> 'true' THEN
    RAISE EXCEPTION 'Post: reverse_dispatch must remain a set-returning (RETURNS TABLE) function.' USING ERRCODE='raise_exception';
  END IF;

  -- SECURITY DEFINER preserved.
  SELECT prosecdef INTO v_secdef FROM pg_proc WHERE oid = v_oid;
  IF NOT v_secdef THEN
    RAISE EXCEPTION 'Post: reverse_dispatch must remain SECURITY DEFINER.' USING ERRCODE='raise_exception';
  END IF;

  -- search_path = public, pg_temp preserved.
  SELECT proconfig INTO v_cfg FROM pg_proc WHERE oid = v_oid;
  v_has_path := EXISTS (
    SELECT 1 FROM unnest(COALESCE(v_cfg, ARRAY[]::TEXT[])) AS c
    WHERE c LIKE 'search_path=%'
      AND position('public' IN c) > 0
      AND position('pg_temp' IN c) > 0
  );
  IF NOT v_has_path THEN
    RAISE EXCEPTION 'Post: reverse_dispatch must pin search_path = public, pg_temp.' USING ERRCODE='raise_exception';
  END IF;

  -- authenticated EXECUTE present; PUBLIC EXECUTE absent.
  IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'Post: authenticated must retain EXECUTE on reverse_dispatch.' USING ERRCODE='raise_exception';
  END IF;
  IF has_function_privilege('public', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'Post: PUBLIC must NOT have EXECUTE on reverse_dispatch.' USING ERRCODE='raise_exception';
  END IF;

  -- The reversal role guard remains internal (defence in depth; unchanged by 054).
  IF has_function_privilege('authenticated', 'public.assert_dispatch_reversal_actor(uuid)', 'EXECUTE')
     OR has_function_privilege('public', 'public.assert_dispatch_reversal_actor(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Post: assert_dispatch_reversal_actor must remain internal (no PUBLIC/authenticated EXECUTE).' USING ERRCODE='raise_exception';
  END IF;

  RAISE NOTICE 'Post: reverse_dispatch corrected — dispatch_id ambiguity fixed; SECURITY DEFINER, search_path pinned, authenticated EXECUTE, PUBLIC denied, signature unchanged.';
END $$;

COMMIT;
