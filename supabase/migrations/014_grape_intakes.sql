-- ============================================================
-- WINERIX — P2B: Grape Intakes (first cellar increment)
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- Depends on: 005 (harvest), 006 (organisations, is_org_member,
--             update_updated_at), 010 (prevent_owner_id_change)
--
-- PURPOSE:
--   Create public.grape_intakes — one row per received delivery/load of grapes
--   at the cellar, originating from a harvest. Extends the traceability chain:
--   Harvest -> Grape Intake. Cultivar/vineyard/block/planting are DERIVED via
--   the harvest and are intentionally NOT duplicated here.
--
-- SCOPE — THIS MIGRATION ONLY:
--   Creates grape_intakes + FKs + indexes + CHECKs + org-based RLS +
--   owner_id immutability + updated_at trigger + a cross-organisation
--   integrity trigger. No backfill.
--
-- THIS MIGRATION DOES NOT:
--   * modify harvest / plantings / cultivars / any existing table
--   * add wine batch/lot/vessel/blend/bottling/stock/inventory/lab tables
--   * duplicate vineyard_id / block_id / planting_id / cultivar_id
--   * add a unique constraint on harvest_id (one harvest -> many intakes)
--   * seed / backfill any data
--
-- INTEGRITY: RLS checks only grape_intakes.org_id; a SECURITY DEFINER trigger
--   additionally guarantees the referenced harvest is same-org (mirrors 012/013).
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
  IF to_regclass('public.harvest') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.harvest is missing (run 005 first).' USING ERRCODE = 'undefined_table';
  END IF;
  IF to_regclass('public.grape_intakes') IS NOT NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.grape_intakes already exists.' USING ERRCODE = 'duplicate_table';
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
  -- harvest must carry org_id for the integrity check.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='harvest' AND column_name='org_id'
  ) THEN
    RAISE EXCEPTION 'Pre-flight failed: harvest.org_id is missing (run 009 first).' USING ERRCODE = 'undefined_column';
  END IF;
END $$;

-- ============================================================
-- 1. GRAPE_INTAKES TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS public.grape_intakes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL,
  harvest_id   UUID NOT NULL,
  owner_id     UUID NOT NULL,
  intake_date  DATE,
  received_kg  NUMERIC(12, 2),
  status       TEXT NOT NULL DEFAULT 'received',
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_grape_intakes_org
    FOREIGN KEY (org_id) REFERENCES public.organisations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_grape_intakes_harvest
    FOREIGN KEY (harvest_id) REFERENCES public.harvest(id) ON DELETE RESTRICT,
  CONSTRAINT fk_grape_intakes_owner
    FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE RESTRICT,

  -- Received weight must be non-negative when provided.
  CONSTRAINT grape_intakes_received_kg_non_negative
    CHECK (received_kg IS NULL OR received_kg >= 0),

  -- Controlled status values (P2B: exactly these three).
  CONSTRAINT grape_intakes_status_check
    CHECK (status IN ('received', 'processed', 'rejected'))
);

-- Indexes (NO unique constraint on harvest_id — one harvest -> many intakes).
CREATE INDEX IF NOT EXISTS idx_grape_intakes_org_id     ON public.grape_intakes(org_id);
CREATE INDEX IF NOT EXISTS idx_grape_intakes_harvest_id ON public.grape_intakes(harvest_id);
CREATE INDEX IF NOT EXISTS idx_grape_intakes_owner_id   ON public.grape_intakes(owner_id);

-- ============================================================
-- 2. OWNER_ID IMMUTABILITY (reuse existing function from 010)
-- ============================================================
DROP TRIGGER IF EXISTS grape_intakes_owner_id_immutable ON public.grape_intakes;
CREATE TRIGGER grape_intakes_owner_id_immutable
  BEFORE UPDATE ON public.grape_intakes
  FOR EACH ROW EXECUTE FUNCTION public.prevent_owner_id_change();

-- ============================================================
-- 3. UPDATED_AT (reuse existing function from 001)
-- ============================================================
DROP TRIGGER IF EXISTS grape_intakes_updated_at ON public.grape_intakes;
CREATE TRIGGER grape_intakes_updated_at
  BEFORE UPDATE ON public.grape_intakes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ============================================================
-- 4. CROSS-ORGANISATION INTEGRITY (authoritative, DB-enforced)
-- Guarantees the referenced harvest belongs to the SAME organisation as the
-- intake. SECURITY DEFINER so it reads harvest regardless of RLS; pinned
-- search_path; static SQL. Mirrors validate_planting_org_integrity (012) and
-- validate_harvest_planting_integrity (013).
-- ============================================================
CREATE OR REPLACE FUNCTION public.validate_grape_intake_org_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  harvest_org UUID;
BEGIN
  -- harvest_id is NOT NULL, but guard defensively.
  IF NEW.harvest_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT h.org_id INTO harvest_org FROM public.harvest h WHERE h.id = NEW.harvest_id;

  IF harvest_org IS NULL THEN
    RAISE EXCEPTION 'Invalid harvest: harvest % does not exist.', NEW.harvest_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF harvest_org <> NEW.org_id THEN
    RAISE EXCEPTION 'Cross-organisation reference: harvest % belongs to a different organisation.', NEW.harvest_id
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS grape_intakes_org_integrity ON public.grape_intakes;
CREATE TRIGGER grape_intakes_org_integrity
  BEFORE INSERT OR UPDATE ON public.grape_intakes
  FOR EACH ROW EXECUTE FUNCTION public.validate_grape_intake_org_integrity();

-- ============================================================
-- 5. ROW LEVEL SECURITY (org-membership based; four permissive policies)
-- ============================================================
ALTER TABLE public.grape_intakes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view organisation grape intakes"
  ON public.grape_intakes FOR SELECT
  USING (public.is_org_member(org_id));

CREATE POLICY "Users can insert organisation grape intakes"
  ON public.grape_intakes FOR INSERT
  WITH CHECK (public.is_org_member(org_id) AND owner_id = auth.uid());

CREATE POLICY "Users can update organisation grape intakes"
  ON public.grape_intakes FOR UPDATE
  USING (public.is_org_member(org_id))
  WITH CHECK (public.is_org_member(org_id));

CREATE POLICY "Users can delete organisation grape intakes"
  ON public.grape_intakes FOR DELETE
  USING (public.is_org_member(org_id));

-- ============================================================
-- 6. POST-CHANGE VALIDATION (catalog checks). RAISE => rollback.
-- ============================================================
DO $$
DECLARE
  n INTEGER;
  rls_on BOOLEAN;
  delete_rule_val TEXT;
BEGIN
  IF to_regclass('public.grape_intakes') IS NULL THEN
    RAISE EXCEPTION 'Post-check failed: public.grape_intakes was not created.' USING ERRCODE = 'raise_exception';
  END IF;

  -- Expected columns present.
  SELECT COUNT(*) INTO n FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'grape_intakes'
    AND column_name IN ('id','org_id','harvest_id','owner_id','intake_date',
                        'received_kg','status','notes','created_at','updated_at');
  IF n <> 10 THEN RAISE EXCEPTION 'Post-check failed: grape_intakes columns mismatch (found %).', n USING ERRCODE = 'raise_exception'; END IF;

  -- NOT NULL columns.
  SELECT COUNT(*) INTO n FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'grape_intakes' AND is_nullable = 'NO'
    AND column_name IN ('id','org_id','harvest_id','owner_id','status','created_at','updated_at');
  IF n <> 7 THEN RAISE EXCEPTION 'Post-check failed: grape_intakes NOT NULL columns mismatch (found %).', n USING ERRCODE = 'raise_exception'; END IF;

  -- Three foreign keys.
  SELECT COUNT(*) INTO n FROM information_schema.table_constraints
  WHERE table_schema = 'public' AND table_name = 'grape_intakes' AND constraint_type = 'FOREIGN KEY';
  IF n <> 3 THEN RAISE EXCEPTION 'Post-check failed: grape_intakes should have 3 FKs (found %).', n USING ERRCODE = 'raise_exception'; END IF;

  -- Harvest FK uses RESTRICT.
  SELECT rc.delete_rule INTO delete_rule_val
  FROM information_schema.referential_constraints rc
  JOIN information_schema.table_constraints tc
    ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema
  WHERE tc.table_schema='public' AND tc.table_name='grape_intakes' AND tc.constraint_name='fk_grape_intakes_harvest';
  IF delete_rule_val IS NULL THEN
    RAISE EXCEPTION 'Post-check failed: fk_grape_intakes_harvest is missing.' USING ERRCODE = 'raise_exception';
  END IF;
  IF delete_rule_val <> 'NO ACTION' AND delete_rule_val <> 'RESTRICT' THEN
    RAISE EXCEPTION 'Post-check failed: harvest FK must be RESTRICT (found %).', delete_rule_val USING ERRCODE = 'raise_exception';
  END IF;

  -- Indexes.
  SELECT COUNT(*) INTO n FROM pg_indexes
  WHERE schemaname = 'public' AND tablename = 'grape_intakes'
    AND indexname IN ('idx_grape_intakes_org_id','idx_grape_intakes_harvest_id','idx_grape_intakes_owner_id');
  IF n <> 3 THEN RAISE EXCEPTION 'Post-check failed: grape_intakes indexes missing (found %).', n USING ERRCODE = 'raise_exception'; END IF;

  -- CHECK constraints (status + received_kg).
  SELECT COUNT(*) INTO n FROM information_schema.table_constraints
  WHERE table_schema = 'public' AND table_name = 'grape_intakes' AND constraint_type = 'CHECK'
    AND constraint_name IN ('grape_intakes_status_check','grape_intakes_received_kg_non_negative');
  IF n <> 2 THEN RAISE EXCEPTION 'Post-check failed: grape_intakes CHECK constraints missing (found %).', n USING ERRCODE = 'raise_exception'; END IF;

  -- RLS enabled.
  SELECT relrowsecurity INTO rls_on FROM pg_class WHERE oid = 'public.grape_intakes'::regclass;
  IF NOT COALESCE(rls_on, false) THEN
    RAISE EXCEPTION 'Post-check failed: RLS not enabled on grape_intakes.' USING ERRCODE = 'raise_exception';
  END IF;

  -- Exactly four policies, none owner-based.
  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname = 'public' AND tablename = 'grape_intakes';
  IF n <> 4 THEN RAISE EXCEPTION 'Post-check failed: grape_intakes has % policies (expected 4).', n USING ERRCODE = 'raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'grape_intakes' AND policyname LIKE 'Users can % own %';
  IF n > 0 THEN RAISE EXCEPTION 'Post-check failed: grape_intakes has % owner-based policy(ies).', n USING ERRCODE = 'raise_exception'; END IF;

  -- Triggers: owner immutability, updated_at, cross-org integrity.
  SELECT COUNT(*) INTO n FROM pg_trigger
  WHERE tgrelid = 'public.grape_intakes'::regclass AND NOT tgisinternal
    AND tgname IN ('grape_intakes_owner_id_immutable','grape_intakes_updated_at','grape_intakes_org_integrity');
  IF n <> 3 THEN RAISE EXCEPTION 'Post-check failed: grape_intakes triggers missing (found %).', n USING ERRCODE = 'raise_exception'; END IF;

  -- Integrity function exists and is SECURITY DEFINER.
  IF to_regprocedure('public.validate_grape_intake_org_integrity()') IS NULL THEN
    RAISE EXCEPTION 'Post-check failed: validate_grape_intake_org_integrity() missing.' USING ERRCODE = 'raise_exception';
  END IF;
  SELECT COUNT(*) INTO n FROM pg_proc
  WHERE oid = 'public.validate_grape_intake_org_integrity()'::regprocedure AND prosecdef = true;
  IF n <> 1 THEN RAISE EXCEPTION 'Post-check failed: validate_grape_intake_org_integrity() must be SECURITY DEFINER.' USING ERRCODE = 'raise_exception'; END IF;

  -- Table starts empty (no backfill).
  SELECT COUNT(*) INTO n FROM public.grape_intakes;
  IF n <> 0 THEN RAISE EXCEPTION 'Post-check failed: grape_intakes must start empty (found % rows).', n USING ERRCODE = 'raise_exception'; END IF;
END $$;

COMMIT;
