-- ============================================================
-- WINERIX — P2G-2: Audit Wiring
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- Depends on: 006 (audit_log, organisations), 017 (wine_batches,
--             batch_grape_intakes), 018 (wine_lots), 019 (vessels,
--             vessel_placements), 020 (production_events)
--
-- PURPOSE:
--   Wire the EXISTING public.audit_log (created untouched in 006) to the six
--   cellar tables via one generic SECURITY DEFINER trigger function plus
--   explicit AFTER-row triggers. The audit log is a TECHNICAL database-mutation
--   history (who changed which row, old -> new, when). It complements — and
--   does NOT replace — Production Events (business cellar history) and Vessel
--   Placements (physical location history). These three layers stay distinct.
--
-- SCOPE — THIS MIGRATION ONLY:
--   Creates public.audit_log_row_change() + AFTER triggers on:
--     wine_batches, batch_grape_intakes, wine_lots, vessels,
--     vessel_placements  -> INSERT/UPDATE/DELETE
--     production_events   -> INSERT ONLY (append-only table)
--   Plus post-validation. Fully additive.
--
-- THIS MIGRATION DOES NOT:
--   * alter audit_log columns / constraints / indexes / RLS / policies / grants
--   * alter any business-table column, constraint, RLS, grant, or existing
--     trigger (org-integrity, owner-immutability, updated_at all preserved)
--   * attach any trigger to audit_log (recursion guard)
--   * write / backfill any audit rows (audit_log stays empty after this runs)
--   * add UI, services, or any src/ change
--
-- FAILURE SEMANTICS: audit writes are TRANSACTIONAL. The trigger does NOT catch
--   or swallow errors. If the audit_log insert fails, the whole transaction —
--   including the business mutation — rolls back. A cellar mutation must never
--   succeed without its audit record.
-- ============================================================

BEGIN;

-- ============================================================
-- 0. PRE-FLIGHT (fail before creating anything if deps are missing)
-- ============================================================
DO $$
DECLARE
  t TEXT;
  required_tables TEXT[] := ARRAY[
    'audit_log','wine_batches','batch_grape_intakes','wine_lots',
    'vessels','vessel_placements','production_events'
  ];
BEGIN
  FOREACH t IN ARRAY required_tables LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE EXCEPTION 'Pre-flight failed: public.% is missing (run its migration first).', t
        USING ERRCODE = 'undefined_table';
    END IF;
  END LOOP;

  -- audit_log must have the columns the writer targets.
  IF (
    SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema='public' AND table_name='audit_log'
      AND column_name IN ('id','org_id','actor_user_id','action','entity_type','entity_id','old_data','new_data','metadata','created_at')
  ) <> 10 THEN
    RAISE EXCEPTION 'Pre-flight failed: audit_log does not have the expected columns.' USING ERRCODE = 'undefined_column';
  END IF;

  -- Every target row-source must carry org_id and id (the writer reads them).
  FOREACH t IN ARRAY ARRAY['wine_batches','batch_grape_intakes','wine_lots','vessels','vessel_placements','production_events'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name=t AND column_name='org_id'
    ) THEN
      RAISE EXCEPTION 'Pre-flight failed: %.org_id is missing.', t USING ERRCODE = 'undefined_column';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name=t AND column_name='id'
    ) THEN
      RAISE EXCEPTION 'Pre-flight failed: %.id is missing.', t USING ERRCODE = 'undefined_column';
    END IF;
  END LOOP;
END $$;

-- ============================================================
-- 1. GENERIC AUDIT WRITER
-- One function for all target tables. SECURITY DEFINER so it can INSERT into
-- audit_log (which has no client INSERT policy/grant); pinned search_path;
-- derives everything from TG_OP / TG_TABLE_NAME / OLD / NEW.
--
-- actor_user_id = auth.uid() (NULL under service-role / migration contexts;
-- no fake id). SECURITY DEFINER does NOT change auth.uid(), so real callers are
-- attributed correctly. org_id/entity_id/old_data/new_data come straight from
-- the row — no membership lookups. metadata is intentionally NULL for now.
--
-- No EXCEPTION handling: a failed audit insert propagates and rolls back the
-- business mutation (transactional audit).
-- ============================================================
CREATE OR REPLACE FUNCTION public.audit_log_row_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_entity_type TEXT;
  v_org_id      UUID;
  v_entity_id   UUID;
  v_old         JSONB;
  v_new         JSONB;
BEGIN
  -- Map table name -> singular entity type. Fail safely on an unexpected table
  -- rather than writing an incorrect entity_type.
  v_entity_type := CASE TG_TABLE_NAME
    WHEN 'wine_batches'        THEN 'wine_batch'
    WHEN 'batch_grape_intakes' THEN 'batch_grape_intake'
    WHEN 'wine_lots'           THEN 'wine_lot'
    WHEN 'vessels'             THEN 'vessel'
    WHEN 'vessel_placements'   THEN 'vessel_placement'
    WHEN 'production_events'   THEN 'production_event'
    ELSE NULL
  END;

  IF v_entity_type IS NULL THEN
    RAISE EXCEPTION 'audit_log_row_change: unexpected table % — refusing to write an audit row.', TG_TABLE_NAME
      USING ERRCODE = 'raise_exception';
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_org_id    := NEW.org_id;
    v_entity_id := NEW.id;
    v_old       := NULL;
    v_new       := to_jsonb(NEW);
  ELSIF TG_OP = 'UPDATE' THEN
    v_org_id    := NEW.org_id;
    v_entity_id := NEW.id;
    v_old       := to_jsonb(OLD);
    v_new       := to_jsonb(NEW);
  ELSIF TG_OP = 'DELETE' THEN
    v_org_id    := OLD.org_id;
    v_entity_id := OLD.id;
    v_old       := to_jsonb(OLD);
    v_new       := NULL;
  ELSE
    RAISE EXCEPTION 'audit_log_row_change: unsupported operation %.', TG_OP
      USING ERRCODE = 'raise_exception';
  END IF;

  INSERT INTO public.audit_log
    (org_id, actor_user_id, action, entity_type, entity_id, old_data, new_data, metadata)
  VALUES
    (v_org_id, auth.uid(), TG_OP, v_entity_type, v_entity_id, v_old, v_new, NULL);

  -- AFTER trigger: return value is ignored, but return the appropriate row.
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

-- The function must only ever be reached through the triggers below.
REVOKE ALL ON FUNCTION public.audit_log_row_change() FROM PUBLIC;

-- ============================================================
-- 2. AUDIT TRIGGERS — explicit, per-table, AFTER ROW
-- Full INSERT/UPDATE/DELETE on the five mutable tables; INSERT ONLY on the
-- append-only production_events. NO trigger on audit_log (recursion guard).
-- Existing business/security triggers are untouched.
-- ============================================================

DROP TRIGGER IF EXISTS trg_audit_wine_batches ON public.wine_batches;
CREATE TRIGGER trg_audit_wine_batches
  AFTER INSERT OR UPDATE OR DELETE ON public.wine_batches
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_row_change();

DROP TRIGGER IF EXISTS trg_audit_batch_grape_intakes ON public.batch_grape_intakes;
CREATE TRIGGER trg_audit_batch_grape_intakes
  AFTER INSERT OR UPDATE OR DELETE ON public.batch_grape_intakes
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_row_change();

DROP TRIGGER IF EXISTS trg_audit_wine_lots ON public.wine_lots;
CREATE TRIGGER trg_audit_wine_lots
  AFTER INSERT OR UPDATE OR DELETE ON public.wine_lots
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_row_change();

DROP TRIGGER IF EXISTS trg_audit_vessels ON public.vessels;
CREATE TRIGGER trg_audit_vessels
  AFTER INSERT OR UPDATE OR DELETE ON public.vessels
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_row_change();

DROP TRIGGER IF EXISTS trg_audit_vessel_placements ON public.vessel_placements;
CREATE TRIGGER trg_audit_vessel_placements
  AFTER INSERT OR UPDATE OR DELETE ON public.vessel_placements
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_row_change();

-- production_events is append-only (INSERT only): audit INSERT only.
DROP TRIGGER IF EXISTS trg_audit_production_events ON public.production_events;
CREATE TRIGGER trg_audit_production_events
  AFTER INSERT ON public.production_events
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_row_change();

-- ============================================================
-- 3. POST-VALIDATION (catalog checks). RAISE => rollback.
-- ============================================================
DO $$
DECLARE
  n INTEGER;
  is_secdef BOOLEAN;
  cfg TEXT[];
  has_pinned_path BOOLEAN;
  public_can_execute BOOLEAN;
BEGIN
  -- 1. audit_log exists.
  IF to_regclass('public.audit_log') IS NULL THEN
    RAISE EXCEPTION 'Post-check failed: public.audit_log missing.' USING ERRCODE = 'raise_exception';
  END IF;

  -- 2. writer function exists.
  IF to_regprocedure('public.audit_log_row_change()') IS NULL THEN
    RAISE EXCEPTION 'Post-check failed: audit_log_row_change() missing.' USING ERRCODE = 'raise_exception';
  END IF;

  -- 3. writer is SECURITY DEFINER.
  SELECT prosecdef INTO is_secdef FROM pg_proc
  WHERE oid = 'public.audit_log_row_change()'::regprocedure;
  IF NOT COALESCE(is_secdef, false) THEN
    RAISE EXCEPTION 'Post-check failed: audit_log_row_change() must be SECURITY DEFINER.' USING ERRCODE = 'raise_exception';
  END IF;

  -- 4. writer has a pinned search_path covering public + pg_temp. proconfig
  -- stores entries as 'name=value'; spacing of the value is normalised by PG
  -- and can vary, so match the search_path entry and assert it contains both
  -- schemas rather than an exact string.
  SELECT proconfig INTO cfg FROM pg_proc
  WHERE oid = 'public.audit_log_row_change()'::regprocedure;
  has_pinned_path := EXISTS (
    SELECT 1 FROM unnest(COALESCE(cfg, ARRAY[]::TEXT[])) AS c
    WHERE c LIKE 'search_path=%'
      AND position('public' IN c) > 0
      AND position('pg_temp' IN c) > 0
  );
  IF NOT has_pinned_path THEN
    RAISE EXCEPTION 'Post-check failed: audit_log_row_change() must SET search_path = public, pg_temp (found %).', cfg USING ERRCODE = 'raise_exception';
  END IF;

  -- 5. writer NOT executable by PUBLIC.
  SELECT has_function_privilege('public', 'public.audit_log_row_change()', 'EXECUTE')
    INTO public_can_execute;
  IF public_can_execute THEN
    RAISE EXCEPTION 'Post-check failed: PUBLIC must not have EXECUTE on audit_log_row_change().' USING ERRCODE = 'raise_exception';
  END IF;

  -- 6. audit_log has NO trigger (recursion guard).
  SELECT COUNT(*) INTO n FROM pg_trigger
  WHERE tgrelid = 'public.audit_log'::regclass AND NOT tgisinternal;
  IF n <> 0 THEN
    RAISE EXCEPTION 'Post-check failed: audit_log must have no triggers (found %).', n USING ERRCODE = 'raise_exception';
  END IF;

  -- 7-11. each mutable table has its audit trigger.
  SELECT COUNT(*) INTO n FROM pg_trigger WHERE tgrelid='public.wine_batches'::regclass AND tgname='trg_audit_wine_batches' AND NOT tgisinternal;
  IF n <> 1 THEN RAISE EXCEPTION 'Post-check failed: trg_audit_wine_batches missing.' USING ERRCODE = 'raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_trigger WHERE tgrelid='public.batch_grape_intakes'::regclass AND tgname='trg_audit_batch_grape_intakes' AND NOT tgisinternal;
  IF n <> 1 THEN RAISE EXCEPTION 'Post-check failed: trg_audit_batch_grape_intakes missing.' USING ERRCODE = 'raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_trigger WHERE tgrelid='public.wine_lots'::regclass AND tgname='trg_audit_wine_lots' AND NOT tgisinternal;
  IF n <> 1 THEN RAISE EXCEPTION 'Post-check failed: trg_audit_wine_lots missing.' USING ERRCODE = 'raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_trigger WHERE tgrelid='public.vessels'::regclass AND tgname='trg_audit_vessels' AND NOT tgisinternal;
  IF n <> 1 THEN RAISE EXCEPTION 'Post-check failed: trg_audit_vessels missing.' USING ERRCODE = 'raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_trigger WHERE tgrelid='public.vessel_placements'::regclass AND tgname='trg_audit_vessel_placements' AND NOT tgisinternal;
  IF n <> 1 THEN RAISE EXCEPTION 'Post-check failed: trg_audit_vessel_placements missing.' USING ERRCODE = 'raise_exception'; END IF;

  -- 12. production_events has the INSERT audit trigger.
  SELECT COUNT(*) INTO n FROM pg_trigger WHERE tgrelid='public.production_events'::regclass AND tgname='trg_audit_production_events' AND NOT tgisinternal;
  IF n <> 1 THEN RAISE EXCEPTION 'Post-check failed: trg_audit_production_events missing.' USING ERRCODE = 'raise_exception'; END IF;

  -- 13/14. production_events audit trigger fires on INSERT ONLY (not UPDATE/DELETE).
  -- pg_trigger.tgtype bit 2 (value 4) = INSERT, bit 3 (8) = DELETE, bit 4 (16) = UPDATE.
  SELECT (tgtype & 4) <> 0, (tgtype & 8) <> 0, (tgtype & 16) <> 0
    INTO STRICT public_can_execute, has_pinned_path, is_secdef
  FROM pg_trigger
  WHERE tgrelid='public.production_events'::regclass AND tgname='trg_audit_production_events' AND NOT tgisinternal;
  IF NOT public_can_execute THEN
    RAISE EXCEPTION 'Post-check failed: trg_audit_production_events must fire on INSERT.' USING ERRCODE = 'raise_exception';
  END IF;
  IF has_pinned_path THEN
    RAISE EXCEPTION 'Post-check failed: trg_audit_production_events must NOT fire on DELETE.' USING ERRCODE = 'raise_exception';
  END IF;
  IF is_secdef THEN
    RAISE EXCEPTION 'Post-check failed: trg_audit_production_events must NOT fire on UPDATE.' USING ERRCODE = 'raise_exception';
  END IF;

  -- Exact audit-trigger count across the six target tables = 6.
  SELECT COUNT(*) INTO n FROM pg_trigger
  WHERE NOT tgisinternal
    AND tgname IN (
      'trg_audit_wine_batches','trg_audit_batch_grape_intakes','trg_audit_wine_lots',
      'trg_audit_vessels','trg_audit_vessel_placements','trg_audit_production_events'
    );
  IF n <> 6 THEN RAISE EXCEPTION 'Post-check failed: expected exactly 6 audit triggers (found %).', n USING ERRCODE = 'raise_exception'; END IF;

  -- No audit rows were created by this migration.
  SELECT COUNT(*) INTO n FROM public.audit_log;
  IF n <> 0 THEN RAISE EXCEPTION 'Post-check failed: audit_log must remain empty after wiring (found % rows).', n USING ERRCODE = 'raise_exception'; END IF;
END $$;

COMMIT;
