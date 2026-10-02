-- ============================================================
-- WINERIX — P2I-8: Start Maturation (controlled processing-state operation)
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- Depends on: 006 (is_org_member/has_org_role), 018 (wine_lots), 020
--             (production_events), 022 (assert_cellar_actor), 024 (processing_state
--             column + guard trigger + guard function), 021/023 (audit wiring)
--
-- PURPOSE:
--   Add public.start_maturation(p_lot_id, p_notes) — a single atomic, controlled
--   maturation operation that:
--     1. resolves the lot and derives org_id from it,
--     2. asserts the authenticated cellar actor,
--     3. validates lot status + processing_state transition,
--     4. creates a 'maturation' production event (no vessel / no volume / no lineage),
--     5. transitions processing_state -> 'maturing' through the EXISTING guard,
--     6. returns the created production event.
--
--   The vocabulary already exists: wine_lots.processing_state accepts 'maturing'
--   (024) and production_events accepts event_type 'maturation' (020). Only a
--   guard-aware SECURITY DEFINER function can change processing_state, so this
--   operation requires its own RPC (mirrors start_fermentation / end_fermentation,
--   minus any vessel placement).
--
-- THIS MIGRATION DOES NOT:
--   * create tables / columns / processing states / event types
--   * modify the guard function or trigger (wine_lots_guard_processing_state)
--   * modify any existing RPC, migration (020-025), or audit infrastructure
--   * change vessel_placements / lot_volume_movements / lot_lineage / wine_lots.volume_litres
--   * backfill or delete data
--   The ONLY new object is public.start_maturation(uuid, text).
--
-- AUDIT: the production_events INSERT and the wine_lots UPDATE are captured by
--   the existing audit_log_row_change() triggers (021/023). No new audit object.
-- ============================================================

BEGIN;

-- ============================================================
-- 0. PRE-FLIGHT
-- ============================================================
DO $$
BEGIN
  IF to_regclass('public.wine_lots') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight: wine_lots missing (018).' USING ERRCODE='undefined_table';
  END IF;
  IF to_regclass('public.production_events') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight: production_events missing (020).' USING ERRCODE='undefined_table';
  END IF;
  IF to_regprocedure('public.assert_cellar_actor(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight: assert_cellar_actor missing (022).' USING ERRCODE='undefined_function';
  END IF;
  IF to_regprocedure('public.guard_wine_lot_processing_state()') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight: guard_wine_lot_processing_state missing (024).' USING ERRCODE='undefined_function';
  END IF;
  -- processing_state column must exist and accept 'maturing'; event_type must accept 'maturation'.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='wine_lots' AND column_name='processing_state') THEN
    RAISE EXCEPTION 'Pre-flight: wine_lots.processing_state missing (024).' USING ERRCODE='undefined_column';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid='public.wine_lots'::regclass AND c.contype='c'
      AND pg_get_constraintdef(c.oid) ILIKE '%maturing%'
  ) THEN
    RAISE EXCEPTION 'Pre-flight: wine_lots processing_state CHECK does not accept maturing (024).' USING ERRCODE='check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid='public.production_events'::regclass AND c.contype='c'
      AND pg_get_constraintdef(c.oid) ILIKE '%maturation%'
  ) THEN
    RAISE EXCEPTION 'Pre-flight: production_events event_type CHECK does not accept maturation (020).' USING ERRCODE='check_violation';
  END IF;
END $$;

-- ============================================================
-- 1. START MATURATION
-- Mirrors start_fermentation's guard pattern (set flag -> UPDATE -> unset flag)
-- but performs NO vessel placement and NO volume change. Allowed transitions:
--   NULL -> maturing, settling -> maturing
-- Rejected: fermenting (end fermentation first), maturing (already), and any
-- other unexpected processing_state (never silently overwritten).
-- ============================================================
CREATE OR REPLACE FUNCTION public.start_maturation(
  p_lot_id UUID,
  p_notes TEXT DEFAULT NULL
)
RETURNS public.production_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org    UUID;
  v_owner  UUID;
  v_status TEXT;
  v_state  TEXT;
  v_now    TIMESTAMPTZ := NOW();
  v_event  public.production_events;
BEGIN
  -- Resolve the lot + derive org (never from the client).
  SELECT org_id, status, processing_state INTO v_org, v_status, v_state
  FROM public.wine_lots WHERE id = p_lot_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Wine lot % not found.', p_lot_id USING ERRCODE='raise_exception';
  END IF;

  -- Authenticated cellar actor for this organisation (OWNER/ADMIN/CELLAR).
  v_owner := public.assert_cellar_actor(v_org);

  -- Lot must be active (reject terminal/non-operational states).
  IF v_status IN ('depleted','archived','bottled') THEN
    RAISE EXCEPTION 'Cannot start maturation on a % lot.', v_status USING ERRCODE='raise_exception';
  END IF;

  -- Processing-state transition validation.
  IF v_state = 'maturing' THEN
    RAISE EXCEPTION 'Lot is already in maturation.' USING ERRCODE='raise_exception';
  ELSIF v_state = 'fermenting' THEN
    RAISE EXCEPTION 'End fermentation before starting maturation.' USING ERRCODE='raise_exception';
  ELSIF v_state IS NOT NULL AND v_state <> 'settling' THEN
    -- Guard against any unexpected state rather than silently overwriting it.
    RAISE EXCEPTION 'Maturation can only begin from a settling or unset state (current: %).', v_state USING ERRCODE='raise_exception';
  END IF;
  -- Allowed here: v_state IS NULL or v_state = 'settling'.

  -- Create exactly one maturation production event (no vessel, no volume, no lineage).
  INSERT INTO public.production_events
    (org_id, owner_id, wine_lot_id, vessel_id, vessel_placement_id, event_type, event_at, notes)
  VALUES
    (v_org, v_owner, p_lot_id, NULL, NULL, 'maturation', v_now, p_notes)
  RETURNING * INTO v_event;

  -- Transition processing_state -> maturing through the EXISTING guard.
  PERFORM set_config('winerix.allow_processing_state', 'on', true);
  UPDATE public.wine_lots SET processing_state = 'maturing' WHERE id = p_lot_id;
  PERFORM set_config('winerix.allow_processing_state', 'off', true);

  RETURN v_event;
END;
$$;

REVOKE ALL ON FUNCTION public.start_maturation(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.start_maturation(UUID, TEXT) TO authenticated;

-- ============================================================
-- 2. POST-VALIDATION (catalog checks only). RAISE => rollback.
-- ============================================================
DO $$
DECLARE
  is_secdef BOOLEAN;
  cfg TEXT[];
  has_pinned_path BOOLEAN;
  rettype TEXT;
BEGIN
  -- Function exists with the expected signature.
  IF to_regprocedure('public.start_maturation(uuid, text)') IS NULL THEN
    RAISE EXCEPTION 'Post-check: start_maturation(uuid, text) missing.' USING ERRCODE='raise_exception';
  END IF;

  -- SECURITY DEFINER.
  SELECT prosecdef INTO is_secdef FROM pg_proc WHERE oid='public.start_maturation(uuid, text)'::regprocedure;
  IF NOT COALESCE(is_secdef,false) THEN
    RAISE EXCEPTION 'Post-check: start_maturation must be SECURITY DEFINER.' USING ERRCODE='raise_exception';
  END IF;

  -- Pinned search_path covering public + pg_temp.
  SELECT proconfig INTO cfg FROM pg_proc WHERE oid='public.start_maturation(uuid, text)'::regprocedure;
  has_pinned_path := EXISTS (
    SELECT 1 FROM unnest(COALESCE(cfg, ARRAY[]::TEXT[])) c
    WHERE c LIKE 'search_path=%' AND position('public' IN c) > 0 AND position('pg_temp' IN c) > 0
  );
  IF NOT has_pinned_path THEN
    RAISE EXCEPTION 'Post-check: start_maturation must SET search_path = public, pg_temp (found %).', cfg USING ERRCODE='raise_exception';
  END IF;

  -- Return type is production_events.
  SELECT pg_catalog.format_type(prorettype, NULL) INTO rettype
  FROM pg_proc WHERE oid='public.start_maturation(uuid, text)'::regprocedure;
  IF rettype <> 'production_events' AND rettype <> 'public.production_events' THEN
    RAISE EXCEPTION 'Post-check: start_maturation must RETURN production_events (found %).', rettype USING ERRCODE='raise_exception';
  END IF;

  -- PUBLIC must not execute; authenticated must.
  IF has_function_privilege('public','public.start_maturation(uuid, text)','EXECUTE') THEN
    RAISE EXCEPTION 'Post-check: PUBLIC must not execute start_maturation.' USING ERRCODE='raise_exception';
  END IF;
  IF NOT has_function_privilege('authenticated','public.start_maturation(uuid, text)','EXECUTE') THEN
    RAISE EXCEPTION 'Post-check: authenticated must execute start_maturation.' USING ERRCODE='raise_exception';
  END IF;

  -- Structures relied upon remain intact (not modified by this migration).
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='wine_lots' AND column_name='processing_state') THEN
    RAISE EXCEPTION 'Post-check: wine_lots.processing_state missing.' USING ERRCODE='raise_exception';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c WHERE c.conrelid='public.wine_lots'::regclass AND c.contype='c'
      AND pg_get_constraintdef(c.oid) ILIKE '%maturing%'
  ) THEN
    RAISE EXCEPTION 'Post-check: processing_state no longer accepts maturing.' USING ERRCODE='raise_exception';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c WHERE c.conrelid='public.production_events'::regclass AND c.contype='c'
      AND pg_get_constraintdef(c.oid) ILIKE '%maturation%'
  ) THEN
    RAISE EXCEPTION 'Post-check: production_events no longer accepts maturation.' USING ERRCODE='raise_exception';
  END IF;

  -- Guard trigger/function still present (we must not have altered it).
  IF to_regprocedure('public.guard_wine_lot_processing_state()') IS NULL THEN
    RAISE EXCEPTION 'Post-check: guard_wine_lot_processing_state missing.' USING ERRCODE='raise_exception';
  END IF;
END $$;

COMMIT;
