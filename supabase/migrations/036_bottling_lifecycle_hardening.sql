-- ============================================================
-- WINERIX — P2J-B4.1: Bottling Run Lifecycle Hardening
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- Depends on: 034 (bottling_runs / bottling_run_lots / bottling_outputs),
--             035 (complete_bottling_run)
--
-- PURPOSE:
--   Enforce, at the DATABASE level, that once a bottling run is TERMINAL
--   (status 'completed' or 'cancelled') its core data — and its child source
--   lots and outputs — can no longer be modified. This closes the gap left by
--   B4 where the B3 service could still UPDATE a completed run's rows.
--
--   Three BEFORE UPDATE triggers:
--     * bottling_runs      — reject UPDATE when OLD.status is terminal (uses OLD,
--                            never trusts NEW.status, so completed->planned etc.
--                            is impossible). planned/in_progress -> completed is
--                            still allowed (OLD is non-terminal), so B4's
--                            complete_bottling_run keeps working.
--     * bottling_run_lots  — reject UPDATE when the parent run (OLD and, if the
--                            FK is being changed, NEW) is terminal; a child can
--                            never be moved out of a terminal run.
--     * bottling_outputs   — same parent-terminal protection.
--
-- SCOPE — THIS MIGRATION ONLY:
--   Creates three SECURITY DEFINER trigger functions + their BEFORE UPDATE
--   triggers, plus post-validation. Additive and reversible.
--
-- THIS MIGRATION DOES NOT:
--   * modify production_events / wine_lots / lot_volume_movements / their CHECKs
--   * modify complete_bottling_run (035) or the B4 architecture
--   * change RLS policies, grants, or the organisation/RBAC model
--   * add DELETE policies, grants, UI, services, or any new domain table
--   * create a cancellation workflow or a general lifecycle engine
--   * create a second audit writer (a rejected UPDATE simply fails -> no audit row)
-- ============================================================

BEGIN;

-- ============================================================
-- 0. PRE-FLIGHT
-- ============================================================
DO $$
BEGIN
  IF to_regclass('public.bottling_runs') IS NULL THEN RAISE EXCEPTION 'Pre-flight: bottling_runs missing (034).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.bottling_run_lots') IS NULL THEN RAISE EXCEPTION 'Pre-flight: bottling_run_lots missing (034).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.bottling_outputs') IS NULL THEN RAISE EXCEPTION 'Pre-flight: bottling_outputs missing (034).' USING ERRCODE='undefined_table'; END IF;
  IF to_regprocedure('public.complete_bottling_run(uuid)') IS NULL THEN RAISE EXCEPTION 'Pre-flight: complete_bottling_run(uuid) missing (035).' USING ERRCODE='undefined_function'; END IF;
  -- Confirm the four-state status vocabulary (incl. the two terminal states).
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid='public.bottling_runs'::regclass AND c.contype='c'
      AND pg_get_constraintdef(c.oid) ILIKE '%planned%'
      AND pg_get_constraintdef(c.oid) ILIKE '%in_progress%'
      AND pg_get_constraintdef(c.oid) ILIKE '%completed%'
      AND pg_get_constraintdef(c.oid) ILIKE '%cancelled%'
  ) THEN
    RAISE EXCEPTION 'Pre-flight: bottling_runs status vocabulary not as expected.' USING ERRCODE='raise_exception';
  END IF;
END $$;

-- ============================================================
-- 1. bottling_runs — terminal immutability (BEFORE UPDATE)
-- Keyed on OLD.status so the legitimate transition INTO completed (OLD is
-- planned/in_progress) is allowed, while any UPDATE of an already-terminal row
-- is rejected regardless of what NEW.status claims.
-- ============================================================
CREATE OR REPLACE FUNCTION public.guard_bottling_run_terminal()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.status = 'completed' THEN
    RAISE EXCEPTION 'Completed bottling runs are immutable.' USING ERRCODE = 'raise_exception';
  ELSIF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'Cancelled bottling runs are immutable.' USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bottling_runs_terminal_guard ON public.bottling_runs;
CREATE TRIGGER bottling_runs_terminal_guard
  BEFORE UPDATE ON public.bottling_runs
  FOR EACH ROW EXECUTE FUNCTION public.guard_bottling_run_terminal();

-- ============================================================
-- 2. bottling_run_lots — parent-terminal immutability (BEFORE UPDATE)
-- SECURITY DEFINER so it can read the parent run's status regardless of RLS.
-- Checks the OLD parent, and (if bottling_run_id is being changed) the NEW
-- parent too — so a child can neither be edited under a terminal run nor moved
-- out of one.
-- ============================================================
CREATE OR REPLACE FUNCTION public.guard_bottling_run_lot_terminal()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_old_status TEXT;
  v_new_status TEXT;
BEGIN
  SELECT status INTO v_old_status FROM public.bottling_runs WHERE id = OLD.bottling_run_id;
  IF v_old_status IN ('completed','cancelled') THEN
    RAISE EXCEPTION 'Source lots of a % bottling run are immutable.', v_old_status USING ERRCODE = 'raise_exception';
  END IF;

  IF NEW.bottling_run_id IS DISTINCT FROM OLD.bottling_run_id THEN
    SELECT status INTO v_new_status FROM public.bottling_runs WHERE id = NEW.bottling_run_id;
    IF v_new_status IN ('completed','cancelled') THEN
      RAISE EXCEPTION 'Cannot move a source lot into a % bottling run.', v_new_status USING ERRCODE = 'raise_exception';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bottling_run_lots_terminal_guard ON public.bottling_run_lots;
CREATE TRIGGER bottling_run_lots_terminal_guard
  BEFORE UPDATE ON public.bottling_run_lots
  FOR EACH ROW EXECUTE FUNCTION public.guard_bottling_run_lot_terminal();

-- ============================================================
-- 3. bottling_outputs — parent-terminal immutability (BEFORE UPDATE)
-- ============================================================
CREATE OR REPLACE FUNCTION public.guard_bottling_output_terminal()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_old_status TEXT;
  v_new_status TEXT;
BEGIN
  SELECT status INTO v_old_status FROM public.bottling_runs WHERE id = OLD.bottling_run_id;
  IF v_old_status IN ('completed','cancelled') THEN
    RAISE EXCEPTION 'Outputs of a % bottling run are immutable.', v_old_status USING ERRCODE = 'raise_exception';
  END IF;

  IF NEW.bottling_run_id IS DISTINCT FROM OLD.bottling_run_id THEN
    SELECT status INTO v_new_status FROM public.bottling_runs WHERE id = NEW.bottling_run_id;
    IF v_new_status IN ('completed','cancelled') THEN
      RAISE EXCEPTION 'Cannot move an output into a % bottling run.', v_new_status USING ERRCODE = 'raise_exception';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bottling_outputs_terminal_guard ON public.bottling_outputs;
CREATE TRIGGER bottling_outputs_terminal_guard
  BEFORE UPDATE ON public.bottling_outputs
  FOR EACH ROW EXECUTE FUNCTION public.guard_bottling_output_terminal();

-- ============================================================
-- 4. POST-VALIDATION (catalog checks). RAISE => rollback.
-- ============================================================
DO $$
DECLARE
  n INTEGER;
  cfg TEXT[];
  v_oid OID;
BEGIN
  -- 1-3. The three terminal-guard triggers exist on their tables.
  SELECT COUNT(*) INTO n FROM pg_trigger WHERE tgrelid='public.bottling_runs'::regclass AND tgname='bottling_runs_terminal_guard' AND NOT tgisinternal;
  IF n <> 1 THEN RAISE EXCEPTION 'Post: bottling_runs_terminal_guard missing.' USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_trigger WHERE tgrelid='public.bottling_run_lots'::regclass AND tgname='bottling_run_lots_terminal_guard' AND NOT tgisinternal;
  IF n <> 1 THEN RAISE EXCEPTION 'Post: bottling_run_lots_terminal_guard missing.' USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_trigger WHERE tgrelid='public.bottling_outputs'::regclass AND tgname='bottling_outputs_terminal_guard' AND NOT tgisinternal;
  IF n <> 1 THEN RAISE EXCEPTION 'Post: bottling_outputs_terminal_guard missing.' USING ERRCODE='raise_exception'; END IF;

  -- Triggers are BEFORE UPDATE only (tgtype bit 1 (2)=BEFORE, bit 4 (16)=UPDATE,
  -- bit 2 (4)=INSERT, bit 3 (8)=DELETE).
  FOR v_oid IN
    SELECT t.oid FROM pg_trigger t
    WHERE t.tgname IN ('bottling_runs_terminal_guard','bottling_run_lots_terminal_guard','bottling_outputs_terminal_guard')
      AND NOT t.tgisinternal
  LOOP
    IF (SELECT (tgtype & 2) FROM pg_trigger WHERE oid=v_oid) = 0 THEN RAISE EXCEPTION 'Post: terminal guard must be BEFORE.' USING ERRCODE='raise_exception'; END IF;
    IF (SELECT (tgtype & 16) FROM pg_trigger WHERE oid=v_oid) = 0 THEN RAISE EXCEPTION 'Post: terminal guard must fire on UPDATE.' USING ERRCODE='raise_exception'; END IF;
    IF (SELECT (tgtype & 4) FROM pg_trigger WHERE oid=v_oid) <> 0 THEN RAISE EXCEPTION 'Post: terminal guard must NOT fire on INSERT.' USING ERRCODE='raise_exception'; END IF;
    IF (SELECT (tgtype & 8) FROM pg_trigger WHERE oid=v_oid) <> 0 THEN RAISE EXCEPTION 'Post: terminal guard must NOT fire on DELETE.' USING ERRCODE='raise_exception'; END IF;
  END LOOP;

  -- 4. Trigger functions are SECURITY DEFINER with pinned search_path.
  SELECT COUNT(*) INTO n FROM pg_proc WHERE oid IN (
    'public.guard_bottling_run_terminal()'::regprocedure,
    'public.guard_bottling_run_lot_terminal()'::regprocedure,
    'public.guard_bottling_output_terminal()'::regprocedure
  ) AND prosecdef = true;
  IF n <> 3 THEN RAISE EXCEPTION 'Post: 3 terminal-guard fns must be SECURITY DEFINER (%).', n USING ERRCODE='raise_exception'; END IF;
  FOR v_oid IN SELECT oid FROM pg_proc WHERE oid IN (
    'public.guard_bottling_run_terminal()'::regprocedure,
    'public.guard_bottling_run_lot_terminal()'::regprocedure,
    'public.guard_bottling_output_terminal()'::regprocedure)
  LOOP
    SELECT proconfig INTO cfg FROM pg_proc WHERE oid=v_oid;
    IF NOT EXISTS (SELECT 1 FROM unnest(COALESCE(cfg,ARRAY[]::TEXT[])) c WHERE c LIKE 'search_path=%' AND position('public' IN c)>0 AND position('pg_temp' IN c)>0) THEN
      RAISE EXCEPTION 'Post: terminal-guard fn must pin search_path.' USING ERRCODE='raise_exception';
    END IF;
  END LOOP;

  -- 5. RLS still enabled on all three bottling tables.
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.bottling_runs'::regclass) THEN RAISE EXCEPTION 'Post: RLS off on bottling_runs.' USING ERRCODE='raise_exception'; END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.bottling_run_lots'::regclass) THEN RAISE EXCEPTION 'Post: RLS off on bottling_run_lots.' USING ERRCODE='raise_exception'; END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.bottling_outputs'::regclass) THEN RAISE EXCEPTION 'Post: RLS off on bottling_outputs.' USING ERRCODE='raise_exception'; END IF;

  -- 6. No DELETE policy introduced; authenticated still has no DELETE.
  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename IN ('bottling_runs','bottling_run_lots','bottling_outputs') AND cmd='DELETE';
  IF n <> 0 THEN RAISE EXCEPTION 'Post: no DELETE policy may exist on bottling tables (%).', n USING ERRCODE='raise_exception'; END IF;
  IF has_table_privilege('authenticated','public.bottling_runs','DELETE')
     OR has_table_privilege('authenticated','public.bottling_run_lots','DELETE')
     OR has_table_privilege('authenticated','public.bottling_outputs','DELETE') THEN
    RAISE EXCEPTION 'Post: authenticated must not have DELETE on bottling tables.' USING ERRCODE='raise_exception';
  END IF;

  -- 7. B4 RPC still present.
  IF to_regprocedure('public.complete_bottling_run(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Post: complete_bottling_run(uuid) must still exist.' USING ERRCODE='raise_exception';
  END IF;

  -- 8. production_events unchanged: wine_lot_id still NOT NULL; event_type still has bottling.
  SELECT COUNT(*) INTO n FROM information_schema.columns
  WHERE table_schema='public' AND table_name='production_events' AND column_name='wine_lot_id' AND is_nullable='NO';
  IF n <> 1 THEN RAISE EXCEPTION 'Post: production_events.wine_lot_id must remain NOT NULL.' USING ERRCODE='raise_exception'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid='public.production_events'::regclass AND c.contype='c'
                 AND pg_get_constraintdef(c.oid) ILIKE '%bottling%') THEN
    RAISE EXCEPTION 'Post: production_events event_type vocabulary unexpectedly changed.' USING ERRCODE='raise_exception';
  END IF;

  -- 9. Existing bottling audit triggers remain.
  SELECT COUNT(*) INTO n FROM pg_trigger WHERE NOT tgisinternal AND tgname IN (
    'trg_audit_bottling_runs','trg_audit_bottling_run_lots','trg_audit_bottling_outputs');
  IF n <> 3 THEN RAISE EXCEPTION 'Post: the 3 bottling audit triggers must remain (%).', n USING ERRCODE='raise_exception'; END IF;

  -- 10. Existing movement vocabulary remains (bottling_out/bottling_loss intact).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid='public.lot_volume_movements'::regclass AND c.contype='c'
                 AND pg_get_constraintdef(c.oid) ILIKE '%bottling_out%' AND pg_get_constraintdef(c.oid) ILIKE '%bottling_loss%'
                 AND pg_get_constraintdef(c.oid) ILIKE '%initial%') THEN
    RAISE EXCEPTION 'Post: lot_volume_movements movement_type vocabulary unexpectedly changed.' USING ERRCODE='raise_exception';
  END IF;
END $$;

COMMIT;
