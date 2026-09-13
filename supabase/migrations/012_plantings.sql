-- ============================================================
-- WINERIX — P1C: Plantings
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- Depends on: 002 (blocks), 006 (organisations, is_org_member,
--             update_updated_at), 010 (prevent_owner_id_change),
--             011 (cultivars)
--
-- PURPOSE:
--   Create public.plantings — the actual vineyard planting composition within a
--   block (block -> planting -> cultivar). Multiple plantings per block are
--   supported. The vineyard is derived via block_id -> blocks.vineyard_id and
--   is intentionally NOT duplicated here.
--
-- SCOPE — THIS MIGRATION ONLY:
--   Creates the plantings table + FKs + indexes + CHECKs + org-based RLS +
--   owner_id immutability (reuses 010's function) + updated_at trigger +
--   an authoritative cross-organisation integrity trigger.
--
-- THIS MIGRATION DOES NOT:
--   * modify blocks / cultivars / harvest / any existing table
--   * add vineyard_id, cultivar percentage, spacing/training/soil/GPS fields
--   * add a 'planned' status
--   * add composite FKs to existing tables
--   * seed any planting data
--
-- MULTI-TENANCY (P0 rules): org_id NOT NULL -> organisations(id), indexed,
--   org-based RLS via public.is_org_member(org_id). owner_id is immutable
--   creator attribution. A cross-org trigger additionally guarantees the
--   referenced block and cultivar belong to the SAME organisation as the
--   planting (RLS alone cannot enforce this for relational FKs).
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
  IF to_regclass('public.blocks') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.blocks is missing (run 002 first).' USING ERRCODE = 'undefined_table';
  END IF;
  IF to_regclass('public.cultivars') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.cultivars is missing (run 011 first).' USING ERRCODE = 'undefined_table';
  END IF;
  IF to_regclass('public.plantings') IS NOT NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.plantings already exists.' USING ERRCODE = 'duplicate_table';
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
END $$;

-- ============================================================
-- 1. PLANTINGS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS public.plantings (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL,
  block_id       UUID NOT NULL,
  cultivar_id    UUID NOT NULL,
  owner_id       UUID NOT NULL,
  planting_year  INTEGER,
  area_hectares  NUMERIC(10, 2),
  rootstock      TEXT,
  clone          TEXT,
  status         TEXT NOT NULL DEFAULT 'active',
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Foreign keys (explicit, descriptive names).
  CONSTRAINT fk_plantings_org
    FOREIGN KEY (org_id) REFERENCES public.organisations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_plantings_block
    FOREIGN KEY (block_id) REFERENCES public.blocks(id) ON DELETE CASCADE,
  CONSTRAINT fk_plantings_cultivar
    FOREIGN KEY (cultivar_id) REFERENCES public.cultivars(id) ON DELETE RESTRICT,
  CONSTRAINT fk_plantings_owner
    FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE RESTRICT,

  -- Area must be non-negative when provided (no cross-row/aggregate check).
  CONSTRAINT plantings_area_non_negative
    CHECK (area_hectares IS NULL OR area_hectares >= 0),

  -- Controlled status values (P1C: exactly these three; NO 'planned').
  CONSTRAINT plantings_status_check
    CHECK (status IN ('active', 'removed', 'replanted'))
);

-- Indexes.
CREATE INDEX IF NOT EXISTS idx_plantings_org_id      ON public.plantings(org_id);
CREATE INDEX IF NOT EXISTS idx_plantings_block_id    ON public.plantings(block_id);
CREATE INDEX IF NOT EXISTS idx_plantings_cultivar_id ON public.plantings(cultivar_id);
CREATE INDEX IF NOT EXISTS idx_plantings_owner_id    ON public.plantings(owner_id);

-- ============================================================
-- 2. OWNER_ID IMMUTABILITY (reuse existing function from 010)
-- ============================================================
DROP TRIGGER IF EXISTS plantings_owner_id_immutable ON public.plantings;
CREATE TRIGGER plantings_owner_id_immutable
  BEFORE UPDATE ON public.plantings
  FOR EACH ROW EXECUTE FUNCTION public.prevent_owner_id_change();

-- ============================================================
-- 3. UPDATED_AT (reuse existing function from 001)
-- ============================================================
DROP TRIGGER IF EXISTS plantings_updated_at ON public.plantings;
CREATE TRIGGER plantings_updated_at
  BEFORE UPDATE ON public.plantings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ============================================================
-- 4. CROSS-ORGANISATION INTEGRITY (authoritative, DB-enforced)
-- Guarantees the referenced block AND cultivar belong to the SAME
-- organisation as the planting. RLS alone cannot enforce this: a member of
-- Org A could otherwise insert a planting (org_id = A) referencing a block or
-- cultivar id belonging to Org B. SECURITY DEFINER so the checks read
-- blocks/cultivars without being blocked by their RLS; pinned search_path;
-- static SQL only; no client-controlled bypass.
-- ============================================================
CREATE OR REPLACE FUNCTION public.validate_planting_org_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  block_org    UUID;
  cultivar_org UUID;
BEGIN
  SELECT b.org_id INTO block_org FROM public.blocks b WHERE b.id = NEW.block_id;
  IF block_org IS NULL THEN
    RAISE EXCEPTION 'Invalid block: block % does not exist.', NEW.block_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF block_org <> NEW.org_id THEN
    RAISE EXCEPTION 'Cross-organisation reference: block % belongs to a different organisation.', NEW.block_id
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT c.org_id INTO cultivar_org FROM public.cultivars c WHERE c.id = NEW.cultivar_id;
  IF cultivar_org IS NULL THEN
    RAISE EXCEPTION 'Invalid cultivar: cultivar % does not exist.', NEW.cultivar_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF cultivar_org <> NEW.org_id THEN
    RAISE EXCEPTION 'Cross-organisation reference: cultivar % belongs to a different organisation.', NEW.cultivar_id
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS plantings_org_integrity ON public.plantings;
CREATE TRIGGER plantings_org_integrity
  BEFORE INSERT OR UPDATE ON public.plantings
  FOR EACH ROW EXECUTE FUNCTION public.validate_planting_org_integrity();

-- ============================================================
-- 5. ROW LEVEL SECURITY (org-membership based; four permissive policies)
-- ============================================================
ALTER TABLE public.plantings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view organisation plantings"
  ON public.plantings FOR SELECT
  USING (public.is_org_member(org_id));

CREATE POLICY "Users can insert organisation plantings"
  ON public.plantings FOR INSERT
  WITH CHECK (public.is_org_member(org_id) AND owner_id = auth.uid());

CREATE POLICY "Users can update organisation plantings"
  ON public.plantings FOR UPDATE
  USING (public.is_org_member(org_id))
  WITH CHECK (public.is_org_member(org_id));

CREATE POLICY "Users can delete organisation plantings"
  ON public.plantings FOR DELETE
  USING (public.is_org_member(org_id));

-- ============================================================
-- 6. POST-CHANGE VALIDATION (catalog checks). RAISE => rollback.
-- ============================================================
DO $$
DECLARE
  n INTEGER;
  rls_on BOOLEAN;
BEGIN
  IF to_regclass('public.plantings') IS NULL THEN
    RAISE EXCEPTION 'Post-check failed: public.plantings was not created.' USING ERRCODE = 'raise_exception';
  END IF;

  -- Expected columns present.
  SELECT COUNT(*) INTO n FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'plantings'
    AND column_name IN ('id','org_id','block_id','cultivar_id','owner_id',
                        'planting_year','area_hectares','rootstock','clone',
                        'status','notes','created_at','updated_at');
  IF n <> 13 THEN RAISE EXCEPTION 'Post-check failed: plantings columns mismatch (found %).', n USING ERRCODE = 'raise_exception'; END IF;

  -- NOT NULL columns.
  SELECT COUNT(*) INTO n FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'plantings'
    AND is_nullable = 'NO'
    AND column_name IN ('id','org_id','block_id','cultivar_id','owner_id','status','created_at','updated_at');
  IF n <> 8 THEN RAISE EXCEPTION 'Post-check failed: plantings NOT NULL columns mismatch (found %).', n USING ERRCODE = 'raise_exception'; END IF;

  -- Four foreign keys.
  SELECT COUNT(*) INTO n FROM information_schema.table_constraints
  WHERE table_schema = 'public' AND table_name = 'plantings' AND constraint_type = 'FOREIGN KEY';
  IF n <> 4 THEN RAISE EXCEPTION 'Post-check failed: plantings should have 4 FKs (found %).', n USING ERRCODE = 'raise_exception'; END IF;

  -- Indexes.
  SELECT COUNT(*) INTO n FROM pg_indexes
  WHERE schemaname = 'public' AND tablename = 'plantings'
    AND indexname IN ('idx_plantings_org_id','idx_plantings_block_id','idx_plantings_cultivar_id','idx_plantings_owner_id');
  IF n <> 4 THEN RAISE EXCEPTION 'Post-check failed: plantings indexes missing (found %).', n USING ERRCODE = 'raise_exception'; END IF;

  -- CHECK constraints (status + area).
  SELECT COUNT(*) INTO n FROM information_schema.table_constraints
  WHERE table_schema = 'public' AND table_name = 'plantings' AND constraint_type = 'CHECK'
    AND constraint_name IN ('plantings_status_check','plantings_area_non_negative');
  IF n <> 2 THEN RAISE EXCEPTION 'Post-check failed: plantings CHECK constraints missing (found %).', n USING ERRCODE = 'raise_exception'; END IF;

  -- RLS enabled.
  SELECT relrowsecurity INTO rls_on FROM pg_class WHERE oid = 'public.plantings'::regclass;
  IF NOT COALESCE(rls_on, false) THEN
    RAISE EXCEPTION 'Post-check failed: RLS not enabled on plantings.' USING ERRCODE = 'raise_exception';
  END IF;

  -- Exactly four policies, none owner-based.
  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname = 'public' AND tablename = 'plantings';
  IF n <> 4 THEN RAISE EXCEPTION 'Post-check failed: plantings has % policies (expected 4).', n USING ERRCODE = 'raise_exception'; END IF;

  SELECT COUNT(*) INTO n FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'plantings' AND policyname LIKE 'Users can % own %';
  IF n > 0 THEN RAISE EXCEPTION 'Post-check failed: plantings has % owner-based policy(ies).', n USING ERRCODE = 'raise_exception'; END IF;

  -- Triggers: owner immutability, updated_at, cross-org integrity.
  SELECT COUNT(*) INTO n FROM pg_trigger
  WHERE tgrelid = 'public.plantings'::regclass AND NOT tgisinternal
    AND tgname IN ('plantings_owner_id_immutable','plantings_updated_at','plantings_org_integrity');
  IF n <> 3 THEN RAISE EXCEPTION 'Post-check failed: plantings triggers missing (found %).', n USING ERRCODE = 'raise_exception'; END IF;

  -- No planting rows were inserted.
  SELECT COUNT(*) INTO n FROM public.plantings;
  IF n <> 0 THEN RAISE EXCEPTION 'Post-check failed: plantings must start empty (found % rows).', n USING ERRCODE = 'raise_exception'; END IF;

  -- Cross-org integrity function exists.
  IF to_regprocedure('public.validate_planting_org_integrity()') IS NULL THEN
    RAISE EXCEPTION 'Post-check failed: validate_planting_org_integrity() missing.' USING ERRCODE = 'raise_exception';
  END IF;
END $$;

COMMIT;
