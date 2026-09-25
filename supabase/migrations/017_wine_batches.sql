-- ============================================================
-- WINERIX — P2D: Wine Batches + Batch↔Grape-Intake linkage (first cellar-production increment)
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- Depends on: 006 (organisations, is_org_member, update_updated_at),
--             010 (prevent_owner_id_change), 014 (grape_intakes)
--
-- PURPOSE:
--   Create public.wine_batches — a production/origin grouping (vintage) — and
--   public.batch_grape_intakes — the many-to-many link recording WHICH grape
--   intakes (and HOW MANY kg of each) contributed to a batch. Extends the
--   traceability chain: Grape Intake -> Wine Batch. Vineyard/block/planting/
--   cultivar/harvest remain DERIVED via the grape intake and are NEVER
--   duplicated here.
--
-- SCOPE — THIS MIGRATION ONLY:
--   Creates wine_batches + batch_grape_intakes + FKs + indexes + CHECKs +
--   org-based RLS + owner_id immutability + updated_at triggers + a
--   cross-organisation integrity trigger on the junction. No backfill.
--
-- THIS MIGRATION DOES NOT:
--   * modify grape_intakes / harvest / plantings / cultivars / any existing table
--   * add wine lot / vessel / vessel placement / lot lineage / blending /
--     production-event / bottling / inventory / audit-wiring tables
--   * duplicate vineyard_id / block_id / planting_id / cultivar_id / harvest_id
--   * store a running wine-litres quantity (Wine Lot handles litres later)
--   * store a running grape-kg quantity on wine_batches (derived via SUM over
--     batch_grape_intakes.contributed_kg)
--   * seed / backfill any data
--
-- INTEGRITY: RLS checks only <table>.org_id; a SECURITY DEFINER trigger
--   additionally guarantees the referenced wine_batch AND grape_intake are
--   same-org (mirrors 012/013/014).
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
  IF to_regclass('public.grape_intakes') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.grape_intakes is missing (run 014 first).' USING ERRCODE = 'undefined_table';
  END IF;
  IF to_regclass('public.wine_batches') IS NOT NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.wine_batches already exists.' USING ERRCODE = 'duplicate_table';
  END IF;
  IF to_regclass('public.batch_grape_intakes') IS NOT NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.batch_grape_intakes already exists.' USING ERRCODE = 'duplicate_table';
  END IF;
  IF to_regprocedure('public.is_org_member(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.is_org_member(uuid) is missing (run 006 first).' USING ERRCODE = 'undefined_function';
  END IF;
  IF to_regprocedure('public.prevent_owner_id_change()') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.prevent_owner_id_change() is missing (run 010 first).' USING ERRCODE = 'undefined_function';
  END IF;
  IF to_regprocedure('public.update_updated_at()') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.update_updated_at() is missing (run 001 first).' USING ERRCODE = 'undefined_function';
  END IF;
  -- grape_intakes must carry org_id for the integrity check.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='grape_intakes' AND column_name='org_id'
  ) THEN
    RAISE EXCEPTION 'Pre-flight failed: grape_intakes.org_id is missing (run 014 first).' USING ERRCODE = 'undefined_column';
  END IF;
END $$;

-- ============================================================
-- 1. WINE_BATCHES TABLE
-- A production/origin grouping. batch_code is the human identity (unique per
-- organisation). vintage is the production/harvest year. No running quantity
-- column — grape contribution is SUM(batch_grape_intakes.contributed_kg).
-- ============================================================
CREATE TABLE IF NOT EXISTS public.wine_batches (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL,
  owner_id    UUID NOT NULL,
  batch_code  TEXT NOT NULL,
  name        TEXT,
  vintage     INTEGER,
  status      TEXT NOT NULL DEFAULT 'planned',
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_wine_batches_org
    FOREIGN KEY (org_id) REFERENCES public.organisations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_wine_batches_owner
    FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE RESTRICT,

  -- batch_code must not be blank.
  CONSTRAINT wine_batches_batch_code_not_blank
    CHECK (length(btrim(batch_code)) > 0),

  -- Sensible vintage window when supplied (viticulture year; generous bounds).
  CONSTRAINT wine_batches_vintage_sensible
    CHECK (vintage IS NULL OR (vintage >= 1900 AND vintage <= 2200)),

  -- Controlled status values (P2D: exactly these four).
  CONSTRAINT wine_batches_status_check
    CHECK (status IN ('planned', 'active', 'closed', 'discarded'))
);

-- batch_code is unique WITHIN an organisation (never globally).
CREATE UNIQUE INDEX IF NOT EXISTS uq_wine_batches_org_batch_code
  ON public.wine_batches(org_id, batch_code);

CREATE INDEX IF NOT EXISTS idx_wine_batches_org_id   ON public.wine_batches(org_id);
CREATE INDEX IF NOT EXISTS idx_wine_batches_owner_id ON public.wine_batches(owner_id);
CREATE INDEX IF NOT EXISTS idx_wine_batches_status   ON public.wine_batches(status);
CREATE INDEX IF NOT EXISTS idx_wine_batches_vintage  ON public.wine_batches(vintage);

-- ============================================================
-- 2. BATCH_GRAPE_INTAKES TABLE (many-to-many junction)
-- Records which grape intakes contributed to a batch and how many kg of each.
-- An intake may contribute to MULTIPLE batches (allowed by design); the same
-- intake may not be linked to the SAME batch twice (UNIQUE below).
-- ============================================================
CREATE TABLE IF NOT EXISTS public.batch_grape_intakes (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL,
  owner_id         UUID NOT NULL,
  wine_batch_id    UUID NOT NULL,
  grape_intake_id  UUID NOT NULL,
  contributed_kg   NUMERIC(12, 2) NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_bgi_org
    FOREIGN KEY (org_id) REFERENCES public.organisations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_bgi_owner
    FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_bgi_wine_batch
    FOREIGN KEY (wine_batch_id) REFERENCES public.wine_batches(id) ON DELETE CASCADE,
  CONSTRAINT fk_bgi_grape_intake
    FOREIGN KEY (grape_intake_id) REFERENCES public.grape_intakes(id) ON DELETE RESTRICT,

  -- Contributed weight must be non-negative.
  CONSTRAINT bgi_contributed_kg_non_negative
    CHECK (contributed_kg >= 0),

  -- The same grape intake cannot be linked to the same batch twice.
  CONSTRAINT uq_bgi_batch_intake UNIQUE (wine_batch_id, grape_intake_id)
);

CREATE INDEX IF NOT EXISTS idx_bgi_org_id          ON public.batch_grape_intakes(org_id);
CREATE INDEX IF NOT EXISTS idx_bgi_wine_batch_id   ON public.batch_grape_intakes(wine_batch_id);
CREATE INDEX IF NOT EXISTS idx_bgi_grape_intake_id ON public.batch_grape_intakes(grape_intake_id);

-- ============================================================
-- 3. OWNER_ID IMMUTABILITY (reuse existing function from 010)
-- ============================================================
DROP TRIGGER IF EXISTS wine_batches_owner_id_immutable ON public.wine_batches;
CREATE TRIGGER wine_batches_owner_id_immutable
  BEFORE UPDATE ON public.wine_batches
  FOR EACH ROW EXECUTE FUNCTION public.prevent_owner_id_change();

DROP TRIGGER IF EXISTS batch_grape_intakes_owner_id_immutable ON public.batch_grape_intakes;
CREATE TRIGGER batch_grape_intakes_owner_id_immutable
  BEFORE UPDATE ON public.batch_grape_intakes
  FOR EACH ROW EXECUTE FUNCTION public.prevent_owner_id_change();

-- ============================================================
-- 4. UPDATED_AT (reuse existing function from 001)
-- ============================================================
DROP TRIGGER IF EXISTS wine_batches_updated_at ON public.wine_batches;
CREATE TRIGGER wine_batches_updated_at
  BEFORE UPDATE ON public.wine_batches
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS batch_grape_intakes_updated_at ON public.batch_grape_intakes;
CREATE TRIGGER batch_grape_intakes_updated_at
  BEFORE UPDATE ON public.batch_grape_intakes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ============================================================
-- 5. CROSS-ORGANISATION INTEGRITY (authoritative, DB-enforced)
-- Guarantees the referenced wine_batch AND grape_intake both exist and belong
-- to the SAME organisation as the junction row. SECURITY DEFINER so it reads
-- wine_batches/grape_intakes regardless of RLS; pinned search_path; static SQL.
-- Mirrors validate_planting_org_integrity (012) / validate_grape_intake_org_integrity (014).
-- ============================================================
CREATE OR REPLACE FUNCTION public.validate_batch_grape_intake_org_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  batch_org  UUID;
  intake_org UUID;
BEGIN
  SELECT b.org_id INTO batch_org FROM public.wine_batches b WHERE b.id = NEW.wine_batch_id;
  IF batch_org IS NULL THEN
    RAISE EXCEPTION 'Invalid wine batch: batch % does not exist.', NEW.wine_batch_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF batch_org <> NEW.org_id THEN
    RAISE EXCEPTION 'Cross-organisation reference: wine batch % belongs to a different organisation.', NEW.wine_batch_id
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT gi.org_id INTO intake_org FROM public.grape_intakes gi WHERE gi.id = NEW.grape_intake_id;
  IF intake_org IS NULL THEN
    RAISE EXCEPTION 'Invalid grape intake: intake % does not exist.', NEW.grape_intake_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF intake_org <> NEW.org_id THEN
    RAISE EXCEPTION 'Cross-organisation reference: grape intake % belongs to a different organisation.', NEW.grape_intake_id
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS batch_grape_intakes_org_integrity ON public.batch_grape_intakes;
CREATE TRIGGER batch_grape_intakes_org_integrity
  BEFORE INSERT OR UPDATE ON public.batch_grape_intakes
  FOR EACH ROW EXECUTE FUNCTION public.validate_batch_grape_intake_org_integrity();

-- ============================================================
-- 6. ROW LEVEL SECURITY (org-membership based; four permissive policies each)
-- ============================================================
ALTER TABLE public.wine_batches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view organisation wine batches"
  ON public.wine_batches FOR SELECT
  USING (public.is_org_member(org_id));

CREATE POLICY "Users can insert organisation wine batches"
  ON public.wine_batches FOR INSERT
  WITH CHECK (public.is_org_member(org_id) AND owner_id = auth.uid());

CREATE POLICY "Users can update organisation wine batches"
  ON public.wine_batches FOR UPDATE
  USING (public.is_org_member(org_id))
  WITH CHECK (public.is_org_member(org_id));

CREATE POLICY "Users can delete organisation wine batches"
  ON public.wine_batches FOR DELETE
  USING (public.is_org_member(org_id));

ALTER TABLE public.batch_grape_intakes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view organisation batch grape intakes"
  ON public.batch_grape_intakes FOR SELECT
  USING (public.is_org_member(org_id));

CREATE POLICY "Users can insert organisation batch grape intakes"
  ON public.batch_grape_intakes FOR INSERT
  WITH CHECK (public.is_org_member(org_id) AND owner_id = auth.uid());

CREATE POLICY "Users can update organisation batch grape intakes"
  ON public.batch_grape_intakes FOR UPDATE
  USING (public.is_org_member(org_id))
  WITH CHECK (public.is_org_member(org_id));

CREATE POLICY "Users can delete organisation batch grape intakes"
  ON public.batch_grape_intakes FOR DELETE
  USING (public.is_org_member(org_id));

-- ============================================================
-- 7. TABLE PRIVILEGES FOR THE `authenticated` ROLE
-- RLS still decides which rows are visible/mutable (see 016 for why explicit
-- grants are required on manually-provisioned projects).
-- ============================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON public.wine_batches        TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.batch_grape_intakes TO authenticated;

-- ============================================================
-- 8. POST-CHANGE VALIDATION (catalog checks). RAISE => rollback.
-- ============================================================
DO $$
DECLARE
  n INTEGER;
  rls_on BOOLEAN;
  delete_rule_val TEXT;
BEGIN
  -- ---- wine_batches ----------------------------------------------------
  IF to_regclass('public.wine_batches') IS NULL THEN
    RAISE EXCEPTION 'Post-check failed: public.wine_batches was not created.' USING ERRCODE = 'raise_exception';
  END IF;

  SELECT COUNT(*) INTO n FROM information_schema.columns
  WHERE table_schema='public' AND table_name='wine_batches'
    AND column_name IN ('id','org_id','owner_id','batch_code','name','vintage','status','notes','created_at','updated_at');
  IF n <> 10 THEN RAISE EXCEPTION 'Post-check failed: wine_batches columns mismatch (found %).', n USING ERRCODE = 'raise_exception'; END IF;

  SELECT COUNT(*) INTO n FROM information_schema.columns
  WHERE table_schema='public' AND table_name='wine_batches' AND is_nullable='NO'
    AND column_name IN ('id','org_id','owner_id','batch_code','status','created_at','updated_at');
  IF n <> 7 THEN RAISE EXCEPTION 'Post-check failed: wine_batches NOT NULL columns mismatch (found %).', n USING ERRCODE = 'raise_exception'; END IF;

  SELECT COUNT(*) INTO n FROM information_schema.table_constraints
  WHERE table_schema='public' AND table_name='wine_batches' AND constraint_type='FOREIGN KEY';
  IF n <> 2 THEN RAISE EXCEPTION 'Post-check failed: wine_batches should have 2 FKs (found %).', n USING ERRCODE = 'raise_exception'; END IF;

  SELECT COUNT(*) INTO n FROM information_schema.table_constraints
  WHERE table_schema='public' AND table_name='wine_batches' AND constraint_type='CHECK'
    AND constraint_name IN ('wine_batches_batch_code_not_blank','wine_batches_vintage_sensible','wine_batches_status_check');
  IF n <> 3 THEN RAISE EXCEPTION 'Post-check failed: wine_batches CHECK constraints missing (found %).', n USING ERRCODE = 'raise_exception'; END IF;

  -- Org-scoped unique batch_code index present.
  SELECT COUNT(*) INTO n FROM pg_indexes
  WHERE schemaname='public' AND tablename='wine_batches' AND indexname='uq_wine_batches_org_batch_code';
  IF n <> 1 THEN RAISE EXCEPTION 'Post-check failed: uq_wine_batches_org_batch_code missing.' USING ERRCODE = 'raise_exception'; END IF;

  SELECT COUNT(*) INTO n FROM pg_indexes
  WHERE schemaname='public' AND tablename='wine_batches'
    AND indexname IN ('idx_wine_batches_org_id','idx_wine_batches_owner_id','idx_wine_batches_status','idx_wine_batches_vintage');
  IF n <> 4 THEN RAISE EXCEPTION 'Post-check failed: wine_batches indexes missing (found %).', n USING ERRCODE = 'raise_exception'; END IF;

  SELECT relrowsecurity INTO rls_on FROM pg_class WHERE oid='public.wine_batches'::regclass;
  IF NOT COALESCE(rls_on, false) THEN
    RAISE EXCEPTION 'Post-check failed: RLS not enabled on wine_batches.' USING ERRCODE = 'raise_exception';
  END IF;

  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='wine_batches';
  IF n <> 4 THEN RAISE EXCEPTION 'Post-check failed: wine_batches has % policies (expected 4).', n USING ERRCODE = 'raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_policies
  WHERE schemaname='public' AND tablename='wine_batches' AND policyname LIKE 'Users can % own %';
  IF n > 0 THEN RAISE EXCEPTION 'Post-check failed: wine_batches has % owner-based policy(ies).', n USING ERRCODE = 'raise_exception'; END IF;

  SELECT COUNT(*) INTO n FROM pg_trigger
  WHERE tgrelid='public.wine_batches'::regclass AND NOT tgisinternal
    AND tgname IN ('wine_batches_owner_id_immutable','wine_batches_updated_at');
  IF n <> 2 THEN RAISE EXCEPTION 'Post-check failed: wine_batches triggers missing (found %).', n USING ERRCODE = 'raise_exception'; END IF;

  SELECT COUNT(*) INTO n FROM public.wine_batches;
  IF n <> 0 THEN RAISE EXCEPTION 'Post-check failed: wine_batches must start empty (found % rows).', n USING ERRCODE = 'raise_exception'; END IF;

  -- ---- batch_grape_intakes --------------------------------------------
  IF to_regclass('public.batch_grape_intakes') IS NULL THEN
    RAISE EXCEPTION 'Post-check failed: public.batch_grape_intakes was not created.' USING ERRCODE = 'raise_exception';
  END IF;

  SELECT COUNT(*) INTO n FROM information_schema.columns
  WHERE table_schema='public' AND table_name='batch_grape_intakes'
    AND column_name IN ('id','org_id','owner_id','wine_batch_id','grape_intake_id','contributed_kg','created_at','updated_at');
  IF n <> 8 THEN RAISE EXCEPTION 'Post-check failed: batch_grape_intakes columns mismatch (found %).', n USING ERRCODE = 'raise_exception'; END IF;

  SELECT COUNT(*) INTO n FROM information_schema.columns
  WHERE table_schema='public' AND table_name='batch_grape_intakes' AND is_nullable='NO'
    AND column_name IN ('id','org_id','owner_id','wine_batch_id','grape_intake_id','contributed_kg','created_at','updated_at');
  IF n <> 8 THEN RAISE EXCEPTION 'Post-check failed: batch_grape_intakes NOT NULL columns mismatch (found %).', n USING ERRCODE = 'raise_exception'; END IF;

  SELECT COUNT(*) INTO n FROM information_schema.table_constraints
  WHERE table_schema='public' AND table_name='batch_grape_intakes' AND constraint_type='FOREIGN KEY';
  IF n <> 4 THEN RAISE EXCEPTION 'Post-check failed: batch_grape_intakes should have 4 FKs (found %).', n USING ERRCODE = 'raise_exception'; END IF;

  -- wine_batch FK uses CASCADE.
  SELECT rc.delete_rule INTO delete_rule_val
  FROM information_schema.referential_constraints rc
  JOIN information_schema.table_constraints tc
    ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema
  WHERE tc.table_schema='public' AND tc.table_name='batch_grape_intakes' AND tc.constraint_name='fk_bgi_wine_batch';
  IF delete_rule_val <> 'CASCADE' THEN
    RAISE EXCEPTION 'Post-check failed: fk_bgi_wine_batch must be ON DELETE CASCADE (found %).', COALESCE(delete_rule_val,'<missing>') USING ERRCODE = 'raise_exception';
  END IF;

  -- grape_intake FK uses RESTRICT (protects intake history).
  SELECT rc.delete_rule INTO delete_rule_val
  FROM information_schema.referential_constraints rc
  JOIN information_schema.table_constraints tc
    ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema
  WHERE tc.table_schema='public' AND tc.table_name='batch_grape_intakes' AND tc.constraint_name='fk_bgi_grape_intake';
  IF delete_rule_val <> 'NO ACTION' AND delete_rule_val <> 'RESTRICT' THEN
    RAISE EXCEPTION 'Post-check failed: fk_bgi_grape_intake must be RESTRICT (found %).', COALESCE(delete_rule_val,'<missing>') USING ERRCODE = 'raise_exception';
  END IF;

  -- CHECK + UNIQUE constraints.
  SELECT COUNT(*) INTO n FROM information_schema.table_constraints
  WHERE table_schema='public' AND table_name='batch_grape_intakes' AND constraint_type='CHECK'
    AND constraint_name='bgi_contributed_kg_non_negative';
  IF n <> 1 THEN RAISE EXCEPTION 'Post-check failed: bgi_contributed_kg_non_negative CHECK missing.' USING ERRCODE = 'raise_exception'; END IF;

  SELECT COUNT(*) INTO n FROM information_schema.table_constraints
  WHERE table_schema='public' AND table_name='batch_grape_intakes' AND constraint_type='UNIQUE'
    AND constraint_name='uq_bgi_batch_intake';
  IF n <> 1 THEN RAISE EXCEPTION 'Post-check failed: uq_bgi_batch_intake UNIQUE missing.' USING ERRCODE = 'raise_exception'; END IF;

  SELECT COUNT(*) INTO n FROM pg_indexes
  WHERE schemaname='public' AND tablename='batch_grape_intakes'
    AND indexname IN ('idx_bgi_org_id','idx_bgi_wine_batch_id','idx_bgi_grape_intake_id');
  IF n <> 3 THEN RAISE EXCEPTION 'Post-check failed: batch_grape_intakes indexes missing (found %).', n USING ERRCODE = 'raise_exception'; END IF;

  SELECT relrowsecurity INTO rls_on FROM pg_class WHERE oid='public.batch_grape_intakes'::regclass;
  IF NOT COALESCE(rls_on, false) THEN
    RAISE EXCEPTION 'Post-check failed: RLS not enabled on batch_grape_intakes.' USING ERRCODE = 'raise_exception';
  END IF;

  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='batch_grape_intakes';
  IF n <> 4 THEN RAISE EXCEPTION 'Post-check failed: batch_grape_intakes has % policies (expected 4).', n USING ERRCODE = 'raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_policies
  WHERE schemaname='public' AND tablename='batch_grape_intakes' AND policyname LIKE 'Users can % own %';
  IF n > 0 THEN RAISE EXCEPTION 'Post-check failed: batch_grape_intakes has % owner-based policy(ies).', n USING ERRCODE = 'raise_exception'; END IF;

  SELECT COUNT(*) INTO n FROM pg_trigger
  WHERE tgrelid='public.batch_grape_intakes'::regclass AND NOT tgisinternal
    AND tgname IN ('batch_grape_intakes_owner_id_immutable','batch_grape_intakes_updated_at','batch_grape_intakes_org_integrity');
  IF n <> 3 THEN RAISE EXCEPTION 'Post-check failed: batch_grape_intakes triggers missing (found %).', n USING ERRCODE = 'raise_exception'; END IF;

  IF to_regprocedure('public.validate_batch_grape_intake_org_integrity()') IS NULL THEN
    RAISE EXCEPTION 'Post-check failed: validate_batch_grape_intake_org_integrity() missing.' USING ERRCODE = 'raise_exception';
  END IF;
  SELECT COUNT(*) INTO n FROM pg_proc
  WHERE oid='public.validate_batch_grape_intake_org_integrity()'::regprocedure AND prosecdef = true;
  IF n <> 1 THEN RAISE EXCEPTION 'Post-check failed: validate_batch_grape_intake_org_integrity() must be SECURITY DEFINER.' USING ERRCODE = 'raise_exception'; END IF;

  SELECT COUNT(*) INTO n FROM public.batch_grape_intakes;
  IF n <> 0 THEN RAISE EXCEPTION 'Post-check failed: batch_grape_intakes must start empty (found % rows).', n USING ERRCODE = 'raise_exception'; END IF;
END $$;

COMMIT;
