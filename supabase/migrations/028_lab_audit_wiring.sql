-- ============================================================
-- WINERIX — P2J: Lab Audit Wiring
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- Depends on: 006 (audit_log), 021 (audit_log_row_change writer + pattern),
--             027 (lab_analytes, lab_samples, lab_measurements)
--
-- PURPOSE:
--   Wire the three P2J lab tables into the EXISTING audit log using the SAME
--   generic writer (public.audit_log_row_change) first created in 021 and
--   already extended by 023/P2H. No second audit writer. The writer maps
--   TG_TABLE_NAME -> entity_type via a hardcoded CASE and RAISES on an
--   unexpected table, so this migration must first extend that CASE to
--   recognise the lab tables — PRESERVING every mapping already present (the
--   six from 021 plus lot_lineage / lot_volume_movements from 023) — then
--   attach the triggers. The final CASE therefore holds 11 mappings.
--
-- SCOPE — THIS MIGRATION ONLY:
--   * CREATE OR REPLACE audit_log_row_change() ADDING three entity-type
--     mappings (lab_analyte, lab_sample, lab_measurement) on top of the eight
--     that already exist. Dropping any existing mapping would break inserts
--     into that table (fail-closed). The SECURITY DEFINER / pinned search_path
--     / REVOKE-from-PUBLIC posture and the transactional (no EXCEPTION swallow)
--     behaviour are preserved verbatim.
--   * AFTER-row triggers:
--       lab_analytes, lab_samples  -> INSERT/UPDATE/DELETE
--       lab_measurements           -> INSERT ONLY (append-only table)
--   * Post-validation. Fully additive.
--
-- THIS MIGRATION DOES NOT:
--   * alter audit_log columns / constraints / indexes / RLS / policies / grants
--   * delete, truncate, or modify any existing audit_log row (safe on a DB that
--     already contains thousands of historical audit records)
--   * alter any lab-table column, constraint, RLS, grant, or existing trigger
--   * change the audit triggers already attached in 021 (six cellar tables) or
--     023 (trg_audit_lot_lineage, trg_audit_lot_volume_movements)
--   * remove or replace any existing entity-type mapping in the writer
--   * attach any trigger to audit_log (recursion guard)
--   * write / backfill any audit rows
--   * add UI / services / any src change
--
-- FAILURE SEMANTICS: audit writes are TRANSACTIONAL (same as 021). A failed
--   audit insert rolls back the business mutation.
-- ============================================================

BEGIN;

-- ============================================================
-- 0. PRE-FLIGHT
-- ============================================================
DO $$
DECLARE
  t TEXT;
BEGIN
  IF to_regclass('public.audit_log') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.audit_log is missing (run 006 first).' USING ERRCODE='undefined_table';
  END IF;
  IF to_regprocedure('public.audit_log_row_change()') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: audit_log_row_change() is missing (run 021 first).' USING ERRCODE='undefined_function';
  END IF;
  FOREACH t IN ARRAY ARRAY['lab_analytes','lab_samples','lab_measurements'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE EXCEPTION 'Pre-flight failed: public.% is missing (run 027 first).', t USING ERRCODE='undefined_table';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=t AND column_name='org_id') THEN
      RAISE EXCEPTION 'Pre-flight failed: %.org_id is missing.', t USING ERRCODE='undefined_column';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=t AND column_name='id') THEN
      RAISE EXCEPTION 'Pre-flight failed: %.id is missing.', t USING ERRCODE='undefined_column';
    END IF;
  END LOOP;
END $$;

-- ============================================================
-- 0b. CAPTURE AUDIT BASELINE
-- audit_log already holds legitimate historical records on a live database, so
-- it is NOT required to be empty. Capture the current row count into a
-- transaction-local setting; the post-validation confirms THIS migration did
-- not add, remove, or otherwise change that count. No audit row is read,
-- deleted, truncated, or modified.
-- ============================================================
DO $$
BEGIN
  PERFORM set_config('winerix.audit_baseline_count', (SELECT COUNT(*)::text FROM public.audit_log), true);
END $$;

-- ============================================================
-- 1. EXTEND THE GENERIC AUDIT WRITER (same function from 021, extended by 023)
-- Adds lab_analytes / lab_samples / lab_measurements to the entity-type map
-- while preserving ALL eight existing mappings. All other behaviour is
-- unchanged. Kept as a single writer so there is exactly one audit path for the
-- whole schema.
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
  -- MUST contain every mapping the live writer already has (021 added six,
  -- 023/P2H added lot_lineage + lot_volume_movements) PLUS the three lab tables.
  -- Dropping any existing mapping would make inserts into that table FAIL
  -- (fail-closed ELSE NULL -> RAISE). Final CASE = 11 mappings.
  v_entity_type := CASE TG_TABLE_NAME
    WHEN 'wine_batches'         THEN 'wine_batch'
    WHEN 'batch_grape_intakes'  THEN 'batch_grape_intake'
    WHEN 'wine_lots'            THEN 'wine_lot'
    WHEN 'vessels'              THEN 'vessel'
    WHEN 'vessel_placements'    THEN 'vessel_placement'
    WHEN 'production_events'    THEN 'production_event'
    WHEN 'lot_lineage'          THEN 'lot_lineage'
    WHEN 'lot_volume_movements' THEN 'lot_volume_movement'
    WHEN 'lab_analytes'         THEN 'lab_analyte'
    WHEN 'lab_samples'          THEN 'lab_sample'
    WHEN 'lab_measurements'     THEN 'lab_measurement'
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

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

-- Preserve the 021 posture: not callable by PUBLIC (only via triggers).
REVOKE ALL ON FUNCTION public.audit_log_row_change() FROM PUBLIC;

-- ============================================================
-- 2. AUDIT TRIGGERS — explicit, per-table, AFTER ROW
-- Full INSERT/UPDATE/DELETE on the two mutable lab tables; INSERT ONLY on the
-- append-only lab_measurements. NO trigger on audit_log (recursion guard).
-- ============================================================
DROP TRIGGER IF EXISTS trg_audit_lab_analytes ON public.lab_analytes;
CREATE TRIGGER trg_audit_lab_analytes
  AFTER INSERT OR UPDATE OR DELETE ON public.lab_analytes
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_row_change();

DROP TRIGGER IF EXISTS trg_audit_lab_samples ON public.lab_samples;
CREATE TRIGGER trg_audit_lab_samples
  AFTER INSERT OR UPDATE OR DELETE ON public.lab_samples
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_row_change();

-- lab_measurements is append-only (INSERT only): audit INSERT only.
DROP TRIGGER IF EXISTS trg_audit_lab_measurements ON public.lab_measurements;
CREATE TRIGGER trg_audit_lab_measurements
  AFTER INSERT ON public.lab_measurements
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
  fires_insert BOOLEAN;
  fires_delete BOOLEAN;
  fires_update BOOLEAN;
BEGIN
  -- Writer still exists, SECURITY DEFINER, pinned search_path, not PUBLIC-exec.
  IF to_regprocedure('public.audit_log_row_change()') IS NULL THEN
    RAISE EXCEPTION 'Post-check: audit_log_row_change() missing.' USING ERRCODE='raise_exception';
  END IF;
  SELECT prosecdef INTO is_secdef FROM pg_proc WHERE oid='public.audit_log_row_change()'::regprocedure;
  IF NOT COALESCE(is_secdef,false) THEN
    RAISE EXCEPTION 'Post-check: audit_log_row_change() must remain SECURITY DEFINER.' USING ERRCODE='raise_exception';
  END IF;
  SELECT proconfig INTO cfg FROM pg_proc WHERE oid='public.audit_log_row_change()'::regprocedure;
  has_pinned_path := EXISTS (
    SELECT 1 FROM unnest(COALESCE(cfg, ARRAY[]::TEXT[])) AS c
    WHERE c LIKE 'search_path=%' AND position('public' IN c) > 0 AND position('pg_temp' IN c) > 0
  );
  IF NOT has_pinned_path THEN
    RAISE EXCEPTION 'Post-check: audit_log_row_change() must keep search_path = public, pg_temp (found %).', cfg USING ERRCODE='raise_exception';
  END IF;
  IF has_function_privilege('public','public.audit_log_row_change()','EXECUTE') THEN
    RAISE EXCEPTION 'Post-check: PUBLIC must not have EXECUTE on audit_log_row_change().' USING ERRCODE='raise_exception';
  END IF;

  -- Three new lab audit triggers present.
  SELECT COUNT(*) INTO n FROM pg_trigger
  WHERE NOT tgisinternal AND tgname IN ('trg_audit_lab_analytes','trg_audit_lab_samples','trg_audit_lab_measurements');
  IF n <> 3 THEN RAISE EXCEPTION 'Post-check: expected 3 lab audit triggers (found %).', n USING ERRCODE='raise_exception'; END IF;

  -- measurements trigger fires on INSERT only. tgtype bit 2 (4)=INSERT, 3 (8)=DELETE, 4 (16)=UPDATE.
  SELECT (tgtype & 4) <> 0, (tgtype & 8) <> 0, (tgtype & 16) <> 0
    INTO STRICT fires_insert, fires_delete, fires_update
  FROM pg_trigger
  WHERE tgrelid='public.lab_measurements'::regclass AND tgname='trg_audit_lab_measurements' AND NOT tgisinternal;
  IF NOT fires_insert THEN RAISE EXCEPTION 'Post-check: trg_audit_lab_measurements must fire on INSERT.' USING ERRCODE='raise_exception'; END IF;
  IF fires_delete THEN RAISE EXCEPTION 'Post-check: trg_audit_lab_measurements must NOT fire on DELETE.' USING ERRCODE='raise_exception'; END IF;
  IF fires_update THEN RAISE EXCEPTION 'Post-check: trg_audit_lab_measurements must NOT fire on UPDATE.' USING ERRCODE='raise_exception'; END IF;

  -- The 021 cellar audit triggers are still present (we must not have disturbed them).
  SELECT COUNT(*) INTO n FROM pg_trigger
  WHERE NOT tgisinternal AND tgname IN (
    'trg_audit_wine_batches','trg_audit_batch_grape_intakes','trg_audit_wine_lots',
    'trg_audit_vessels','trg_audit_vessel_placements','trg_audit_production_events'
  );
  IF n <> 6 THEN RAISE EXCEPTION 'Post-check: the 6 cellar audit triggers from 021 must remain (found %).', n USING ERRCODE='raise_exception'; END IF;

  -- The 023/P2H audit triggers are still present (the writer must keep their mappings).
  SELECT COUNT(*) INTO n FROM pg_trigger
  WHERE NOT tgisinternal AND tgname IN ('trg_audit_lot_lineage','trg_audit_lot_volume_movements');
  IF n <> 2 THEN RAISE EXCEPTION 'Post-check: the 2 P2H audit triggers (lot_lineage, lot_volume_movements) must remain (found %).', n USING ERRCODE='raise_exception'; END IF;

  -- audit_log still has NO trigger (recursion guard).
  SELECT COUNT(*) INTO n FROM pg_trigger WHERE tgrelid='public.audit_log'::regclass AND NOT tgisinternal;
  IF n <> 0 THEN RAISE EXCEPTION 'Post-check: audit_log must have no triggers (found %).', n USING ERRCODE='raise_exception'; END IF;

  -- This migration created NO audit rows: the count must EQUAL the baseline
  -- captured in step 0b (NOT zero — a live audit_log legitimately has history).
  SELECT COUNT(*) INTO n FROM public.audit_log;
  IF n <> COALESCE(NULLIF(current_setting('winerix.audit_baseline_count', true), ''), '-1')::integer THEN
    RAISE EXCEPTION 'Post-check: this migration must not change the audit_log row count (baseline %, now %).',
      current_setting('winerix.audit_baseline_count', true), n USING ERRCODE='raise_exception';
  END IF;
END $$;

COMMIT;
