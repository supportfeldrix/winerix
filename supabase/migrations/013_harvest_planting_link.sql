-- ============================================================
-- WINERIX — P1E: Harvest → Planting link
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- Depends on: 005 (harvest), 006 (organisations), 012 (plantings)
--
-- PURPOSE:
--   Add a nullable harvest.planting_id linking a harvest to a specific planting
--   (the most precise cultivar source; cultivar is derived via the planting).
--   This closes Block -> Planting -> Cultivar -> Harvest for the common
--   single-variety case. Harvest Lines (multi-variety per harvest) are NOT part
--   of this task.
--
-- SCOPE — THIS MIGRATION ONLY:
--   Adds harvest.planting_id (nullable) + FK (ON DELETE SET NULL) + index +
--   an authoritative BEFORE INSERT/UPDATE cross-org / same-block integrity
--   trigger. No backfill.
--
-- THIS MIGRATION DOES NOT:
--   * add harvest.cultivar_id (cultivar derives from planting.cultivar_id)
--   * modify harvest.vineyard_id / block_id / org_id / owner_id or any other
--     existing harvest column, constraint, RLS policy, or trigger
--   * backfill planting_id (existing harvests remain planting_id = NULL)
--   * introduce harvest lines / cellar tables
--
-- INTEGRITY: RLS on harvest checks only harvest.org_id; it cannot ensure a
--   referenced planting is same-org / same-block. A SECURITY DEFINER trigger
--   enforces that when planting_id IS NOT NULL (mirrors 012's approach). No
--   composite FKs on completed tables.
-- ============================================================

BEGIN;

-- ============================================================
-- 0. PRE-FLIGHT (fail before changing anything if deps are missing)
-- ============================================================
DO $$
BEGIN
  IF to_regclass('public.harvest') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.harvest is missing (run 005 first).' USING ERRCODE = 'undefined_table';
  END IF;
  IF to_regclass('public.plantings') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.plantings is missing (run 012 first).' USING ERRCODE = 'undefined_table';
  END IF;
  -- harvest must have org_id and block_id for the integrity checks.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='harvest' AND column_name='org_id'
  ) THEN
    RAISE EXCEPTION 'Pre-flight failed: harvest.org_id is missing (run 009 first).' USING ERRCODE = 'undefined_column';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='harvest' AND column_name='block_id'
  ) THEN
    RAISE EXCEPTION 'Pre-flight failed: harvest.block_id is missing.' USING ERRCODE = 'undefined_column';
  END IF;
  -- planting_id must not already exist.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='harvest' AND column_name='planting_id'
  ) THEN
    RAISE EXCEPTION 'Pre-flight failed: harvest.planting_id already exists.' USING ERRCODE = 'duplicate_column';
  END IF;
END $$;

-- ============================================================
-- 1. ADD NULLABLE COLUMN + FK (ON DELETE SET NULL) + INDEX
-- planting_id is nullable; existing rows keep NULL (no backfill). SET NULL so
-- removing a planting detaches lineage without deleting harvest history.
-- ============================================================
ALTER TABLE public.harvest
  ADD COLUMN IF NOT EXISTS planting_id UUID;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_harvest_planting') THEN
    ALTER TABLE public.harvest
      ADD CONSTRAINT fk_harvest_planting
      FOREIGN KEY (planting_id) REFERENCES public.plantings(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_harvest_planting_id ON public.harvest(planting_id);

-- ============================================================
-- 2. CROSS-ORG / SAME-BLOCK INTEGRITY (authoritative, DB-enforced)
-- Only enforced when planting_id IS NOT NULL. SECURITY DEFINER so it can read
-- plantings regardless of RLS; pinned search_path; static SQL; no bypass.
-- ============================================================
CREATE OR REPLACE FUNCTION public.validate_harvest_planting_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  planting_org   UUID;
  planting_block UUID;
BEGIN
  -- Nothing to validate for block-level / unlinked harvests.
  IF NEW.planting_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT p.org_id, p.block_id
    INTO planting_org, planting_block
  FROM public.plantings p
  WHERE p.id = NEW.planting_id;

  IF planting_org IS NULL THEN
    RAISE EXCEPTION 'Invalid planting: planting % does not exist.', NEW.planting_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF planting_org <> NEW.org_id THEN
    RAISE EXCEPTION 'Cross-organisation reference: planting % belongs to a different organisation.', NEW.planting_id
      USING ERRCODE = 'raise_exception';
  END IF;

  -- If the harvest names a block, the planting must belong to that block.
  IF NEW.block_id IS NOT NULL AND planting_block <> NEW.block_id THEN
    RAISE EXCEPTION 'Block mismatch: planting % does not belong to the selected block.', NEW.planting_id
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS harvest_planting_integrity ON public.harvest;
CREATE TRIGGER harvest_planting_integrity
  BEFORE INSERT OR UPDATE ON public.harvest
  FOR EACH ROW EXECUTE FUNCTION public.validate_harvest_planting_integrity();

-- ============================================================
-- 3. POST-CHANGE VALIDATION (catalog checks). RAISE => rollback.
-- ============================================================
DO $$
DECLARE
  n INTEGER;
  is_nullable_val TEXT;
  delete_rule_val TEXT;
BEGIN
  -- Column exists and is nullable.
  SELECT is_nullable INTO is_nullable_val FROM information_schema.columns
  WHERE table_schema='public' AND table_name='harvest' AND column_name='planting_id';
  IF is_nullable_val IS NULL THEN
    RAISE EXCEPTION 'Post-check failed: harvest.planting_id was not created.' USING ERRCODE = 'raise_exception';
  END IF;
  IF is_nullable_val <> 'YES' THEN
    RAISE EXCEPTION 'Post-check failed: harvest.planting_id must be nullable.' USING ERRCODE = 'raise_exception';
  END IF;

  -- FK exists with ON DELETE SET NULL, referencing plantings.
  SELECT rc.delete_rule INTO delete_rule_val
  FROM information_schema.referential_constraints rc
  JOIN information_schema.table_constraints tc
    ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema
  WHERE tc.table_schema='public' AND tc.table_name='harvest' AND tc.constraint_name='fk_harvest_planting';
  IF delete_rule_val IS NULL THEN
    RAISE EXCEPTION 'Post-check failed: fk_harvest_planting is missing.' USING ERRCODE = 'raise_exception';
  END IF;
  IF delete_rule_val <> 'SET NULL' THEN
    RAISE EXCEPTION 'Post-check failed: fk_harvest_planting must be ON DELETE SET NULL (found %).', delete_rule_val USING ERRCODE = 'raise_exception';
  END IF;

  -- Index exists.
  SELECT COUNT(*) INTO n FROM pg_indexes
  WHERE schemaname='public' AND tablename='harvest' AND indexname='idx_harvest_planting_id';
  IF n <> 1 THEN RAISE EXCEPTION 'Post-check failed: idx_harvest_planting_id missing.' USING ERRCODE = 'raise_exception'; END IF;

  -- Integrity trigger + function exist.
  SELECT COUNT(*) INTO n FROM pg_trigger
  WHERE tgrelid='public.harvest'::regclass AND tgname='harvest_planting_integrity' AND NOT tgisinternal;
  IF n <> 1 THEN RAISE EXCEPTION 'Post-check failed: harvest_planting_integrity trigger missing.' USING ERRCODE = 'raise_exception'; END IF;

  IF to_regprocedure('public.validate_harvest_planting_integrity()') IS NULL THEN
    RAISE EXCEPTION 'Post-check failed: validate_harvest_planting_integrity() missing.' USING ERRCODE = 'raise_exception';
  END IF;

  -- No existing harvest row was backfilled with a planting.
  SELECT COUNT(*) INTO n FROM public.harvest WHERE planting_id IS NOT NULL;
  IF n <> 0 THEN RAISE EXCEPTION 'Post-check failed: existing harvests must keep planting_id NULL (found % non-null).', n USING ERRCODE = 'raise_exception'; END IF;
END $$;

COMMIT;
