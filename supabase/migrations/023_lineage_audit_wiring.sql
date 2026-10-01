-- ============================================================
-- WINERIX — P2H-2: Audit Wiring for Lot Lineage & Volume Movements
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- Depends on: 021 (audit_log + audit_log_row_change()), 022 (lot_lineage,
--             lot_volume_movements)
--
-- PURPOSE:
--   Wire the two append-only P2H-1 tables into the EXISTING audit system from
--   migration 021, reusing the single generic writer public.audit_log_row_change().
--   No second audit writer is created.
--
--     lot_lineage           -> AFTER INSERT  -> entity_type 'lot_lineage'
--     lot_volume_movements  -> AFTER INSERT  -> entity_type 'lot_volume_movement'
--
--   Both tables are append-only, so ONLY an INSERT audit trigger is attached
--   (no UPDATE, no DELETE).
--
-- REQUIRED CHANGE TO THE EXISTING WRITER (reuse, not replace):
--   The 021 writer maps TG_TABLE_NAME -> entity_type via a CASE and FAIL-CLOSES
--   (RAISE EXCEPTION) on any unmapped table. Attaching the new triggers without
--   teaching the CASE the two new tables would make every insert into
--   lot_lineage / lot_volume_movements FAIL. We therefore CREATE OR REPLACE the
--   SAME function (same name, signature, SECURITY DEFINER, pinned search_path)
--   adding exactly the two new WHEN branches — all existing mappings and
--   behaviour are preserved verbatim. This is reuse of the single writer, not a
--   second writer, and migration 021's file is NOT modified.
--
-- THIS MIGRATION DOES NOT:
--   * create a second audit function
--   * modify audit_log columns / RLS / grants
--   * attach any trigger to audit_log (recursion guard)
--   * add UPDATE or DELETE triggers to the append-only tables
--   * alter migrations 021 / 022, or any existing table / column / RLS
--   * change the six existing P2G audit triggers
-- ============================================================

BEGIN;

-- ============================================================
-- 0. PRE-FLIGHT
-- ============================================================
DO $$
BEGIN
  IF to_regclass('public.audit_log') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.audit_log is missing (run 021 first).' USING ERRCODE = 'undefined_table';
  END IF;
  IF to_regprocedure('public.audit_log_row_change()') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.audit_log_row_change() is missing (run 021 first).' USING ERRCODE = 'undefined_function';
  END IF;
  IF to_regclass('public.lot_lineage') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.lot_lineage is missing (run 022 first).' USING ERRCODE = 'undefined_table';
  END IF;
  IF to_regclass('public.lot_volume_movements') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.lot_volume_movements is missing (run 022 first).' USING ERRCODE = 'undefined_table';
  END IF;
  -- The writer reads NEW.org_id and NEW.id; both new tables must carry them.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='lot_lineage' AND column_name='org_id')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='lot_lineage' AND column_name='id') THEN
    RAISE EXCEPTION 'Pre-flight failed: lot_lineage must have id and org_id.' USING ERRCODE = 'undefined_column';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='lot_volume_movements' AND column_name='org_id')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='lot_volume_movements' AND column_name='id') THEN
    RAISE EXCEPTION 'Pre-flight failed: lot_volume_movements must have id and org_id.' USING ERRCODE = 'undefined_column';
  END IF;
END $$;

-- ============================================================
-- 1. EXTEND THE EXISTING WRITER'S ENTITY MAP (reuse the SAME function)
-- Identical to the 021 definition except the CASE gains the two new tables.
-- SECURITY DEFINER, pinned search_path, fail-closed behaviour, and all existing
-- mappings are preserved exactly. No second writer is introduced.
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
    WHEN 'wine_batches'         THEN 'wine_batch'
    WHEN 'batch_grape_intakes'  THEN 'batch_grape_intake'
    WHEN 'wine_lots'            THEN 'wine_lot'
    WHEN 'vessels'              THEN 'vessel'
    WHEN 'vessel_placements'    THEN 'vessel_placement'
    WHEN 'production_events'    THEN 'production_event'
    WHEN 'lot_lineage'          THEN 'lot_lineage'
    WHEN 'lot_volume_movements' THEN 'lot_volume_movement'
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

-- Preserve the 021 security posture (idempotent re-assertion; not a weakening).
REVOKE ALL ON FUNCTION public.audit_log_row_change() FROM PUBLIC;

-- ============================================================
-- 2. NEW AUDIT TRIGGERS — INSERT ONLY (append-only tables)
-- No trigger on audit_log (recursion guard). Existing business/security and the
-- six P2G audit triggers are untouched.
-- ============================================================
DROP TRIGGER IF EXISTS trg_audit_lot_lineage ON public.lot_lineage;
CREATE TRIGGER trg_audit_lot_lineage
  AFTER INSERT ON public.lot_lineage
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_row_change();

DROP TRIGGER IF EXISTS trg_audit_lot_volume_movements ON public.lot_volume_movements;
CREATE TRIGGER trg_audit_lot_volume_movements
  AFTER INSERT ON public.lot_volume_movements
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_row_change();

-- ============================================================
-- 3. POST-VALIDATION (catalog checks). RAISE => rollback.
-- pg_trigger.tgtype bit 2 (value 4) = INSERT, bit 3 (8) = DELETE, bit 4 (16) = UPDATE.
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
  -- 1. audit_log exists.
  IF to_regclass('public.audit_log') IS NULL THEN
    RAISE EXCEPTION 'Post-check 1 failed: audit_log missing.' USING ERRCODE='raise_exception';
  END IF;

  -- 2. writer exists.
  IF to_regprocedure('public.audit_log_row_change()') IS NULL THEN
    RAISE EXCEPTION 'Post-check 2 failed: audit_log_row_change() missing.' USING ERRCODE='raise_exception';
  END IF;

  -- 3. writer is SECURITY DEFINER.
  SELECT prosecdef INTO is_secdef FROM pg_proc WHERE oid='public.audit_log_row_change()'::regprocedure;
  IF NOT COALESCE(is_secdef,false) THEN
    RAISE EXCEPTION 'Post-check 3 failed: writer must be SECURITY DEFINER.' USING ERRCODE='raise_exception';
  END IF;

  -- 4. writer has pinned search_path covering public + pg_temp.
  SELECT proconfig INTO cfg FROM pg_proc WHERE oid='public.audit_log_row_change()'::regprocedure;
  has_pinned_path := EXISTS (
    SELECT 1 FROM unnest(COALESCE(cfg, ARRAY[]::TEXT[])) AS c
    WHERE c LIKE 'search_path=%' AND position('public' IN c) > 0 AND position('pg_temp' IN c) > 0
  );
  IF NOT has_pinned_path THEN
    RAISE EXCEPTION 'Post-check 4 failed: writer must SET search_path = public, pg_temp (found %).', cfg USING ERRCODE='raise_exception';
  END IF;

  -- 5. PUBLIC EXECUTE revoked.
  IF has_function_privilege('public','public.audit_log_row_change()','EXECUTE') THEN
    RAISE EXCEPTION 'Post-check 5 failed: PUBLIC must not have EXECUTE on the writer.' USING ERRCODE='raise_exception';
  END IF;

  -- 6. audit_log has NO triggers.
  SELECT COUNT(*) INTO n FROM pg_trigger WHERE tgrelid='public.audit_log'::regclass AND NOT tgisinternal;
  IF n <> 0 THEN RAISE EXCEPTION 'Post-check 6 failed: audit_log must have no triggers (found %).', n USING ERRCODE='raise_exception'; END IF;

  -- 7/8/9. lot_lineage: exactly one audit trigger, INSERT only.
  SELECT COUNT(*) INTO n FROM pg_trigger WHERE tgrelid='public.lot_lineage'::regclass AND tgname='trg_audit_lot_lineage' AND NOT tgisinternal;
  IF n <> 1 THEN RAISE EXCEPTION 'Post-check 7 failed: trg_audit_lot_lineage missing or duplicated (found %).', n USING ERRCODE='raise_exception'; END IF;
  SELECT (tgtype & 4) <> 0, (tgtype & 8) <> 0, (tgtype & 16) <> 0
    INTO STRICT fires_insert, fires_delete, fires_update
  FROM pg_trigger WHERE tgrelid='public.lot_lineage'::regclass AND tgname='trg_audit_lot_lineage' AND NOT tgisinternal;
  IF NOT fires_insert THEN RAISE EXCEPTION 'Post-check 7 failed: trg_audit_lot_lineage must fire on INSERT.' USING ERRCODE='raise_exception'; END IF;
  IF fires_update THEN RAISE EXCEPTION 'Post-check 8 failed: trg_audit_lot_lineage must NOT fire on UPDATE.' USING ERRCODE='raise_exception'; END IF;
  IF fires_delete THEN RAISE EXCEPTION 'Post-check 9 failed: trg_audit_lot_lineage must NOT fire on DELETE.' USING ERRCODE='raise_exception'; END IF;

  -- 10/11/12. lot_volume_movements: exactly one audit trigger, INSERT only.
  SELECT COUNT(*) INTO n FROM pg_trigger WHERE tgrelid='public.lot_volume_movements'::regclass AND tgname='trg_audit_lot_volume_movements' AND NOT tgisinternal;
  IF n <> 1 THEN RAISE EXCEPTION 'Post-check 10 failed: trg_audit_lot_volume_movements missing or duplicated (found %).', n USING ERRCODE='raise_exception'; END IF;
  SELECT (tgtype & 4) <> 0, (tgtype & 8) <> 0, (tgtype & 16) <> 0
    INTO STRICT fires_insert, fires_delete, fires_update
  FROM pg_trigger WHERE tgrelid='public.lot_volume_movements'::regclass AND tgname='trg_audit_lot_volume_movements' AND NOT tgisinternal;
  IF NOT fires_insert THEN RAISE EXCEPTION 'Post-check 10 failed: trg_audit_lot_volume_movements must fire on INSERT.' USING ERRCODE='raise_exception'; END IF;
  IF fires_update THEN RAISE EXCEPTION 'Post-check 11 failed: trg_audit_lot_volume_movements must NOT fire on UPDATE.' USING ERRCODE='raise_exception'; END IF;
  IF fires_delete THEN RAISE EXCEPTION 'Post-check 12 failed: trg_audit_lot_volume_movements must NOT fire on DELETE.' USING ERRCODE='raise_exception'; END IF;

  -- 13. The six existing P2G audit triggers remain present.
  SELECT COUNT(*) INTO n FROM pg_trigger
  WHERE NOT tgisinternal AND tgname IN (
    'trg_audit_wine_batches','trg_audit_batch_grape_intakes','trg_audit_wine_lots',
    'trg_audit_vessels','trg_audit_vessel_placements','trg_audit_production_events'
  );
  IF n <> 6 THEN RAISE EXCEPTION 'Post-check 13 failed: expected the 6 existing P2G audit triggers (found %).', n USING ERRCODE='raise_exception'; END IF;

  -- 14. Total audit triggers across the eight audited business tables = 8.
  SELECT COUNT(*) INTO n FROM pg_trigger
  WHERE NOT tgisinternal AND tgname IN (
    'trg_audit_wine_batches','trg_audit_batch_grape_intakes','trg_audit_wine_lots',
    'trg_audit_vessels','trg_audit_vessel_placements','trg_audit_production_events',
    'trg_audit_lot_lineage','trg_audit_lot_volume_movements'
  );
  IF n <> 8 THEN RAISE EXCEPTION 'Post-check 14 failed: expected exactly 8 audit triggers total (found %).', n USING ERRCODE='raise_exception'; END IF;
END $$;

COMMIT;
