-- ============================================================
-- WINERIX — P1B: Cultivar Master Data
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- Depends on: 006_tenancy_foundation.sql (organisations, is_org_member,
--                                          update_updated_at)
--
-- PURPOSE:
--   Create public.cultivars as ORGANISATION-OWNED master/reference data.
--   Cultivars are the grape varieties an organisation curates; they will later
--   be referenced by plantings (P1C) and, further out, by traceability/Wine of
--   Origin reporting. This migration is reference-data only — it does NOT
--   constitute SAWIS / Wine of Origin compliance.
--
-- SCOPE — THIS MIGRATION ONLY:
--   Creates the cultivars table + FKs + indexes + case-insensitive uniqueness
--   + RLS (org-membership based) + created_by immutability + updated_at trigger.
--
-- THIS MIGRATION DOES NOT:
--   * modify vineyards / blocks / harvest / any existing child table
--   * change any existing RLS policy or P0 migration (006/008/009/010)
--   * add plantings, synonyms, Wine-of-Origin codes, or compliance fields
--   * seed any cultivar data
--
-- MULTI-TENANCY (P0 rules): org_id NOT NULL -> organisations(id), indexed,
--   org-based RLS via public.is_org_member(org_id). created_by is immutable
--   creator attribution (this table intentionally has no owner_id).
-- ============================================================

BEGIN;

-- ============================================================
-- 0. PRE-FLIGHT (fail before creating anything if deps are missing)
-- ============================================================
DO $$
BEGIN
  IF to_regclass('public.organisations') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.organisations is missing (run 006 first).'
      USING ERRCODE = 'undefined_table';
  END IF;
  IF to_regprocedure('public.is_org_member(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.is_org_member(uuid) is missing (run 006 first).'
      USING ERRCODE = 'undefined_function';
  END IF;
  IF to_regprocedure('public.update_updated_at()') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.update_updated_at() is missing (run 001 first).'
      USING ERRCODE = 'undefined_function';
  END IF;
END $$;

-- ============================================================
-- 1. CULTIVARS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS public.cultivars (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES public.organisations(id) ON DELETE RESTRICT,
  name        TEXT NOT NULL,
  colour      TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_by  UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Name must not be blank / whitespace-only.
  CONSTRAINT cultivars_name_not_blank CHECK (length(btrim(name)) > 0),

  -- Colour is optional; when present it must be one of the controlled values.
  CONSTRAINT cultivars_colour_check
    CHECK (colour IS NULL OR colour IN ('red', 'white', 'rosé', 'other'))
);

-- Indexes.
CREATE INDEX IF NOT EXISTS idx_cultivars_org_id ON public.cultivars(org_id);
CREATE INDEX IF NOT EXISTS idx_cultivars_created_by ON public.cultivars(created_by);

-- Case-insensitive uniqueness of cultivar name WITHIN an organisation.
-- The same name may exist across different organisations; within one org,
-- names differing only by case are rejected.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cultivars_org_lower_name
  ON public.cultivars(org_id, lower(name));

-- ============================================================
-- 2. CREATED_BY IMMUTABILITY
-- Dedicated trigger function (cultivars use created_by, not owner_id). Does not
-- touch the existing prevent_owner_id_change() from migration 010.
-- ============================================================
CREATE OR REPLACE FUNCTION public.prevent_created_by_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'created_by is immutable and cannot be reassigned (creator attribution).'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS cultivars_created_by_immutable ON public.cultivars;
CREATE TRIGGER cultivars_created_by_immutable
  BEFORE UPDATE ON public.cultivars
  FOR EACH ROW EXECUTE FUNCTION public.prevent_created_by_change();

-- ============================================================
-- 3. UPDATED_AT (reuse existing public.update_updated_at from 001)
-- ============================================================
DROP TRIGGER IF EXISTS cultivars_updated_at ON public.cultivars;
CREATE TRIGGER cultivars_updated_at
  BEFORE UPDATE ON public.cultivars
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ============================================================
-- 4. ROW LEVEL SECURITY (org-membership based; four permissive policies)
-- ============================================================
ALTER TABLE public.cultivars ENABLE ROW LEVEL SECURITY;

-- SELECT: active members of the organisation may read its cultivars.
CREATE POLICY "Users can view organisation cultivars"
  ON public.cultivars FOR SELECT
  USING (public.is_org_member(org_id));

-- INSERT: active member of the target org AND creator attribution is self.
CREATE POLICY "Users can insert organisation cultivars"
  ON public.cultivars FOR INSERT
  WITH CHECK (public.is_org_member(org_id) AND created_by = auth.uid());

-- UPDATE: active members of the organisation (created_by immutability enforced
-- by the trigger above).
CREATE POLICY "Users can update organisation cultivars"
  ON public.cultivars FOR UPDATE
  USING (public.is_org_member(org_id))
  WITH CHECK (public.is_org_member(org_id));

-- DELETE: active members of the organisation. (The application prefers
-- deactivation; physical delete is also blocked by FK RESTRICT once a future
-- planting references the cultivar.)
CREATE POLICY "Users can delete organisation cultivars"
  ON public.cultivars FOR DELETE
  USING (public.is_org_member(org_id));

-- ============================================================
-- 5. POST-CHANGE VALIDATION (catalog checks). RAISE => rollback.
-- ============================================================
DO $$
DECLARE
  n INTEGER;
  rls_on BOOLEAN;
BEGIN
  -- table exists
  IF to_regclass('public.cultivars') IS NULL THEN
    RAISE EXCEPTION 'Post-check failed: public.cultivars was not created.'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- required columns + nullability
  SELECT COUNT(*) INTO n FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'cultivars'
    AND column_name = 'org_id' AND data_type = 'uuid' AND is_nullable = 'NO';
  IF n <> 1 THEN RAISE EXCEPTION 'Post-check failed: cultivars.org_id must be UUID NOT NULL.' USING ERRCODE = 'raise_exception'; END IF;

  SELECT COUNT(*) INTO n FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'cultivars'
    AND column_name = 'created_by' AND data_type = 'uuid' AND is_nullable = 'NO';
  IF n <> 1 THEN RAISE EXCEPTION 'Post-check failed: cultivars.created_by must be UUID NOT NULL.' USING ERRCODE = 'raise_exception'; END IF;

  SELECT COUNT(*) INTO n FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'cultivars'
    AND column_name IN ('name', 'colour', 'is_active', 'created_at', 'updated_at');
  IF n <> 5 THEN RAISE EXCEPTION 'Post-check failed: cultivars is missing expected columns.' USING ERRCODE = 'raise_exception'; END IF;

  -- foreign keys (org_id -> organisations, created_by -> auth.users)
  SELECT COUNT(*) INTO n
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
  JOIN information_schema.constraint_column_usage ccu
    ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
  WHERE tc.constraint_type = 'FOREIGN KEY'
    AND tc.table_schema = 'public' AND tc.table_name = 'cultivars'
    AND kcu.column_name = 'org_id' AND ccu.table_name = 'organisations' AND ccu.column_name = 'id';
  IF n < 1 THEN RAISE EXCEPTION 'Post-check failed: cultivars.org_id FK to organisations missing.' USING ERRCODE = 'raise_exception'; END IF;

  SELECT COUNT(*) INTO n
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
  WHERE tc.constraint_type = 'FOREIGN KEY'
    AND tc.table_schema = 'public' AND tc.table_name = 'cultivars'
    AND kcu.column_name = 'created_by';
  IF n < 1 THEN RAISE EXCEPTION 'Post-check failed: cultivars.created_by FK missing.' USING ERRCODE = 'raise_exception'; END IF;

  -- org_id index
  SELECT COUNT(*) INTO n FROM pg_indexes
  WHERE schemaname = 'public' AND tablename = 'cultivars' AND indexname = 'idx_cultivars_org_id';
  IF n <> 1 THEN RAISE EXCEPTION 'Post-check failed: idx_cultivars_org_id missing.' USING ERRCODE = 'raise_exception'; END IF;

  -- case-insensitive uniqueness
  SELECT COUNT(*) INTO n FROM pg_indexes
  WHERE schemaname = 'public' AND tablename = 'cultivars' AND indexname = 'uq_cultivars_org_lower_name';
  IF n <> 1 THEN RAISE EXCEPTION 'Post-check failed: uq_cultivars_org_lower_name missing.' USING ERRCODE = 'raise_exception'; END IF;

  -- RLS enabled
  SELECT relrowsecurity INTO rls_on FROM pg_class WHERE oid = 'public.cultivars'::regclass;
  IF NOT COALESCE(rls_on, false) THEN
    RAISE EXCEPTION 'Post-check failed: RLS not enabled on cultivars.' USING ERRCODE = 'raise_exception';
  END IF;

  -- exactly four policies
  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname = 'public' AND tablename = 'cultivars';
  IF n <> 4 THEN RAISE EXCEPTION 'Post-check failed: cultivars has % policies (expected 4).', n USING ERRCODE = 'raise_exception'; END IF;

  -- created_by immutability trigger
  SELECT COUNT(*) INTO n FROM pg_trigger
  WHERE tgrelid = 'public.cultivars'::regclass AND tgname = 'cultivars_created_by_immutable' AND NOT tgisinternal;
  IF n <> 1 THEN RAISE EXCEPTION 'Post-check failed: created_by immutability trigger missing.' USING ERRCODE = 'raise_exception'; END IF;

  -- updated_at trigger
  SELECT COUNT(*) INTO n FROM pg_trigger
  WHERE tgrelid = 'public.cultivars'::regclass AND tgname = 'cultivars_updated_at' AND NOT tgisinternal;
  IF n <> 1 THEN RAISE EXCEPTION 'Post-check failed: updated_at trigger missing.' USING ERRCODE = 'raise_exception'; END IF;
END $$;

COMMIT;
