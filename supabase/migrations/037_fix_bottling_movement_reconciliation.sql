-- ============================================================
-- WINERIX — P2J-B4 FIX: Bottling Movement Reconciliation (migration 037)
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- Depends on: 035 (complete_bottling_run), 034 (bottling tables +
--             bottling_out/bottling_loss movement types), 022 (lot volume
--             ledger + the SUM(deltas) == wine_lots.volume_litres invariant),
--             020/034 (production_events + 'bottling'), 018 (wine_lots status).
--
-- PURPOSE:
--   Migration 035 wrote the per-source-lot bottling_out movement as
--   -consumed_volume_litres AND, separately, a bottling_loss movement as
--   -loss_litres. Because consumed = bottled + loss, that double-counts the loss
--   in the append-only lot volume ledger: SUM(movement deltas) came to
--   -(consumed + loss) while wine_lots.volume_litres was (correctly) reduced by
--   only consumed. This BREAKS the P2H invariant asserted in 022:
--       SUM(lot_volume_movements.volume_delta_litres) == wine_lots.volume_litres
--   (per lot), by exactly -loss whenever loss > 0.
--
--   THE FIX (minimal): split the consumed deduction across the ledger by its two
--   categories so the deltas sum to -consumed:
--       bottling_out  = -bottled_litres   (was -consumed_volume_litres)
--       bottling_loss = -loss_litres      (UNCHANGED)
--   => bottling_out + bottling_loss = -(bottled + loss) = -consumed.
--   The physical wine_lots.volume_litres deduction (-consumed) is CORRECT and is
--   left exactly as-is. The guard on the bottling_out insert changes from
--   consumed_volume_litres > 0 to bottled_litres > 0 (a zero-bottled line writes
--   no bottling_out row; its loss, if any, is still recorded via bottling_loss).
--
-- SCOPE — THIS MIGRATION ONLY:
--   CREATE OR REPLACE public.complete_bottling_run(uuid) with the two movement
--   lines corrected. EVERYTHING ELSE is preserved byte-for-byte: signature,
--   SECURITY DEFINER, SET search_path, auth/role checks, status validation,
--   FOR UPDATE + deterministic locking, cross-org checks, source/output
--   validation, output reconciliation, Option-A per-lot production events,
--   wine_lots status handling, run status handling, audit behaviour, return
--   type, and grants. No schema change, no new table/type/trigger, no new
--   migration dependency. This DDL writes NO bottling/movement/event rows.
--
-- THIS MIGRATION DOES NOT:
--   * edit 035 or 036 (history preserved; this is a forward fix)
--   * change wine_lots.volume_litres deduction (stays -consumed, correct)
--   * add a run-level production event or alter production_events
--   * execute the RPC, create test data, or touch any live bottling run/lot
-- ============================================================

BEGIN;

-- ============================================================
-- 0. PRE-FLIGHT — the target function and its dependencies must already exist.
-- ============================================================
DO $$
BEGIN
  IF to_regprocedure('public.complete_bottling_run(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight: complete_bottling_run(uuid) missing (apply 035 first).' USING ERRCODE='undefined_function';
  END IF;
  IF to_regclass('public.bottling_runs') IS NULL THEN RAISE EXCEPTION 'Pre-flight: bottling_runs missing (034).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.bottling_run_lots') IS NULL THEN RAISE EXCEPTION 'Pre-flight: bottling_run_lots missing (034).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.bottling_outputs') IS NULL THEN RAISE EXCEPTION 'Pre-flight: bottling_outputs missing (034).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.wine_lots') IS NULL THEN RAISE EXCEPTION 'Pre-flight: wine_lots missing (018).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.lot_volume_movements') IS NULL THEN RAISE EXCEPTION 'Pre-flight: lot_volume_movements missing (022).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.production_events') IS NULL THEN RAISE EXCEPTION 'Pre-flight: production_events missing (020).' USING ERRCODE='undefined_table'; END IF;
  IF to_regprocedure('public.assert_cellar_actor(uuid)') IS NULL THEN RAISE EXCEPTION 'Pre-flight: assert_cellar_actor missing (022).' USING ERRCODE='undefined_function'; END IF;
END $$;

-- ============================================================
-- 1. complete_bottling_run — unchanged EXCEPT the two movement lines in step 8.
-- ============================================================
CREATE OR REPLACE FUNCTION public.complete_bottling_run(p_bottling_run_id UUID)
RETURNS public.bottling_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid              UUID := auth.uid();
  v_org              UUID;
  v_owner            UUID;
  v_run              public.bottling_runs;
  v_now              TIMESTAMPTZ := now();
  v_lot_count        INTEGER;
  v_output_count     INTEGER;
  v_src_bottled_sum  NUMERIC(12,2);
  v_out_bottled_sum  NUMERIC(12,2);
  r                  RECORD;
  v_event_id         UUID;
  v_new_vol          NUMERIC(12,2);
BEGIN
  -- 1. Authentication (fail closed).
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.' USING ERRCODE = 'raise_exception';
  END IF;

  -- 2. Lock the bottling run FOR UPDATE (prevents concurrent completion) and
  -- derive its organisation from the row (never from the client).
  SELECT * INTO v_run FROM public.bottling_runs WHERE id = p_bottling_run_id FOR UPDATE;
  IF v_run.id IS NULL THEN
    RAISE EXCEPTION 'Bottling run % not found.', p_bottling_run_id USING ERRCODE = 'raise_exception';
  END IF;
  v_org := v_run.org_id;

  -- 3. Authorisation: active membership + OWNER/ADMIN/CELLAR for the run's org
  -- (reuses the established cellar guard; returns the actor uid).
  v_owner := public.assert_cellar_actor(v_org);

  -- 4. Status eligibility: only planned or in_progress -> completed.
  IF v_run.status NOT IN ('planned','in_progress') THEN
    RAISE EXCEPTION 'Bottling run cannot be completed from status "%".', v_run.status USING ERRCODE = 'raise_exception';
  END IF;

  -- 5. There must be at least one source lot and at least one output.
  SELECT COUNT(*) INTO v_lot_count FROM public.bottling_run_lots WHERE bottling_run_id = v_run.id;
  IF v_lot_count = 0 THEN
    RAISE EXCEPTION 'Bottling run has no source wine lots.' USING ERRCODE = 'raise_exception';
  END IF;
  SELECT COUNT(*) INTO v_output_count FROM public.bottling_outputs WHERE bottling_run_id = v_run.id;
  IF v_output_count = 0 THEN
    RAISE EXCEPTION 'Bottling run has no outputs.' USING ERRCODE = 'raise_exception';
  END IF;

  -- 6. Lock every source wine lot FOR UPDATE in a DETERMINISTIC order (by
  -- wine_lot_id) to minimise deadlock risk under concurrency. Locks are taken
  -- before any availability check or mutation.
  PERFORM 1
  FROM public.wine_lots wl
  WHERE wl.id IN (SELECT brl.wine_lot_id FROM public.bottling_run_lots brl WHERE brl.bottling_run_id = v_run.id)
  ORDER BY wl.id
  FOR UPDATE;

  -- 7. Output reconciliation (NUMERIC): total output bottled must equal total
  -- source bottled. Validate output row data too.
  SELECT COALESCE(SUM(bottled_litres), 0)::NUMERIC(12,2) INTO v_out_bottled_sum
  FROM public.bottling_outputs WHERE bottling_run_id = v_run.id;

  IF EXISTS (
    SELECT 1 FROM public.bottling_outputs
    WHERE bottling_run_id = v_run.id
      AND (bottle_volume_ml <= 0 OR bottle_count < 0 OR bottled_litres < 0 OR length(btrim(packaging_format)) = 0
           OR (vintage IS NOT NULL AND (vintage < 1900 OR vintage > 2200)))
  ) THEN
    RAISE EXCEPTION 'One or more bottling outputs have invalid values.' USING ERRCODE = 'raise_exception';
  END IF;

  SELECT COALESCE(SUM(bottled_litres), 0)::NUMERIC(12,2) INTO v_src_bottled_sum
  FROM public.bottling_run_lots WHERE bottling_run_id = v_run.id;

  IF v_out_bottled_sum <> v_src_bottled_sum THEN
    RAISE EXCEPTION 'Output bottled litres (%) do not reconcile with source bottled litres (%).',
      v_out_bottled_sum, v_src_bottled_sum USING ERRCODE = 'raise_exception';
  END IF;

  -- 8. Per source lot: validate, reconcile, create the Option-A event, write the
  -- movement(s), and update the lot volume via the ESTABLISHED pattern. The
  -- source lots are already locked (step 6); re-read current volume for each.
  FOR r IN
    SELECT brl.id AS brl_id, brl.wine_lot_id, brl.consumed_volume_litres, brl.bottled_litres, brl.loss_litres,
           wl.org_id AS lot_org, wl.volume_litres AS lot_vol, wl.status AS lot_status
    FROM public.bottling_run_lots brl
    JOIN public.wine_lots wl ON wl.id = brl.wine_lot_id
    WHERE brl.bottling_run_id = v_run.id
    ORDER BY brl.wine_lot_id
  LOOP
    -- Cross-organisation integrity (never trust stored org blindly).
    IF r.lot_org <> v_org THEN
      RAISE EXCEPTION 'Cross-organisation reference: wine lot % belongs to a different organisation.', r.wine_lot_id USING ERRCODE = 'raise_exception';
    END IF;

    -- Non-negativity (DB CHECKs also enforce) + exact reconciliation.
    IF r.consumed_volume_litres < 0 OR r.bottled_litres < 0 OR r.loss_litres < 0 THEN
      RAISE EXCEPTION 'Source allocation for wine lot % has negative values.', r.wine_lot_id USING ERRCODE = 'raise_exception';
    END IF;
    IF r.bottled_litres + r.loss_litres <> r.consumed_volume_litres THEN
      RAISE EXCEPTION 'Source allocation for wine lot % does not reconcile (bottled % + loss % <> consumed %).',
        r.wine_lot_id, r.bottled_litres, r.loss_litres, r.consumed_volume_litres USING ERRCODE = 'raise_exception';
    END IF;

    -- Availability (checked AFTER locking).
    IF r.consumed_volume_litres > r.lot_vol THEN
      RAISE EXCEPTION 'Insufficient wine lot volume for bottling: lot % has % L but % L is required.',
        r.wine_lot_id, r.lot_vol, r.consumed_volume_litres USING ERRCODE = 'raise_exception';
    END IF;

    -- OPTION A: one bottling production_event for THIS source lot.
    INSERT INTO public.production_events (org_id, owner_id, wine_lot_id, event_type, event_at, notes)
    VALUES (v_org, v_owner, r.wine_lot_id, 'bottling', v_now,
            format('Bottling run %s', v_run.bottling_code))
    RETURNING id INTO v_event_id;

    -- Movement: bottling_out = the BOTTLED portion (ledger reconciliation fix).
    -- Previously this was -consumed_volume_litres, which double-counted the loss
    -- against the separate bottling_loss row below. bottling_out + bottling_loss
    -- must sum to -consumed so SUM(deltas) == the -consumed volume deduction.
    -- Only create a movement when there is bottled volume to move.
    IF r.bottled_litres > 0 THEN
      INSERT INTO public.lot_volume_movements
        (org_id, owner_id, wine_lot_id, movement_type, volume_delta_litres, lot_lineage_id, production_event_id, notes, occurred_at)
      VALUES (v_org, v_owner, r.wine_lot_id, 'bottling_out', -r.bottled_litres, NULL, v_event_id,
              format('Bottling run %s', v_run.bottling_code), v_now);
    END IF;

    -- Movement: bottling_loss (only when loss > 0), same correlated event.
    -- UNCHANGED from 035.
    IF r.loss_litres > 0 THEN
      INSERT INTO public.lot_volume_movements
        (org_id, owner_id, wine_lot_id, movement_type, volume_delta_litres, lot_lineage_id, production_event_id, notes, occurred_at)
      VALUES (v_org, v_owner, r.wine_lot_id, 'bottling_loss', -r.loss_litres, NULL, v_event_id,
              format('Bottling loss, run %s', v_run.bottling_code), v_now);
    END IF;

    -- Update the materialised lot volume via the ESTABLISHED pattern (same
    -- transaction as the movement inserts). Deduct the FULL consumed volume
    -- (bottled + loss) — UNCHANGED from 035; this physical deduction is correct.
    -- At exactly zero, transition status to 'bottled' (a valid existing status);
    -- otherwise leave status untouched. Never set an arbitrary absolute value;
    -- never touch processing_state.
    v_new_vol := (r.lot_vol - r.consumed_volume_litres)::NUMERIC(12,2);
    UPDATE public.wine_lots
       SET volume_litres = v_new_vol,
           status = CASE WHEN v_new_vol = 0 THEN 'bottled' ELSE status END
     WHERE id = r.wine_lot_id;
  END LOOP;

  -- 9. Complete the run (its audit UPDATE is captured by the existing trigger).
  UPDATE public.bottling_runs
     SET status = 'completed'
   WHERE id = v_run.id
   RETURNING * INTO v_run;

  RETURN v_run;
END;
$$;

-- ============================================================
-- 2. PERMISSIONS — reassert authenticated only (never PUBLIC / anon).
--    CREATE OR REPLACE preserves existing grants, but we reassert to be safe
--    and idempotent (matches the 035 pattern).
-- ============================================================
REVOKE ALL ON FUNCTION public.complete_bottling_run(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_bottling_run(UUID) TO authenticated;

-- ============================================================
-- 3. POST-VALIDATION (catalog checks). RAISE => rollback.
-- ============================================================
DO $$
DECLARE
  v_oid     OID;
  is_secdef BOOLEAN;
  cfg       TEXT[];
  rettype   TEXT;
BEGIN
  v_oid := to_regprocedure('public.complete_bottling_run(uuid)');
  IF v_oid IS NULL THEN RAISE EXCEPTION 'Post: complete_bottling_run(uuid) missing.' USING ERRCODE='raise_exception'; END IF;

  -- 1. SECURITY DEFINER preserved.
  SELECT prosecdef INTO is_secdef FROM pg_proc WHERE oid = v_oid;
  IF NOT COALESCE(is_secdef,false) THEN RAISE EXCEPTION 'Post: complete_bottling_run must be SECURITY DEFINER.' USING ERRCODE='raise_exception'; END IF;

  -- 2. search_path pinned to public, pg_temp.
  SELECT proconfig INTO cfg FROM pg_proc WHERE oid = v_oid;
  IF NOT EXISTS (SELECT 1 FROM unnest(COALESCE(cfg,ARRAY[]::TEXT[])) c
                 WHERE c LIKE 'search_path=%' AND position('public' IN c)>0 AND position('pg_temp' IN c)>0) THEN
    RAISE EXCEPTION 'Post: complete_bottling_run must SET search_path = public, pg_temp.' USING ERRCODE='raise_exception';
  END IF;

  -- 3. PUBLIC must not EXECUTE; authenticated must EXECUTE; anon must not.
  IF has_function_privilege('public', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'Post: PUBLIC must not EXECUTE complete_bottling_run.' USING ERRCODE='raise_exception'; END IF;
  IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'Post: authenticated must EXECUTE complete_bottling_run.' USING ERRCODE='raise_exception'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') AND has_function_privilege('anon', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'Post: anon must not EXECUTE complete_bottling_run.' USING ERRCODE='raise_exception'; END IF;

  -- 4. Return type unchanged.
  SELECT format_type(prorettype, NULL) INTO rettype FROM pg_proc WHERE oid = v_oid;
  IF rettype NOT IN ('bottling_runs','public.bottling_runs') THEN
    RAISE EXCEPTION 'Post: complete_bottling_run must return public.bottling_runs (found %).', rettype USING ERRCODE='raise_exception';
  END IF;

  -- 5. The corrected source text uses -r.bottled_litres for bottling_out and no
  -- longer uses -r.consumed_volume_litres for a movement delta.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE oid = v_oid
      AND pg_get_functiondef(oid) ILIKE '%''bottling_out'', -r.bottled_litres%'
  ) THEN
    RAISE EXCEPTION 'Post: bottling_out movement must use -r.bottled_litres.' USING ERRCODE='raise_exception';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc WHERE oid = v_oid
      AND pg_get_functiondef(oid) ILIKE '%''bottling_out'', -r.consumed_volume_litres%'
  ) THEN
    RAISE EXCEPTION 'Post: bottling_out must NOT use -r.consumed_volume_litres (double-counts loss).' USING ERRCODE='raise_exception';
  END IF;
END $$;

COMMIT;
