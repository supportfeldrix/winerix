-- ============================================================
-- WINERIX — P2J-8: Laboratory Specifications (foundation)
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- Depends on: 001 (update_updated_at), 006 (organisations, is_org_member,
--             has_org_role), 010 (prevent_owner_id_change), 027 (lab_analytes)
--
-- PURPOSE:
--   Add public.lab_specifications — an organisation's INTERNAL laboratory /
--   quality rule stating the expected range or target for ONE analyte at ONE
--   process stage (sample_type), valid over a period of time. Extends the lab
--   model alongside (NOT inside) measurements:
--       lab_analyte + sample_type -> lab_specification (expected range)
--       lab_measurement                           (factual reading)
--   A specification is a DEFINITION, never a lineage object and never a legal /
--   SAWIS / SARS / export / regulatory statement.
--
-- SINGLE-TABLE, TIME-SLICED VERSIONING:
--   Each row is one version of a spec for an (analyte, sample_type) pair.
--   Replacing a spec = retire the current row (set effective_to + is_active =
--   false) then INSERT a replacement whose supersedes_id points at the retired
--   row. A partial unique index guarantees at most ONE active current version
--   per (org_id, lab_analyte_id, sample_type), giving deterministic lookup.
--
-- SCOPE — THIS MIGRATION ONLY:
--   Creates the table + FKs (incl. a self-reference) + CHECKs + indexes + the
--   partial unique current-spec index + org-based RLS (SELECT member;
--   INSERT/UPDATE OWNER/ADMIN/CELLAR; NO DELETE) + owner_id immutability +
--   updated_at + a SECURITY DEFINER cross-organisation integrity trigger +
--   grants (SELECT/INSERT/UPDATE only). No backfill.
--
-- THIS MIGRATION DOES NOT:
--   * wire the audit log (that is 030_lab_specifications_audit_wiring.sql)
--   * add any FK or trigger from specifications to lab_measurements/lab_samples
--   * modify lab_measurements / lab_samples / lab_analytes (or any existing
--     table, policy, grant, trigger, or function)
--   * implement evaluation / pass-fail / within-spec / alerts / scoring / unit
--     conversion / tolerance / comparison_operator / range_mode
--   * add a DELETE policy or a DELETE grant (specs are retired, never deleted)
--   * seed / backfill any data (the table starts empty)
--
-- HISTORICAL RULE: a specification change must NEVER modify a measurement,
--   sample, or analyte. This table has no FK into and no trigger on those
--   tables, so it structurally cannot alter them.
-- ============================================================

BEGIN;

-- ============================================================
-- 0. PRE-FLIGHT (fail before creating anything if deps are missing)
-- ============================================================
DO $$
BEGIN
  IF to_regclass('public.organisations') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.organisations is missing (run 006 first).' USING ERRCODE = 'undefined_table';
  END IF;
  IF to_regclass('public.lab_analytes') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.lab_analytes is missing (run 027 first).' USING ERRCODE = 'undefined_table';
  END IF;
  IF to_regclass('public.lab_specifications') IS NOT NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.lab_specifications already exists.' USING ERRCODE = 'duplicate_table';
  END IF;
  IF to_regprocedure('public.is_org_member(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.is_org_member(uuid) is missing (run 006 first).' USING ERRCODE = 'undefined_function';
  END IF;
  IF to_regprocedure('public.has_org_role(uuid, text[])') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.has_org_role(uuid, text[]) is missing (run 006 first).' USING ERRCODE = 'undefined_function';
  END IF;
  IF to_regprocedure('public.prevent_owner_id_change()') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.prevent_owner_id_change() is missing (run 010 first).' USING ERRCODE = 'undefined_function';
  END IF;
  IF to_regprocedure('public.update_updated_at()') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.update_updated_at() is missing (run 001 first).' USING ERRCODE = 'undefined_function';
  END IF;
  -- lab_analytes must carry org_id for the integrity check.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='lab_analytes' AND column_name='org_id'
  ) THEN
    RAISE EXCEPTION 'Pre-flight failed: lab_analytes.org_id is missing (run 027 first).' USING ERRCODE = 'undefined_column';
  END IF;
END $$;

-- ============================================================
-- 1. LAB_SPECIFICATIONS TABLE
-- min_value / max_value / target_value are all nullable NUMERIC. The "range
-- mode" is INFERRED from which are populated (min-only / max-only / min+max /
-- target-only / range+target) — there is deliberately NO tolerance,
-- comparison_operator, range_mode, or has_bound column. unit is a SNAPSHOT of
-- the analyte's canonical_unit at creation (immutable history; never
-- auto-synchronised). supersedes_id is a self-reference for version
-- traceability. No FK to measurements/samples by design.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.lab_specifications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL,
  owner_id        UUID NOT NULL,
  lab_analyte_id  UUID NOT NULL,
  sample_type     TEXT NOT NULL,
  name            TEXT NOT NULL,
  min_value       NUMERIC,
  max_value       NUMERIC,
  target_value    NUMERIC,
  unit            TEXT NOT NULL,
  effective_from  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  effective_to    TIMESTAMPTZ,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  supersedes_id   UUID,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_lab_specifications_org
    FOREIGN KEY (org_id) REFERENCES public.organisations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_lab_specifications_owner
    FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_lab_specifications_analyte
    FOREIGN KEY (lab_analyte_id) REFERENCES public.lab_analytes(id) ON DELETE RESTRICT,
  -- Self-reference for version traceability (retired -> replacement).
  CONSTRAINT fk_lab_specifications_supersedes
    FOREIGN KEY (supersedes_id) REFERENCES public.lab_specifications(id) ON DELETE RESTRICT,

  CONSTRAINT lab_specifications_name_not_blank
    CHECK (length(btrim(name)) > 0),
  CONSTRAINT lab_specifications_unit_not_blank
    CHECK (length(btrim(unit)) > 0),
  -- Same process-stage vocabulary as lab_samples.sample_type (027).
  CONSTRAINT lab_specifications_sample_type_check
    CHECK (sample_type IN ('fermentation','maturation','pre_filtration','pre_bottling','release','other')),
  -- At least one bound/target must be present (a spec with no numbers is meaningless).
  CONSTRAINT lab_specifications_has_value
    CHECK (min_value IS NOT NULL OR max_value IS NOT NULL OR target_value IS NOT NULL),
  -- When both bounds are present, min must not exceed max.
  CONSTRAINT lab_specifications_min_le_max
    CHECK (min_value IS NULL OR max_value IS NULL OR min_value <= max_value),
  -- A row must not supersede itself.
  CONSTRAINT lab_specifications_no_self_supersede
    CHECK (supersedes_id IS NULL OR supersedes_id <> id)
);

-- Deterministic current-spec selection: at most ONE active, open-ended version
-- per (org, analyte, sample_type). Retired versions (is_active=false OR
-- effective_to set) are unconstrained, so full history accumulates freely.
CREATE UNIQUE INDEX IF NOT EXISTS uq_lab_specifications_current
  ON public.lab_specifications(org_id, lab_analyte_id, sample_type)
  WHERE is_active = TRUE AND effective_to IS NULL;

CREATE INDEX IF NOT EXISTS idx_lab_specifications_org_id         ON public.lab_specifications(org_id);
CREATE INDEX IF NOT EXISTS idx_lab_specifications_owner_id       ON public.lab_specifications(owner_id);
CREATE INDEX IF NOT EXISTS idx_lab_specifications_analyte_id     ON public.lab_specifications(lab_analyte_id);
CREATE INDEX IF NOT EXISTS idx_lab_specifications_sample_type    ON public.lab_specifications(sample_type);
CREATE INDEX IF NOT EXISTS idx_lab_specifications_is_active      ON public.lab_specifications(is_active);
CREATE INDEX IF NOT EXISTS idx_lab_specifications_supersedes_id  ON public.lab_specifications(supersedes_id);
-- Supports the future deterministic "spec effective at time T" lookup.
CREATE INDEX IF NOT EXISTS idx_lab_specifications_lookup
  ON public.lab_specifications(org_id, lab_analyte_id, sample_type, is_active, effective_from DESC);
CREATE INDEX IF NOT EXISTS idx_lab_specifications_effective
  ON public.lab_specifications(effective_from, effective_to);

-- ============================================================
-- 2. OWNER_ID IMMUTABILITY (reuse 010)
-- ============================================================
DROP TRIGGER IF EXISTS lab_specifications_owner_id_immutable ON public.lab_specifications;
CREATE TRIGGER lab_specifications_owner_id_immutable
  BEFORE UPDATE ON public.lab_specifications
  FOR EACH ROW EXECUTE FUNCTION public.prevent_owner_id_change();

-- ============================================================
-- 3. UPDATED_AT (reuse 001)
-- ============================================================
DROP TRIGGER IF EXISTS lab_specifications_updated_at ON public.lab_specifications;
CREATE TRIGGER lab_specifications_updated_at
  BEFORE UPDATE ON public.lab_specifications
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ============================================================
-- 4. CROSS-ORGANISATION INTEGRITY (DB-enforced, fail-closed)
-- Guarantees the referenced analyte — and, when set, the superseded spec —
-- belong to the SAME organisation as this specification. SECURITY DEFINER so it
-- reads the referenced rows regardless of RLS; pinned search_path; static SQL.
-- Mirrors validate_lab_measurement_org_integrity (027).
-- ============================================================
CREATE OR REPLACE FUNCTION public.validate_lab_specification_org_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  analyte_org   UUID;
  supersede_org UUID;
BEGIN
  SELECT a.org_id INTO analyte_org FROM public.lab_analytes a WHERE a.id = NEW.lab_analyte_id;
  IF analyte_org IS NULL THEN
    RAISE EXCEPTION 'Invalid lab analyte: analyte % does not exist.', NEW.lab_analyte_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF analyte_org <> NEW.org_id THEN
    RAISE EXCEPTION 'Cross-organisation reference: lab analyte % belongs to a different organisation.', NEW.lab_analyte_id
      USING ERRCODE = 'raise_exception';
  END IF;

  IF NEW.supersedes_id IS NOT NULL THEN
    SELECT s.org_id INTO supersede_org FROM public.lab_specifications s WHERE s.id = NEW.supersedes_id;
    IF supersede_org IS NULL THEN
      RAISE EXCEPTION 'Invalid superseded specification: % does not exist.', NEW.supersedes_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF supersede_org <> NEW.org_id THEN
      RAISE EXCEPTION 'Cross-organisation reference: specification % belongs to a different organisation.', NEW.supersedes_id
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS lab_specifications_org_integrity ON public.lab_specifications;
CREATE TRIGGER lab_specifications_org_integrity
  BEFORE INSERT OR UPDATE ON public.lab_specifications
  FOR EACH ROW EXECUTE FUNCTION public.validate_lab_specification_org_integrity();

-- ============================================================
-- 5. ROW LEVEL SECURITY
-- SELECT: any org member. INSERT/UPDATE: OWNER/ADMIN/CELLAR (has_org_role),
-- owner_id = auth.uid() on insert. NO DELETE policy — specs are retired via
-- is_active/effective_to, never hard-deleted. Mirrors lab_analytes (027).
-- ============================================================
ALTER TABLE public.lab_specifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view organisation lab specifications"
  ON public.lab_specifications FOR SELECT
  USING (public.is_org_member(org_id));

CREATE POLICY "Cellar roles can insert organisation lab specifications"
  ON public.lab_specifications FOR INSERT
  WITH CHECK (
    public.is_org_member(org_id)
    AND owner_id = auth.uid()
    AND public.has_org_role(org_id, ARRAY['OWNER','ADMIN','CELLAR'])
  );

CREATE POLICY "Cellar roles can update organisation lab specifications"
  ON public.lab_specifications FOR UPDATE
  USING (
    public.is_org_member(org_id)
    AND public.has_org_role(org_id, ARRAY['OWNER','ADMIN','CELLAR'])
  )
  WITH CHECK (
    public.is_org_member(org_id)
    AND public.has_org_role(org_id, ARRAY['OWNER','ADMIN','CELLAR'])
  );

-- No DELETE policy: specifications are retired (is_active = false + effective_to),
-- never hard-deleted — historical versions must remain for audit/history.

-- ============================================================
-- 6. TABLE PRIVILEGES FOR THE `authenticated` ROLE
-- SELECT, INSERT, UPDATE only — NO DELETE (grant-level reinforcement of the
-- retire-not-delete rule). RLS still decides which rows are visible/mutable.
-- ============================================================
GRANT SELECT, INSERT, UPDATE ON public.lab_specifications TO authenticated;

-- ============================================================
-- 7. POST-CHANGE VALIDATION (catalog checks). RAISE => rollback.
-- ============================================================
DO $$
DECLARE
  n INTEGER;
  rls_on BOOLEAN;
  is_secdef BOOLEAN;
  cfg TEXT[];
  has_pinned_path BOOLEAN;
BEGIN
  -- Table exists.
  IF to_regclass('public.lab_specifications') IS NULL THEN
    RAISE EXCEPTION 'Post-check: lab_specifications not created.' USING ERRCODE='raise_exception';
  END IF;

  -- All 18 columns present.
  SELECT COUNT(*) INTO n FROM information_schema.columns
  WHERE table_schema='public' AND table_name='lab_specifications'
    AND column_name IN ('id','org_id','owner_id','lab_analyte_id','sample_type','name',
                        'min_value','max_value','target_value','unit','effective_from',
                        'effective_to','is_active','supersedes_id','notes','created_at','updated_at');
  IF n <> 17 THEN RAISE EXCEPTION 'Post-check: lab_specifications columns mismatch (found %).', n USING ERRCODE='raise_exception'; END IF;

  -- NOT NULL columns.
  SELECT COUNT(*) INTO n FROM information_schema.columns
  WHERE table_schema='public' AND table_name='lab_specifications' AND is_nullable='NO'
    AND column_name IN ('id','org_id','owner_id','lab_analyte_id','sample_type','name',
                        'unit','effective_from','is_active','created_at','updated_at');
  IF n <> 11 THEN RAISE EXCEPTION 'Post-check: lab_specifications NOT NULL columns mismatch (found %).', n USING ERRCODE='raise_exception'; END IF;

  -- Nullable columns must remain nullable.
  SELECT COUNT(*) INTO n FROM information_schema.columns
  WHERE table_schema='public' AND table_name='lab_specifications' AND is_nullable='YES'
    AND column_name IN ('min_value','max_value','target_value','effective_to','supersedes_id','notes');
  IF n <> 6 THEN RAISE EXCEPTION 'Post-check: lab_specifications nullable columns mismatch (found %).', n USING ERRCODE='raise_exception'; END IF;

  -- Four foreign keys.
  SELECT COUNT(*) INTO n FROM information_schema.table_constraints
  WHERE table_schema='public' AND table_name='lab_specifications' AND constraint_type='FOREIGN KEY';
  IF n <> 4 THEN RAISE EXCEPTION 'Post-check: lab_specifications should have 4 FKs (found %).', n USING ERRCODE='raise_exception'; END IF;

  -- All FKs RESTRICT / NO ACTION (no cascade), including the self-reference.
  SELECT COUNT(*) INTO n FROM information_schema.referential_constraints rc
  JOIN information_schema.table_constraints tc
    ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema
  WHERE tc.table_schema='public' AND tc.table_name='lab_specifications'
    AND rc.delete_rule NOT IN ('NO ACTION','RESTRICT');
  IF n <> 0 THEN RAISE EXCEPTION 'Post-check: all lab_specifications FKs must be RESTRICT/NO ACTION (found % violating).', n USING ERRCODE='raise_exception'; END IF;

  -- CHECK constraints present.
  SELECT COUNT(*) INTO n FROM pg_constraint
  WHERE conrelid='public.lab_specifications'::regclass AND contype='c'
    AND conname IN ('lab_specifications_name_not_blank','lab_specifications_unit_not_blank',
                    'lab_specifications_sample_type_check','lab_specifications_has_value',
                    'lab_specifications_min_le_max','lab_specifications_no_self_supersede');
  IF n <> 6 THEN RAISE EXCEPTION 'Post-check: lab_specifications CHECK constraints missing (found %).', n USING ERRCODE='raise_exception'; END IF;

  -- Partial unique current-spec index present.
  SELECT COUNT(*) INTO n FROM pg_indexes
  WHERE schemaname='public' AND tablename='lab_specifications' AND indexname='uq_lab_specifications_current';
  IF n <> 1 THEN RAISE EXCEPTION 'Post-check: uq_lab_specifications_current missing.' USING ERRCODE='raise_exception'; END IF;
  -- Confirm it really is partial (WHERE is_active ... effective_to IS NULL).
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND tablename='lab_specifications' AND indexname='uq_lab_specifications_current'
      AND indexdef ILIKE '%where%' AND indexdef ILIKE '%is_active%' AND indexdef ILIKE '%effective_to%'
  ) THEN
    RAISE EXCEPTION 'Post-check: uq_lab_specifications_current must be partial on is_active/effective_to.' USING ERRCODE='raise_exception';
  END IF;

  -- Supporting indexes present.
  SELECT COUNT(*) INTO n FROM pg_indexes
  WHERE schemaname='public' AND tablename='lab_specifications'
    AND indexname IN ('idx_lab_specifications_org_id','idx_lab_specifications_owner_id',
                      'idx_lab_specifications_analyte_id','idx_lab_specifications_sample_type',
                      'idx_lab_specifications_is_active','idx_lab_specifications_supersedes_id',
                      'idx_lab_specifications_lookup','idx_lab_specifications_effective');
  IF n <> 8 THEN RAISE EXCEPTION 'Post-check: lab_specifications supporting indexes missing (found %).', n USING ERRCODE='raise_exception'; END IF;

  -- RLS enabled.
  SELECT relrowsecurity INTO rls_on FROM pg_class WHERE oid='public.lab_specifications'::regclass;
  IF NOT COALESCE(rls_on,false) THEN RAISE EXCEPTION 'Post-check: RLS not enabled on lab_specifications.' USING ERRCODE='raise_exception'; END IF;

  -- Exactly three policies (SELECT/INSERT/UPDATE), NO DELETE policy.
  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='lab_specifications';
  IF n <> 3 THEN RAISE EXCEPTION 'Post-check: lab_specifications has % policies (expected 3).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='lab_specifications' AND cmd='DELETE';
  IF n <> 0 THEN RAISE EXCEPTION 'Post-check: lab_specifications must have no DELETE policy (found %).', n USING ERRCODE='raise_exception'; END IF;
  -- Confirm the SELECT/INSERT/UPDATE policies each exist.
  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='lab_specifications' AND cmd IN ('SELECT','INSERT','UPDATE');
  IF n <> 3 THEN RAISE EXCEPTION 'Post-check: lab_specifications must have SELECT/INSERT/UPDATE policies (found %).', n USING ERRCODE='raise_exception'; END IF;

  -- authenticated grants: SELECT/INSERT/UPDATE yes, DELETE no.
  IF NOT (has_table_privilege('authenticated','public.lab_specifications','SELECT')
          AND has_table_privilege('authenticated','public.lab_specifications','INSERT')
          AND has_table_privilege('authenticated','public.lab_specifications','UPDATE')) THEN
    RAISE EXCEPTION 'Post-check: authenticated must have SELECT/INSERT/UPDATE on lab_specifications.' USING ERRCODE='raise_exception';
  END IF;
  IF has_table_privilege('authenticated','public.lab_specifications','DELETE') THEN
    RAISE EXCEPTION 'Post-check: authenticated must NOT have DELETE on lab_specifications.' USING ERRCODE='raise_exception';
  END IF;

  -- Triggers present: owner immutability, updated_at, cross-org integrity.
  SELECT COUNT(*) INTO n FROM pg_trigger
  WHERE tgrelid='public.lab_specifications'::regclass AND NOT tgisinternal
    AND tgname IN ('lab_specifications_owner_id_immutable','lab_specifications_updated_at','lab_specifications_org_integrity');
  IF n <> 3 THEN RAISE EXCEPTION 'Post-check: lab_specifications triggers missing (found %).', n USING ERRCODE='raise_exception'; END IF;

  -- Integrity function exists, is SECURITY DEFINER, and pins search_path.
  IF to_regprocedure('public.validate_lab_specification_org_integrity()') IS NULL THEN
    RAISE EXCEPTION 'Post-check: validate_lab_specification_org_integrity() missing.' USING ERRCODE='raise_exception';
  END IF;
  SELECT prosecdef INTO is_secdef FROM pg_proc WHERE oid='public.validate_lab_specification_org_integrity()'::regprocedure;
  IF NOT COALESCE(is_secdef,false) THEN
    RAISE EXCEPTION 'Post-check: validate_lab_specification_org_integrity() must be SECURITY DEFINER.' USING ERRCODE='raise_exception';
  END IF;
  SELECT proconfig INTO cfg FROM pg_proc WHERE oid='public.validate_lab_specification_org_integrity()'::regprocedure;
  has_pinned_path := EXISTS (
    SELECT 1 FROM unnest(COALESCE(cfg, ARRAY[]::TEXT[])) AS c
    WHERE c LIKE 'search_path=%' AND position('public' IN c) > 0 AND position('pg_temp' IN c) > 0
  );
  IF NOT has_pinned_path THEN
    RAISE EXCEPTION 'Post-check: validate_lab_specification_org_integrity() must SET search_path = public, pg_temp (found %).', cfg USING ERRCODE='raise_exception';
  END IF;

  -- Table starts empty (no backfill).
  SELECT COUNT(*) INTO n FROM public.lab_specifications;
  IF n <> 0 THEN RAISE EXCEPTION 'Post-check: lab_specifications must start empty (found % rows).', n USING ERRCODE='raise_exception'; END IF;
END $$;

COMMIT;
