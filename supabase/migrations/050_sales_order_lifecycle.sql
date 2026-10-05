-- ============================================================
-- WINERIX — P2L-7: Sales Order Lifecycle Management (controlled cancellation)
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- Depends on: 001 (update_updated_at), 006 (organisations, is_org_member,
--             has_org_role), 021 (audit writer), 046 (sales_orders + status
--             CHECK), 047 (sales_order_lines + confirm RPC + draft-only UPDATE
--             policy), 048 (stock_allocations + assert_sales_actor +
--             recompute_sales_order_allocation_status), 049 (allocate RPC fix).
--
-- PURPOSE:
--   Add the one lifecycle transition not yet covered: CANCELLATION. The forward
--   lifecycle (draft -> confirmed -> partially_allocated -> ready_to_dispatch)
--   is already handled by:
--     * confirm_sales_order (047)                              draft -> confirmed
--     * allocate/release + recompute_sales_order_allocation_status (048/049)
--         confirmed <-> partially_allocated <-> ready_to_dispatch
--   P2L-7 adds a secure, guarded cancel_sales_order RPC and leaves ALL of the
--   above untouched. The database remains the single authority for status.
--
--   Cancellation rules (business-critical):
--     * OWNER/ADMIN/SALES only; authenticated; same org.
--     * The order must NOT already be cancelled.
--     * The order must NOT be in a P2M state (dispatched / partially_dispatched
--       / completed) — those are owned by a later phase.
--     * The order must have ZERO OPEN stock allocations. Cancellation NEVER
--       silently releases allocations; the user must release them first (P2L-6
--       release RPC remains authoritative). This keeps the ledger accurate.
--     * The order row is preserved (never deleted); status -> 'cancelled';
--       the optional reason is appended to notes; updated_at bumped; the change
--       is audited by the existing sales_orders audit trigger.
--
-- SCOPE — THIS MIGRATION ONLY:
--   public.cancel_sales_order(uuid, text) — SECURITY DEFINER, pinned search_path,
--   REVOKE PUBLIC / GRANT authenticated — plus post-validation. No schema change
--   (the cancellation reason uses the existing notes column — no redundant
--   column added). The sales_orders status CHECK already includes 'cancelled'
--   (046); no CHECK change is needed. The P2L-5 draft-only UPDATE policy is
--   PRESERVED (the RPC is SECURITY DEFINER and bypasses RLS to set the status,
--   so no permissive status-mutation policy is introduced).
--
-- THIS MIGRATION DOES NOT:
--   * release / delete / modify any stock_allocations
--   * change stock_items.qty_bottles or create any stock_movement
--   * implement dispatch / partial dispatch / completion (P2M)
--   * create invoices / payments / Finance entries
--   * add a cancellation column, a new status, or a new audit system
--   * modify confirm_sales_order, allocate/release RPCs, recompute helper, or
--     any RLS policy / grant on sales_orders
-- ============================================================

BEGIN;

-- ============================================================
-- 0. PRE-FLIGHT (fail-fast)
-- ============================================================
DO $$
BEGIN
  IF to_regclass('public.sales_orders') IS NULL THEN RAISE EXCEPTION 'Pre-flight: sales_orders missing (046).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.stock_allocations') IS NULL THEN RAISE EXCEPTION 'Pre-flight: stock_allocations missing (048).' USING ERRCODE='undefined_table'; END IF;
  IF to_regprocedure('public.assert_sales_actor(uuid)') IS NULL THEN RAISE EXCEPTION 'Pre-flight: assert_sales_actor missing (048).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.confirm_sales_order(uuid)') IS NULL THEN RAISE EXCEPTION 'Pre-flight: confirm_sales_order missing (047).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.recompute_sales_order_allocation_status(uuid)') IS NULL THEN RAISE EXCEPTION 'Pre-flight: recompute_sales_order_allocation_status missing (048).' USING ERRCODE='undefined_function'; END IF;
  -- The 'cancelled' status must already be in the sales_orders status CHECK (046).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.sales_orders'::regclass AND contype='c'
                 AND conname='so_status_check' AND pg_get_constraintdef(oid) ILIKE '%cancelled%') THEN
    RAISE EXCEPTION 'Pre-flight: sales_orders status CHECK must already allow cancelled (046).' USING ERRCODE='raise_exception';
  END IF;
END $$;

-- ============================================================
-- 1. cancel_sales_order — controlled, guarded cancellation
-- Returns the updated sales_orders row.
-- ============================================================
CREATE OR REPLACE FUNCTION public.cancel_sales_order(
  p_sales_order_id UUID,
  p_reason         TEXT DEFAULT NULL
)
RETURNS public.sales_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid       UUID := auth.uid();
  v_owner     UUID;
  v_order     public.sales_orders;
  v_open_cnt  INTEGER;
  v_reason    TEXT;
BEGIN
  -- 1. Authentication (fail closed).
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.' USING ERRCODE = 'raise_exception';
  END IF;

  -- Lock the order row FOR UPDATE (serialises the lifecycle transition).
  SELECT * INTO v_order FROM public.sales_orders WHERE id = p_sales_order_id FOR UPDATE;
  IF v_order.id IS NULL THEN
    RAISE EXCEPTION 'Sales order % not found.', p_sales_order_id USING ERRCODE = 'raise_exception';
  END IF;

  -- 2+3. Authorisation: active membership + OWNER/ADMIN/SALES for the order org.
  v_owner := public.assert_sales_actor(v_order.org_id);

  -- 4. Must not already be cancelled.
  IF v_order.status = 'cancelled' THEN
    RAISE EXCEPTION 'This sales order is already cancelled.' USING ERRCODE = 'raise_exception';
  END IF;

  -- 5. Must not be in a P2M dispatch/completed state (owned by a later phase).
  IF v_order.status IN ('dispatched','partially_dispatched','completed') THEN
    RAISE EXCEPTION 'A dispatched or completed sales order cannot be cancelled here.' USING ERRCODE = 'raise_exception';
  END IF;

  -- 6. Must have ZERO OPEN stock allocations. Cancellation never auto-releases.
  SELECT COUNT(*) INTO v_open_cnt
  FROM public.stock_allocations a
  WHERE a.sales_order_id = v_order.id AND a.status = 'open';
  IF v_open_cnt > 0 THEN
    RAISE EXCEPTION 'This sales order still has % open stock allocation(s). Release them before cancelling.', v_open_cnt USING ERRCODE = 'raise_exception';
  END IF;

  -- Preserve the order; append the cancellation reason to notes (no new column).
  v_reason := NULLIF(btrim(COALESCE(p_reason, '')), '');

  UPDATE public.sales_orders
     SET status = 'cancelled',
         notes = CASE
                   WHEN v_reason IS NULL THEN notes
                   WHEN notes IS NULL OR btrim(notes) = '' THEN format('Cancelled: %s', v_reason)
                   ELSE format('%s | Cancelled: %s', notes, v_reason)
                 END,
         updated_at = NOW()
   WHERE id = v_order.id
   RETURNING * INTO v_order;

  RETURN v_order;
END;
$$;
REVOKE ALL ON FUNCTION public.cancel_sales_order(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_sales_order(UUID, TEXT) TO authenticated;

-- ============================================================
-- 2. POST-VALIDATION (catalog checks). RAISE => rollback.
-- ============================================================
DO $$
DECLARE v_oid OID; is_secdef BOOLEAN; cfg TEXT[]; n INTEGER;
BEGIN
  -- Cancel RPC exists + SECURITY DEFINER + pinned search_path + authenticated-only.
  v_oid := to_regprocedure('public.cancel_sales_order(uuid, text)');
  IF v_oid IS NULL THEN RAISE EXCEPTION 'Post: cancel_sales_order missing.' USING ERRCODE='raise_exception'; END IF;
  SELECT prosecdef INTO is_secdef FROM pg_proc WHERE oid=v_oid;
  IF NOT COALESCE(is_secdef,false) THEN RAISE EXCEPTION 'Post: cancel_sales_order must be SECURITY DEFINER.' USING ERRCODE='raise_exception'; END IF;
  SELECT proconfig INTO cfg FROM pg_proc WHERE oid=v_oid;
  IF NOT EXISTS (SELECT 1 FROM unnest(COALESCE(cfg,ARRAY[]::TEXT[])) c WHERE c LIKE 'search_path=%' AND position('public' IN c)>0 AND position('pg_temp' IN c)>0) THEN
    RAISE EXCEPTION 'Post: cancel_sales_order must pin search_path = public, pg_temp.' USING ERRCODE='raise_exception';
  END IF;
  IF has_function_privilege('public', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'Post: PUBLIC must not EXECUTE cancel_sales_order.' USING ERRCODE='raise_exception'; END IF;
  IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'Post: authenticated must EXECUTE cancel_sales_order.' USING ERRCODE='raise_exception'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') AND has_function_privilege('anon', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'Post: anon must not EXECUTE cancel_sales_order.' USING ERRCODE='raise_exception'; END IF;

  -- The cancel RPC must guard on OPEN allocations and must NOT touch stock.
  IF pg_get_functiondef(v_oid) NOT ILIKE '%stock_allocations%' OR pg_get_functiondef(v_oid) NOT ILIKE '%open%' THEN
    RAISE EXCEPTION 'Post: cancel_sales_order must check open stock_allocations.' USING ERRCODE='raise_exception';
  END IF;
  IF pg_get_functiondef(v_oid) ILIKE '%stock_items%' OR pg_get_functiondef(v_oid) ILIKE '%stock_movements%' THEN
    RAISE EXCEPTION 'Post: cancel_sales_order must NOT reference stock_items / stock_movements.' USING ERRCODE='raise_exception';
  END IF;

  -- Existing lifecycle machinery must remain intact (unchanged).
  IF to_regprocedure('public.confirm_sales_order(uuid)') IS NULL THEN RAISE EXCEPTION 'Post: confirm_sales_order must remain present.' USING ERRCODE='raise_exception'; END IF;
  IF to_regprocedure('public.allocate_stock_for_sales_order_line(uuid, uuid, integer, text)') IS NULL THEN RAISE EXCEPTION 'Post: allocate RPC must remain present.' USING ERRCODE='raise_exception'; END IF;
  IF to_regprocedure('public.release_stock_allocation(uuid, text)') IS NULL THEN RAISE EXCEPTION 'Post: release RPC must remain present.' USING ERRCODE='raise_exception'; END IF;
  IF to_regprocedure('public.recompute_sales_order_allocation_status(uuid)') IS NULL THEN RAISE EXCEPTION 'Post: recompute helper must remain present.' USING ERRCODE='raise_exception'; END IF;

  -- sales_orders RLS still enabled; still exactly 3 policies; UPDATE still draft-gated.
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.sales_orders'::regclass) THEN
    RAISE EXCEPTION 'Post: RLS must remain enabled on sales_orders.' USING ERRCODE='raise_exception';
  END IF;
  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='sales_orders';
  IF n <> 3 THEN RAISE EXCEPTION 'Post: sales_orders must still have exactly 3 policies (%).', n USING ERRCODE='raise_exception'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='sales_orders' AND cmd='UPDATE' AND qual ILIKE '%draft%') THEN
    RAISE EXCEPTION 'Post: sales_orders UPDATE policy must remain draft-gated (no permissive status mutation).' USING ERRCODE='raise_exception';
  END IF;

  -- Audit mapping for sales_order (+ sales_order_line) still present.
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.audit_log_row_change()'::regprocedure
      AND pg_get_functiondef(oid) ILIKE '%''sales_order''%'
      AND pg_get_functiondef(oid) ILIKE '%''sales_order_line''%') THEN
    RAISE EXCEPTION 'Post: audit writer must retain sales_order mappings.' USING ERRCODE='raise_exception';
  END IF;

  -- status CHECK still allows the full P2L vocabulary.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.sales_orders'::regclass AND contype='c' AND conname='so_status_check'
      AND pg_get_constraintdef(oid) ILIKE '%draft%' AND pg_get_constraintdef(oid) ILIKE '%confirmed%'
      AND pg_get_constraintdef(oid) ILIKE '%partially_allocated%' AND pg_get_constraintdef(oid) ILIKE '%ready_to_dispatch%'
      AND pg_get_constraintdef(oid) ILIKE '%cancelled%') THEN
    RAISE EXCEPTION 'Post: sales_orders status CHECK must retain the P2L lifecycle vocabulary.' USING ERRCODE='raise_exception';
  END IF;
END $$;

COMMIT;
