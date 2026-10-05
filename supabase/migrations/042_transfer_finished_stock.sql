-- ============================================================
-- WINERIX — P2K-6: Finished Goods Stock Transfers (atomic, balanced)
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- Depends on: 006 (is_org_member/has_org_role), 022 (assert_cellar_actor +
--             the ledger pattern), 038 (finished_products), 039 (stock_locations),
--             040 (stock_items + stock_movements + integrity triggers + audit),
--             041 (receive RPC — NOT modified here).
--
-- PURPOSE:
--   Move finished goods between two ACTIVE stock locations in the SAME
--   organisation, atomically, via the ESTABLISHED ledger pattern. A transfer is
--   two correlated signed-delta movements sharing one transfer_group_id:
--     transfer_out  = -p_bottles  at the source location
--     transfer_in   = +p_bottles  at the destination location
--   Their deltas net to zero, so TOTAL organisation stock for the product is
--   unchanged while the per-location balances move. Each affected stock_items
--   row's balance is maintained in the SAME transaction so the invariant holds:
--     stock_items.qty_bottles == SUM(stock_movements.qty_bottles_delta)
--       GROUP BY (product_id, location_id)
--   Bottles only — NO litres movement. Partial transfers ARE allowed.
--
-- SCOPE — THIS MIGRATION ONLY:
--   public.transfer_finished_stock(uuid, uuid, uuid, integer) RETURNS void-ish
--   (a composite of the two resulting balances), SECURITY DEFINER, pinned
--   search_path, REVOKE PUBLIC / GRANT authenticated, plus post-validation.
--   No new table, no new movement type (transfer_in/transfer_out already exist
--   in 040), no schema change, no modification of 038/039/040/041 or any other
--   existing object. Reuses the existing audit triggers (no audit writer change).
--
-- THIS MIGRATION DOES NOT:
--   * implement adjustments / damage / sales / dispatch / cases / pallets /
--     valuation (later phases)
--   * modify receive_bottling_output or the P2K-5 idempotency logic
--   * add a recalculation trigger (balances maintained explicitly by the RPC)
--   * auto-create an empty SOURCE stock item (missing source => reject)
--   * allow negative stock, same-location transfers, or cross-org transfers
-- ============================================================

BEGIN;

-- ============================================================
-- 0. PRE-FLIGHT (fail-fast; never silently create dependencies)
-- ============================================================
DO $$
BEGIN
  IF to_regclass('public.finished_products') IS NULL THEN RAISE EXCEPTION 'Pre-flight: finished_products missing (038).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.stock_locations') IS NULL THEN RAISE EXCEPTION 'Pre-flight: stock_locations missing (039).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.stock_items') IS NULL THEN RAISE EXCEPTION 'Pre-flight: stock_items missing (040).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.stock_movements') IS NULL THEN RAISE EXCEPTION 'Pre-flight: stock_movements missing (040).' USING ERRCODE='undefined_table'; END IF;
  IF to_regprocedure('public.assert_cellar_actor(uuid)') IS NULL THEN RAISE EXCEPTION 'Pre-flight: assert_cellar_actor missing (022).' USING ERRCODE='undefined_function'; END IF;
  -- Movement vocabulary must already include both transfer types (040).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid='public.stock_movements'::regclass AND c.contype='c'
                 AND pg_get_constraintdef(c.oid) ILIKE '%transfer_out%' AND pg_get_constraintdef(c.oid) ILIKE '%transfer_in%') THEN
    RAISE EXCEPTION 'Pre-flight: stock_movements must allow transfer_in/transfer_out (040).' USING ERRCODE='raise_exception';
  END IF;
END $$;

-- ============================================================
-- 1. transfer_finished_stock — the atomic, balanced transfer operation
-- Returns the two resulting balances as a single row for convenient UI display:
--   (from_stock_item_id, from_qty_bottles, to_stock_item_id, to_qty_bottles,
--    transfer_group_id, bottles).
-- ============================================================
DROP FUNCTION IF EXISTS public.transfer_finished_stock(uuid, uuid, uuid, integer);

CREATE OR REPLACE FUNCTION public.transfer_finished_stock(
  p_product_id       UUID,
  p_from_location_id UUID,
  p_to_location_id   UUID,
  p_bottles          INTEGER
)
RETURNS TABLE (
  from_stock_item_id UUID,
  from_qty_bottles   INTEGER,
  to_stock_item_id   UUID,
  to_qty_bottles     INTEGER,
  transfer_group_id  UUID,
  bottles            INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid         UUID := auth.uid();
  v_org         UUID;
  v_owner       UUID;
  v_prod_org    UUID;
  v_prod_active BOOLEAN;
  v_from_org    UUID;
  v_from_active BOOLEAN;
  v_to_org      UUID;
  v_to_active   BOOLEAN;
  v_group       UUID := gen_random_uuid();
  v_from_item   public.stock_items;
  v_to_item     public.stock_items;
BEGIN
  -- 1. Authentication (fail closed).
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.' USING ERRCODE = 'raise_exception';
  END IF;

  -- 4. Quantity validation (checked early; cheap and clear).
  IF p_bottles IS NULL OR p_bottles <= 0 THEN
    RAISE EXCEPTION 'Transfer quantity must be a positive number of bottles.' USING ERRCODE = 'raise_exception';
  END IF;

  -- 3a. Source and destination must differ.
  IF p_from_location_id = p_to_location_id THEN
    RAISE EXCEPTION 'The source and destination locations must be different.' USING ERRCODE = 'raise_exception';
  END IF;

  -- 4(product). Validate the product and derive the organisation from it (never
  -- from the client). The product must exist and be active.
  SELECT org_id, is_active INTO v_prod_org, v_prod_active FROM public.finished_products WHERE id = p_product_id;
  IF v_prod_org IS NULL THEN
    RAISE EXCEPTION 'Finished product % not found.', p_product_id USING ERRCODE = 'raise_exception';
  END IF;
  IF NOT COALESCE(v_prod_active, FALSE) THEN
    RAISE EXCEPTION 'The selected finished product is inactive and cannot be transferred.' USING ERRCODE = 'raise_exception';
  END IF;
  v_org := v_prod_org;

  -- 2. Authorisation: active membership + OWNER/ADMIN/CELLAR for the org.
  v_owner := public.assert_cellar_actor(v_org);

  -- 3b. Source + destination locations must exist, be ACTIVE, and be same-org.
  SELECT org_id, is_active INTO v_from_org, v_from_active FROM public.stock_locations WHERE id = p_from_location_id;
  IF v_from_org IS NULL THEN
    RAISE EXCEPTION 'Source stock location % not found.', p_from_location_id USING ERRCODE = 'raise_exception';
  END IF;
  IF v_from_org <> v_org THEN
    RAISE EXCEPTION 'Cross-organisation reference: source location % belongs to a different organisation.', p_from_location_id USING ERRCODE = 'raise_exception';
  END IF;
  IF NOT COALESCE(v_from_active, FALSE) THEN
    RAISE EXCEPTION 'The source stock location is inactive and cannot be used.' USING ERRCODE = 'raise_exception';
  END IF;

  SELECT org_id, is_active INTO v_to_org, v_to_active FROM public.stock_locations WHERE id = p_to_location_id;
  IF v_to_org IS NULL THEN
    RAISE EXCEPTION 'Destination stock location % not found.', p_to_location_id USING ERRCODE = 'raise_exception';
  END IF;
  IF v_to_org <> v_org THEN
    RAISE EXCEPTION 'Cross-organisation reference: destination location % belongs to a different organisation.', p_to_location_id USING ERRCODE = 'raise_exception';
  END IF;
  IF NOT COALESCE(v_to_active, FALSE) THEN
    RAISE EXCEPTION 'The destination stock location is inactive and cannot be used.' USING ERRCODE = 'raise_exception';
  END IF;

  -- 7+8. Lock the SOURCE stock item FOR UPDATE. It MUST exist (never auto-create
  -- an empty source) and MUST hold at least p_bottles.
  SELECT * INTO v_from_item FROM public.stock_items
  WHERE org_id = v_org AND product_id = p_product_id AND location_id = p_from_location_id
  FOR UPDATE;
  IF v_from_item.id IS NULL THEN
    RAISE EXCEPTION 'There is no stock of this product at the source location.' USING ERRCODE = 'raise_exception';
  END IF;
  IF v_from_item.qty_bottles < p_bottles THEN
    RAISE EXCEPTION 'Insufficient stock at source: % bottles available, % requested.', v_from_item.qty_bottles, p_bottles USING ERRCODE = 'raise_exception';
  END IF;

  -- 6+9. Get-or-create the DESTINATION stock item, locked. To avoid a deadlock
  -- window and a unique-violation race on first-ever destination insert, use an
  -- idempotent upsert on the (org, product, location) unique key, then lock.
  INSERT INTO public.stock_items (org_id, owner_id, product_id, location_id, qty_bottles)
  VALUES (v_org, v_owner, p_product_id, p_to_location_id, 0)
  ON CONFLICT (org_id, product_id, location_id) DO NOTHING;

  SELECT * INTO v_to_item FROM public.stock_items
  WHERE org_id = v_org AND product_id = p_product_id AND location_id = p_to_location_id
  FOR UPDATE;

  -- 10. Decrease the source balance.
  UPDATE public.stock_items
     SET qty_bottles = qty_bottles - p_bottles
   WHERE id = v_from_item.id
   RETURNING * INTO v_from_item;

  -- 11. Increase the destination balance.
  UPDATE public.stock_items
     SET qty_bottles = qty_bottles + p_bottles
   WHERE id = v_to_item.id
   RETURNING * INTO v_to_item;

  -- 12. transfer_out movement (source, -p_bottles), correlated by group.
  INSERT INTO public.stock_movements
    (org_id, owner_id, stock_item_id, product_id, location_id, movement_type,
     qty_bottles_delta, reference_type, reference_id, transfer_group_id, notes, occurred_at)
  VALUES
    (v_org, v_owner, v_from_item.id, p_product_id, p_from_location_id, 'transfer_out',
     -p_bottles, 'stock_transfer', NULL, v_group,
     format('Transfer out (%s bottles)', p_bottles), now());

  -- 13. transfer_in movement (destination, +p_bottles), SAME group.
  INSERT INTO public.stock_movements
    (org_id, owner_id, stock_item_id, product_id, location_id, movement_type,
     qty_bottles_delta, reference_type, reference_id, transfer_group_id, notes, occurred_at)
  VALUES
    (v_org, v_owner, v_to_item.id, p_product_id, p_to_location_id, 'transfer_in',
     p_bottles, 'stock_transfer', NULL, v_group,
     format('Transfer in (%s bottles)', p_bottles), now());

  from_stock_item_id := v_from_item.id;
  from_qty_bottles   := v_from_item.qty_bottles;
  to_stock_item_id   := v_to_item.id;
  to_qty_bottles     := v_to_item.qty_bottles;
  transfer_group_id  := v_group;
  bottles            := p_bottles;
  RETURN NEXT;
END;
$$;

-- ============================================================
-- 2. PERMISSIONS — authenticated only (never PUBLIC / anon).
-- ============================================================
REVOKE ALL ON FUNCTION public.transfer_finished_stock(UUID, UUID, UUID, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transfer_finished_stock(UUID, UUID, UUID, INTEGER) TO authenticated;

-- ============================================================
-- 3. POST-VALIDATION (catalog checks). RAISE => rollback.
-- ============================================================
DO $$
DECLARE
  v_oid     OID;
  is_secdef BOOLEAN;
  cfg       TEXT[];
BEGIN
  v_oid := to_regprocedure('public.transfer_finished_stock(uuid, uuid, uuid, integer)');
  IF v_oid IS NULL THEN RAISE EXCEPTION 'Post: transfer_finished_stock(uuid,uuid,uuid,integer) missing.' USING ERRCODE='raise_exception'; END IF;

  SELECT prosecdef INTO is_secdef FROM pg_proc WHERE oid = v_oid;
  IF NOT COALESCE(is_secdef,false) THEN RAISE EXCEPTION 'Post: transfer_finished_stock must be SECURITY DEFINER.' USING ERRCODE='raise_exception'; END IF;

  SELECT proconfig INTO cfg FROM pg_proc WHERE oid = v_oid;
  IF NOT EXISTS (SELECT 1 FROM unnest(COALESCE(cfg,ARRAY[]::TEXT[])) c
                 WHERE c LIKE 'search_path=%' AND position('public' IN c)>0 AND position('pg_temp' IN c)>0) THEN
    RAISE EXCEPTION 'Post: transfer_finished_stock must SET search_path = public, pg_temp.' USING ERRCODE='raise_exception';
  END IF;

  IF has_function_privilege('public', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'Post: PUBLIC must not EXECUTE transfer_finished_stock.' USING ERRCODE='raise_exception'; END IF;
  IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'Post: authenticated must EXECUTE transfer_finished_stock.' USING ERRCODE='raise_exception'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') AND has_function_privilege('anon', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'Post: anon must not EXECUTE transfer_finished_stock.' USING ERRCODE='raise_exception'; END IF;

  -- This migration created no stock rows and did not change the movement vocabulary.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid='public.stock_movements'::regclass AND c.contype='c'
                 AND pg_get_constraintdef(c.oid) ILIKE '%receipt%' AND pg_get_constraintdef(c.oid) ILIKE '%transfer_in%'
                 AND pg_get_constraintdef(c.oid) ILIKE '%transfer_out%' AND pg_get_constraintdef(c.oid) ILIKE '%dispatch%') THEN
    RAISE EXCEPTION 'Post: stock_movements movement_type vocabulary unexpectedly changed.' USING ERRCODE='raise_exception';
  END IF;

  -- receive_bottling_output (041) must still exist unchanged in signature.
  IF to_regprocedure('public.receive_bottling_output(uuid, uuid, uuid)') IS NULL THEN
    RAISE EXCEPTION 'Post: receive_bottling_output (041) must remain present.' USING ERRCODE='raise_exception';
  END IF;
END $$;

COMMIT;
