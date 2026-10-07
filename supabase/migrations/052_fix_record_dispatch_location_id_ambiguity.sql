-- ============================================================
-- WINERIX — P2M-2 CORRECTIVE FIX
-- 052: Resolve "column reference location_id is ambiguous" (SQLSTATE 42702)
--      in public.record_dispatch(uuid, jsonb, text).
-- Depends on: 051_dispatch_core.sql (creates record_dispatch).
--
-- DIAGNOSIS
--   record_dispatch RETURNS TABLE (... location_id uuid, qty_bottles integer ...).
--   Every RETURNS TABLE output column is an implicitly-declared PL/pgSQL variable
--   in the function body. Two SQL statements that touch public.stock_items read
--   those column names UNQUALIFIED, so PostgreSQL cannot tell the OUT variable
--   from the table column and raises 42702:
--
--     1) the "lock the physical balance" SELECT:
--          SELECT * INTO v_item FROM public.stock_items
--          WHERE org_id = ... AND product_id = ... AND location_id = ...  -- location_id ambiguous
--          FOR UPDATE;
--     2) the stock decrement UPDATE:
--          UPDATE public.stock_items
--             SET qty_bottles = qty_bottles - v_req_qty                   -- RHS qty_bottles ambiguous
--           WHERE id = v_item.id;
--
--   The failing call reported location_id first; qty_bottles would fail next.
--
-- FIX (minimal, behaviour-preserving)
--   Alias public.stock_items AS si and fully-qualify its column references in
--   those two statements (si.org_id / si.product_id / si.location_id, and
--   si.qty_bottles on the UPDATE's right-hand side). No variables renamed, no
--   business logic changed, no new columns, no second dispatch path. Every other
--   statement already qualifies via table-row variables (v_order, v_alloc,
--   v_item) or uses INSERT/SET targets that are not subject to this ambiguity, so
--   they are left exactly as-is.
--
--   This migration ONLY re-creates the function. It does not touch any table,
--   policy, grant posture (re-asserted identically below), the test data, the
--   RPC signature, the result columns, authentication, authorisation, locking,
--   atomicity, or the sales-order / allocation lifecycle. It is NOT a redesign.
-- ============================================================

BEGIN;

-- Fail fast if the function we are correcting is not present.
DO $$
BEGIN
  IF to_regprocedure('public.record_dispatch(uuid, jsonb, text)') IS NULL THEN
    RAISE EXCEPTION 'Pre: public.record_dispatch(uuid, jsonb, text) not found — apply 051 first.'
      USING ERRCODE = 'raise_exception';
  END IF;
END $$;

-- ------------------------------------------------------------
-- Re-create record_dispatch with the two stock_items statements qualified.
-- Body is identical to 051 except for the aliased/qualified stock_items access.
-- ------------------------------------------------------------
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
    -- FIX 052: alias stock_items AS si and qualify every column so location_id
    -- (and the other stock_items columns) cannot collide with the RETURNS TABLE
    -- output variable of the same name.
    SELECT si.* INTO v_item
    FROM public.stock_items AS si
    WHERE si.org_id = v_order.org_id
      AND si.product_id = v_alloc.finished_product_id
      AND si.location_id = v_alloc.location_id
    FOR UPDATE;
    IF v_item.id IS NULL THEN
      RAISE EXCEPTION 'There is no physical stock of this product at the allocation location (allocation %).', v_alloc_id USING ERRCODE = 'raise_exception';
    END IF;
    IF v_item.qty_bottles < v_req_qty THEN
      RAISE EXCEPTION 'Insufficient physical stock: % available, % requested (allocation %).', v_item.qty_bottles, v_req_qty, v_alloc_id USING ERRCODE = 'raise_exception';
    END IF;

    -- Decrement physical stock.
    -- FIX 052: alias stock_items AS si and qualify the right-hand-side read of
    -- qty_bottles so it cannot collide with the RETURNS TABLE output variable.
    UPDATE public.stock_items AS si
       SET qty_bottles = si.qty_bottles - v_req_qty
     WHERE si.id = v_item.id;

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

-- Re-assert the identical security posture (idempotent): PUBLIC cannot execute,
-- authenticated can. CREATE OR REPLACE preserves existing grants, but we restate
-- them so this migration is self-contained and the posture is explicit.
REVOKE ALL ON FUNCTION public.record_dispatch(UUID, JSONB, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_dispatch(UUID, JSONB, TEXT) TO authenticated;

-- ============================================================
-- POST-VALIDATION (catalog checks). RAISE => rollback.
-- ============================================================
DO $$
DECLARE
  v_oid       OID := to_regprocedure('public.record_dispatch(uuid, jsonb, text)');
  v_secdef    BOOLEAN;
  v_cfg       TEXT[];
  v_has_path  BOOLEAN;
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'Post: record_dispatch(uuid, jsonb, text) missing after replace.' USING ERRCODE='raise_exception';
  END IF;

  -- SECURITY DEFINER preserved.
  SELECT prosecdef INTO v_secdef FROM pg_proc WHERE oid = v_oid;
  IF NOT v_secdef THEN
    RAISE EXCEPTION 'Post: record_dispatch must remain SECURITY DEFINER.' USING ERRCODE='raise_exception';
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
    RAISE EXCEPTION 'Post: record_dispatch must pin search_path = public, pg_temp.' USING ERRCODE='raise_exception';
  END IF;

  -- authenticated EXECUTE present.
  IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'Post: authenticated must retain EXECUTE on record_dispatch.' USING ERRCODE='raise_exception';
  END IF;

  -- PUBLIC EXECUTE absent.
  IF has_function_privilege('public', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'Post: PUBLIC must NOT have EXECUTE on record_dispatch.' USING ERRCODE='raise_exception';
  END IF;

  RAISE NOTICE 'Post: record_dispatch corrected — SECURITY DEFINER, search_path pinned, authenticated EXECUTE, PUBLIC denied.';
END $$;

COMMIT;
