-- ============================================================
-- WINERIX — P2J-13b: Laboratory Alert Controlled RPCs
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- Depends on: 006 (is_org_member, has_org_role), 027 (lab_measurements),
--             029 (lab_specifications), 032 (lab_alerts + audit trigger)
--
-- PURPOSE:
--   Provide the SECURITY DEFINER operations the alert SERVICE uses to persist
--   and transition laboratory alerts. The service computes the evaluation (via
--   the existing JS labEvaluationService — the single source of truth) and
--   passes the already-computed, FROZEN snapshot to create_lab_alert. These
--   RPCs do NOT re-implement the evaluation comparison.
--
--   Functions:
--     create_lab_alert(...)      — idempotent insert of a frozen alert snapshot
--     acknowledge_lab_alert(id)  — open -> acknowledged
--     resolve_lab_alert(id,notes)   — open|acknowledged -> resolved
--     dismiss_lab_alert(id,notes)   — open|acknowledged -> dismissed
--
--   Every function: fail closed on unauthenticated; derive org from the
--   referenced row and owner/actor from auth.uid() (never the client); require
--   OWNER/ADMIN/CELLAR membership; SET search_path = public, pg_temp; REVOKE
--   from PUBLIC; GRANT EXECUTE to authenticated only. The 032 CHECK constraints
--   and audit trigger remain the backstop — these RPCs never bypass them.
--
-- THIS MIGRATION DOES NOT:
--   * duplicate the evaluation engine or compute within/below/above here
--   * create lab_evaluations; alter lab_alerts/lab_measurements/lab_specifications
--     or any existing table, policy, grant, or trigger
--   * create a second audit writer or change audit wiring (032's AFTER
--     INSERT/UPDATE trigger captures create + lifecycle changes automatically)
--   * allow reopening (resolved/dismissed are terminal) or cross-org access
--   * grant anything to anon
-- ============================================================

BEGIN;

-- ============================================================
-- 0. PRE-FLIGHT
-- ============================================================
DO $$
BEGIN
  IF to_regclass('public.lab_alerts') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.lab_alerts is missing (run 032 first).' USING ERRCODE='undefined_table';
  END IF;
  IF to_regclass('public.lab_measurements') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.lab_measurements is missing (run 027 first).' USING ERRCODE='undefined_table';
  END IF;
  IF to_regprocedure('public.is_org_member(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.is_org_member(uuid) is missing (run 006 first).' USING ERRCODE='undefined_function';
  END IF;
  IF to_regprocedure('public.has_org_role(uuid, text[])') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.has_org_role(uuid, text[]) is missing (run 006 first).' USING ERRCODE='undefined_function';
  END IF;
  -- The audit trigger from 032 must exist (we rely on it; we never modify it).
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid='public.lab_alerts'::regclass AND tgname='trg_audit_lab_alerts' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'Pre-flight failed: trg_audit_lab_alerts is missing (run 032 first).' USING ERRCODE='undefined_object';
  END IF;
END $$;

-- ============================================================
-- 1. CREATE — idempotent persist of a frozen alert snapshot
-- The client supplies the already-computed evaluation basis. The RPC derives
-- org from the measurement and owner from auth.uid(), validates membership/role
-- and the type/class pairing, then inserts with ON CONFLICT DO NOTHING on the
-- 032 dedup key (org_id, lab_measurement_id, alert_type). Always RETURNS the
-- existing-or-new row, so the operation is deterministic and idempotent.
--
-- NOTE: triggered_at / created_at are server-side now() — the client cannot
-- back-date or future-date an alert.
-- ============================================================
CREATE OR REPLACE FUNCTION public.create_lab_alert(
  p_lab_measurement_id         UUID,
  p_alert_type                 TEXT,
  p_alert_class                TEXT,
  p_measurement_value          NUMERIC     DEFAULT NULL,
  p_measurement_unit           TEXT        DEFAULT NULL,
  p_specification_id           UUID        DEFAULT NULL,
  p_specification_name         TEXT        DEFAULT NULL,
  p_specification_min_value    NUMERIC     DEFAULT NULL,
  p_specification_max_value    NUMERIC     DEFAULT NULL,
  p_specification_target_value NUMERIC     DEFAULT NULL,
  p_specification_unit         TEXT        DEFAULT NULL,
  p_evaluation_status          TEXT        DEFAULT NULL,
  p_range_result               TEXT        DEFAULT NULL
)
RETURNS public.lab_alerts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid    UUID := auth.uid();
  v_org    UUID;
  v_now    TIMESTAMPTZ := now();
  v_alert  public.lab_alerts;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.' USING ERRCODE = 'raise_exception';
  END IF;

  -- Only the approved alert types/classes in this phase (DB CHECKs also enforce).
  IF p_alert_type NOT IN ('below_minimum','above_maximum','incompatible_unit') THEN
    RAISE EXCEPTION 'Unsupported alert type %.', p_alert_type USING ERRCODE = 'raise_exception';
  END IF;
  IF NOT (
    (p_alert_type IN ('below_minimum','above_maximum') AND p_alert_class = 'range_exception')
    OR (p_alert_type = 'incompatible_unit' AND p_alert_class = 'data_quality')
  ) THEN
    RAISE EXCEPTION 'Invalid alert type/class combination (% / %).', p_alert_type, p_alert_class USING ERRCODE = 'raise_exception';
  END IF;

  -- Derive org from the measurement (never from the client).
  SELECT m.org_id INTO v_org FROM public.lab_measurements m WHERE m.id = p_lab_measurement_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Lab measurement % not found.', p_lab_measurement_id USING ERRCODE = 'raise_exception';
  END IF;

  -- Membership + write role for the measurement's organisation (fail closed).
  IF NOT public.is_org_member(v_org) THEN
    RAISE EXCEPTION 'Not a member of the measurement''s organisation.' USING ERRCODE = 'raise_exception';
  END IF;
  IF NOT public.has_org_role(v_org, ARRAY['OWNER','ADMIN','CELLAR']) THEN
    RAISE EXCEPTION 'This operation requires an Owner, Admin or Cellar role.' USING ERRCODE = 'raise_exception';
  END IF;

  -- Idempotent insert on the 032 dedup key. New row is always 'open'.
  INSERT INTO public.lab_alerts (
    org_id, owner_id, lab_measurement_id, alert_type, alert_class, status, triggered_at,
    measurement_value, measurement_unit,
    specification_id, specification_name, specification_min_value, specification_max_value,
    specification_target_value, specification_unit, evaluation_status, range_result
  ) VALUES (
    v_org, v_uid, p_lab_measurement_id, p_alert_type, p_alert_class, 'open', v_now,
    p_measurement_value, p_measurement_unit,
    p_specification_id, p_specification_name, p_specification_min_value, p_specification_max_value,
    p_specification_target_value, p_specification_unit, p_evaluation_status, p_range_result
  )
  ON CONFLICT (org_id, lab_measurement_id, alert_type) DO NOTHING
  RETURNING * INTO v_alert;

  -- On conflict (already existed), fetch and return the existing row so the
  -- caller gets a deterministic result (idempotent success).
  IF v_alert.id IS NULL THEN
    SELECT * INTO v_alert FROM public.lab_alerts
    WHERE org_id = v_org AND lab_measurement_id = p_lab_measurement_id AND alert_type = p_alert_type;
  END IF;

  RETURN v_alert;
END;
$$;

REVOKE ALL ON FUNCTION public.create_lab_alert(
  UUID, TEXT, TEXT, NUMERIC, TEXT, UUID, TEXT, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_lab_alert(
  UUID, TEXT, TEXT, NUMERIC, TEXT, UUID, TEXT, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, TEXT) TO authenticated;

-- ============================================================
-- 2. ACKNOWLEDGE — open -> acknowledged
-- ============================================================
CREATE OR REPLACE FUNCTION public.acknowledge_lab_alert(p_alert_id UUID)
RETURNS public.lab_alerts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid   UUID := auth.uid();
  v_alert public.lab_alerts;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated.' USING ERRCODE='raise_exception'; END IF;

  SELECT * INTO v_alert FROM public.lab_alerts WHERE id = p_alert_id FOR UPDATE;
  IF v_alert.id IS NULL THEN RAISE EXCEPTION 'Alert % not found.', p_alert_id USING ERRCODE='raise_exception'; END IF;

  IF NOT public.is_org_member(v_alert.org_id) THEN
    RAISE EXCEPTION 'Not a member of the alert''s organisation.' USING ERRCODE='raise_exception';
  END IF;
  IF NOT public.has_org_role(v_alert.org_id, ARRAY['OWNER','ADMIN','CELLAR']) THEN
    RAISE EXCEPTION 'This operation requires an Owner, Admin or Cellar role.' USING ERRCODE='raise_exception';
  END IF;

  IF v_alert.status <> 'open' THEN
    RAISE EXCEPTION 'Only an open alert can be acknowledged (current status: %).', v_alert.status USING ERRCODE='raise_exception';
  END IF;

  UPDATE public.lab_alerts
     SET status = 'acknowledged', acknowledged_at = now(), acknowledged_by = v_uid
   WHERE id = p_alert_id
   RETURNING * INTO v_alert;
  RETURN v_alert;
END;
$$;
REVOKE ALL ON FUNCTION public.acknowledge_lab_alert(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.acknowledge_lab_alert(UUID) TO authenticated;

-- ============================================================
-- 3. RESOLVE — open|acknowledged -> resolved (notes optional)
-- ============================================================
CREATE OR REPLACE FUNCTION public.resolve_lab_alert(p_alert_id UUID, p_notes TEXT DEFAULT NULL)
RETURNS public.lab_alerts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid   UUID := auth.uid();
  v_alert public.lab_alerts;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated.' USING ERRCODE='raise_exception'; END IF;

  SELECT * INTO v_alert FROM public.lab_alerts WHERE id = p_alert_id FOR UPDATE;
  IF v_alert.id IS NULL THEN RAISE EXCEPTION 'Alert % not found.', p_alert_id USING ERRCODE='raise_exception'; END IF;

  IF NOT public.is_org_member(v_alert.org_id) THEN
    RAISE EXCEPTION 'Not a member of the alert''s organisation.' USING ERRCODE='raise_exception';
  END IF;
  IF NOT public.has_org_role(v_alert.org_id, ARRAY['OWNER','ADMIN','CELLAR']) THEN
    RAISE EXCEPTION 'This operation requires an Owner, Admin or Cellar role.' USING ERRCODE='raise_exception';
  END IF;

  IF v_alert.status NOT IN ('open','acknowledged') THEN
    RAISE EXCEPTION 'Only an open or acknowledged alert can be resolved (current status: %).', v_alert.status USING ERRCODE='raise_exception';
  END IF;

  UPDATE public.lab_alerts
     SET status = 'resolved', resolved_at = now(), resolved_by = v_uid,
         resolution_notes = COALESCE(p_notes, resolution_notes)
   WHERE id = p_alert_id
   RETURNING * INTO v_alert;
  RETURN v_alert;
END;
$$;
REVOKE ALL ON FUNCTION public.resolve_lab_alert(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_lab_alert(UUID, TEXT) TO authenticated;

-- ============================================================
-- 4. DISMISS — open|acknowledged -> dismissed (notes optional)
-- ============================================================
CREATE OR REPLACE FUNCTION public.dismiss_lab_alert(p_alert_id UUID, p_notes TEXT DEFAULT NULL)
RETURNS public.lab_alerts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid   UUID := auth.uid();
  v_alert public.lab_alerts;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated.' USING ERRCODE='raise_exception'; END IF;

  SELECT * INTO v_alert FROM public.lab_alerts WHERE id = p_alert_id FOR UPDATE;
  IF v_alert.id IS NULL THEN RAISE EXCEPTION 'Alert % not found.', p_alert_id USING ERRCODE='raise_exception'; END IF;

  IF NOT public.is_org_member(v_alert.org_id) THEN
    RAISE EXCEPTION 'Not a member of the alert''s organisation.' USING ERRCODE='raise_exception';
  END IF;
  IF NOT public.has_org_role(v_alert.org_id, ARRAY['OWNER','ADMIN','CELLAR']) THEN
    RAISE EXCEPTION 'This operation requires an Owner, Admin or Cellar role.' USING ERRCODE='raise_exception';
  END IF;

  IF v_alert.status NOT IN ('open','acknowledged') THEN
    RAISE EXCEPTION 'Only an open or acknowledged alert can be dismissed (current status: %).', v_alert.status USING ERRCODE='raise_exception';
  END IF;

  UPDATE public.lab_alerts
     SET status = 'dismissed', dismissed_at = now(), dismissed_by = v_uid,
         resolution_notes = COALESCE(p_notes, resolution_notes)
   WHERE id = p_alert_id
   RETURNING * INTO v_alert;
  RETURN v_alert;
END;
$$;
REVOKE ALL ON FUNCTION public.dismiss_lab_alert(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dismiss_lab_alert(UUID, TEXT) TO authenticated;

-- ============================================================
-- 5. POST-VALIDATION (catalog checks). RAISE => rollback.
-- ============================================================
DO $$
DECLARE
  r RECORD;
  sig TEXT;
  v_oid OID;
  cfg TEXT[];
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('public.create_lab_alert(uuid, text, text, numeric, text, uuid, text, numeric, numeric, numeric, text, text, text)'),
      ('public.acknowledge_lab_alert(uuid)'),
      ('public.resolve_lab_alert(uuid, text)'),
      ('public.dismiss_lab_alert(uuid, text)')
    ) AS t(sig)
  LOOP
    v_oid := to_regprocedure(r.sig);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'Post-check: function % missing.', r.sig USING ERRCODE='raise_exception';
    END IF;
    -- SECURITY DEFINER.
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_oid) THEN
      RAISE EXCEPTION 'Post-check: % must be SECURITY DEFINER.', r.sig USING ERRCODE='raise_exception';
    END IF;
    -- Pinned search_path.
    SELECT proconfig INTO cfg FROM pg_proc WHERE oid = v_oid;
    IF NOT EXISTS (SELECT 1 FROM unnest(COALESCE(cfg,ARRAY[]::TEXT[])) c
                   WHERE c LIKE 'search_path=%' AND position('public' IN c)>0 AND position('pg_temp' IN c)>0) THEN
      RAISE EXCEPTION 'Post-check: % must SET search_path = public, pg_temp.', r.sig USING ERRCODE='raise_exception';
    END IF;
    -- PUBLIC cannot EXECUTE; authenticated can.
    IF has_function_privilege('public', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'Post-check: PUBLIC must not EXECUTE %.', r.sig USING ERRCODE='raise_exception';
    END IF;
    IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'Post-check: authenticated must EXECUTE %.', r.sig USING ERRCODE='raise_exception';
    END IF;
    -- anon (if present) must NOT execute.
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon')
       AND has_function_privilege('anon', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'Post-check: anon must not EXECUTE %.', r.sig USING ERRCODE='raise_exception';
    END IF;
    -- All four return the lab_alerts composite row.
    IF (SELECT format_type(prorettype, NULL) FROM pg_proc WHERE oid = v_oid) NOT IN ('lab_alerts','public.lab_alerts') THEN
      RAISE EXCEPTION 'Post-check: % must return public.lab_alerts.', r.sig USING ERRCODE='raise_exception';
    END IF;
  END LOOP;

  -- The 032 audit trigger must still be present and unchanged.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid='public.lab_alerts'::regclass AND tgname='trg_audit_lab_alerts' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'Post-check: trg_audit_lab_alerts must remain (032 intact).' USING ERRCODE='raise_exception';
  END IF;
END $$;

COMMIT;
