-- ============================================================
-- WINERIX — P2J-9: Lab Specification Audit Wiring
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- Depends on: 006 (audit_log), 021 (audit_log_row_change writer + pattern),
--             023 (lot_lineage / lot_volume_movements mappings), 028 (lab
--             analyte/sample/measurement mappings), 029 (lab_specifications)
--
-- PURPOSE:
--   Wire public.lab_specifications into the EXISTING audit log using the SAME
--   generic writer (public.audit_log_row_change) first created in 021 and
--   extended by 023 (P2H) and 028 (P2J lab tables). No second audit writer,
--   no second audit table. The writer maps TG_TABLE_NAME -> entity_type via a
--   hardcoded CASE and RAISES on an unexpected table, so this migration must
--   first extend that CASE to recognise lab_specifications — PRESERVING every
--   mapping already present (the eleven listed below) — then attach the
--   trigger. The final CASE therefore holds 12 mappings.
--
--   Preserved mappings (MUST remain, verbatim):
--     wine_batches         -> wine_batch
--     batch_grape_intakes  -> batch_grape_intake
--     wine_lots            -> wine_lot
--     vessels              -> vessel
--     vessel_placements    -> vessel_placement
--     production_events    -> production_event
--     lot_lineage          -> lot_lineage
--     lot_volume_movements -> lot_volume_movement
--     lab_analytes         -> lab_analyte
--     lab_samples          -> lab_sample
--     lab_measurements     -> lab_measurement
--   Added:
--     lab_specifications   -> lab_specification
--
-- SCOPE — THIS MIGRATION ONLY:
--   * CREATE OR REPLACE audit_log_row_change() ADDING exactly one mapping
--     (lab_specification) on top of the eleven that already exist. Dropping any
--     existing mapping would break inserts into that table (fail-closed ELSE
--     NULL -> RAISE). The SECURITY DEFINER / pinned search_path /
--     REVOKE-from-PUBLIC posture and the transactional (no EXCEPTION swallow)
--     behaviour are preserved verbatim.
--   * AFTER-row trigger on lab_specifications -> INSERT/UPDATE/DELETE.
--     INSERT + UPDATE are the real paths (029 grants only SELECT/INSERT/UPDATE
--     and has no DELETE policy). DELETE coverage is included as defence-in-depth
--     so that a privileged / migration-context delete is still captured — this
--     does NOT grant the application any ability to delete (no DELETE policy and
--     no DELETE grant are added here).
--   * Post-validation. Fully additive.
--
-- THIS MIGRATION DOES NOT:
--   * recreate / truncate audit_log, delete any audit record, or alter
--     audit_log columns / constraints / indexes / RLS / policies / grants
--   * replace the writer with another function or create a second audit table
--   * remove or rename any existing entity-type mapping
--   * change any existing cellar / P2H / lab audit trigger
--   * alter lab_specifications columns / constraints / RLS / grants / triggers
--   * add a DELETE policy or DELETE grant on lab_specifications
--   * attach any trigger to audit_log (recursion guard)
--   * write / backfill / seed any row (audit_log and lab_specifications unchanged)
--   * add UI / services / any src change
--
-- FAILURE SEMANTICS: audit writes are TRANSACTIONAL (same as 021/028). A failed
--   audit insert rolls back the business mutation.
-- ============================================================

BEGIN;

-- ============================================================
-- 0. PRE-FLIGHT
-- ============================================================
DO $$
BEGIN
  IF to_regclass('public.audit_log') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.audit_log is missing (run 006 first).' USING ERRCODE='undefined_table';
  END IF;
  IF to_regprocedure('public.audit_log_row_change()') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: audit_log_row_change() is missing (run 021 first).' USING ERRCODE='undefined_function';
  END IF;
  IF to_regclass('public.lab_specifications') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.lab_specifications is missing (run 029 first).' USING ERRCODE='undefined_table';
  END IF;
  -- The writer reads NEW.org_id and NEW.id; lab_specifications must carry both.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='lab_specifications' AND column_name='org_id') THEN
    RAISE EXCEPTION 'Pre-flight failed: lab_specifications.org_id is missing.' USING ERRCODE='undefined_column';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='lab_specifications' AND column_name='id') THEN
    RAISE EXCEPTION 'Pre-flight failed: lab_specifications.id is missing.' USING ERRCODE='undefined_column';
  END IF;
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
-- 1. EXTEND THE GENERIC AUDIT WRITER (same function from 021/023/028)
-- Adds lab_specifications -> lab_specification to the entity-type map while
-- preserving ALL eleven existing mappings. All other behaviour (SECURITY
-- DEFINER, pinned search_path, fail-closed ELSE, transactional insert, DELETE
-- returns OLD) is unchanged. Kept as a single writer so there is exactly one
-- audit path for the whole schema.
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
  -- 023/P2H added lot_lineage + lot_volume_movements, 028 added the three lab
  -- tables) PLUS lab_specifications. Dropping any existing mapping would make
  -- inserts into that table FAIL (fail-closed ELSE NULL -> RAISE).
  -- Final CASE = 12 mappings.
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
    WHEN 'lab_specifications'   THEN 'lab_specification'
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
-- 2. AUDIT TRIGGER — lab_specifications, AFTER ROW, INSERT/UPDATE/DELETE
-- INSERT + UPDATE are the real application paths (029: SELECT/INSERT/UPDATE
-- grant, no DELETE policy, no DELETE grant). DELETE coverage is defence-in-depth
-- only — it audits a hypothetical privileged/migration delete and does NOT give
-- the application any delete capability. NO trigger on audit_log (recursion guard).
-- ============================================================
DROP TRIGGER IF EXISTS trg_audit_lab_specifications ON public.lab_specifications;
CREATE TRIGGER trg_audit_lab_specifications
  AFTER INSERT OR UPDATE OR DELETE ON public.lab_specifications
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
  fires_update BOOLEAN;
  fires_delete BOOLEAN;
BEGIN
  -- 1. lab_specifications has exactly one audit trigger, firing INSERT+UPDATE+DELETE.
  SELECT COUNT(*) INTO n FROM pg_trigger
  WHERE tgrelid='public.lab_specifications'::regclass AND tgname='trg_audit_lab_specifications' AND NOT tgisinternal;
  IF n <> 1 THEN RAISE EXCEPTION 'Post-check: trg_audit_lab_specifications missing or duplicated (found %).', n USING ERRCODE='raise_exception'; END IF;
  -- tgtype bit 2 (4)=INSERT, bit 3 (8)=DELETE, bit 4 (16)=UPDATE.
  SELECT (tgtype & 4) <> 0, (tgtype & 16) <> 0, (tgtype & 8) <> 0
    INTO STRICT fires_insert, fires_update, fires_delete
  FROM pg_trigger
  WHERE tgrelid='public.lab_specifications'::regclass AND tgname='trg_audit_lab_specifications' AND NOT tgisinternal;
  IF NOT fires_insert THEN RAISE EXCEPTION 'Post-check: trg_audit_lab_specifications must fire on INSERT.' USING ERRCODE='raise_exception'; END IF;
  IF NOT fires_update THEN RAISE EXCEPTION 'Post-check: trg_audit_lab_specifications must fire on UPDATE.' USING ERRCODE='raise_exception'; END IF;
  IF NOT fires_delete THEN RAISE EXCEPTION 'Post-check: trg_audit_lab_specifications must fire on DELETE.' USING ERRCODE='raise_exception'; END IF;

  -- 2. Every existing audit trigger is still present (6 cellar from 021,
  -- 2 from 023/P2H, 3 from 028/lab) = 11 pre-existing triggers.
  SELECT COUNT(*) INTO n FROM pg_trigger
  WHERE NOT tgisinternal AND tgname IN (
    'trg_audit_wine_batches','trg_audit_batch_grape_intakes','trg_audit_wine_lots',
    'trg_audit_vessels','trg_audit_vessel_placements','trg_audit_production_events',
    'trg_audit_lot_lineage','trg_audit_lot_volume_movements',
    'trg_audit_lab_analytes','trg_audit_lab_samples','trg_audit_lab_measurements'
  );
  IF n <> 11 THEN RAISE EXCEPTION 'Post-check: expected the 11 pre-existing audit triggers to remain (found %).', n USING ERRCODE='raise_exception'; END IF;

  -- 3. Writer remains SECURITY DEFINER with pinned search_path = public, pg_temp.
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

  -- 4. PUBLIC must not have EXECUTE on the writer.
  IF has_function_privilege('public','public.audit_log_row_change()','EXECUTE') THEN
    RAISE EXCEPTION 'Post-check: PUBLIC must not have EXECUTE on audit_log_row_change().' USING ERRCODE='raise_exception';
  END IF;

  -- 5. The lab_specification mapping exists in the writer source. (The CASE is
  -- internal to the function body; verify via its source text.)
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid='public.audit_log_row_change()'::regprocedure
      AND pg_get_functiondef(oid) ILIKE '%''lab_specifications''%'
      AND pg_get_functiondef(oid) ILIKE '%''lab_specification''%'
  ) THEN
    RAISE EXCEPTION 'Post-check: audit writer must map lab_specifications -> lab_specification.' USING ERRCODE='raise_exception';
  END IF;
  -- Defensive: the eleven existing entity_type strings must still be in the writer.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid='public.audit_log_row_change()'::regprocedure
      AND pg_get_functiondef(oid) ILIKE '%''wine_batch''%'
      AND pg_get_functiondef(oid) ILIKE '%''batch_grape_intake''%'
      AND pg_get_functiondef(oid) ILIKE '%''wine_lot''%'
      AND pg_get_functiondef(oid) ILIKE '%''vessel''%'
      AND pg_get_functiondef(oid) ILIKE '%''vessel_placement''%'
      AND pg_get_functiondef(oid) ILIKE '%''production_event''%'
      AND pg_get_functiondef(oid) ILIKE '%''lot_lineage''%'
      AND pg_get_functiondef(oid) ILIKE '%''lot_volume_movement''%'
      AND pg_get_functiondef(oid) ILIKE '%''lab_analyte''%'
      AND pg_get_functiondef(oid) ILIKE '%''lab_sample''%'
      AND pg_get_functiondef(oid) ILIKE '%''lab_measurement''%'
  ) THEN
    RAISE EXCEPTION 'Post-check: audit writer must preserve all eleven existing entity-type mappings.' USING ERRCODE='raise_exception';
  END IF;

  -- 6. audit_log row count preserved (this migration added no audit rows).
  SELECT COUNT(*) INTO n FROM public.audit_log;
  IF n <> COALESCE(NULLIF(current_setting('winerix.audit_baseline_count', true), ''), '-1')::integer THEN
    RAISE EXCEPTION 'Post-check: this migration must not change the audit_log row count (baseline %, now %).',
      current_setting('winerix.audit_baseline_count', true), n USING ERRCODE='raise_exception';
  END IF;

  -- 6b. audit_log still has NO trigger (recursion guard).
  SELECT COUNT(*) INTO n FROM pg_trigger WHERE tgrelid='public.audit_log'::regclass AND NOT tgisinternal;
  IF n <> 0 THEN RAISE EXCEPTION 'Post-check: audit_log must have no triggers (found %).', n USING ERRCODE='raise_exception'; END IF;

  -- 7. lab_specifications remains empty after the migration (no seed/backfill).
  SELECT COUNT(*) INTO n FROM public.lab_specifications;
  IF n <> 0 THEN RAISE EXCEPTION 'Post-check: lab_specifications must remain empty (found % rows).', n USING ERRCODE='raise_exception'; END IF;

  -- 8. 029 security posture untouched: still no DELETE policy, authenticated has
  -- no DELETE grant (this audit migration must not have loosened it).
  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='lab_specifications' AND cmd='DELETE';
  IF n <> 0 THEN RAISE EXCEPTION 'Post-check: lab_specifications must still have no DELETE policy (found %).', n USING ERRCODE='raise_exception'; END IF;
  IF has_table_privilege('authenticated','public.lab_specifications','DELETE') THEN
    RAISE EXCEPTION 'Post-check: authenticated must still NOT have DELETE on lab_specifications.' USING ERRCODE='raise_exception';
  END IF;
END $$;

COMMIT;
