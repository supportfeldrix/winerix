-- ============================================================
-- WINERIX — P2L-6 FIX: allocate_stock_for_sales_order_line ambiguous columns
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- Depends on: 048 (stock_allocations + allocate/release RPCs + helpers).
--
-- ROOT CAUSE:
--   In migration 048 the RPC allocate_stock_for_sales_order_line used a
--   RETURNS TABLE whose output-column names (sales_order_id, sales_order_line_id,
--   finished_product_id, location_id, qty_bottles, ...) are ALSO column names on
--   public.stock_allocations. In PL/pgSQL every RETURNS TABLE column is an
--   in-scope variable for the whole function body, so the INSERT ... VALUES into
--   public.stock_allocations referenced identifiers that matched BOTH a table
--   column AND an output variable. Under the default plpgsql.variable_conflict
--   setting this raises SQLSTATE 42702 "column reference is ambiguous", which the
--   client surfaced as a generic failure. No allocation was ever written.
--
-- FIX:
--   CREATE OR REPLACE the function with the SAME signature
--   (uuid, uuid, integer, text) but RENAMED output columns (out_* prefix) so no
--   output variable collides with any table column. The body is otherwise
--   identical. All security properties are preserved:
--     * SECURITY DEFINER
--     * SET search_path = public, pg_temp
--     * REVOKE PUBLIC / GRANT EXECUTE TO authenticated (anon never granted)
--     * assert_sales_actor (OWNER/ADMIN/SALES) enforcement
--     * organisation isolation (org derived from the line; same-org checks)
--     * sales order row lock + stock_items row lock (oversell protection)
--     * never mutates stock_items; never creates stock_movements
--     * audit behaviour unchanged (the INSERT still fires trg_audit_stock_allocations)
--
-- NOTE: because the RETURNS TABLE column names change, this uses
--   DROP FUNCTION + CREATE (Postgres cannot CREATE OR REPLACE a function whose
--   OUT parameters changed). The signature (argument types) is unchanged, so the
--   GRANT is re-applied. Migration 048 is NOT edited in place.
--
-- THIS MIGRATION DOES NOT:
--   * change the table, RLS, grants, audit mapping, or the release RPC
--   * change the allocation logic, validation order, or returned values
--   * alter stock_items / stock_movements / sales_orders / sales_order_lines
-- ============================================================

BEGIN;

-- ============================================================
-- 0. PRE-FLIGHT
-- ============================================================
DO $$
BEGIN
  IF to_regclass('public.stock_allocations') IS NULL THEN RAISE EXCEPTION 'Pre-flight: stock_allocations missing (048).' USING ERRCODE='undefined_table'; END IF;
  IF to_regprocedure('public.assert_sales_actor(uuid)') IS NULL THEN RAISE EXCEPTION 'Pre-flight: assert_sales_actor missing (048).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.recompute_sales_order_allocation_status(uuid)') IS NULL THEN RAISE EXCEPTION 'Pre-flight: recompute_sales_order_allocation_status missing (048).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.allocate_stock_for_sales_order_line(uuid, uuid, integer, text)') IS NULL THEN RAISE EXCEPTION 'Pre-flight: allocate_stock_for_sales_order_line missing (048).' USING ERRCODE='undefined_function'; END IF;
END $$;

-- ============================================================
-- 1. REPLACE the RPC with non-colliding RETURNS TABLE column names.
-- ============================================================
DROP FUNCTION IF EXISTS public.allocate_stock_for_sales_order_line(uuid, uuid, integer, text);

CREATE OR REPLACE FUNCTION public.allocate_stock_for_sales_order_line(
  p_sales_order_line_id UUID,
  p_location_id         UUID,
  p_qty_bottles         INTEGER,
  p_notes               TEXT DEFAULT NULL
)
RETURNS TABLE (
  out_allocation_id       UUID,
  out_sales_order_id      UUID,
  out_sales_order_line_id UUID,
  out_finished_product_id UUID,
  out_location_id         UUID,
  out_qty_bottles         INTEGER,
  out_order_status        TEXT,
  out_line_ordered        INTEGER,
  out_line_allocated_open INTEGER,
  out_line_remaining      INTEGER,
  out_location_physical   INTEGER,
  out_location_reserved   INTEGER,
  out_location_available  INTEGER
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

  -- Quantity validation (cheap; do it early).
  IF p_qty_bottles IS NULL OR p_qty_bottles <= 0 THEN
    RAISE EXCEPTION 'Allocation quantity must be a positive number of bottles.' USING ERRCODE = 'raise_exception';
  END IF;

  -- Resolve the order line (org derived from it, never from the client).
  SELECT * INTO v_line FROM public.sales_order_lines WHERE id = p_sales_order_line_id;
  IF v_line.id IS NULL THEN
    RAISE EXCEPTION 'Sales order line % not found.', p_sales_order_line_id USING ERRCODE = 'raise_exception';
  END IF;

  -- 2+3. Authorisation: active membership + OWNER/ADMIN/SALES for the line's org.
  v_owner := public.assert_sales_actor(v_line.org_id);

  -- 4. Lock the parent sales order FOR UPDATE.
  SELECT * INTO v_order FROM public.sales_orders WHERE id = v_line.sales_order_id FOR UPDATE;
  IF v_order.id IS NULL THEN
    RAISE EXCEPTION 'Sales order % not found.', v_line.sales_order_id USING ERRCODE = 'raise_exception';
  END IF;

  -- 5. Order must be in an allocatable lifecycle state.
  IF v_order.status NOT IN ('confirmed','partially_allocated','ready_to_dispatch') THEN
    RAISE EXCEPTION 'Stock can only be allocated to a confirmed sales order (status is "%").', v_order.status USING ERRCODE = 'raise_exception';
  END IF;

  -- 6. Line must belong to the order (defence in depth).
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
  -- exist. This is the oversale-protection point: all availability maths and the
  -- INSERT happen while this row is locked.
  SELECT * INTO v_item FROM public.stock_items
  WHERE org_id = v_line.org_id AND product_id = v_line.finished_product_id AND location_id = p_location_id
  FOR UPDATE;
  IF v_item.id IS NULL THEN
    RAISE EXCEPTION 'There is no stock of this product at the selected location.' USING ERRCODE = 'raise_exception';
  END IF;

  -- 9+10+11. physical, reserved (OPEN allocations at this product/location),
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
  -- Column references are now unambiguous (no OUT var shares a column name).
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

  -- 15. Return the created allocation + useful availability figures.
  out_allocation_id       := v_new_id;
  out_sales_order_id      := v_line.sales_order_id;
  out_sales_order_line_id := v_line.id;
  out_finished_product_id := v_line.finished_product_id;
  out_location_id         := p_location_id;
  out_qty_bottles         := p_qty_bottles;
  out_order_status        := v_new_status;
  out_line_ordered        := v_line.quantity_bottles;
  out_line_allocated_open := v_open_line + p_qty_bottles;
  out_line_remaining      := v_remaining - p_qty_bottles;
  out_location_physical   := v_physical;
  out_location_reserved   := v_reserved + p_qty_bottles;
  out_location_available  := v_available - p_qty_bottles;
  RETURN NEXT;
END;
$$;

-- Re-apply permissions (signature unchanged; re-grant after DROP/CREATE).
REVOKE ALL ON FUNCTION public.allocate_stock_for_sales_order_line(UUID, UUID, INTEGER, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.allocate_stock_for_sales_order_line(UUID, UUID, INTEGER, TEXT) TO authenticated;

-- ============================================================
-- 2. POST-VALIDATION. RAISE => rollback.
-- ============================================================
DO $$
DECLARE v_oid OID; is_secdef BOOLEAN; cfg TEXT[]; n INTEGER;
BEGIN
  v_oid := to_regprocedure('public.allocate_stock_for_sales_order_line(uuid, uuid, integer, text)');
  IF v_oid IS NULL THEN RAISE EXCEPTION 'Post: allocate RPC missing after replace.' USING ERRCODE='raise_exception'; END IF;

  SELECT prosecdef INTO is_secdef FROM pg_proc WHERE oid=v_oid;
  IF NOT COALESCE(is_secdef,false) THEN RAISE EXCEPTION 'Post: allocate RPC must be SECURITY DEFINER.' USING ERRCODE='raise_exception'; END IF;

  SELECT proconfig INTO cfg FROM pg_proc WHERE oid=v_oid;
  IF NOT EXISTS (SELECT 1 FROM unnest(COALESCE(cfg,ARRAY[]::TEXT[])) c WHERE c LIKE 'search_path=%' AND position('public' IN c)>0 AND position('pg_temp' IN c)>0) THEN
    RAISE EXCEPTION 'Post: allocate RPC must pin search_path = public, pg_temp.' USING ERRCODE='raise_exception';
  END IF;

  IF has_function_privilege('public', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'Post: PUBLIC must not EXECUTE allocate RPC.' USING ERRCODE='raise_exception'; END IF;
  IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'Post: authenticated must EXECUTE allocate RPC.' USING ERRCODE='raise_exception'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') AND has_function_privilege('anon', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'Post: anon must not EXECUTE allocate RPC.' USING ERRCODE='raise_exception'; END IF;

  -- Output columns must use the out_* names (no collision with table columns).
  SELECT COUNT(*) INTO n FROM unnest(COALESCE((SELECT proargnames FROM pg_proc WHERE oid=v_oid), ARRAY[]::TEXT[])) nm
  WHERE nm LIKE 'out\_%';
  IF n <> 13 THEN RAISE EXCEPTION 'Post: allocate RPC must expose 13 out_* columns (found %).', n USING ERRCODE='raise_exception'; END IF;

  -- The body must reference the stock_allocations INSERT (still RPC-authoritative).
  IF pg_get_functiondef(v_oid) NOT ILIKE '%insert into public.stock_allocations%' THEN
    RAISE EXCEPTION 'Post: allocate RPC must still INSERT into stock_allocations.' USING ERRCODE='raise_exception';
  END IF;

  -- Did NOT create any allocation as a side effect.
  SELECT COUNT(*) INTO n FROM public.stock_allocations;
  IF n <> 0 THEN RAISE EXCEPTION 'Post: stock_allocations must still be empty (found %).', n USING ERRCODE='raise_exception'; END IF;
END $$;

COMMIT;
