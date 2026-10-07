-- ============================================================
-- WINERIX — P2J: Cellar Quality & Laboratory (foundation)
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- Depends on: 001 (update_updated_at), 006 (organisations, is_org_member,
--             has_org_role), 010 (prevent_owner_id_change), 018 (wine_lots)
--
-- PURPOSE:
--   Add the laboratory / quality layer as a NORMALISED Sample -> Measurement
--   model keyed off an extensible, org-scoped analyte catalog. Extends the
--   traceability chain:
--     ... -> Wine Lot -> Lab Sample -> Lab Measurement (per analyte)
--
--   Three tables:
--     * lab_analytes      — org-scoped catalog of measurable quantities
--                           (pH, TA, VA, free SO2, ...). Extensible at runtime;
--                           NOT a database enum. Soft-deletable via is_active.
--     * lab_samples       — a sample drawn from a wine lot at a point in time;
--                           carries review/quality status. Mutable (review
--                           metadata is expected to change).
--     * lab_measurements  — one row per analyte reading on a sample.
--                           APPEND-ONLY: corrections are new rows, never UPDATE
--                           or DELETE. unit is stored as a SNAPSHOT at write
--                           time (historical immutability — a later change to
--                           the analyte's canonical unit must not rewrite past
--                           readings).
--
-- SCOPE — THIS MIGRATION ONLY:
--   Creates the three tables + FKs + indexes + CHECKs + org-based RLS with
--   role-scoped writes (OWNER/ADMIN/CELLAR via has_org_role) + owner_id
--   immutability + updated_at (on the two mutable tables) + SECURITY DEFINER
--   cross-organisation / cross-reference integrity triggers + grants.
--   No backfill. No seed catalog (analytes are added on demand).
--
-- THIS MIGRATION DOES NOT:
--   * add a stored wine_lots.quality_status column (quality is DERIVED from
--     lab_samples; a stored column would be a competing source of truth)
--   * create specifications / spec-limits / certificate-of-analysis (CoA)
--     tables — designed-for but DEFERRED beyond P2J
--   * claim or implement SAWIS / SARS / DALRRD integration
--   * duplicate any lineage derivable through wine_lots (batch / intake /
--     harvest / planting / cultivar / block / vineyard)
--   * wire the audit log (that is 028_lab_audit_wiring.sql)
--   * add any UI / service / src change
--   * modify any existing table, policy, grant, trigger, or function
--   * seed / backfill any data
--
-- APPEND-ONLY ENFORCEMENT: lab_measurements has SELECT + INSERT policies ONLY
--   (no UPDATE / DELETE policy) AND the authenticated grant is SELECT, INSERT
--   ONLY. A correction is a new measurement row.
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
  IF to_regclass('public.wine_lots') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.wine_lots is missing (run 018 first).' USING ERRCODE = 'undefined_table';
  END IF;
  IF to_regclass('public.lab_analytes') IS NOT NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.lab_analytes already exists.' USING ERRCODE = 'duplicate_table';
  END IF;
  IF to_regclass('public.lab_samples') IS NOT NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.lab_samples already exists.' USING ERRCODE = 'duplicate_table';
  END IF;
  IF to_regclass('public.lab_measurements') IS NOT NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.lab_measurements already exists.' USING ERRCODE = 'duplicate_table';
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
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='wine_lots' AND column_name='org_id'
  ) THEN
    RAISE EXCEPTION 'Pre-flight failed: wine_lots.org_id is missing (run 018 first).' USING ERRCODE = 'undefined_column';
  END IF;
END $$;

-- ============================================================
-- 1. LAB_ANALYTES — org-scoped, extensible catalog
-- The set of measurable quantities an organisation tracks. Added on demand;
-- never a database enum. canonical_unit is the organisation's default unit for
-- the analyte (snapshotted onto each measurement at write time). code is the
-- stable per-org identifier (e.g. 'pH', 'TA'); display_name is human text.
-- Soft-delete via is_active (RESTRICT FKs mean a referenced analyte cannot be
-- hard-deleted; is_active hides it from new sample entry).
-- ============================================================
CREATE TABLE IF NOT EXISTS public.lab_analytes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL,
  owner_id        UUID NOT NULL,
  code            TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  canonical_unit  TEXT NOT NULL,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_lab_analytes_org
    FOREIGN KEY (org_id) REFERENCES public.organisations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_lab_analytes_owner
    FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE RESTRICT,

  CONSTRAINT lab_analytes_code_not_blank
    CHECK (length(btrim(code)) > 0),
  CONSTRAINT lab_analytes_display_name_not_blank
    CHECK (length(btrim(display_name)) > 0),
  -- canonical_unit is the analyte's default unit; it must exist and be non-blank.
  CONSTRAINT lab_analytes_canonical_unit_not_blank
    CHECK (length(btrim(canonical_unit)) > 0)
);

-- code is unique WITHIN an organisation (never globally), CASE-INSENSITIVELY —
-- 'pH', 'ph' and 'PH' must not coexist in the same organisation.
CREATE UNIQUE INDEX IF NOT EXISTS uq_lab_analytes_org_code
  ON public.lab_analytes(org_id, lower(code));

CREATE INDEX IF NOT EXISTS idx_lab_analytes_org_id    ON public.lab_analytes(org_id);
CREATE INDEX IF NOT EXISTS idx_lab_analytes_owner_id  ON public.lab_analytes(owner_id);
CREATE INDEX IF NOT EXISTS idx_lab_analytes_is_active ON public.lab_analytes(is_active);

-- ============================================================
-- 2. LAB_SAMPLES — a sample drawn from a wine lot
-- Parent of measurements. Mutable: review/quality metadata is expected to
-- change (status transitions, reviewer, review notes).
--   sample_type = the PURPOSE / PROCESS STAGE of the sample (WHEN/WHY it was
--     drawn in the cellar workflow). Physical/container context (tank, barrel,
--     bottle) is NOT stored here — it is derived from vessel/placement history.
--   status      = the sample's QUALITY / REVIEW STATE.
-- Both are controlled vocabularies (CHECK, not enum, so future values are a
-- one-line migration without a type rewrite). 'other' is the sample_type
-- extensibility escape hatch. Lot-level quality is DERIVED from these sample
-- statuses; there is NO stored wine_lots.quality_status.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.lab_samples (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL,
  owner_id        UUID NOT NULL,
  wine_lot_id     UUID NOT NULL,
  sample_code     TEXT,
  sample_type     TEXT NOT NULL DEFAULT 'fermentation',
  status          TEXT NOT NULL DEFAULT 'pending',
  sampled_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_by     UUID,
  reviewed_at     TIMESTAMPTZ,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_lab_samples_org
    FOREIGN KEY (org_id) REFERENCES public.organisations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_lab_samples_owner
    FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE RESTRICT,
  -- Every sample belongs to exactly one lot; RESTRICT protects sample history.
  CONSTRAINT fk_lab_samples_wine_lot
    FOREIGN KEY (wine_lot_id) REFERENCES public.wine_lots(id) ON DELETE RESTRICT,
  CONSTRAINT fk_lab_samples_reviewed_by
    FOREIGN KEY (reviewed_by) REFERENCES auth.users(id) ON DELETE RESTRICT,

  CONSTRAINT lab_samples_type_check
    CHECK (sample_type IN ('fermentation','maturation','pre_filtration','pre_bottling','release','other')),
  CONSTRAINT lab_samples_status_check
    CHECK (status IN ('pending','within_spec','attention','hold','released'))
);

-- sample_code (when set) is unique WITHIN an organisation.
CREATE UNIQUE INDEX IF NOT EXISTS uq_lab_samples_org_sample_code
  ON public.lab_samples(org_id, sample_code)
  WHERE sample_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_lab_samples_org_id      ON public.lab_samples(org_id);
CREATE INDEX IF NOT EXISTS idx_lab_samples_owner_id    ON public.lab_samples(owner_id);
CREATE INDEX IF NOT EXISTS idx_lab_samples_wine_lot_id ON public.lab_samples(wine_lot_id);
CREATE INDEX IF NOT EXISTS idx_lab_samples_status      ON public.lab_samples(status);
CREATE INDEX IF NOT EXISTS idx_lab_samples_sampled_at  ON public.lab_samples(sampled_at);

-- ============================================================
-- 3. LAB_MEASUREMENTS — one analyte reading per row (APPEND-ONLY)
-- value_numeric is the measured value; unit is a SNAPSHOT of the analyte's unit
-- at write time (deliberate denormalisation for historical immutability). A
-- correction is a NEW row, never an UPDATE/DELETE — enforced by policy + grant
-- (SELECT + INSERT only) and by the absence of updated_at.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.lab_measurements (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL,
  owner_id        UUID NOT NULL,
  lab_sample_id   UUID NOT NULL,
  lab_analyte_id  UUID NOT NULL,
  value_numeric   NUMERIC,
  value_text      TEXT,
  unit            TEXT NOT NULL,
  measured_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_lab_measurements_org
    FOREIGN KEY (org_id) REFERENCES public.organisations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_lab_measurements_owner
    FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_lab_measurements_sample
    FOREIGN KEY (lab_sample_id) REFERENCES public.lab_samples(id) ON DELETE RESTRICT,
  CONSTRAINT fk_lab_measurements_analyte
    FOREIGN KEY (lab_analyte_id) REFERENCES public.lab_analytes(id) ON DELETE RESTRICT,

  -- A measurement must carry at least one value (numeric or text).
  CONSTRAINT lab_measurements_has_value
    CHECK (value_numeric IS NOT NULL OR length(btrim(COALESCE(value_text, ''))) > 0),
  -- The historical unit snapshot must exist and be non-blank.
  CONSTRAINT lab_measurements_unit_not_blank
    CHECK (length(btrim(unit)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_lab_measurements_org_id     ON public.lab_measurements(org_id);
CREATE INDEX IF NOT EXISTS idx_lab_measurements_owner_id   ON public.lab_measurements(owner_id);
CREATE INDEX IF NOT EXISTS idx_lab_measurements_sample_id  ON public.lab_measurements(lab_sample_id);
CREATE INDEX IF NOT EXISTS idx_lab_measurements_analyte_id ON public.lab_measurements(lab_analyte_id);
-- Supports "latest reading per analyte on a sample" queries over the history.
CREATE INDEX IF NOT EXISTS idx_lab_measurements_sample_analyte_time
  ON public.lab_measurements(lab_sample_id, lab_analyte_id, measured_at DESC);

-- ============================================================
-- 4. OWNER_ID IMMUTABILITY (reuse 010) — on all three tables
-- ============================================================
DROP TRIGGER IF EXISTS lab_analytes_owner_id_immutable ON public.lab_analytes;
CREATE TRIGGER lab_analytes_owner_id_immutable
  BEFORE UPDATE ON public.lab_analytes
  FOR EACH ROW EXECUTE FUNCTION public.prevent_owner_id_change();

DROP TRIGGER IF EXISTS lab_samples_owner_id_immutable ON public.lab_samples;
CREATE TRIGGER lab_samples_owner_id_immutable
  BEFORE UPDATE ON public.lab_samples
  FOR EACH ROW EXECUTE FUNCTION public.prevent_owner_id_change();

-- lab_measurements is append-only (no UPDATE path), so no owner-immutability
-- trigger is required there.

-- ============================================================
-- 5. UPDATED_AT (reuse 001) — on the two MUTABLE tables only
-- lab_measurements has no updated_at (append-only).
-- ============================================================
DROP TRIGGER IF EXISTS lab_analytes_updated_at ON public.lab_analytes;
CREATE TRIGGER lab_analytes_updated_at
  BEFORE UPDATE ON public.lab_analytes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS lab_samples_updated_at ON public.lab_samples;
CREATE TRIGGER lab_samples_updated_at
  BEFORE UPDATE ON public.lab_samples
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ============================================================
-- 6. CROSS-ORGANISATION / CROSS-REFERENCE INTEGRITY (DB-enforced)
-- SECURITY DEFINER so the checks read referenced tables regardless of RLS;
-- pinned search_path; static SQL. Mirrors validate_wine_lot_org_integrity (018).
-- ============================================================

-- 6a. lab_samples: referenced wine_lot must exist and be same-org.
CREATE OR REPLACE FUNCTION public.validate_lab_sample_org_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  lot_org UUID;
BEGIN
  SELECT wl.org_id INTO lot_org FROM public.wine_lots wl WHERE wl.id = NEW.wine_lot_id;
  IF lot_org IS NULL THEN
    RAISE EXCEPTION 'Invalid wine lot: lot % does not exist.', NEW.wine_lot_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF lot_org <> NEW.org_id THEN
    RAISE EXCEPTION 'Cross-organisation reference: wine lot % belongs to a different organisation.', NEW.wine_lot_id
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS lab_samples_org_integrity ON public.lab_samples;
CREATE TRIGGER lab_samples_org_integrity
  BEFORE INSERT OR UPDATE ON public.lab_samples
  FOR EACH ROW EXECUTE FUNCTION public.validate_lab_sample_org_integrity();

-- 6b. lab_measurements: referenced sample AND analyte must exist and be same-org.
CREATE OR REPLACE FUNCTION public.validate_lab_measurement_org_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  sample_org  UUID;
  analyte_org UUID;
BEGIN
  SELECT s.org_id INTO sample_org FROM public.lab_samples s WHERE s.id = NEW.lab_sample_id;
  IF sample_org IS NULL THEN
    RAISE EXCEPTION 'Invalid lab sample: sample % does not exist.', NEW.lab_sample_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF sample_org <> NEW.org_id THEN
    RAISE EXCEPTION 'Cross-organisation reference: lab sample % belongs to a different organisation.', NEW.lab_sample_id
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT a.org_id INTO analyte_org FROM public.lab_analytes a WHERE a.id = NEW.lab_analyte_id;
  IF analyte_org IS NULL THEN
    RAISE EXCEPTION 'Invalid lab analyte: analyte % does not exist.', NEW.lab_analyte_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF analyte_org <> NEW.org_id THEN
    RAISE EXCEPTION 'Cross-organisation reference: lab analyte % belongs to a different organisation.', NEW.lab_analyte_id
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$;

-- INSERT only — lab_measurements is append-only.
DROP TRIGGER IF EXISTS lab_measurements_org_integrity ON public.lab_measurements;
CREATE TRIGGER lab_measurements_org_integrity
  BEFORE INSERT ON public.lab_measurements
  FOR EACH ROW EXECUTE FUNCTION public.validate_lab_measurement_org_integrity();

-- ============================================================
-- 7. ROW LEVEL SECURITY
-- SELECT: any org member. WRITE: OWNER/ADMIN/CELLAR (has_org_role), owner_id =
-- auth.uid(). lab_analytes + lab_samples are mutable via SELECT/INSERT/UPDATE
-- policies only — NO DELETE policy (analytes retire via is_active, samples keep
-- their history). lab_measurements is APPEND-ONLY (SELECT + INSERT only — no
-- UPDATE/DELETE policy).
-- ============================================================

-- ---- 7a. lab_analytes --------------------------------------------------------
ALTER TABLE public.lab_analytes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view organisation lab analytes"
  ON public.lab_analytes FOR SELECT
  USING (public.is_org_member(org_id));

CREATE POLICY "Cellar roles can insert organisation lab analytes"
  ON public.lab_analytes FOR INSERT
  WITH CHECK (
    public.is_org_member(org_id)
    AND owner_id = auth.uid()
    AND public.has_org_role(org_id, ARRAY['OWNER','ADMIN','CELLAR'])
  );

CREATE POLICY "Cellar roles can update organisation lab analytes"
  ON public.lab_analytes FOR UPDATE
  USING (
    public.is_org_member(org_id)
    AND public.has_org_role(org_id, ARRAY['OWNER','ADMIN','CELLAR'])
  )
  WITH CHECK (
    public.is_org_member(org_id)
    AND public.has_org_role(org_id, ARRAY['OWNER','ADMIN','CELLAR'])
  );

-- No DELETE policy: analytes are retired via is_active = false (soft-delete),
-- never hard-deleted (RESTRICT FKs would block it anyway).

-- ---- 7b. lab_samples ---------------------------------------------------------
ALTER TABLE public.lab_samples ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view organisation lab samples"
  ON public.lab_samples FOR SELECT
  USING (public.is_org_member(org_id));

CREATE POLICY "Cellar roles can insert organisation lab samples"
  ON public.lab_samples FOR INSERT
  WITH CHECK (
    public.is_org_member(org_id)
    AND owner_id = auth.uid()
    AND public.has_org_role(org_id, ARRAY['OWNER','ADMIN','CELLAR'])
  );

CREATE POLICY "Cellar roles can update organisation lab samples"
  ON public.lab_samples FOR UPDATE
  USING (
    public.is_org_member(org_id)
    AND public.has_org_role(org_id, ARRAY['OWNER','ADMIN','CELLAR'])
  )
  WITH CHECK (
    public.is_org_member(org_id)
    AND public.has_org_role(org_id, ARRAY['OWNER','ADMIN','CELLAR'])
  );

-- No DELETE policy: samples carry quality/review history and are not deleted
-- (RESTRICT FKs from lab_measurements would block it anyway).

-- ---- 7c. lab_measurements (APPEND-ONLY: SELECT + INSERT policies only) -------
ALTER TABLE public.lab_measurements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view organisation lab measurements"
  ON public.lab_measurements FOR SELECT
  USING (public.is_org_member(org_id));

CREATE POLICY "Cellar roles can insert organisation lab measurements"
  ON public.lab_measurements FOR INSERT
  WITH CHECK (
    public.is_org_member(org_id)
    AND owner_id = auth.uid()
    AND public.has_org_role(org_id, ARRAY['OWNER','ADMIN','CELLAR'])
  );

-- No UPDATE policy and no DELETE policy: corrections are new rows.

-- ============================================================
-- 8. TABLE PRIVILEGES FOR THE `authenticated` ROLE
-- RLS still decides which rows are visible/mutable (see 016 for why explicit
-- grants are required on manually-provisioned projects). lab_measurements is
-- SELECT, INSERT only — the grant itself enforces append-only in addition to
-- the policy set.
-- ============================================================
-- lab_analytes / lab_samples: SELECT, INSERT, UPDATE only — no DELETE
-- (analytes retire via is_active; samples keep their quality/review history).
GRANT SELECT, INSERT, UPDATE ON public.lab_analytes TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.lab_samples  TO authenticated;
GRANT SELECT, INSERT         ON public.lab_measurements TO authenticated;

-- ============================================================
-- 9. POST-CHANGE VALIDATION (catalog checks). RAISE => rollback.
-- ============================================================
DO $$
DECLARE
  n INTEGER;
  rls_on BOOLEAN;
  priv_update BOOLEAN;
  priv_delete BOOLEAN;
BEGIN
  -- Tables exist.
  IF to_regclass('public.lab_analytes') IS NULL THEN RAISE EXCEPTION 'Post-check: lab_analytes not created.' USING ERRCODE='raise_exception'; END IF;
  IF to_regclass('public.lab_samples') IS NULL THEN RAISE EXCEPTION 'Post-check: lab_samples not created.' USING ERRCODE='raise_exception'; END IF;
  IF to_regclass('public.lab_measurements') IS NULL THEN RAISE EXCEPTION 'Post-check: lab_measurements not created.' USING ERRCODE='raise_exception'; END IF;

  -- Column counts.
  SELECT COUNT(*) INTO n FROM information_schema.columns
  WHERE table_schema='public' AND table_name='lab_analytes'
    AND column_name IN ('id','org_id','owner_id','code','display_name','canonical_unit','is_active','notes','created_at','updated_at');
  IF n <> 10 THEN RAISE EXCEPTION 'Post-check: lab_analytes columns mismatch (found %).', n USING ERRCODE='raise_exception'; END IF;

  SELECT COUNT(*) INTO n FROM information_schema.columns
  WHERE table_schema='public' AND table_name='lab_samples'
    AND column_name IN ('id','org_id','owner_id','wine_lot_id','sample_code','sample_type','status','sampled_at','reviewed_by','reviewed_at','notes','created_at','updated_at');
  IF n <> 13 THEN RAISE EXCEPTION 'Post-check: lab_samples columns mismatch (found %).', n USING ERRCODE='raise_exception'; END IF;

  SELECT COUNT(*) INTO n FROM information_schema.columns
  WHERE table_schema='public' AND table_name='lab_measurements'
    AND column_name IN ('id','org_id','owner_id','lab_sample_id','lab_analyte_id','value_numeric','value_text','unit','measured_at','notes','created_at');
  IF n <> 11 THEN RAISE EXCEPTION 'Post-check: lab_measurements columns mismatch (found %).', n USING ERRCODE='raise_exception'; END IF;

  -- lab_measurements must NOT have updated_at (append-only).
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='lab_measurements' AND column_name='updated_at') THEN
    RAISE EXCEPTION 'Post-check: lab_measurements must not have updated_at (append-only).' USING ERRCODE='raise_exception';
  END IF;

  -- FK counts.
  SELECT COUNT(*) INTO n FROM information_schema.table_constraints
  WHERE table_schema='public' AND table_name='lab_analytes' AND constraint_type='FOREIGN KEY';
  IF n <> 2 THEN RAISE EXCEPTION 'Post-check: lab_analytes should have 2 FKs (found %).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM information_schema.table_constraints
  WHERE table_schema='public' AND table_name='lab_samples' AND constraint_type='FOREIGN KEY';
  IF n <> 4 THEN RAISE EXCEPTION 'Post-check: lab_samples should have 4 FKs (found %).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM information_schema.table_constraints
  WHERE table_schema='public' AND table_name='lab_measurements' AND constraint_type='FOREIGN KEY';
  IF n <> 4 THEN RAISE EXCEPTION 'Post-check: lab_measurements should have 4 FKs (found %).', n USING ERRCODE='raise_exception'; END IF;

  -- All FKs RESTRICT / NO ACTION (no cascade).
  SELECT COUNT(*) INTO n FROM information_schema.referential_constraints rc
  JOIN information_schema.table_constraints tc
    ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema
  WHERE tc.table_schema='public'
    AND tc.table_name IN ('lab_analytes','lab_samples','lab_measurements')
    AND rc.delete_rule NOT IN ('NO ACTION','RESTRICT');
  IF n <> 0 THEN RAISE EXCEPTION 'Post-check: all lab FKs must be RESTRICT/NO ACTION (found % violating).', n USING ERRCODE='raise_exception'; END IF;

  -- CHECK constraints present.
  SELECT COUNT(*) INTO n FROM information_schema.table_constraints
  WHERE table_schema='public' AND table_name='lab_samples' AND constraint_type='CHECK'
    AND constraint_name IN ('lab_samples_type_check','lab_samples_status_check');
  IF n <> 2 THEN RAISE EXCEPTION 'Post-check: lab_samples CHECK constraints missing (found %).', n USING ERRCODE='raise_exception'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='lab_measurements_has_value' AND conrelid='public.lab_measurements'::regclass) THEN
    RAISE EXCEPTION 'Post-check: lab_measurements_has_value CHECK missing.' USING ERRCODE='raise_exception';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='lab_analytes_canonical_unit_not_blank' AND conrelid='public.lab_analytes'::regclass) THEN
    RAISE EXCEPTION 'Post-check: lab_analytes_canonical_unit_not_blank CHECK missing.' USING ERRCODE='raise_exception';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='lab_measurements_unit_not_blank' AND conrelid='public.lab_measurements'::regclass) THEN
    RAISE EXCEPTION 'Post-check: lab_measurements_unit_not_blank CHECK missing.' USING ERRCODE='raise_exception';
  END IF;

  -- canonical_unit and measurement unit must be NOT NULL (required snapshots).
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='lab_analytes' AND column_name='canonical_unit' AND is_nullable='YES') THEN
    RAISE EXCEPTION 'Post-check: lab_analytes.canonical_unit must be NOT NULL.' USING ERRCODE='raise_exception';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='lab_measurements' AND column_name='unit' AND is_nullable='YES') THEN
    RAISE EXCEPTION 'Post-check: lab_measurements.unit must be NOT NULL.' USING ERRCODE='raise_exception';
  END IF;

  -- Unique indexes present.
  SELECT COUNT(*) INTO n FROM pg_indexes WHERE schemaname='public' AND tablename='lab_analytes' AND indexname='uq_lab_analytes_org_code';
  IF n <> 1 THEN RAISE EXCEPTION 'Post-check: uq_lab_analytes_org_code missing.' USING ERRCODE='raise_exception'; END IF;
  -- The analyte uniqueness index must be CASE-INSENSITIVE (expression index on lower(code)).
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND tablename='lab_analytes' AND indexname='uq_lab_analytes_org_code'
      AND indexdef ILIKE '%lower(code)%'
  ) THEN
    RAISE EXCEPTION 'Post-check: uq_lab_analytes_org_code must be case-insensitive (lower(code)).' USING ERRCODE='raise_exception';
  END IF;
  SELECT COUNT(*) INTO n FROM pg_indexes WHERE schemaname='public' AND tablename='lab_samples' AND indexname='uq_lab_samples_org_sample_code';
  IF n <> 1 THEN RAISE EXCEPTION 'Post-check: uq_lab_samples_org_sample_code missing.' USING ERRCODE='raise_exception'; END IF;

  -- RLS enabled on all three.
  FOR n IN
    SELECT 1 FROM unnest(ARRAY['lab_analytes','lab_samples','lab_measurements']) t
  LOOP NULL; END LOOP;
  SELECT relrowsecurity INTO rls_on FROM pg_class WHERE oid='public.lab_analytes'::regclass;
  IF NOT COALESCE(rls_on,false) THEN RAISE EXCEPTION 'Post-check: RLS not enabled on lab_analytes.' USING ERRCODE='raise_exception'; END IF;
  SELECT relrowsecurity INTO rls_on FROM pg_class WHERE oid='public.lab_samples'::regclass;
  IF NOT COALESCE(rls_on,false) THEN RAISE EXCEPTION 'Post-check: RLS not enabled on lab_samples.' USING ERRCODE='raise_exception'; END IF;
  SELECT relrowsecurity INTO rls_on FROM pg_class WHERE oid='public.lab_measurements'::regclass;
  IF NOT COALESCE(rls_on,false) THEN RAISE EXCEPTION 'Post-check: RLS not enabled on lab_measurements.' USING ERRCODE='raise_exception'; END IF;

  -- Policy counts: 3 on each mutable table (SELECT/INSERT/UPDATE, NO DELETE),
  -- exactly 2 on append-only measurements (SELECT/INSERT).
  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='lab_analytes';
  IF n <> 3 THEN RAISE EXCEPTION 'Post-check: lab_analytes has % policies (expected 3 — no DELETE).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='lab_samples';
  IF n <> 3 THEN RAISE EXCEPTION 'Post-check: lab_samples has % policies (expected 3 — no DELETE).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='lab_measurements';
  IF n <> 2 THEN RAISE EXCEPTION 'Post-check: lab_measurements has % policies (expected 2 — append-only).', n USING ERRCODE='raise_exception'; END IF;

  -- lab_analytes must have NO DELETE policy (soft-delete via is_active).
  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='lab_analytes' AND cmd='DELETE';
  IF n <> 0 THEN RAISE EXCEPTION 'Post-check: lab_analytes must have no DELETE policy (found %).', n USING ERRCODE='raise_exception'; END IF;

  -- lab_samples must have NO DELETE policy (history preserved).
  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='lab_samples' AND cmd='DELETE';
  IF n <> 0 THEN RAISE EXCEPTION 'Post-check: lab_samples must have no DELETE policy (found %).', n USING ERRCODE='raise_exception'; END IF;

  -- lab_measurements must have NO UPDATE/DELETE policy.
  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='lab_measurements' AND cmd IN ('UPDATE','DELETE');
  IF n <> 0 THEN RAISE EXCEPTION 'Post-check: lab_measurements must have no UPDATE/DELETE policy (found %).', n USING ERRCODE='raise_exception'; END IF;

  -- authenticated must NOT have DELETE on lab_analytes or lab_samples (grant-level).
  IF has_table_privilege('authenticated','public.lab_analytes','DELETE') THEN
    RAISE EXCEPTION 'Post-check: authenticated must not have DELETE on lab_analytes.' USING ERRCODE='raise_exception';
  END IF;
  IF has_table_privilege('authenticated','public.lab_samples','DELETE') THEN
    RAISE EXCEPTION 'Post-check: authenticated must not have DELETE on lab_samples.' USING ERRCODE='raise_exception';
  END IF;
  -- authenticated SHOULD retain SELECT/INSERT/UPDATE on the two mutable tables.
  IF NOT (has_table_privilege('authenticated','public.lab_analytes','SELECT')
          AND has_table_privilege('authenticated','public.lab_analytes','INSERT')
          AND has_table_privilege('authenticated','public.lab_analytes','UPDATE')) THEN
    RAISE EXCEPTION 'Post-check: authenticated must have SELECT/INSERT/UPDATE on lab_analytes.' USING ERRCODE='raise_exception';
  END IF;
  IF NOT (has_table_privilege('authenticated','public.lab_samples','SELECT')
          AND has_table_privilege('authenticated','public.lab_samples','INSERT')
          AND has_table_privilege('authenticated','public.lab_samples','UPDATE')) THEN
    RAISE EXCEPTION 'Post-check: authenticated must have SELECT/INSERT/UPDATE on lab_samples.' USING ERRCODE='raise_exception';
  END IF;

  -- authenticated must NOT have UPDATE/DELETE on lab_measurements (grant-level append-only).
  SELECT has_table_privilege('authenticated','public.lab_measurements','UPDATE') INTO priv_update;
  SELECT has_table_privilege('authenticated','public.lab_measurements','DELETE') INTO priv_delete;
  IF priv_update OR priv_delete THEN
    RAISE EXCEPTION 'Post-check: authenticated must not have UPDATE/DELETE on lab_measurements.' USING ERRCODE='raise_exception';
  END IF;
  IF NOT has_table_privilege('authenticated','public.lab_measurements','INSERT') THEN
    RAISE EXCEPTION 'Post-check: authenticated must have INSERT on lab_measurements.' USING ERRCODE='raise_exception';
  END IF;
  IF NOT has_table_privilege('authenticated','public.lab_measurements','SELECT') THEN
    RAISE EXCEPTION 'Post-check: authenticated must have SELECT on lab_measurements.' USING ERRCODE='raise_exception';
  END IF;

  -- Integrity functions exist and are SECURITY DEFINER.
  IF to_regprocedure('public.validate_lab_sample_org_integrity()') IS NULL THEN
    RAISE EXCEPTION 'Post-check: validate_lab_sample_org_integrity() missing.' USING ERRCODE='raise_exception'; END IF;
  IF to_regprocedure('public.validate_lab_measurement_org_integrity()') IS NULL THEN
    RAISE EXCEPTION 'Post-check: validate_lab_measurement_org_integrity() missing.' USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_proc
  WHERE oid IN (
    'public.validate_lab_sample_org_integrity()'::regprocedure,
    'public.validate_lab_measurement_org_integrity()'::regprocedure
  ) AND prosecdef = true;
  IF n <> 2 THEN RAISE EXCEPTION 'Post-check: both lab integrity functions must be SECURITY DEFINER (found %).', n USING ERRCODE='raise_exception'; END IF;

  -- Triggers present (owner-immutable + updated_at on the two mutable tables;
  -- integrity triggers on samples + measurements).
  SELECT COUNT(*) INTO n FROM pg_trigger WHERE NOT tgisinternal AND tgname IN (
    'lab_analytes_owner_id_immutable','lab_analytes_updated_at',
    'lab_samples_owner_id_immutable','lab_samples_updated_at',
    'lab_samples_org_integrity','lab_measurements_org_integrity'
  );
  IF n <> 6 THEN RAISE EXCEPTION 'Post-check: expected 6 lab triggers (found %).', n USING ERRCODE='raise_exception'; END IF;

  -- measurement integrity trigger fires on INSERT only (append-only). tgtype bit 2 (4)=INSERT, 3 (8)=DELETE, 4 (16)=UPDATE.
  SELECT COUNT(*) INTO n FROM pg_trigger
  WHERE tgrelid='public.lab_measurements'::regclass AND tgname='lab_measurements_org_integrity' AND NOT tgisinternal
    AND (tgtype & 4) <> 0 AND (tgtype & 8) = 0 AND (tgtype & 16) = 0;
  IF n <> 1 THEN RAISE EXCEPTION 'Post-check: lab_measurements_org_integrity must fire on INSERT only.' USING ERRCODE='raise_exception'; END IF;

  -- All three tables start empty (no backfill, no seed).
  SELECT COUNT(*) INTO n FROM public.lab_analytes;
  IF n <> 0 THEN RAISE EXCEPTION 'Post-check: lab_analytes must start empty (found %).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM public.lab_samples;
  IF n <> 0 THEN RAISE EXCEPTION 'Post-check: lab_samples must start empty (found %).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM public.lab_measurements;
  IF n <> 0 THEN RAISE EXCEPTION 'Post-check: lab_measurements must start empty (found %).', n USING ERRCODE='raise_exception'; END IF;
END $$;

COMMIT;
