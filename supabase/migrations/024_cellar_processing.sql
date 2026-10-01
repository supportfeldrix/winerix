-- ============================================================
-- WINERIX — P2I-2: Cellar Production / Processing (backend only)
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- Depends on: 006 (is_org_member/has_org_role), 018 (wine_lots), 019 (vessels,
--             vessel_placements), 020 (production_events), 021 (audit writer),
--             022 (lot_volume_movements, lot_lineage, assert_cellar_actor,
--             record_lot_loss, record_lot_adjustment)
--
-- PURPOSE:
--   Add the controlled "production operation" layer by COMPOSING the existing
--   primitives (production_events + P2H volume ledger + vessel_placements),
--   NOT by adding a new transaction/volume/lineage/location/audit system.
--
--   Adds:
--     * wine_lots.processing_state (nullable, controlled; separate from status)
--     * an additive, default-NULL p_production_event_id parameter on the P2H
--       volume functions record_lot_loss / record_lot_adjustment, so a movement
--       can be correlated to the production event that caused it
--     * SECURITY DEFINER wrapper RPCs: record_rack, record_filtration,
--       record_addition, start_fermentation, end_fermentation — each creates a
--       production_event and performs its effects atomically
--     * a narrow guard so processing_state is only changed by these operations
--
-- IMPORTANT ARCHITECTURE NOTE (deviation worth flagging):
--   There are NO P2F *database* functions for vessel placement — P2F performs
--   place/transfer/remove client-side in vesselService.js via direct writes to
--   vessel_placements. The P2I RPCs therefore perform the placement open/close
--   INLINE (helper _place_lot_in_vessel), replicating P2F semantics exactly:
--   close the lot's open placement (removed_at = now) and insert a new open
--   placement at the lot's CURRENT volume. This preserves vessel_placements as
--   the sole location truth and the one-open-placement-per-lot invariant (the
--   partial unique index uq_vp_one_open_per_lot). No current_vessel_id is added.
--
-- THIS MIGRATION DOES NOT:
--   * create production_transactions / a second volume / lineage / location /
--     audit system
--   * add current_vessel_id / parent_lot_id / ingredient inventory /
--     fermentation_runs / temperature / Brix / yeast / lab / bottling / stock
--   * directly UPDATE wine_lots.volume_litres (all volume via P2H functions)
--   * create a second audit writer (reuses audit_log_row_change via existing triggers)
--   * drop/rename anything or delete data; no backfill (existing lots -> NULL state)
-- ============================================================

BEGIN;

-- ============================================================
-- 0. PRE-FLIGHT
-- ============================================================
DO $$
BEGIN
  IF to_regclass('public.wine_lots') IS NULL THEN RAISE EXCEPTION 'Pre-flight: wine_lots missing (018).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.vessels') IS NULL THEN RAISE EXCEPTION 'Pre-flight: vessels missing (019).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.vessel_placements') IS NULL THEN RAISE EXCEPTION 'Pre-flight: vessel_placements missing (019).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.production_events') IS NULL THEN RAISE EXCEPTION 'Pre-flight: production_events missing (020).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.lot_volume_movements') IS NULL THEN RAISE EXCEPTION 'Pre-flight: lot_volume_movements missing (022).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.lot_lineage') IS NULL THEN RAISE EXCEPTION 'Pre-flight: lot_lineage missing (022).' USING ERRCODE='undefined_table'; END IF;
  IF to_regprocedure('public.assert_cellar_actor(uuid)') IS NULL THEN RAISE EXCEPTION 'Pre-flight: assert_cellar_actor missing (022).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.record_lot_loss(uuid, numeric, text)') IS NULL THEN RAISE EXCEPTION 'Pre-flight: record_lot_loss missing (022).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.record_lot_adjustment(uuid, numeric, text)') IS NULL THEN RAISE EXCEPTION 'Pre-flight: record_lot_adjustment missing (022).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.audit_log_row_change()') IS NULL THEN RAISE EXCEPTION 'Pre-flight: audit writer missing (021).' USING ERRCODE='undefined_function'; END IF;
  -- correlation columns from 022 must exist.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='lot_volume_movements' AND column_name='production_event_id') THEN
    RAISE EXCEPTION 'Pre-flight: lot_volume_movements.production_event_id missing (022).' USING ERRCODE='undefined_column';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='lot_lineage' AND column_name='production_event_id') THEN
    RAISE EXCEPTION 'Pre-flight: lot_lineage.production_event_id missing (022).' USING ERRCODE='undefined_column';
  END IF;
END $$;

-- ============================================================
-- 1. PROCESSING STATE (additive, nullable, controlled; separate from status)
-- ============================================================
ALTER TABLE public.wine_lots
  ADD COLUMN IF NOT EXISTS processing_state TEXT;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wine_lots_processing_state_check') THEN
    ALTER TABLE public.wine_lots
      ADD CONSTRAINT wine_lots_processing_state_check
      CHECK (processing_state IS NULL OR processing_state IN ('fermenting','settling','maturing'));
  END IF;
END $$;

-- ============================================================
-- 2. PRODUCTION EVENT TYPE: add 'fermentation_end' additively.
-- Existing types (transfer/racking/settling/fermentation/maturation/filtration/
-- addition/adjustment/other) are preserved; the end-of-fermentation operation
-- records a distinct, explicit event type.
-- ============================================================
DO $$
DECLARE
  conname TEXT;
BEGIN
  SELECT c.conname INTO conname
  FROM pg_constraint c
  WHERE c.conrelid = 'public.production_events'::regclass
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ILIKE '%event_type%';

  IF conname IS NULL THEN
    RAISE EXCEPTION 'Could not locate production_events event_type CHECK constraint.' USING ERRCODE='raise_exception';
  END IF;

  -- Only replace if 'fermentation_end' is not already allowed.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid='public.production_events'::regclass AND c.contype='c'
      AND pg_get_constraintdef(c.oid) ILIKE '%fermentation_end%'
  ) THEN
    EXECUTE format('ALTER TABLE public.production_events DROP CONSTRAINT %I', conname);
    ALTER TABLE public.production_events
      ADD CONSTRAINT production_events_event_type_check
      CHECK (event_type IN (
        'transfer','racking','settling','fermentation','fermentation_end',
        'maturation','filtration','addition','adjustment','other'
      ));
  END IF;
END $$;

-- ============================================================
-- 3. EXTEND P2H VOLUME FUNCTIONS WITH OPTIONAL production_event_id
-- Additive 4th parameter (DEFAULT NULL) — existing 3-arg calls still resolve to
-- these functions. All validation / security / reconciliation / cross-org
-- protection is preserved verbatim; only the movement INSERT gains the
-- correlation column.
-- ============================================================
CREATE OR REPLACE FUNCTION public.record_lot_loss(
  p_lot_id UUID,
  p_volume NUMERIC,
  p_notes TEXT DEFAULT NULL,
  p_production_event_id UUID DEFAULT NULL
)
RETURNS public.wine_lots
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org   UUID;
  v_owner UUID;
  v_cur   NUMERIC(12,2);
  v_res   public.wine_lots;
BEGIN
  IF p_volume IS NULL OR p_volume <= 0 THEN
    RAISE EXCEPTION 'Loss volume must be greater than zero.' USING ERRCODE = 'raise_exception';
  END IF;
  SELECT org_id, volume_litres INTO v_org, v_cur FROM public.wine_lots WHERE id = p_lot_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Wine lot % not found.', p_lot_id USING ERRCODE = 'raise_exception';
  END IF;
  v_owner := public.assert_cellar_actor(v_org);
  IF p_volume > v_cur THEN
    RAISE EXCEPTION 'Loss (%) exceeds current volume (%).', p_volume, v_cur USING ERRCODE = 'raise_exception';
  END IF;

  INSERT INTO public.lot_volume_movements (org_id, owner_id, wine_lot_id, movement_type, volume_delta_litres, notes, production_event_id)
  VALUES (v_org, v_owner, p_lot_id, 'loss', -p_volume, p_notes, p_production_event_id);

  UPDATE public.wine_lots
     SET volume_litres = volume_litres - p_volume,
         status = CASE WHEN volume_litres - p_volume = 0 THEN 'depleted' ELSE status END
   WHERE id = p_lot_id
   RETURNING * INTO v_res;

  RETURN v_res;
END;
$$;
REVOKE ALL ON FUNCTION public.record_lot_loss(UUID, NUMERIC, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_lot_loss(UUID, NUMERIC, TEXT, UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.record_lot_adjustment(
  p_lot_id UUID,
  p_delta NUMERIC,
  p_notes TEXT DEFAULT NULL,
  p_production_event_id UUID DEFAULT NULL
)
RETURNS public.wine_lots
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org   UUID;
  v_owner UUID;
  v_cur   NUMERIC(12,2);
  v_res   public.wine_lots;
BEGIN
  IF p_delta IS NULL OR p_delta = 0 THEN
    RAISE EXCEPTION 'Adjustment delta must be non-zero.' USING ERRCODE = 'raise_exception';
  END IF;
  SELECT org_id, volume_litres INTO v_org, v_cur FROM public.wine_lots WHERE id = p_lot_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Wine lot % not found.', p_lot_id USING ERRCODE = 'raise_exception';
  END IF;
  v_owner := public.assert_cellar_actor(v_org);
  IF v_cur + p_delta < 0 THEN
    RAISE EXCEPTION 'Adjustment would take volume below zero (current %, delta %).', v_cur, p_delta USING ERRCODE = 'raise_exception';
  END IF;

  INSERT INTO public.lot_volume_movements (org_id, owner_id, wine_lot_id, movement_type, volume_delta_litres, notes, production_event_id)
  VALUES (v_org, v_owner, p_lot_id, 'adjustment', p_delta, p_notes, p_production_event_id);

  UPDATE public.wine_lots
     SET volume_litres = volume_litres + p_delta,
         status = CASE WHEN volume_litres + p_delta = 0 THEN 'depleted' ELSE status END
   WHERE id = p_lot_id
   RETURNING * INTO v_res;

  RETURN v_res;
END;
$$;
REVOKE ALL ON FUNCTION public.record_lot_adjustment(UUID, NUMERIC, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_lot_adjustment(UUID, NUMERIC, TEXT, UUID) TO authenticated;

-- ============================================================
-- 4. PROCESSING-STATE GUARD
-- processing_state must only change inside a P2I operation. The operations set a
-- transaction-local flag (winerix.allow_processing_state='on') before the UPDATE;
-- any other attempt to change processing_state is rejected. Narrowly scoped:
-- only fires when the value actually changes.
-- ============================================================
CREATE OR REPLACE FUNCTION public.guard_wine_lot_processing_state()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.processing_state IS DISTINCT FROM OLD.processing_state THEN
    IF current_setting('winerix.allow_processing_state', true) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'processing_state can only be changed by a fermentation operation.' USING ERRCODE = 'raise_exception';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS wine_lots_guard_processing_state ON public.wine_lots;
CREATE TRIGGER wine_lots_guard_processing_state
  BEFORE UPDATE ON public.wine_lots
  FOR EACH ROW EXECUTE FUNCTION public.guard_wine_lot_processing_state();

-- ============================================================
-- 5. INTERNAL HELPER — place/transfer a lot into a vessel (inline P2F semantics)
-- Closes the lot's current open placement (if any and if different) and opens a
-- new placement at the lot's CURRENT volume. Preserves one-open-placement-per-lot.
-- SECURITY DEFINER; expects caller to have already asserted cellar actor + org.
-- NOTE: returns the open placement id so callers can correlate the production
-- event (production_events.vessel_placement_id). Because the return type is
-- changed from an earlier VOID version, DROP first — CREATE OR REPLACE cannot
-- change a function's return type. Safe: this helper is only invoked by the
-- P2I operation functions, which are (re)created later in this same migration.
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
-- 6. P2I OPERATION RPCS
-- Each: assert cellar actor, derive org from the lot (never from client),
-- create the production_event, perform effects (reusing P2H/inline-P2F), stamp
-- production_event_id on volume movements, atomic by virtue of one function call.
-- ============================================================

-- ---- A. RACK ----------------------------------------------------------------
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

-- ---- B. FILTRATION ----------------------------------------------------------
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

-- ---- C. ADDITION ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_addition(
  p_lot_id UUID,
  p_volume_delta_litres NUMERIC DEFAULT NULL,
  p_notes TEXT DEFAULT NULL
)
RETURNS public.production_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org   UUID;
  v_owner UUID;
  v_now   TIMESTAMPTZ := NOW();
  v_event public.production_events;
BEGIN
  SELECT org_id INTO v_org FROM public.wine_lots WHERE id = p_lot_id;
  IF v_org IS NULL THEN RAISE EXCEPTION 'Wine lot % not found.', p_lot_id USING ERRCODE='raise_exception'; END IF;
  v_owner := public.assert_cellar_actor(v_org);

  INSERT INTO public.production_events (org_id, owner_id, wine_lot_id, event_type, event_at, notes)
  VALUES (v_org, v_owner, p_lot_id, 'addition', v_now, p_notes)
  RETURNING * INTO v_event;

  IF p_volume_delta_litres IS NOT NULL AND p_volume_delta_litres <> 0 THEN
    PERFORM public.record_lot_adjustment(p_lot_id, p_volume_delta_litres, p_notes, v_event.id);
  END IF;

  RETURN v_event;
END;
$$;
REVOKE ALL ON FUNCTION public.record_addition(UUID, NUMERIC, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_addition(UUID, NUMERIC, TEXT) TO authenticated;

-- ---- D. START FERMENTATION --------------------------------------------------
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

-- ---- E. END FERMENTATION ----------------------------------------------------
CREATE OR REPLACE FUNCTION public.end_fermentation(
  p_lot_id UUID,
  p_loss_litres NUMERIC DEFAULT NULL,
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
  v_state  TEXT;
  v_now    TIMESTAMPTZ := NOW();
  v_event  public.production_events;
BEGIN
  SELECT org_id, processing_state INTO v_org, v_state FROM public.wine_lots WHERE id = p_lot_id;
  IF v_org IS NULL THEN RAISE EXCEPTION 'Wine lot % not found.', p_lot_id USING ERRCODE='raise_exception'; END IF;
  v_owner := public.assert_cellar_actor(v_org);
  IF v_state IS DISTINCT FROM 'fermenting' THEN
    RAISE EXCEPTION 'This lot is not currently fermenting.' USING ERRCODE='raise_exception';
  END IF;

  INSERT INTO public.production_events (org_id, owner_id, wine_lot_id, event_type, event_at, notes)
  VALUES (v_org, v_owner, p_lot_id, 'fermentation_end', v_now, p_notes)
  RETURNING * INTO v_event;

  PERFORM set_config('winerix.allow_processing_state', 'on', true);
  UPDATE public.wine_lots SET processing_state = 'settling' WHERE id = p_lot_id;
  PERFORM set_config('winerix.allow_processing_state', 'off', true);

  IF p_loss_litres IS NOT NULL AND p_loss_litres > 0 THEN
    PERFORM public.record_lot_loss(p_lot_id, p_loss_litres, p_notes, v_event.id);
  END IF;

  RETURN v_event;
END;
$$;
REVOKE ALL ON FUNCTION public.end_fermentation(UUID, NUMERIC, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.end_fermentation(UUID, NUMERIC, TEXT) TO authenticated;

-- ============================================================
-- 7. POST-CHANGE VALIDATION. RAISE => rollback.
-- ============================================================
DO $$
DECLARE
  n INTEGER;
  nullable TEXT;
  cfg TEXT[];
BEGIN
  -- 1/2. processing_state exists and is nullable.
  SELECT is_nullable INTO nullable FROM information_schema.columns
  WHERE table_schema='public' AND table_name='wine_lots' AND column_name='processing_state';
  IF nullable IS NULL THEN RAISE EXCEPTION 'Post-check 1: wine_lots.processing_state missing.' USING ERRCODE='raise_exception'; END IF;
  IF nullable <> 'YES' THEN RAISE EXCEPTION 'Post-check 2: processing_state must be nullable.' USING ERRCODE='raise_exception'; END IF;

  -- 3. CHECK constraint present.
  SELECT COUNT(*) INTO n FROM pg_constraint WHERE conname='wine_lots_processing_state_check' AND conrelid='public.wine_lots'::regclass;
  IF n <> 1 THEN RAISE EXCEPTION 'Post-check 3: processing_state CHECK missing.' USING ERRCODE='raise_exception'; END IF;

  -- 4. Existing rows remain valid (all NULL, no backfill).
  SELECT COUNT(*) INTO n FROM public.wine_lots WHERE processing_state IS NOT NULL;
  IF n <> 0 THEN RAISE EXCEPTION 'Post-check 4: existing lots must have NULL processing_state (found %).', n USING ERRCODE='raise_exception'; END IF;

  -- 5. Required production event types available (fermentation + fermentation_end).
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c WHERE c.conrelid='public.production_events'::regclass AND c.contype='c'
      AND pg_get_constraintdef(c.oid) ILIKE '%fermentation_end%'
      AND pg_get_constraintdef(c.oid) ILIKE '%racking%'
      AND pg_get_constraintdef(c.oid) ILIKE '%filtration%'
      AND pg_get_constraintdef(c.oid) ILIKE '%addition%'
  ) THEN
    RAISE EXCEPTION 'Post-check 5: production_events event_type set is not as expected.' USING ERRCODE='raise_exception';
  END IF;

  -- 6. correlation columns still present.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='lot_volume_movements' AND column_name='production_event_id') THEN
    RAISE EXCEPTION 'Post-check 6a: lot_volume_movements.production_event_id missing.' USING ERRCODE='raise_exception'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='lot_lineage' AND column_name='production_event_id') THEN
    RAISE EXCEPTION 'Post-check 6b: lot_lineage.production_event_id missing.' USING ERRCODE='raise_exception'; END IF;

  -- 7/8. Existing P2H functions still exist (4-arg now for loss/adjustment); P2F has no DB function (expected).
  IF to_regprocedure('public.split_wine_lot(uuid, jsonb, text)') IS NULL THEN RAISE EXCEPTION 'Post-check 7a: split_wine_lot missing.' USING ERRCODE='raise_exception'; END IF;
  IF to_regprocedure('public.combine_wine_lots(jsonb, text, text, text)') IS NULL THEN RAISE EXCEPTION 'Post-check 7b: combine_wine_lots missing.' USING ERRCODE='raise_exception'; END IF;
  IF to_regprocedure('public.record_lot_loss(uuid, numeric, text, uuid)') IS NULL THEN RAISE EXCEPTION 'Post-check 7c: record_lot_loss(4-arg) missing.' USING ERRCODE='raise_exception'; END IF;
  IF to_regprocedure('public.record_lot_adjustment(uuid, numeric, text, uuid)') IS NULL THEN RAISE EXCEPTION 'Post-check 7d: record_lot_adjustment(4-arg) missing.' USING ERRCODE='raise_exception'; END IF;

  -- 9. New P2I RPCs exist.
  IF to_regprocedure('public.record_rack(uuid, uuid, numeric, text)') IS NULL THEN RAISE EXCEPTION 'Post-check 9a: record_rack missing.' USING ERRCODE='raise_exception'; END IF;
  IF to_regprocedure('public.record_filtration(uuid, uuid, numeric, text)') IS NULL THEN RAISE EXCEPTION 'Post-check 9b: record_filtration missing.' USING ERRCODE='raise_exception'; END IF;
  IF to_regprocedure('public.record_addition(uuid, numeric, text)') IS NULL THEN RAISE EXCEPTION 'Post-check 9c: record_addition missing.' USING ERRCODE='raise_exception'; END IF;
  IF to_regprocedure('public.start_fermentation(uuid, uuid, text)') IS NULL THEN RAISE EXCEPTION 'Post-check 9d: start_fermentation missing.' USING ERRCODE='raise_exception'; END IF;
  IF to_regprocedure('public.end_fermentation(uuid, numeric, text)') IS NULL THEN RAISE EXCEPTION 'Post-check 9e: end_fermentation missing.' USING ERRCODE='raise_exception'; END IF;

  -- 10. New RPCs are SECURITY DEFINER (plus helper + extended volume fns + guard).
  SELECT COUNT(*) INTO n FROM pg_proc WHERE oid IN (
    'public.record_rack(uuid, uuid, numeric, text)'::regprocedure,
    'public.record_filtration(uuid, uuid, numeric, text)'::regprocedure,
    'public.record_addition(uuid, numeric, text)'::regprocedure,
    'public.start_fermentation(uuid, uuid, text)'::regprocedure,
    'public.end_fermentation(uuid, numeric, text)'::regprocedure,
    'public._place_lot_in_vessel(uuid, uuid, uuid, uuid, timestamptz)'::regprocedure,
    'public.record_lot_loss(uuid, numeric, text, uuid)'::regprocedure,
    'public.record_lot_adjustment(uuid, numeric, text, uuid)'::regprocedure,
    'public.guard_wine_lot_processing_state()'::regprocedure
  ) AND prosecdef = true;
  IF n <> 9 THEN RAISE EXCEPTION 'Post-check 10: expected 9 SECURITY DEFINER functions (found %).', n USING ERRCODE='raise_exception'; END IF;

  -- 11. Pinned search_path on the new RPCs.
  SELECT COUNT(*) INTO n FROM pg_proc p
  WHERE p.oid IN (
    'public.record_rack(uuid, uuid, numeric, text)'::regprocedure,
    'public.record_filtration(uuid, uuid, numeric, text)'::regprocedure,
    'public.record_addition(uuid, numeric, text)'::regprocedure,
    'public.start_fermentation(uuid, uuid, text)'::regprocedure,
    'public.end_fermentation(uuid, numeric, text)'::regprocedure
  ) AND EXISTS (
    SELECT 1 FROM unnest(COALESCE(p.proconfig, ARRAY[]::TEXT[])) c
    WHERE c LIKE 'search_path=%' AND position('public' IN c) > 0 AND position('pg_temp' IN c) > 0
  );
  IF n <> 5 THEN RAISE EXCEPTION 'Post-check 11: all P2I RPCs must pin search_path (found %).', n USING ERRCODE='raise_exception'; END IF;

  -- 12. PUBLIC EXECUTE revoked on P2I RPCs + helper.
  IF has_function_privilege('public','public.record_rack(uuid, uuid, numeric, text)','EXECUTE')
     OR has_function_privilege('public','public.record_filtration(uuid, uuid, numeric, text)','EXECUTE')
     OR has_function_privilege('public','public.record_addition(uuid, numeric, text)','EXECUTE')
     OR has_function_privilege('public','public.start_fermentation(uuid, uuid, text)','EXECUTE')
     OR has_function_privilege('public','public.end_fermentation(uuid, numeric, text)','EXECUTE')
     OR has_function_privilege('public','public._place_lot_in_vessel(uuid, uuid, uuid, uuid, timestamptz)','EXECUTE') THEN
    RAISE EXCEPTION 'Post-check 12: PUBLIC must not execute P2I functions.' USING ERRCODE='raise_exception';
  END IF;

  -- 13/14. Existing audit writer intact; no second writer (exactly one).
  IF to_regprocedure('public.audit_log_row_change()') IS NULL THEN RAISE EXCEPTION 'Post-check 13: audit writer missing.' USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_proc WHERE proname='audit_log_row_change' AND pronamespace='public'::regnamespace;
  IF n <> 1 THEN RAISE EXCEPTION 'Post-check 14: expected exactly one audit writer (found %).', n USING ERRCODE='raise_exception'; END IF;

  -- 15. No production_transactions table.
  IF to_regclass('public.production_transactions') IS NOT NULL THEN RAISE EXCEPTION 'Post-check 15: production_transactions must NOT exist.' USING ERRCODE='raise_exception'; END IF;

  -- 16. No current_vessel_id on wine_lots.
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='wine_lots' AND column_name='current_vessel_id') THEN
    RAISE EXCEPTION 'Post-check 16: wine_lots.current_vessel_id must NOT exist.' USING ERRCODE='raise_exception'; END IF;

  -- 17. No parent_lot_id on wine_lots.
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='wine_lots' AND column_name='parent_lot_id') THEN
    RAISE EXCEPTION 'Post-check 17: wine_lots.parent_lot_id must NOT exist.' USING ERRCODE='raise_exception'; END IF;

  -- 18/19. No ingredient inventory / fermentation_runs tables created.
  IF to_regclass('public.fermentation_runs') IS NOT NULL THEN RAISE EXCEPTION 'Post-check 19: fermentation_runs must NOT exist.' USING ERRCODE='raise_exception'; END IF;

  -- 20. Existing P2H volume/lineage tables intact.
  IF to_regclass('public.lot_volume_movements') IS NULL OR to_regclass('public.lot_lineage') IS NULL THEN
    RAISE EXCEPTION 'Post-check 20: P2H tables must remain.' USING ERRCODE='raise_exception';
  END IF;

  -- Guard trigger present.
  SELECT COUNT(*) INTO n FROM pg_trigger WHERE tgrelid='public.wine_lots'::regclass AND tgname='wine_lots_guard_processing_state' AND NOT tgisinternal;
  IF n <> 1 THEN RAISE EXCEPTION 'Post-check: processing_state guard trigger missing.' USING ERRCODE='raise_exception'; END IF;
END $$;

COMMIT;
