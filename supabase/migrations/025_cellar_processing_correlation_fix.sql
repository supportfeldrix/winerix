-- ============================================================
-- WINERIX — P2I-3 FIX: Production Event -> Vessel Placement correlation
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- Depends on: 019 (vessels, vessel_placements), 020 (production_events),
--             022 (assert_cellar_actor, record_lot_loss), 024 (cellar processing)
--
-- PURPOSE:
--   Migration 024 created production operations that place a lot into a vessel
--   but left production_events.vessel_placement_id = NULL, because the inline
--   placement helper _place_lot_in_vessel returned VOID and its callers never
--   stamped the placement id onto the event they created.
--
--   This migration applies ONLY that correlation fix:
--     * _place_lot_in_vessel now RETURNS UUID (the open placement id the lot
--       occupies after the call).
--     * record_rack, record_filtration and start_fermentation capture that id
--       and set production_events.vessel_placement_id to it, in the SAME
--       transaction as the event + placement (atomic).
--
--   record_filtration only correlates when a vessel is actually supplied; with
--   no vessel it preserves the existing behaviour (no placement, NULL link).
--
-- WHY A SEPARATE MIGRATION (not a 024 re-run):
--   024 is live and its post-check asserts every wine_lot has NULL
--   processing_state. Because the app has already started fermentation on
--   BLEND-2026-1 (processing_state='fermenting'), re-running 024 fails that
--   post-check and rolls back. 025 contains ONLY the function fix, with no
--   data assertions, so it applies cleanly against the live database.
--
-- SCOPE — THIS MIGRATION ONLY:
--   Replaces four functions (one helper + three operation RPCs). It does NOT
--   modify tables, columns, processing_state, event-type constraints, triggers,
--   RLS policies, data, or any other function (record_addition / end_fermentation
--   / record_lot_* / split / combine are untouched). It does NOT repair the
--   existing live P2I-3 event (30b066c0-...): 025 makes FUTURE operations correct.
-- ============================================================

BEGIN;

-- ============================================================
-- 0. PRE-FLIGHT — the objects 025 depends on must already exist (from 024/022).
-- ============================================================
DO $$
BEGIN
  IF to_regclass('public.wine_lots') IS NULL THEN RAISE EXCEPTION 'Pre-flight: wine_lots missing.' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.vessels') IS NULL THEN RAISE EXCEPTION 'Pre-flight: vessels missing.' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.vessel_placements') IS NULL THEN RAISE EXCEPTION 'Pre-flight: vessel_placements missing.' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.production_events') IS NULL THEN RAISE EXCEPTION 'Pre-flight: production_events missing.' USING ERRCODE='undefined_table'; END IF;
  IF to_regprocedure('public.assert_cellar_actor(uuid)') IS NULL THEN RAISE EXCEPTION 'Pre-flight: assert_cellar_actor missing (022).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.record_lot_loss(uuid, numeric, text, uuid)') IS NULL THEN RAISE EXCEPTION 'Pre-flight: record_lot_loss(4-arg) missing (024).' USING ERRCODE='undefined_function'; END IF;
  -- The functions this migration replaces were created by 024.
  IF to_regprocedure('public._place_lot_in_vessel(uuid, uuid, uuid, uuid, timestamptz)') IS NULL THEN RAISE EXCEPTION 'Pre-flight: _place_lot_in_vessel missing (024).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.record_rack(uuid, uuid, numeric, text)') IS NULL THEN RAISE EXCEPTION 'Pre-flight: record_rack missing (024).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.record_filtration(uuid, uuid, numeric, text)') IS NULL THEN RAISE EXCEPTION 'Pre-flight: record_filtration missing (024).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.start_fermentation(uuid, uuid, text)') IS NULL THEN RAISE EXCEPTION 'Pre-flight: start_fermentation missing (024).' USING ERRCODE='undefined_function'; END IF;
  -- The correlation column must exist on production_events (from 020).
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='production_events' AND column_name='vessel_placement_id') THEN
    RAISE EXCEPTION 'Pre-flight: production_events.vessel_placement_id missing (020).' USING ERRCODE='undefined_column';
  END IF;
END $$;

-- ============================================================
-- 1. HELPER — _place_lot_in_vessel now RETURNS UUID.
-- Return type changes from VOID -> UUID, which CREATE OR REPLACE cannot do, so
-- DROP first. Safe: the helper is only invoked by the three operation functions
-- recreated below in this same transaction. Behaviour is otherwise identical to
-- 024 (close current open placement if different, open a new one at the lot's
-- current volume, preserve one-open-placement-per-lot).
-- ============================================================
DROP FUNCTION IF EXISTS public._place_lot_in_vessel(UUID, UUID, UUID, UUID, TIMESTAMPTZ);
CREATE OR REPLACE FUNCTION public._place_lot_in_vessel(
  p_org UUID,
  p_owner UUID,
  p_lot_id UUID,
  p_vessel_id UUID,
  p_at TIMESTAMPTZ
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_vessel_org   UUID;
  v_lot_vol      NUMERIC(12,2);
  v_open_id      UUID;
  v_open_vessel  UUID;
  v_new_id       UUID;
BEGIN
  -- Validate vessel exists and is same-org (DB cross-org trigger also enforces).
  SELECT org_id INTO v_vessel_org FROM public.vessels WHERE id = p_vessel_id;
  IF v_vessel_org IS NULL THEN
    RAISE EXCEPTION 'Vessel % not found.', p_vessel_id USING ERRCODE = 'raise_exception';
  END IF;
  IF v_vessel_org <> p_org THEN
    RAISE EXCEPTION 'Cross-organisation reference: vessel % belongs to a different organisation.', p_vessel_id USING ERRCODE = 'raise_exception';
  END IF;

  SELECT volume_litres INTO v_lot_vol FROM public.wine_lots WHERE id = p_lot_id;

  -- Current open placement (if any).
  SELECT id, vessel_id INTO v_open_id, v_open_vessel
  FROM public.vessel_placements
  WHERE org_id = p_org AND wine_lot_id = p_lot_id AND removed_at IS NULL;

  IF v_open_id IS NOT NULL AND v_open_vessel = p_vessel_id THEN
    -- Already in the target vessel; nothing to move. Return the existing open
    -- placement so callers can still correlate the production event to it.
    RETURN v_open_id;
  END IF;

  IF v_open_id IS NOT NULL THEN
    UPDATE public.vessel_placements SET removed_at = p_at WHERE id = v_open_id AND org_id = p_org;
  END IF;

  INSERT INTO public.vessel_placements (org_id, owner_id, wine_lot_id, vessel_id, volume_litres, placed_at)
  VALUES (p_org, p_owner, p_lot_id, p_vessel_id, COALESCE(v_lot_vol, 0), p_at)
  RETURNING id INTO v_new_id;

  -- Return the id of the open placement the lot now occupies.
  RETURN v_new_id;
END;
$$;
REVOKE ALL ON FUNCTION public._place_lot_in_vessel(UUID, UUID, UUID, UUID, TIMESTAMPTZ) FROM PUBLIC;

-- ============================================================
-- 2. RACK — stamp vessel_placement_id with the placement produced.
-- ============================================================
CREATE OR REPLACE FUNCTION public.record_rack(
  p_lot_id UUID,
  p_to_vessel_id UUID,
  p_loss_litres NUMERIC DEFAULT NULL,
  p_notes TEXT DEFAULT NULL
)
RETURNS public.production_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org          UUID;
  v_owner        UUID;
  v_now          TIMESTAMPTZ := NOW();
  v_event        public.production_events;
  v_placement_id UUID;
BEGIN
  SELECT org_id INTO v_org FROM public.wine_lots WHERE id = p_lot_id;
  IF v_org IS NULL THEN RAISE EXCEPTION 'Wine lot % not found.', p_lot_id USING ERRCODE='raise_exception'; END IF;
  v_owner := public.assert_cellar_actor(v_org);
  IF p_to_vessel_id IS NULL THEN RAISE EXCEPTION 'A target vessel is required for racking.' USING ERRCODE='raise_exception'; END IF;

  INSERT INTO public.production_events (org_id, owner_id, wine_lot_id, vessel_id, event_type, event_at, notes)
  VALUES (v_org, v_owner, p_lot_id, p_to_vessel_id, 'racking', v_now, p_notes)
  RETURNING * INTO v_event;

  v_placement_id := public._place_lot_in_vessel(v_org, v_owner, p_lot_id, p_to_vessel_id, v_now);

  -- Correlate the event to the placement it produced (same transaction).
  UPDATE public.production_events SET vessel_placement_id = v_placement_id WHERE id = v_event.id
  RETURNING * INTO v_event;

  IF p_loss_litres IS NOT NULL AND p_loss_litres > 0 THEN
    PERFORM public.record_lot_loss(p_lot_id, p_loss_litres, p_notes, v_event.id);
  END IF;

  RETURN v_event;
END;
$$;
REVOKE ALL ON FUNCTION public.record_rack(UUID, UUID, NUMERIC, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_rack(UUID, UUID, NUMERIC, TEXT) TO authenticated;

-- ============================================================
-- 3. FILTRATION — stamp vessel_placement_id only when a vessel is supplied.
-- ============================================================
CREATE OR REPLACE FUNCTION public.record_filtration(
  p_lot_id UUID,
  p_to_vessel_id UUID DEFAULT NULL,
  p_loss_litres NUMERIC DEFAULT NULL,
  p_notes TEXT DEFAULT NULL
)
RETURNS public.production_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org          UUID;
  v_owner        UUID;
  v_now          TIMESTAMPTZ := NOW();
  v_event        public.production_events;
  v_placement_id UUID;
BEGIN
  SELECT org_id INTO v_org FROM public.wine_lots WHERE id = p_lot_id;
  IF v_org IS NULL THEN RAISE EXCEPTION 'Wine lot % not found.', p_lot_id USING ERRCODE='raise_exception'; END IF;
  v_owner := public.assert_cellar_actor(v_org);

  INSERT INTO public.production_events (org_id, owner_id, wine_lot_id, vessel_id, event_type, event_at, notes)
  VALUES (v_org, v_owner, p_lot_id, p_to_vessel_id, 'filtration', v_now, p_notes)
  RETURNING * INTO v_event;

  IF p_to_vessel_id IS NOT NULL THEN
    v_placement_id := public._place_lot_in_vessel(v_org, v_owner, p_lot_id, p_to_vessel_id, v_now);
    -- Correlate the event to the placement it produced (same transaction).
    UPDATE public.production_events SET vessel_placement_id = v_placement_id WHERE id = v_event.id
    RETURNING * INTO v_event;
  END IF;

  IF p_loss_litres IS NOT NULL AND p_loss_litres > 0 THEN
    PERFORM public.record_lot_loss(p_lot_id, p_loss_litres, p_notes, v_event.id);
  END IF;

  RETURN v_event;
END;
$$;
REVOKE ALL ON FUNCTION public.record_filtration(UUID, UUID, NUMERIC, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_filtration(UUID, UUID, NUMERIC, TEXT) TO authenticated;

-- ============================================================
-- 4. START FERMENTATION — stamp vessel_placement_id with the placement produced.
-- processing_state handling is preserved verbatim from 024 (set to 'fermenting'
-- inside the guard window). 025 does NOT change the processing_state design.
-- ============================================================
CREATE OR REPLACE FUNCTION public.start_fermentation(
  p_lot_id UUID,
  p_vessel_id UUID,
  p_notes TEXT DEFAULT NULL
)
RETURNS public.production_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org          UUID;
  v_owner        UUID;
  v_status       TEXT;
  v_state        TEXT;
  v_now          TIMESTAMPTZ := NOW();
  v_event        public.production_events;
  v_placement_id UUID;
BEGIN
  SELECT org_id, status, processing_state INTO v_org, v_status, v_state FROM public.wine_lots WHERE id = p_lot_id;
  IF v_org IS NULL THEN RAISE EXCEPTION 'Wine lot % not found.', p_lot_id USING ERRCODE='raise_exception'; END IF;
  v_owner := public.assert_cellar_actor(v_org);
  IF p_vessel_id IS NULL THEN RAISE EXCEPTION 'A vessel is required to start fermentation.' USING ERRCODE='raise_exception'; END IF;
  IF v_status IN ('depleted','archived','bottled') THEN
    RAISE EXCEPTION 'Cannot start fermentation on a % lot.', v_status USING ERRCODE='raise_exception';
  END IF;
  IF v_state = 'fermenting' THEN
    RAISE EXCEPTION 'This lot is already fermenting.' USING ERRCODE='raise_exception';
  END IF;

  INSERT INTO public.production_events (org_id, owner_id, wine_lot_id, vessel_id, event_type, event_at, notes)
  VALUES (v_org, v_owner, p_lot_id, p_vessel_id, 'fermentation', v_now, p_notes)
  RETURNING * INTO v_event;

  v_placement_id := public._place_lot_in_vessel(v_org, v_owner, p_lot_id, p_vessel_id, v_now);

  -- Correlate the event to the placement it produced (same transaction).
  UPDATE public.production_events SET vessel_placement_id = v_placement_id WHERE id = v_event.id
  RETURNING * INTO v_event;

  PERFORM set_config('winerix.allow_processing_state', 'on', true);
  UPDATE public.wine_lots SET processing_state = 'fermenting' WHERE id = p_lot_id;
  PERFORM set_config('winerix.allow_processing_state', 'off', true);

  RETURN v_event;
END;
$$;
REVOKE ALL ON FUNCTION public.start_fermentation(UUID, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.start_fermentation(UUID, UUID, TEXT) TO authenticated;

-- ============================================================
-- 5. POST-VALIDATION (catalog checks only; no data assertions). RAISE => rollback.
-- ============================================================
DO $$
DECLARE
  n INTEGER;
  rettype TEXT;
BEGIN
  -- 1. _place_lot_in_vessel exists with the expected signature and RETURNS uuid.
  IF to_regprocedure('public._place_lot_in_vessel(uuid, uuid, uuid, uuid, timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'Post-check 1: _place_lot_in_vessel(expected signature) missing.' USING ERRCODE='raise_exception';
  END IF;
  SELECT pg_catalog.format_type(prorettype, NULL) INTO rettype
  FROM pg_proc WHERE oid = 'public._place_lot_in_vessel(uuid, uuid, uuid, uuid, timestamptz)'::regprocedure;
  IF rettype <> 'uuid' THEN
    RAISE EXCEPTION 'Post-check 1: _place_lot_in_vessel must RETURN uuid (found %).', rettype USING ERRCODE='raise_exception';
  END IF;

  -- 2/3/4. The three affected operation functions exist with expected signatures.
  IF to_regprocedure('public.record_rack(uuid, uuid, numeric, text)') IS NULL THEN RAISE EXCEPTION 'Post-check 2: record_rack missing.' USING ERRCODE='raise_exception'; END IF;
  IF to_regprocedure('public.record_filtration(uuid, uuid, numeric, text)') IS NULL THEN RAISE EXCEPTION 'Post-check 3: record_filtration missing.' USING ERRCODE='raise_exception'; END IF;
  IF to_regprocedure('public.start_fermentation(uuid, uuid, text)') IS NULL THEN RAISE EXCEPTION 'Post-check 4: start_fermentation missing.' USING ERRCODE='raise_exception'; END IF;

  -- 5. All affected functions remain SECURITY DEFINER.
  SELECT COUNT(*) INTO n FROM pg_proc WHERE prosecdef = true AND oid IN (
    'public._place_lot_in_vessel(uuid, uuid, uuid, uuid, timestamptz)'::regprocedure,
    'public.record_rack(uuid, uuid, numeric, text)'::regprocedure,
    'public.record_filtration(uuid, uuid, numeric, text)'::regprocedure,
    'public.start_fermentation(uuid, uuid, text)'::regprocedure
  );
  IF n <> 4 THEN RAISE EXCEPTION 'Post-check 5: all affected functions must be SECURITY DEFINER (found %).', n USING ERRCODE='raise_exception'; END IF;

  -- 6. search_path pinned (public + pg_temp) on all affected functions.
  SELECT COUNT(*) INTO n FROM pg_proc p
  WHERE p.oid IN (
    'public._place_lot_in_vessel(uuid, uuid, uuid, uuid, timestamptz)'::regprocedure,
    'public.record_rack(uuid, uuid, numeric, text)'::regprocedure,
    'public.record_filtration(uuid, uuid, numeric, text)'::regprocedure,
    'public.start_fermentation(uuid, uuid, text)'::regprocedure
  ) AND EXISTS (
    SELECT 1 FROM unnest(COALESCE(p.proconfig, ARRAY[]::TEXT[])) c
    WHERE c LIKE 'search_path=%' AND position('public' IN c) > 0 AND position('pg_temp' IN c) > 0
  );
  IF n <> 4 THEN RAISE EXCEPTION 'Post-check 6: all affected functions must pin search_path (found %).', n USING ERRCODE='raise_exception'; END IF;

  -- 7. PUBLIC must not have EXECUTE on any affected function (incl. the helper).
  IF has_function_privilege('public','public._place_lot_in_vessel(uuid, uuid, uuid, uuid, timestamptz)','EXECUTE')
     OR has_function_privilege('public','public.record_rack(uuid, uuid, numeric, text)','EXECUTE')
     OR has_function_privilege('public','public.record_filtration(uuid, uuid, numeric, text)','EXECUTE')
     OR has_function_privilege('public','public.start_fermentation(uuid, uuid, text)','EXECUTE') THEN
    RAISE EXCEPTION 'Post-check 7: PUBLIC must not execute the affected functions.' USING ERRCODE='raise_exception';
  END IF;

  -- 8. authenticated has EXECUTE on the three user-facing RPCs (NOT the helper).
  IF NOT has_function_privilege('authenticated','public.record_rack(uuid, uuid, numeric, text)','EXECUTE')
     OR NOT has_function_privilege('authenticated','public.record_filtration(uuid, uuid, numeric, text)','EXECUTE')
     OR NOT has_function_privilege('authenticated','public.start_fermentation(uuid, uuid, text)','EXECUTE') THEN
    RAISE EXCEPTION 'Post-check 8: authenticated must have EXECUTE on the operation RPCs.' USING ERRCODE='raise_exception';
  END IF;
  -- The helper must NOT be executable by authenticated (reachable only via the RPCs).
  IF has_function_privilege('authenticated','public._place_lot_in_vessel(uuid, uuid, uuid, uuid, timestamptz)','EXECUTE') THEN
    RAISE EXCEPTION 'Post-check 8: _place_lot_in_vessel must not be executable by authenticated.' USING ERRCODE='raise_exception';
  END IF;
END $$;

COMMIT;
