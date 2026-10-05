-- ============================================================
-- WINERIX — P2K-7: Finished Goods Stock Adjustments & Damage
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- Depends on: 006 (is_org_member/has_org_role), 038 (finished_products),
--             039 (stock_locations), 040 (stock_items + stock_movements +
--             integrity triggers + audit), 041 (receive RPC — NOT modified),
--             042 (transfer RPC — NOT modified).
--
-- PURPOSE:
--   Two controlled, atomic, auditable finished-goods corrections, each a single
--   signed movement + the matching stock_items balance update in ONE transaction
--   (the established ledger pattern), preserving the invariant:
--     stock_items.qty_bottles == SUM(stock_movements.qty_bottles_delta)
--       GROUP BY (product_id, location_id)
--
--   1. adjust_finished_stock(product, location, qty_signed, reason, notes?)
--      - positive qty increases, negative decreases, zero rejected.
--      - decrease never takes stock below zero.
--      - increase creates the stock_items row if absent.
--      movement_type='adjustment', qty_bottles_delta=signed qty,
--      reference_type='stock_adjustment'.
--
--   2. record_finished_stock_damage(product, location, qty_positive, reason, notes?)
--      - qty>0; always decreases; never below zero.
--      movement_type='damage', qty_bottles_delta=-qty,
--      reference_type='stock_damage'.
--
--   ROLE: OWNER or ADMIN ONLY (CELLAR is NOT permitted for either operation —
--   intentionally stricter than receiving/transfers, which keep CELLAR). Reason
--   is mandatory for both. Bottles only — no litres. Org is derived from the
--   product/location rows, never from the client.
--
-- SCOPE — THIS MIGRATION ONLY:
--   Two SECURITY DEFINER RPCs (pinned search_path, REVOKE PUBLIC / GRANT
--   authenticated) + post-validation. No new table, no new movement type
--   ('adjustment'/'damage' already exist in 040), no schema change, no
--   modification of 038/039/040/041/042 or any other object. Reuses the existing
--   audit triggers (no audit writer change). No separate adjustment table —
--   stock_movements is the history.
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
  IF to_regprocedure('public.is_org_member(uuid)') IS NULL THEN RAISE EXCEPTION 'Pre-flight: is_org_member missing (006).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.has_org_role(uuid, text[])') IS NULL THEN RAISE EXCEPTION 'Pre-flight: has_org_role missing (006).' USING ERRCODE='undefined_function'; END IF;
  -- Movement vocabulary must already include both correction types (040).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid='public.stock_movements'::regclass AND c.contype='c'
                 AND pg_get_constraintdef(c.oid) ILIKE '%adjustment%' AND pg_get_constraintdef(c.oid) ILIKE '%damage%') THEN
    RAISE EXCEPTION 'Pre-flight: stock_movements must allow adjustment/damage (040).' USING ERRCODE='raise_exception';
  END IF;
END $$;

-- ============================================================
-- 1. Internal guard: resolve caller, verify membership + OWNER/ADMIN for org.
-- Distinct from assert_cellar_actor (which also allows CELLAR) — adjustments and
-- damage are OWNER/ADMIN only. Returns the actor uid.
-- ============================================================
CREATE OR REPLACE FUNCTION public.assert_stock_admin_actor(target_org UUID)
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
  IF NOT public.has_org_role(target_org, ARRAY['OWNER','ADMIN']) THEN
    RAISE EXCEPTION 'This operation requires an Owner or Admin role.' USING ERRCODE = 'raise_exception';
  END IF;
  RETURN uid;
END;
$$;
REVOKE ALL ON FUNCTION public.assert_stock_admin_actor(UUID) FROM PUBLIC;

-- ============================================================
-- 2. adjust_finished_stock — signed correction (OWNER/ADMIN only)
-- ============================================================
DROP FUNCTION IF EXISTS public.adjust_finished_stock(uuid, uuid, integer, text, text);

CREATE OR REPLACE FUNCTION public.adjust_finished_stock(
  p_product_id  UUID,
  p_location_id UUID,
  p_qty_bottles INTEGER,
  p_reason      TEXT,
  p_notes       TEXT DEFAULT NULL
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
  v_prod_org    UUID;
  v_prod_active BOOLEAN;
  v_loc_org     UUID;
  v_loc_active  BOOLEAN;
  v_reason      TEXT := btrim(COALESCE(p_reason, ''));
  v_item        public.stock_items;
BEGIN
  -- Auth (fail closed) + mandatory reason + non-zero quantity.
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.' USING ERRCODE = 'raise_exception';
  END IF;
  IF length(v_reason) = 0 THEN
    RAISE EXCEPTION 'A reason is required for a stock adjustment.' USING ERRCODE = 'raise_exception';
  END IF;
  IF p_qty_bottles IS NULL OR p_qty_bottles = 0 THEN
    RAISE EXCEPTION 'Adjustment quantity must be a non-zero number of bottles.' USING ERRCODE = 'raise_exception';
  END IF;

  -- Validate product (exists, active) and derive org from it.
  SELECT org_id, is_active INTO v_prod_org, v_prod_active FROM public.finished_products WHERE id = p_product_id;
  IF v_prod_org IS NULL THEN
    RAISE EXCEPTION 'Finished product % not found.', p_product_id USING ERRCODE = 'raise_exception';
  END IF;
  IF NOT COALESCE(v_prod_active, FALSE) THEN
    RAISE EXCEPTION 'The selected finished product is inactive and cannot be adjusted.' USING ERRCODE = 'raise_exception';
  END IF;
  v_org := v_prod_org;

  -- Role: OWNER/ADMIN only (CELLAR excluded).
  v_owner := public.assert_stock_admin_actor(v_org);

  -- Validate location (exists, active, same org).
  SELECT org_id, is_active INTO v_loc_org, v_loc_active FROM public.stock_locations WHERE id = p_location_id;
  IF v_loc_org IS NULL THEN
    RAISE EXCEPTION 'Stock location % not found.', p_location_id USING ERRCODE = 'raise_exception';
  END IF;
  IF v_loc_org <> v_org THEN
    RAISE EXCEPTION 'Cross-organisation reference: stock location % belongs to a different organisation.', p_location_id USING ERRCODE = 'raise_exception';
  END IF;
  IF NOT COALESCE(v_loc_active, FALSE) THEN
    RAISE EXCEPTION 'The selected stock location is inactive and cannot be adjusted.' USING ERRCODE = 'raise_exception';
  END IF;

  -- Get-or-create the (org, product, location) stock item, then lock it.
  -- For a decrease the row MUST already have enough stock; for an increase we
  -- may need to create it. Upsert-then-lock is race-safe on the unique key.
  INSERT INTO public.stock_items (org_id, owner_id, product_id, location_id, qty_bottles)
  VALUES (v_org, v_owner, p_product_id, p_location_id, 0)
  ON CONFLICT (org_id, product_id, location_id) DO NOTHING;

  SELECT * INTO v_item FROM public.stock_items
  WHERE org_id = v_org AND product_id = p_product_id AND location_id = p_location_id
  FOR UPDATE;

  -- Never allow the balance to go negative.
  IF v_item.qty_bottles + p_qty_bottles < 0 THEN
    RAISE EXCEPTION 'Adjustment would take stock below zero (current %, adjustment %).', v_item.qty_bottles, p_qty_bottles USING ERRCODE = 'raise_exception';
  END IF;

  -- Update the materialised balance.
  UPDATE public.stock_items
     SET qty_bottles = qty_bottles + p_qty_bottles
   WHERE id = v_item.id
   RETURNING * INTO v_item;

  -- Insert exactly one adjustment movement (signed).
  INSERT INTO public.stock_movements
    (org_id, owner_id, stock_item_id, product_id, location_id, movement_type,
     qty_bottles_delta, reference_type, reference_id, transfer_group_id, notes, occurred_at)
  VALUES
    (v_org, v_owner, v_item.id, p_product_id, p_location_id, 'adjustment',
     p_qty_bottles, 'stock_adjustment', NULL, NULL,
     CASE WHEN btrim(COALESCE(p_notes,'')) = '' THEN v_reason ELSE v_reason || ' — ' || btrim(p_notes) END,
     now());

  RETURN v_item;
END;
$$;

REVOKE ALL ON FUNCTION public.adjust_finished_stock(UUID, UUID, INTEGER, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.adjust_finished_stock(UUID, UUID, INTEGER, TEXT, TEXT) TO authenticated;

-- ============================================================
-- 3. record_finished_stock_damage — positive qty, always decreases (OWNER/ADMIN)
-- ============================================================
DROP FUNCTION IF EXISTS public.record_finished_stock_damage(uuid, uuid, integer, text, text);

CREATE OR REPLACE FUNCTION public.record_finished_stock_damage(
  p_product_id  UUID,
  p_location_id UUID,
  p_qty_bottles INTEGER,
  p_reason      TEXT,
  p_notes       TEXT DEFAULT NULL
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
  v_prod_org    UUID;
  v_prod_active BOOLEAN;
  v_loc_org     UUID;
  v_loc_active  BOOLEAN;
  v_reason      TEXT := btrim(COALESCE(p_reason, ''));
  v_item        public.stock_items;
BEGIN
  -- Auth (fail closed) + mandatory reason + strictly positive quantity.
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.' USING ERRCODE = 'raise_exception';
  END IF;
  IF length(v_reason) = 0 THEN
    RAISE EXCEPTION 'A reason is required to record damage.' USING ERRCODE = 'raise_exception';
  END IF;
  IF p_qty_bottles IS NULL OR p_qty_bottles <= 0 THEN
    RAISE EXCEPTION 'Damage quantity must be a positive number of bottles.' USING ERRCODE = 'raise_exception';
  END IF;

  -- Validate product (exists, active) and derive org from it.
  SELECT org_id, is_active INTO v_prod_org, v_prod_active FROM public.finished_products WHERE id = p_product_id;
  IF v_prod_org IS NULL THEN
    RAISE EXCEPTION 'Finished product % not found.', p_product_id USING ERRCODE = 'raise_exception';
  END IF;
  IF NOT COALESCE(v_prod_active, FALSE) THEN
    RAISE EXCEPTION 'The selected finished product is inactive and cannot be damaged.' USING ERRCODE = 'raise_exception';
  END IF;
  v_org := v_prod_org;

  -- Role: OWNER/ADMIN only (CELLAR excluded).
  v_owner := public.assert_stock_admin_actor(v_org);

  -- Validate location (exists, active, same org).
  SELECT org_id, is_active INTO v_loc_org, v_loc_active FROM public.stock_locations WHERE id = p_location_id;
  IF v_loc_org IS NULL THEN
    RAISE EXCEPTION 'Stock location % not found.', p_location_id USING ERRCODE = 'raise_exception';
  END IF;
  IF v_loc_org <> v_org THEN
    RAISE EXCEPTION 'Cross-organisation reference: stock location % belongs to a different organisation.', p_location_id USING ERRCODE = 'raise_exception';
  END IF;
  IF NOT COALESCE(v_loc_active, FALSE) THEN
    RAISE EXCEPTION 'The selected stock location is inactive and cannot be damaged.' USING ERRCODE = 'raise_exception';
  END IF;

  -- The source stock item MUST exist and hold enough — never auto-create for a
  -- decrease, never allow negative stock. Lock it FOR UPDATE.
  SELECT * INTO v_item FROM public.stock_items
  WHERE org_id = v_org AND product_id = p_product_id AND location_id = p_location_id
  FOR UPDATE;
  IF v_item.id IS NULL THEN
    RAISE EXCEPTION 'There is no stock of this product at the selected location.' USING ERRCODE = 'raise_exception';
  END IF;
  IF v_item.qty_bottles < p_qty_bottles THEN
    RAISE EXCEPTION 'Insufficient stock to record damage: % bottles available, % requested.', v_item.qty_bottles, p_qty_bottles USING ERRCODE = 'raise_exception';
  END IF;

  -- Decrease the materialised balance.
  UPDATE public.stock_items
     SET qty_bottles = qty_bottles - p_qty_bottles
   WHERE id = v_item.id
   RETURNING * INTO v_item;

  -- Insert exactly one damage movement (negative delta).
  INSERT INTO public.stock_movements
    (org_id, owner_id, stock_item_id, product_id, location_id, movement_type,
     qty_bottles_delta, reference_type, reference_id, transfer_group_id, notes, occurred_at)
  VALUES
    (v_org, v_owner, v_item.id, p_product_id, p_location_id, 'damage',
     -p_qty_bottles, 'stock_damage', NULL, NULL,
     CASE WHEN btrim(COALESCE(p_notes,'')) = '' THEN v_reason ELSE v_reason || ' — ' || btrim(p_notes) END,
     now());

  RETURN v_item;
END;
$$;

REVOKE ALL ON FUNCTION public.record_finished_stock_damage(UUID, UUID, INTEGER, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_finished_stock_damage(UUID, UUID, INTEGER, TEXT, TEXT) TO authenticated;

-- ============================================================
-- 4. POST-VALIDATION (catalog checks). RAISE => rollback.
-- ============================================================
DO $$
DECLARE
  v_oid     OID;
  is_secdef BOOLEAN;
  cfg       TEXT[];
  rettype   TEXT;
  sig       TEXT;
BEGIN
  -- Both RPCs + the admin guard exist, SECURITY DEFINER, pinned search_path.
  FOREACH sig IN ARRAY ARRAY[
    'public.adjust_finished_stock(uuid, uuid, integer, text, text)',
    'public.record_finished_stock_damage(uuid, uuid, integer, text, text)',
    'public.assert_stock_admin_actor(uuid)'
  ] LOOP
    v_oid := to_regprocedure(sig);
    IF v_oid IS NULL THEN RAISE EXCEPTION 'Post: % missing.', sig USING ERRCODE='raise_exception'; END IF;
    SELECT prosecdef INTO is_secdef FROM pg_proc WHERE oid = v_oid;
    IF NOT COALESCE(is_secdef,false) THEN RAISE EXCEPTION 'Post: % must be SECURITY DEFINER.', sig USING ERRCODE='raise_exception'; END IF;
    SELECT proconfig INTO cfg FROM pg_proc WHERE oid = v_oid;
    IF NOT EXISTS (SELECT 1 FROM unnest(COALESCE(cfg,ARRAY[]::TEXT[])) c
                   WHERE c LIKE 'search_path=%' AND position('public' IN c)>0 AND position('pg_temp' IN c)>0) THEN
      RAISE EXCEPTION 'Post: % must SET search_path = public, pg_temp.', sig USING ERRCODE='raise_exception';
    END IF;
  END LOOP;

  -- The two public RPCs: PUBLIC not executable; authenticated executable; return stock_items.
  FOREACH sig IN ARRAY ARRAY[
    'public.adjust_finished_stock(uuid, uuid, integer, text, text)',
    'public.record_finished_stock_damage(uuid, uuid, integer, text, text)'
  ] LOOP
    v_oid := to_regprocedure(sig);
    IF has_function_privilege('public', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'Post: PUBLIC must not EXECUTE %.', sig USING ERRCODE='raise_exception'; END IF;
    IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'Post: authenticated must EXECUTE %.', sig USING ERRCODE='raise_exception'; END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') AND has_function_privilege('anon', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'Post: anon must not EXECUTE %.', sig USING ERRCODE='raise_exception'; END IF;
    SELECT format_type(prorettype, NULL) INTO rettype FROM pg_proc WHERE oid = v_oid;
    IF rettype NOT IN ('stock_items','public.stock_items') THEN
      RAISE EXCEPTION 'Post: % must return public.stock_items (found %).', sig, rettype USING ERRCODE='raise_exception';
    END IF;
  END LOOP;

  -- Existing receipt + transfer RPCs must remain present (unchanged by us).
  IF to_regprocedure('public.receive_bottling_output(uuid, uuid, uuid)') IS NULL THEN
    RAISE EXCEPTION 'Post: receive_bottling_output (041) must remain present.' USING ERRCODE='raise_exception'; END IF;
  IF to_regprocedure('public.transfer_finished_stock(uuid, uuid, uuid, integer)') IS NULL THEN
    RAISE EXCEPTION 'Post: transfer_finished_stock (042) must remain present.' USING ERRCODE='raise_exception'; END IF;

  -- Movement vocabulary unchanged (adjustment + damage still allowed).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid='public.stock_movements'::regclass AND c.contype='c'
                 AND pg_get_constraintdef(c.oid) ILIKE '%adjustment%' AND pg_get_constraintdef(c.oid) ILIKE '%damage%'
                 AND pg_get_constraintdef(c.oid) ILIKE '%receipt%' AND pg_get_constraintdef(c.oid) ILIKE '%transfer_in%') THEN
    RAISE EXCEPTION 'Post: stock_movements movement_type vocabulary unexpectedly changed.' USING ERRCODE='raise_exception';
  END IF;
END $$;

COMMIT;
