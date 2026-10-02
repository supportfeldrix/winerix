-- ============================================================
-- WINERIX — P2J-13a: Laboratory Alerts & Exceptions (database foundation)
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- Depends on: 001 (update_updated_at), 006 (organisations, is_org_member,
--             has_org_role), 010 (prevent_owner_id_change), 021
--             (audit_log + audit_log_row_change), 027 (lab_measurements),
--             029 (lab_specifications), 030 (lab_specification audit mapping)
--
-- PURPOSE:
--   Create public.lab_alerts — a PERSISTED, per-measurement record of a FACTUAL
--   laboratory exception (an out-of-range reading, or a data-quality problem
--   such as a unit mismatch) that may warrant human attention. An alert is NOT
--   a quality / regulatory / release / SAWIS / SARS / export claim, and it NEVER
--   changes lab_samples.status.
--
--   Alerts are generated (in a later task) by the service computing the existing
--   evaluation and calling a small idempotent RPC to persist the snapshot — so
--   this migration deliberately creates NO generation RPC and duplicates NO
--   evaluation comparison logic in SQL. It only lays down the table, its
--   security, lifecycle structure, and audit wiring.
--
--   An alert SNAPSHOTS the specification/evaluation basis (min/max/target/unit +
--   the measured value/unit + evaluation_status/range_result) so a later
--   specification version can never alter the historical meaning of an existing
--   alert. specification_id is retained for reference but is NOT the source of
--   truth for the frozen basis.
--
-- SCOPE — THIS MIGRATION ONLY:
--   Creates lab_alerts + FKs + CHECKs + the (org,measurement,alert_type) dedup
--   unique index + indexes + org-based RLS (SELECT member; INSERT/UPDATE
--   OWNER/ADMIN/CELLAR; NO DELETE) + owner_id immutability + updated_at + a
--   SECURITY DEFINER cross-org integrity trigger + grants (SELECT/INSERT/UPDATE)
--   + extends the EXISTING audit writer with one mapping (lab_alert) and attaches
--   an AFTER INSERT OR UPDATE audit trigger. No backfill; starts empty.
--
-- THIS MIGRATION DOES NOT:
--   * create a generation RPC or any evaluation logic in SQL
--   * create lab_evaluations
--   * alter lab_measurements / lab_samples / lab_specifications / lab_analytes
--     (or any existing table, policy, grant, trigger, or function) except the
--     single additive CREATE OR REPLACE of the shared audit writer
--   * remove/replace any existing audit entity-type mapping or trigger
--   * add a DELETE policy or DELETE grant (alerts are resolved/dismissed, never
--     hard-deleted)
--   * attach any trigger to audit_log (recursion guard)
--   * write/backfill/seed any row; require audit_log to be empty
--   * add UI / services / notifications
-- ============================================================

BEGIN;

-- ============================================================
-- 0. PRE-FLIGHT (fail-fast; never silently create dependencies)
-- ============================================================
DO $$
BEGIN
  IF to_regclass('public.organisations') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.organisations is missing (run 006 first).' USING ERRCODE='undefined_table';
  END IF;
  IF to_regclass('public.audit_log') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.audit_log is missing (run 006 first).' USING ERRCODE='undefined_table';
  END IF;
  IF to_regprocedure('public.audit_log_row_change()') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.audit_log_row_change() is missing (run 021 first).' USING ERRCODE='undefined_function';
  END IF;
  IF to_regclass('public.lab_measurements') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.lab_measurements is missing (run 027 first).' USING ERRCODE='undefined_table';
  END IF;
  IF to_regclass('public.lab_specifications') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.lab_specifications is missing (run 029 first).' USING ERRCODE='undefined_table';
  END IF;
  IF to_regclass('public.lab_alerts') IS NOT NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.lab_alerts already exists.' USING ERRCODE='duplicate_table';
  END IF;
  IF to_regprocedure('public.is_org_member(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.is_org_member(uuid) is missing (run 006 first).' USING ERRCODE='undefined_function';
  END IF;
  IF to_regprocedure('public.has_org_role(uuid, text[])') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.has_org_role(uuid, text[]) is missing (run 006 first).' USING ERRCODE='undefined_function';
  END IF;
  IF to_regprocedure('public.prevent_owner_id_change()') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.prevent_owner_id_change() is missing (run 010 first).' USING ERRCODE='undefined_function';
  END IF;
  IF to_regprocedure('public.update_updated_at()') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.update_updated_at() is missing (run 001 first).' USING ERRCODE='undefined_function';
  END IF;
  -- lab_measurements must carry org_id for the integrity check.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='lab_measurements' AND column_name='org_id') THEN
    RAISE EXCEPTION 'Pre-flight failed: lab_measurements.org_id is missing (run 027 first).' USING ERRCODE='undefined_column';
  END IF;
END $$;

-- ============================================================
-- 0b. CAPTURE AUDIT BASELINE (audit_log is NOT required to be empty)
-- ============================================================
DO $$
BEGIN
  PERFORM set_config('winerix.audit_baseline_count', (SELECT COUNT(*)::text FROM public.audit_log), true);
END $$;

-- ============================================================
-- 1. LAB_ALERTS TABLE
-- Per-measurement factual exception with a FROZEN specification/evaluation
-- snapshot and its own lifecycle (open -> acknowledged -> resolved | dismissed).
-- Only out-of-range (range_exception) and unit-mismatch (data_quality) alert
-- types exist in this phase; no_specification / not_numeric / not_evaluable /
-- within_spec / target_match deliberately do NOT create alerts.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.lab_alerts (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                    UUID NOT NULL,
  owner_id                  UUID NOT NULL,
  lab_measurement_id        UUID NOT NULL,
  alert_type                TEXT NOT NULL,
  alert_class               TEXT NOT NULL,
  status                    TEXT NOT NULL DEFAULT 'open',

  -- Lifecycle timestamps + actors.
  triggered_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_at           TIMESTAMPTZ,
  acknowledged_by           UUID,
  resolved_at               TIMESTAMPTZ,
  resolved_by               UUID,
  dismissed_at              TIMESTAMPTZ,
  dismissed_by              UUID,
  resolution_notes          TEXT,

  -- FROZEN evaluation basis (the alert must not re-read live spec values).
  measurement_value         NUMERIC,
  measurement_unit          TEXT,
  specification_id          UUID,
  specification_name        TEXT,
  specification_min_value   NUMERIC,
  specification_max_value   NUMERIC,
  specification_target_value NUMERIC,
  specification_unit        TEXT,
  evaluation_status         TEXT,
  range_result              TEXT,

  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Relationships — all preserve historical alert records (RESTRICT, never cascade).
  CONSTRAINT fk_lab_alerts_org
    FOREIGN KEY (org_id) REFERENCES public.organisations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_lab_alerts_owner
    FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_lab_alerts_measurement
    FOREIGN KEY (lab_measurement_id) REFERENCES public.lab_measurements(id) ON DELETE RESTRICT,
  CONSTRAINT fk_lab_alerts_specification
    FOREIGN KEY (specification_id) REFERENCES public.lab_specifications(id) ON DELETE RESTRICT,
  CONSTRAINT fk_lab_alerts_acknowledged_by
    FOREIGN KEY (acknowledged_by) REFERENCES auth.users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_lab_alerts_resolved_by
    FOREIGN KEY (resolved_by) REFERENCES auth.users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_lab_alerts_dismissed_by
    FOREIGN KEY (dismissed_by) REFERENCES auth.users(id) ON DELETE RESTRICT,

  -- Controlled vocabularies.
  CONSTRAINT lab_alerts_alert_type_check
    CHECK (alert_type IN ('below_minimum','above_maximum','incompatible_unit')),
  CONSTRAINT lab_alerts_alert_class_check
    CHECK (alert_class IN ('range_exception','data_quality')),
  CONSTRAINT lab_alerts_status_check
    CHECK (status IN ('open','acknowledged','resolved','dismissed')),

  -- Valid type/class pairing only (no arbitrary combinations).
  CONSTRAINT lab_alerts_type_class_check
    CHECK (
      (alert_type IN ('below_minimum','above_maximum') AND alert_class = 'range_exception')
      OR (alert_type = 'incompatible_unit' AND alert_class = 'data_quality')
    ),

  -- Lifecycle consistency: a timestamp/actor may only exist in the matching
  -- terminal/transition state, and open carries none of them.
  CONSTRAINT lab_alerts_open_has_no_lifecycle
    CHECK (
      status <> 'open'
      OR (acknowledged_at IS NULL AND acknowledged_by IS NULL
          AND resolved_at IS NULL AND resolved_by IS NULL
          AND dismissed_at IS NULL AND dismissed_by IS NULL)
    ),
  CONSTRAINT lab_alerts_acknowledged_requires_stamp
    CHECK (status <> 'acknowledged' OR acknowledged_at IS NOT NULL),
  CONSTRAINT lab_alerts_resolved_requires_stamp
    CHECK (status <> 'resolved' OR resolved_at IS NOT NULL),
  CONSTRAINT lab_alerts_dismissed_requires_stamp
    CHECK (status <> 'dismissed' OR dismissed_at IS NOT NULL),
  -- resolved_at / dismissed_at only make sense in their own terminal state.
  CONSTRAINT lab_alerts_resolved_only_when_resolved
    CHECK (resolved_at IS NULL OR status = 'resolved'),
  CONSTRAINT lab_alerts_dismissed_only_when_dismissed
    CHECK (dismissed_at IS NULL OR status = 'dismissed'),
  -- paired actor/timestamp (both or neither) for each lifecycle event.
  CONSTRAINT lab_alerts_ack_pair
    CHECK ((acknowledged_at IS NULL) = (acknowledged_by IS NULL)),
  CONSTRAINT lab_alerts_resolved_pair
    CHECK ((resolved_at IS NULL) = (resolved_by IS NULL)),
  CONSTRAINT lab_alerts_dismissed_pair
    CHECK ((dismissed_at IS NULL) = (dismissed_by IS NULL))
);

-- Deduplication: at most ONE alert per (org, measurement, alert_type). Lets the
-- future generation RPC use ON CONFLICT DO NOTHING for idempotent persistence,
-- so re-opening a sample page never creates duplicate alerts.
CREATE UNIQUE INDEX IF NOT EXISTS uq_lab_alerts_org_measurement_type
  ON public.lab_alerts(org_id, lab_measurement_id, alert_type);

CREATE INDEX IF NOT EXISTS idx_lab_alerts_org_id          ON public.lab_alerts(org_id);
CREATE INDEX IF NOT EXISTS idx_lab_alerts_owner_id        ON public.lab_alerts(owner_id);
CREATE INDEX IF NOT EXISTS idx_lab_alerts_measurement_id  ON public.lab_alerts(lab_measurement_id);
CREATE INDEX IF NOT EXISTS idx_lab_alerts_specification_id ON public.lab_alerts(specification_id);
CREATE INDEX IF NOT EXISTS idx_lab_alerts_status          ON public.lab_alerts(status);
CREATE INDEX IF NOT EXISTS idx_lab_alerts_org_status      ON public.lab_alerts(org_id, status);

-- ============================================================
-- 2. OWNER_ID IMMUTABILITY (reuse 010)
-- ============================================================
DROP TRIGGER IF EXISTS lab_alerts_owner_id_immutable ON public.lab_alerts;
CREATE TRIGGER lab_alerts_owner_id_immutable
  BEFORE UPDATE ON public.lab_alerts
  FOR EACH ROW EXECUTE FUNCTION public.prevent_owner_id_change();

-- ============================================================
-- 3. UPDATED_AT (reuse 001)
-- ============================================================
DROP TRIGGER IF EXISTS lab_alerts_updated_at ON public.lab_alerts;
CREATE TRIGGER lab_alerts_updated_at
  BEFORE UPDATE ON public.lab_alerts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ============================================================
-- 4. CROSS-ORGANISATION INTEGRITY (DB-enforced, fail-closed)
-- Guarantees the referenced measurement — and, when set, the referenced
-- specification — belong to the SAME organisation as the alert. SECURITY
-- DEFINER so it reads the referenced rows regardless of RLS; pinned search_path;
-- static SQL. Mirrors validate_lab_specification_org_integrity (029).
-- ============================================================
CREATE OR REPLACE FUNCTION public.validate_lab_alert_org_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  meas_org UUID;
  spec_org UUID;
BEGIN
  SELECT m.org_id INTO meas_org FROM public.lab_measurements m WHERE m.id = NEW.lab_measurement_id;
  IF meas_org IS NULL THEN
    RAISE EXCEPTION 'Invalid lab measurement: measurement % does not exist.', NEW.lab_measurement_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF meas_org <> NEW.org_id THEN
    RAISE EXCEPTION 'Cross-organisation reference: lab measurement % belongs to a different organisation.', NEW.lab_measurement_id
      USING ERRCODE = 'raise_exception';
  END IF;

  IF NEW.specification_id IS NOT NULL THEN
    SELECT s.org_id INTO spec_org FROM public.lab_specifications s WHERE s.id = NEW.specification_id;
    IF spec_org IS NULL THEN
      RAISE EXCEPTION 'Invalid specification: % does not exist.', NEW.specification_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF spec_org <> NEW.org_id THEN
      RAISE EXCEPTION 'Cross-organisation reference: specification % belongs to a different organisation.', NEW.specification_id
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS lab_alerts_org_integrity ON public.lab_alerts;
CREATE TRIGGER lab_alerts_org_integrity
  BEFORE INSERT OR UPDATE ON public.lab_alerts
  FOR EACH ROW EXECUTE FUNCTION public.validate_lab_alert_org_integrity();

-- ============================================================
-- 5. ROW LEVEL SECURITY
-- SELECT: any org member. INSERT/UPDATE: OWNER/ADMIN/CELLAR (via the future
-- controlled RPCs; the policies describe the intended client capability).
-- NO DELETE policy — alerts are resolved/dismissed, never hard-deleted.
-- ============================================================
ALTER TABLE public.lab_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view organisation lab alerts"
  ON public.lab_alerts FOR SELECT
  USING (public.is_org_member(org_id));

CREATE POLICY "Cellar roles can insert organisation lab alerts"
  ON public.lab_alerts FOR INSERT
  WITH CHECK (
    public.is_org_member(org_id)
    AND owner_id = auth.uid()
    AND public.has_org_role(org_id, ARRAY['OWNER','ADMIN','CELLAR'])
  );

CREATE POLICY "Cellar roles can update organisation lab alerts"
  ON public.lab_alerts FOR UPDATE
  USING (
    public.is_org_member(org_id)
    AND public.has_org_role(org_id, ARRAY['OWNER','ADMIN','CELLAR'])
  )
  WITH CHECK (
    public.is_org_member(org_id)
    AND public.has_org_role(org_id, ARRAY['OWNER','ADMIN','CELLAR'])
  );

-- No DELETE policy by design.

-- ============================================================
-- 6. TABLE PRIVILEGES FOR THE `authenticated` ROLE
-- SELECT, INSERT, UPDATE only — NO DELETE (grant-level reinforcement).
-- ============================================================
GRANT SELECT, INSERT, UPDATE ON public.lab_alerts TO authenticated;

-- ============================================================
-- 7. EXTEND THE EXISTING AUDIT WRITER (reuse the single writer from 021)
-- Adds lab_alerts -> lab_alert, preserving ALL twelve existing mappings
-- verbatim (021 six + 023 two + 028 three + 030 one). SECURITY DEFINER / pinned
-- search_path / fail-closed ELSE / REVOKE-from-PUBLIC posture unchanged.
-- Final CASE = 13 mappings.
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
    WHEN 'lab_alerts'           THEN 'lab_alert'
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

REVOKE ALL ON FUNCTION public.audit_log_row_change() FROM PUBLIC;

-- ============================================================
-- 8. AUDIT TRIGGER — lab_alerts, AFTER ROW, INSERT + UPDATE ONLY
-- Captures creation + acknowledge/resolve/dismiss transitions. No DELETE
-- auditing (DELETE is not available to normal authenticated users). NO trigger
-- on audit_log (recursion guard).
-- ============================================================
DROP TRIGGER IF EXISTS trg_audit_lab_alerts ON public.lab_alerts;
CREATE TRIGGER trg_audit_lab_alerts
  AFTER INSERT OR UPDATE ON public.lab_alerts
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_row_change();

-- ============================================================
-- 9. POST-VALIDATION (catalog checks). RAISE => rollback.
-- ============================================================
DO $$
DECLARE
  n INTEGER;
  rls_on BOOLEAN;
  is_secdef BOOLEAN;
  cfg TEXT[];
  has_pinned BOOLEAN;
  fires_insert BOOLEAN;
  fires_update BOOLEAN;
  fires_delete BOOLEAN;
BEGIN
  -- 1. table exists.
  IF to_regclass('public.lab_alerts') IS NULL THEN
    RAISE EXCEPTION 'Post-check 1: lab_alerts not created.' USING ERRCODE='raise_exception';
  END IF;

  -- 2. expected columns exist (all 27).
  SELECT COUNT(*) INTO n FROM information_schema.columns
  WHERE table_schema='public' AND table_name='lab_alerts'
    AND column_name IN ('id','org_id','owner_id','lab_measurement_id','alert_type','alert_class','status',
      'triggered_at','acknowledged_at','acknowledged_by','resolved_at','resolved_by','dismissed_at','dismissed_by',
      'resolution_notes','measurement_value','measurement_unit','specification_id','specification_name',
      'specification_min_value','specification_max_value','specification_target_value','specification_unit',
      'evaluation_status','range_result','created_at','updated_at');
  IF n <> 27 THEN RAISE EXCEPTION 'Post-check 2: lab_alerts columns mismatch (found %).', n USING ERRCODE='raise_exception'; END IF;

  -- 3. seven foreign keys.
  SELECT COUNT(*) INTO n FROM information_schema.table_constraints
  WHERE table_schema='public' AND table_name='lab_alerts' AND constraint_type='FOREIGN KEY';
  IF n <> 7 THEN RAISE EXCEPTION 'Post-check 3: lab_alerts should have 7 FKs (found %).', n USING ERRCODE='raise_exception'; END IF;
  -- all FKs RESTRICT/NO ACTION (preserve history).
  SELECT COUNT(*) INTO n FROM information_schema.referential_constraints rc
  JOIN information_schema.table_constraints tc
    ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema
  WHERE tc.table_schema='public' AND tc.table_name='lab_alerts'
    AND rc.delete_rule NOT IN ('NO ACTION','RESTRICT');
  IF n <> 0 THEN RAISE EXCEPTION 'Post-check 3: all lab_alerts FKs must be RESTRICT/NO ACTION (found % violating).', n USING ERRCODE='raise_exception'; END IF;

  -- 4. required CHECK constraints exist.
  SELECT COUNT(*) INTO n FROM pg_constraint
  WHERE conrelid='public.lab_alerts'::regclass AND contype='c'
    AND conname IN ('lab_alerts_alert_type_check','lab_alerts_alert_class_check','lab_alerts_status_check',
      'lab_alerts_type_class_check','lab_alerts_open_has_no_lifecycle','lab_alerts_acknowledged_requires_stamp',
      'lab_alerts_resolved_requires_stamp','lab_alerts_dismissed_requires_stamp','lab_alerts_resolved_only_when_resolved',
      'lab_alerts_dismissed_only_when_dismissed','lab_alerts_ack_pair','lab_alerts_resolved_pair','lab_alerts_dismissed_pair');
  IF n <> 13 THEN RAISE EXCEPTION 'Post-check 4: lab_alerts CHECK constraints missing (found %).', n USING ERRCODE='raise_exception'; END IF;

  -- 5. dedup unique index exists.
  SELECT COUNT(*) INTO n FROM pg_indexes
  WHERE schemaname='public' AND tablename='lab_alerts' AND indexname='uq_lab_alerts_org_measurement_type';
  IF n <> 1 THEN RAISE EXCEPTION 'Post-check 5: dedup unique index missing.' USING ERRCODE='raise_exception'; END IF;

  -- 6. RLS enabled.
  SELECT relrowsecurity INTO rls_on FROM pg_class WHERE oid='public.lab_alerts'::regclass;
  IF NOT COALESCE(rls_on,false) THEN RAISE EXCEPTION 'Post-check 6: RLS not enabled on lab_alerts.' USING ERRCODE='raise_exception'; END IF;

  -- 7/8/9. SELECT/INSERT/UPDATE policies exist; exactly three policies.
  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='lab_alerts';
  IF n <> 3 THEN RAISE EXCEPTION 'Post-check 7-9: lab_alerts should have exactly 3 policies (found %).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='lab_alerts' AND cmd IN ('SELECT','INSERT','UPDATE');
  IF n <> 3 THEN RAISE EXCEPTION 'Post-check 7-9: lab_alerts must have SELECT/INSERT/UPDATE policies (found %).', n USING ERRCODE='raise_exception'; END IF;

  -- 10. NO DELETE policy.
  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='lab_alerts' AND cmd='DELETE';
  IF n <> 0 THEN RAISE EXCEPTION 'Post-check 10: lab_alerts must have no DELETE policy (found %).', n USING ERRCODE='raise_exception'; END IF;

  -- 11. authenticated has no DELETE grant (but does have SELECT/INSERT/UPDATE).
  IF has_table_privilege('authenticated','public.lab_alerts','DELETE') THEN
    RAISE EXCEPTION 'Post-check 11: authenticated must not have DELETE on lab_alerts.' USING ERRCODE='raise_exception';
  END IF;
  IF NOT (has_table_privilege('authenticated','public.lab_alerts','SELECT')
          AND has_table_privilege('authenticated','public.lab_alerts','INSERT')
          AND has_table_privilege('authenticated','public.lab_alerts','UPDATE')) THEN
    RAISE EXCEPTION 'Post-check 11: authenticated must have SELECT/INSERT/UPDATE on lab_alerts.' USING ERRCODE='raise_exception';
  END IF;

  -- Triggers (owner-immutable, updated_at, org-integrity) present.
  SELECT COUNT(*) INTO n FROM pg_trigger
  WHERE tgrelid='public.lab_alerts'::regclass AND NOT tgisinternal
    AND tgname IN ('lab_alerts_owner_id_immutable','lab_alerts_updated_at','lab_alerts_org_integrity');
  IF n <> 3 THEN RAISE EXCEPTION 'Post-check: lab_alerts base triggers missing (found %).', n USING ERRCODE='raise_exception'; END IF;

  -- Integrity function is SECURITY DEFINER with pinned search_path.
  IF to_regprocedure('public.validate_lab_alert_org_integrity()') IS NULL THEN
    RAISE EXCEPTION 'Post-check: validate_lab_alert_org_integrity() missing.' USING ERRCODE='raise_exception';
  END IF;
  SELECT prosecdef INTO is_secdef FROM pg_proc WHERE oid='public.validate_lab_alert_org_integrity()'::regprocedure;
  IF NOT COALESCE(is_secdef,false) THEN RAISE EXCEPTION 'Post-check: validate_lab_alert_org_integrity() must be SECURITY DEFINER.' USING ERRCODE='raise_exception'; END IF;
  SELECT proconfig INTO cfg FROM pg_proc WHERE oid='public.validate_lab_alert_org_integrity()'::regprocedure;
  IF NOT EXISTS (SELECT 1 FROM unnest(COALESCE(cfg,ARRAY[]::TEXT[])) c WHERE c LIKE 'search_path=%' AND position('public' IN c)>0 AND position('pg_temp' IN c)>0) THEN
    RAISE EXCEPTION 'Post-check: validate_lab_alert_org_integrity() must pin search_path.' USING ERRCODE='raise_exception';
  END IF;

  -- 12. audit trigger exists on lab_alerts, firing INSERT + UPDATE only (no DELETE).
  SELECT COUNT(*) INTO n FROM pg_trigger
  WHERE tgrelid='public.lab_alerts'::regclass AND tgname='trg_audit_lab_alerts' AND NOT tgisinternal;
  IF n <> 1 THEN RAISE EXCEPTION 'Post-check 12: trg_audit_lab_alerts missing.' USING ERRCODE='raise_exception'; END IF;
  SELECT (tgtype & 4) <> 0, (tgtype & 16) <> 0, (tgtype & 8) <> 0
    INTO STRICT fires_insert, fires_update, fires_delete
  FROM pg_trigger WHERE tgrelid='public.lab_alerts'::regclass AND tgname='trg_audit_lab_alerts' AND NOT tgisinternal;
  IF NOT fires_insert THEN RAISE EXCEPTION 'Post-check 12: trg_audit_lab_alerts must fire on INSERT.' USING ERRCODE='raise_exception'; END IF;
  IF NOT fires_update THEN RAISE EXCEPTION 'Post-check 12: trg_audit_lab_alerts must fire on UPDATE.' USING ERRCODE='raise_exception'; END IF;
  IF fires_delete THEN RAISE EXCEPTION 'Post-check 12: trg_audit_lab_alerts must NOT fire on DELETE.' USING ERRCODE='raise_exception'; END IF;

  -- 13. audit_log still has NO trigger (recursion guard).
  SELECT COUNT(*) INTO n FROM pg_trigger WHERE tgrelid='public.audit_log'::regclass AND NOT tgisinternal;
  IF n <> 0 THEN RAISE EXCEPTION 'Post-check 13: audit_log must have no triggers (found %).', n USING ERRCODE='raise_exception'; END IF;

  -- 14. existing audit mappings remain (writer still SECURITY DEFINER, pinned, maps all 13 entities).
  SELECT prosecdef INTO is_secdef FROM pg_proc WHERE oid='public.audit_log_row_change()'::regprocedure;
  IF NOT COALESCE(is_secdef,false) THEN RAISE EXCEPTION 'Post-check 14: audit writer must remain SECURITY DEFINER.' USING ERRCODE='raise_exception'; END IF;
  IF has_function_privilege('public','public.audit_log_row_change()','EXECUTE') THEN
    RAISE EXCEPTION 'Post-check 14: PUBLIC must not have EXECUTE on the audit writer.' USING ERRCODE='raise_exception';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE oid='public.audit_log_row_change()'::regprocedure
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
      AND pg_get_functiondef(oid) ILIKE '%''lab_specification''%'
      AND pg_get_functiondef(oid) ILIKE '%''lab_alert''%'
  ) THEN
    RAISE EXCEPTION 'Post-check 14: audit writer must preserve all existing mappings and add lab_alert.' USING ERRCODE='raise_exception';
  END IF;

  -- 15. existing audit triggers remain (the 12 pre-existing business-table triggers).
  SELECT COUNT(*) INTO n FROM pg_trigger
  WHERE NOT tgisinternal AND tgname IN (
    'trg_audit_wine_batches','trg_audit_batch_grape_intakes','trg_audit_wine_lots',
    'trg_audit_vessels','trg_audit_vessel_placements','trg_audit_production_events',
    'trg_audit_lot_lineage','trg_audit_lot_volume_movements',
    'trg_audit_lab_analytes','trg_audit_lab_samples','trg_audit_lab_measurements',
    'trg_audit_lab_specifications'
  );
  IF n <> 12 THEN RAISE EXCEPTION 'Post-check 15: the 12 pre-existing audit triggers must remain (found %).', n USING ERRCODE='raise_exception'; END IF;

  -- 16. lab_alerts starts empty.
  SELECT COUNT(*) INTO n FROM public.lab_alerts;
  IF n <> 0 THEN RAISE EXCEPTION 'Post-check 16: lab_alerts must start empty (found %).', n USING ERRCODE='raise_exception'; END IF;

  -- 17. audit_log row count unchanged by this migration (no audit rows written).
  SELECT COUNT(*) INTO n FROM public.audit_log;
  IF n <> COALESCE(NULLIF(current_setting('winerix.audit_baseline_count', true), ''), '-1')::integer THEN
    RAISE EXCEPTION 'Post-check 17: this migration must not change audit_log row count (baseline %, now %).',
      current_setting('winerix.audit_baseline_count', true), n USING ERRCODE='raise_exception';
  END IF;
END $$;

COMMIT;
