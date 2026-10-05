-- ============================================================
-- WINERIX — P2K-5: Receive Finished Goods (atomic stock receipt)
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- Depends on: 006 (is_org_member/has_org_role), 021 (audit_log_row_change),
--             022 (assert_cellar_actor + the ledger pattern), 034 (bottling_runs
--             + bottling_outputs), 038 (finished_products), 039 (stock_locations),
--             040 (stock_items + stock_movements + integrity triggers + audit).
--
-- PURPOSE:
--   Turn a COMPLETED bottling run's bottling_output into finished-goods stock,
--   atomically and idempotently. Reuses the ESTABLISHED ledger pattern from P2H/
--   P2J: insert ONE stock_movements row AND upsert the matching stock_items
--   balance in the SAME transaction, so the invariant holds:
--     stock_items.qty_bottles == SUM(stock_movements.qty_bottles_delta)
--       GROUP BY (product_id, location_id)
--   Bottles are the only unit — NO litres movement is created.
--
--   A bottling output is received in FULL (its bottle_count) exactly once. The
--   receipt is anchored to the output via reference_type='bottling_output' /
--   reference_id=output.id — the traceability anchor AND the idempotency key.
--
-- SCOPE — THIS MIGRATION ONLY:
--   (1) a PARTIAL UNIQUE INDEX on stock_movements enforcing one 'receipt' per
--       (org_id, reference_id) where reference_type='bottling_output' — race-safe,
--       organisation-safe. (2) public.receive_bottling_output(uuid, uuid, uuid)
--       RETURNS public.stock_items, SECURITY DEFINER, pinned search_path,
--       REVOKE PUBLIC / GRANT authenticated, plus post-validation.
--
-- THIS MIGRATION DOES NOT:
--   * implement transfers / adjustments / damage / sale / dispatch (later phases)
--   * backfill or auto-receive any existing bottling output
--   * add finished_product_id to bottling_outputs or modify any existing table
--     (other than adding the partial unique index to stock_movements)
--   * create a litres movement or a second ledger
--   * create a service or UI (application code, not here)
--   * allow partial receipts or remaining-quantity tracking
-- ============================================================

BEGIN;

-- ============================================================
-- 0. PRE-FLIGHT (fail-fast; never silently create dependencies)
-- ============================================================
DO $$
BEGIN
  IF to_regclass('public.bottling_runs') IS NULL THEN RAISE EXCEPTION 'Pre-flight: bottling_runs missing (034).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.bottling_outputs') IS NULL THEN RAISE EXCEPTION 'Pre-flight: bottling_outputs missing (034).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.finished_products') IS NULL THEN RAISE EXCEPTION 'Pre-flight: finished_products missing (038).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.stock_locations') IS NULL THEN RAISE EXCEPTION 'Pre-flight: stock_locations missing (039).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.stock_items') IS NULL THEN RAISE EXCEPTION 'Pre-flight: stock_items missing (040).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.stock_movements') IS NULL THEN RAISE EXCEPTION 'Pre-flight: stock_movements missing (040).' USING ERRCODE='undefined_table'; END IF;
  IF to_regprocedure('public.assert_cellar_actor(uuid)') IS NULL THEN RAISE EXCEPTION 'Pre-flight: assert_cellar_actor missing (022).' USING ERRCODE='undefined_function'; END IF;
  -- stock_movements must allow 'receipt' (040 vocabulary).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid='public.stock_movements'::regclass AND c.contype='c'
                 AND pg_get_constraintdef(c.oid) ILIKE '%receipt%') THEN
    RAISE EXCEPTION 'Pre-flight: stock_movements must allow movement_type receipt (040).' USING ERRCODE='raise_exception';
  END IF;
END $$;

-- ============================================================
-- 1. IDEMPOTENCY — one 'receipt' per bottling output (race-safe, org-safe)
-- Partial unique index: at most one receipt movement may reference a given
-- bottling output. The org_id is included so the key is organisation-scoped
-- (reference_ids are globally unique UUIDs anyway, but this keeps the guard
-- explicitly per-organisation and consistent with the rest of the schema).
-- ============================================================
CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_movements_receipt_bottling_output
  ON public.stock_movements(org_id, reference_id)
  WHERE movement_type = 'receipt' AND reference_type = 'bottling_output';

-- ============================================================
-- 2. receive_bottling_output — the atomic, idempotent receipt operation
-- Args: p_bottling_output_id, p_product_id, p_location_id.
-- Returns the resulting stock_items row (post-balance).
-- ============================================================
CREATE OR REPLACE FUNCTION public.receive_bottling_output(
  p_bottling_output_id UUID,
  p_product_id         UUID,
  p_location_id        UUID
)
RETURNS public.stock_items
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid         UUID := auth.uid();
  v_org         UUID;
  v_owner       UUID;
  v_output      public.bottling_outputs;
  v_run_status  TEXT;
  v_bottles     INTEGER;
  v_prod_org    UUID;
  v_prod_active BOOLEAN;
  v_loc_org     UUID;
  v_loc_active  BOOLEAN;
  v_item        public.stock_items;
BEGIN
  -- 1. Authentication (fail closed).
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.' USING ERRCODE = 'raise_exception';
  END IF;

  -- 3. Lock the bottling output FOR UPDATE and derive its organisation from the
  -- row (never from the client). (Role check follows once org is known.)
  SELECT * INTO v_output FROM public.bottling_outputs WHERE id = p_bottling_output_id FOR UPDATE;
  IF v_output.id IS NULL THEN
    RAISE EXCEPTION 'Bottling output % not found.', p_bottling_output_id USING ERRCODE = 'raise_exception';
  END IF;
  v_org := v_output.org_id;

  -- 2. Authorisation: active membership + OWNER/ADMIN/CELLAR for the output's
  -- org (reuses the established cellar guard; returns the actor uid).
  v_owner := public.assert_cellar_actor(v_org);

  -- 4. The owning bottling run must be COMPLETED (planned/in_progress/cancelled
  -- are rejected). Lock the run row too for a consistent read.
  SELECT status INTO v_run_status FROM public.bottling_runs WHERE id = v_output.bottling_run_id FOR UPDATE;
  IF v_run_status IS NULL THEN
    RAISE EXCEPTION 'Bottling run for output % not found.', p_bottling_output_id USING ERRCODE = 'raise_exception';
  END IF;
  IF v_run_status <> 'completed' THEN
    RAISE EXCEPTION 'Finished goods can only be received from a completed bottling run (run status is "%").', v_run_status USING ERRCODE = 'raise_exception';
  END IF;

  -- Receive the FULL output bottle_count. Must be positive to create stock.
  v_bottles := v_output.bottle_count;
  IF v_bottles IS NULL OR v_bottles <= 0 THEN
    RAISE EXCEPTION 'Bottling output % has no bottles to receive (bottle_count = %).', p_bottling_output_id, v_bottles USING ERRCODE = 'raise_exception';
  END IF;

  -- 5. Validate the selected finished product: same org, exists, ACTIVE.
  SELECT org_id, is_active INTO v_prod_org, v_prod_active FROM public.finished_products WHERE id = p_product_id;
  IF v_prod_org IS NULL THEN
    RAISE EXCEPTION 'Finished product % not found.', p_product_id USING ERRCODE = 'raise_exception';
  END IF;
  IF v_prod_org <> v_org THEN
    RAISE EXCEPTION 'Cross-organisation reference: finished product % belongs to a different organisation.', p_product_id USING ERRCODE = 'raise_exception';
  END IF;
  IF NOT COALESCE(v_prod_active, FALSE) THEN
    RAISE EXCEPTION 'The selected finished product is inactive and cannot receive stock.' USING ERRCODE = 'raise_exception';
  END IF;

  -- 6. Validate the destination stock location: same org, exists, ACTIVE.
  SELECT org_id, is_active INTO v_loc_org, v_loc_active FROM public.stock_locations WHERE id = p_location_id;
  IF v_loc_org IS NULL THEN
    RAISE EXCEPTION 'Stock location % not found.', p_location_id USING ERRCODE = 'raise_exception';
  END IF;
  IF v_loc_org <> v_org THEN
    RAISE EXCEPTION 'Cross-organisation reference: stock location % belongs to a different organisation.', p_location_id USING ERRCODE = 'raise_exception';
  END IF;
  IF NOT COALESCE(v_loc_active, FALSE) THEN
    RAISE EXCEPTION 'The selected stock location is inactive and cannot receive stock.' USING ERRCODE = 'raise_exception';
  END IF;

  -- 7. Defensive idempotency check (the partial unique index is the final guard
  -- against a concurrent duplicate). Friendly message when already received.
  IF EXISTS (
    SELECT 1 FROM public.stock_movements
    WHERE org_id = v_org AND movement_type = 'receipt'
      AND reference_type = 'bottling_output' AND reference_id = v_output.id
  ) THEN
    RAISE EXCEPTION 'This bottling output has already been received into stock.' USING ERRCODE = 'unique_violation';
  END IF;

  -- 8. Get-or-create the (org, product, location) stock_items row, locked.
  SELECT * INTO v_item FROM public.stock_items
  WHERE org_id = v_org AND product_id = p_product_id AND location_id = p_location_id
  FOR UPDATE;

  IF v_item.id IS NULL THEN
    INSERT INTO public.stock_items (org_id, owner_id, product_id, location_id, qty_bottles)
    VALUES (v_org, v_owner, p_product_id, p_location_id, 0)
    RETURNING * INTO v_item;
  END IF;

  -- 9. Update the materialised balance (+full bottle_count).
  UPDATE public.stock_items
     SET qty_bottles = qty_bottles + v_bottles
   WHERE id = v_item.id
   RETURNING * INTO v_item;

  -- 10. Insert exactly ONE receipt movement, anchored to the bottling output.
  -- The partial unique index enforces single-receipt even under concurrency.
  INSERT INTO public.stock_movements
    (org_id, owner_id, stock_item_id, product_id, location_id, movement_type,
     qty_bottles_delta, reference_type, reference_id, transfer_group_id, notes, occurred_at)
  VALUES
    (v_org, v_owner, v_item.id, p_product_id, p_location_id, 'receipt',
     v_bottles, 'bottling_output', v_output.id, NULL,
     format('Received bottling output (%s bottles)', v_bottles), now());

  -- 11. Return the resulting stock_items row (committed on function return).
  RETURN v_item;
END;
$$;

-- ============================================================
-- 3. PERMISSIONS — authenticated only (never PUBLIC / anon).
-- ============================================================
REVOKE ALL ON FUNCTION public.receive_bottling_output(UUID, UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.receive_bottling_output(UUID, UUID, UUID) TO authenticated;

-- ============================================================
-- 4. POST-VALIDATION (catalog checks). RAISE => rollback.
-- ============================================================
DO $$
DECLARE
  v_oid     OID;
  is_secdef BOOLEAN;
  cfg       TEXT[];
  rettype   TEXT;
BEGIN
  -- Partial unique index exists.
  IF to_regclass('public.uq_stock_movements_receipt_bottling_output') IS NULL THEN
    RAISE EXCEPTION 'Post: uq_stock_movements_receipt_bottling_output missing.' USING ERRCODE='raise_exception';
  END IF;

  v_oid := to_regprocedure('public.receive_bottling_output(uuid, uuid, uuid)');
  IF v_oid IS NULL THEN RAISE EXCEPTION 'Post: receive_bottling_output(uuid,uuid,uuid) missing.' USING ERRCODE='raise_exception'; END IF;

  SELECT prosecdef INTO is_secdef FROM pg_proc WHERE oid = v_oid;
  IF NOT COALESCE(is_secdef,false) THEN RAISE EXCEPTION 'Post: receive_bottling_output must be SECURITY DEFINER.' USING ERRCODE='raise_exception'; END IF;

  SELECT proconfig INTO cfg FROM pg_proc WHERE oid = v_oid;
  IF NOT EXISTS (SELECT 1 FROM unnest(COALESCE(cfg,ARRAY[]::TEXT[])) c
                 WHERE c LIKE 'search_path=%' AND position('public' IN c)>0 AND position('pg_temp' IN c)>0) THEN
    RAISE EXCEPTION 'Post: receive_bottling_output must SET search_path = public, pg_temp.' USING ERRCODE='raise_exception';
  END IF;

  IF has_function_privilege('public', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'Post: PUBLIC must not EXECUTE receive_bottling_output.' USING ERRCODE='raise_exception'; END IF;
  IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'Post: authenticated must EXECUTE receive_bottling_output.' USING ERRCODE='raise_exception'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') AND has_function_privilege('anon', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'Post: anon must not EXECUTE receive_bottling_output.' USING ERRCODE='raise_exception'; END IF;

  SELECT format_type(prorettype, NULL) INTO rettype FROM pg_proc WHERE oid = v_oid;
  IF rettype NOT IN ('stock_items','public.stock_items') THEN
    RAISE EXCEPTION 'Post: receive_bottling_output must return public.stock_items (found %).', rettype USING ERRCODE='raise_exception';
  END IF;

  -- This migration created no stock rows.
  IF (SELECT COUNT(*) FROM public.stock_movements) <> 0 THEN
    RAISE EXCEPTION 'Post: stock_movements must still be empty after this migration.' USING ERRCODE='raise_exception';
  END IF;
  IF (SELECT COUNT(*) FROM public.stock_items) <> 0 THEN
    RAISE EXCEPTION 'Post: stock_items must still be empty after this migration.' USING ERRCODE='raise_exception';
  END IF;
END $$;

COMMIT;
