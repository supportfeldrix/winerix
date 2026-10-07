-- ============================================================
-- WINERIX — P2J-10 HARDENING: Atomic Lab Specification Superseding
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- Depends on: 006 (is_org_member, has_org_role), 021 (audit_log_row_change),
--             029 (lab_specifications + partial unique current index +
--             org-integrity trigger), 030 (lab_specification audit trigger)
--
-- PURPOSE:
--   Replace the previous non-atomic client-side "retire old + insert new"
--   superseding workflow with ONE SECURITY DEFINER function that performs both
--   steps inside a single PostgreSQL transaction (the function body). Either
--   both the retirement UPDATE and the replacement INSERT commit, or neither
--   does — there is no client-side failure window.
--
--   public.supersede_lab_specification(
--     p_spec_id, p_name, p_min_value, p_max_value, p_target_value,
--     p_effective_from, p_notes
--   ) RETURNS public.lab_specifications  (the NEW superseding row)
--
-- GUARANTEES:
--   * Exactly ONE UPDATE on the source row (true -> false); never false->false.
--   * The old row is retired BEFORE the new current row is inserted, in the same
--     transaction, so the partial unique current index
--     (org_id, lab_analyte_id, sample_type) WHERE is_active AND effective_to IS NULL
--     is always satisfied and is NOT bypassed or weakened.
--   * org_id / lab_analyte_id / sample_type / unit are preserved from the source;
--     owner_id = auth.uid(); supersedes_id = source.id. The caller cannot change
--     organisation / owner / analyte / sample type / unit.
--   * Value validity (>=1 of min/max/target; min<=max; valid sample_type) and
--     cross-org integrity are enforced by the EXISTING table CHECKs and the
--     existing validate_lab_specification_org_integrity trigger on the INSERT —
--     NOT re-implemented here.
--   * Auditing is handled by the EXISTING migration-030 trigger: this operation
--     naturally produces one UPDATE audit row + one INSERT audit row.
--
-- THIS MIGRATION DOES NOT:
--   * modify migrations 029 / 030, the lab_specifications table, its triggers,
--     constraints, indexes, RLS, or grants
--   * modify audit_log, audit_log_row_change(), audit mappings, or audit triggers
--   * disable any trigger or RLS; create a version table or a second audit writer
--   * add any DELETE policy or DELETE grant
--   * read, modify, delete, or require-empty any lab_specifications row
--   * create UI / services
-- ============================================================

BEGIN;

-- ============================================================
-- 0. PRE-FLIGHT (fail clearly; never silently create dependencies)
-- ============================================================
DO $$
BEGIN
  IF to_regclass('public.lab_specifications') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.lab_specifications is missing (run 029 first).' USING ERRCODE='undefined_table';
  END IF;
  IF to_regprocedure('public.is_org_member(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.is_org_member(uuid) is missing (run 006 first).' USING ERRCODE='undefined_function';
  END IF;
  IF to_regprocedure('public.has_org_role(uuid, text[])') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.has_org_role(uuid, text[]) is missing (run 006 first).' USING ERRCODE='undefined_function';
  END IF;
  IF to_regprocedure('public.audit_log_row_change()') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.audit_log_row_change() is missing (run 021 first).' USING ERRCODE='undefined_function';
  END IF;
  -- The audit trigger from 030 must be present (we rely on it; we never modify it).
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid='public.lab_specifications'::regclass
      AND tgname='trg_audit_lab_specifications' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'Pre-flight failed: trg_audit_lab_specifications is missing (run 030 first).' USING ERRCODE='undefined_object';
  END IF;
END $$;

-- ============================================================
-- 1. THE ATOMIC SUPERSEDE FUNCTION
-- SECURITY DEFINER so the explicit membership/role checks are authoritative
-- regardless of RLS; pinned search_path; no error-swallowing EXCEPTION block —
-- any failure (including the INSERT hitting a CHECK / unique / integrity-trigger
-- error) propagates and rolls back the whole function, including the UPDATE.
-- ============================================================
CREATE OR REPLACE FUNCTION public.supersede_lab_specification(
  p_spec_id        UUID,
  p_name           TEXT        DEFAULT NULL,
  p_min_value      NUMERIC     DEFAULT NULL,
  p_max_value      NUMERIC     DEFAULT NULL,
  p_target_value   NUMERIC     DEFAULT NULL,
  p_effective_from TIMESTAMPTZ DEFAULT NULL,
  p_notes          TEXT        DEFAULT NULL
)
RETURNS public.lab_specifications
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid  UUID := auth.uid();
  v_prev public.lab_specifications;
  v_new  public.lab_specifications;
  v_now  TIMESTAMPTZ := now();
BEGIN
  -- Fail closed on an unauthenticated caller.
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.' USING ERRCODE = 'raise_exception';
  END IF;

  -- 1/2. Lock + load the source specification (prevents concurrent supersedes
  -- of the same current row). NULL id after the SELECT => not found.
  SELECT * INTO v_prev FROM public.lab_specifications WHERE id = p_spec_id FOR UPDATE;
  IF v_prev.id IS NULL THEN
    RAISE EXCEPTION 'Specification % not found.', p_spec_id USING ERRCODE = 'raise_exception';
  END IF;

  -- 4/5. Caller must belong to the spec's organisation and hold a write role.
  -- Checked explicitly because SECURITY DEFINER bypasses RLS.
  IF NOT public.is_org_member(v_prev.org_id) THEN
    RAISE EXCEPTION 'Not a member of the specification''s organisation.' USING ERRCODE = 'raise_exception';
  END IF;
  IF NOT public.has_org_role(v_prev.org_id, ARRAY['OWNER','ADMIN','CELLAR']) THEN
    RAISE EXCEPTION 'This operation requires an Owner, Admin or Cellar role.' USING ERRCODE = 'raise_exception';
  END IF;

  -- 6. Only the CURRENT active, open-ended version may be superseded.
  IF v_prev.is_active IS NOT TRUE OR v_prev.effective_to IS NOT NULL THEN
    RAISE EXCEPTION 'Only the current active specification can be superseded.' USING ERRCODE = 'raise_exception';
  END IF;

  -- 7. Retire the source EXACTLY ONCE (true -> false). Because step 6 proved it
  -- was active + open-ended, this is never a no-op / false->false update.
  UPDATE public.lab_specifications
     SET is_active    = FALSE,
         effective_to = v_now
   WHERE id = v_prev.id;

  -- 8. Insert the replacement in the SAME transaction. org_id / lab_analyte_id /
  -- sample_type / unit are preserved from the source (caller cannot change them);
  -- owner_id = caller; supersedes_id = source. The table CHECKs and the
  -- validate_lab_specification_org_integrity trigger validate this row — if it is
  -- invalid, the INSERT raises and the UPDATE above rolls back with it.
  INSERT INTO public.lab_specifications (
    org_id, owner_id, lab_analyte_id, sample_type, name,
    min_value, max_value, target_value, unit,
    effective_from, effective_to, is_active, supersedes_id, notes
  ) VALUES (
    v_prev.org_id,
    v_uid,
    v_prev.lab_analyte_id,
    v_prev.sample_type,
    COALESCE(p_name, v_prev.name),
    p_min_value,
    p_max_value,
    p_target_value,
    v_prev.unit,                               -- preserved unit snapshot
    COALESCE(p_effective_from, v_now),
    NULL,
    TRUE,
    v_prev.id,
    COALESCE(p_notes, v_prev.notes)
  )
  RETURNING * INTO v_new;

  -- 9. Return the new (superseding) specification.
  RETURN v_new;
END;
$$;

-- ============================================================
-- 2. PERMISSIONS — callable only by authenticated users (not PUBLIC / anon).
-- ============================================================
REVOKE ALL ON FUNCTION public.supersede_lab_specification(
  UUID, TEXT, NUMERIC, NUMERIC, NUMERIC, TIMESTAMPTZ, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.supersede_lab_specification(
  UUID, TEXT, NUMERIC, NUMERIC, NUMERIC, TIMESTAMPTZ, TEXT) TO authenticated;

-- ============================================================
-- 3. POST-VALIDATION (catalog checks). RAISE => rollback.
-- ============================================================
DO $$
DECLARE
  v_oid         OID;
  is_secdef     BOOLEAN;
  cfg           TEXT[];
  has_pinned    BOOLEAN;
  rettype       TEXT;
  n             INTEGER;
BEGIN
  -- 1. Function exists (with the exact 7-arg signature).
  v_oid := to_regprocedure('public.supersede_lab_specification(uuid, text, numeric, numeric, numeric, timestamptz, text)');
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'Post-check: supersede_lab_specification(7-arg) missing.' USING ERRCODE='raise_exception';
  END IF;

  -- 2. SECURITY DEFINER.
  SELECT prosecdef INTO is_secdef FROM pg_proc WHERE oid = v_oid;
  IF NOT COALESCE(is_secdef,false) THEN
    RAISE EXCEPTION 'Post-check: supersede_lab_specification must be SECURITY DEFINER.' USING ERRCODE='raise_exception';
  END IF;

  -- 3. Pinned search_path covering public + pg_temp.
  SELECT proconfig INTO cfg FROM pg_proc WHERE oid = v_oid;
  has_pinned := EXISTS (
    SELECT 1 FROM unnest(COALESCE(cfg, ARRAY[]::TEXT[])) AS c
    WHERE c LIKE 'search_path=%' AND position('public' IN c) > 0 AND position('pg_temp' IN c) > 0
  );
  IF NOT has_pinned THEN
    RAISE EXCEPTION 'Post-check: supersede_lab_specification must SET search_path = public, pg_temp (found %).', cfg USING ERRCODE='raise_exception';
  END IF;

  -- 4. PUBLIC cannot EXECUTE.
  IF has_function_privilege('public', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'Post-check: PUBLIC must not have EXECUTE on supersede_lab_specification.' USING ERRCODE='raise_exception';
  END IF;

  -- 5. authenticated can EXECUTE.
  IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'Post-check: authenticated must have EXECUTE on supersede_lab_specification.' USING ERRCODE='raise_exception';
  END IF;

  -- 6. Return type is public.lab_specifications (the composite row type).
  SELECT format_type(prorettype, NULL) INTO rettype FROM pg_proc WHERE oid = v_oid;
  IF rettype <> 'lab_specifications' AND rettype <> 'public.lab_specifications' THEN
    RAISE EXCEPTION 'Post-check: supersede_lab_specification must return public.lab_specifications (found %).', rettype USING ERRCODE='raise_exception';
  END IF;

  -- 7. Existing lab_specifications structure unchanged (spot-check the 17 columns).
  SELECT COUNT(*) INTO n FROM information_schema.columns
  WHERE table_schema='public' AND table_name='lab_specifications'
    AND column_name IN ('id','org_id','owner_id','lab_analyte_id','sample_type','name',
                        'min_value','max_value','target_value','unit','effective_from',
                        'effective_to','is_active','supersedes_id','notes','created_at','updated_at');
  IF n <> 17 THEN RAISE EXCEPTION 'Post-check: lab_specifications columns changed unexpectedly (found %).', n USING ERRCODE='raise_exception'; END IF;

  -- 7b. Partial unique current index still present (we must not have touched it).
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND tablename='lab_specifications' AND indexname='uq_lab_specifications_current'
  ) THEN
    RAISE EXCEPTION 'Post-check: uq_lab_specifications_current missing (029 must be intact).' USING ERRCODE='raise_exception';
  END IF;

  -- 7c. The 029 org-integrity trigger still present (the INSERT relies on it).
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid='public.lab_specifications'::regclass AND tgname='lab_specifications_org_integrity' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'Post-check: lab_specifications_org_integrity trigger missing (029 must be intact).' USING ERRCODE='raise_exception';
  END IF;

  -- 8. The 030 audit trigger remains present and unchanged.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid='public.lab_specifications'::regclass AND tgname='trg_audit_lab_specifications' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'Post-check: trg_audit_lab_specifications missing (030 must be intact).' USING ERRCODE='raise_exception';
  END IF;

  -- 9. No DELETE policy was introduced on lab_specifications; authenticated has no DELETE.
  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='lab_specifications' AND cmd='DELETE';
  IF n <> 0 THEN RAISE EXCEPTION 'Post-check: lab_specifications must have no DELETE policy (found %).', n USING ERRCODE='raise_exception'; END IF;
  IF has_table_privilege('authenticated','public.lab_specifications','DELETE') THEN
    RAISE EXCEPTION 'Post-check: authenticated must not have DELETE on lab_specifications.' USING ERRCODE='raise_exception';
  END IF;

  -- 10. Existing audit infrastructure unchanged: writer still present, SECURITY
  -- DEFINER, pinned search_path, and audit_log still has no trigger.
  IF to_regprocedure('public.audit_log_row_change()') IS NULL THEN
    RAISE EXCEPTION 'Post-check: audit_log_row_change() missing.' USING ERRCODE='raise_exception';
  END IF;
  SELECT prosecdef INTO is_secdef FROM pg_proc WHERE oid='public.audit_log_row_change()'::regprocedure;
  IF NOT COALESCE(is_secdef,false) THEN
    RAISE EXCEPTION 'Post-check: audit_log_row_change() must remain SECURITY DEFINER.' USING ERRCODE='raise_exception';
  END IF;
  SELECT proconfig INTO cfg FROM pg_proc WHERE oid='public.audit_log_row_change()'::regprocedure;
  IF NOT EXISTS (
    SELECT 1 FROM unnest(COALESCE(cfg, ARRAY[]::TEXT[])) AS c
    WHERE c LIKE 'search_path=%' AND position('public' IN c) > 0 AND position('pg_temp' IN c) > 0
  ) THEN
    RAISE EXCEPTION 'Post-check: audit_log_row_change() search_path must remain pinned.' USING ERRCODE='raise_exception';
  END IF;
  SELECT COUNT(*) INTO n FROM pg_trigger WHERE tgrelid='public.audit_log'::regclass AND NOT tgisinternal;
  IF n <> 0 THEN RAISE EXCEPTION 'Post-check: audit_log must have no triggers (found %).', n USING ERRCODE='raise_exception'; END IF;
END $$;

COMMIT;
