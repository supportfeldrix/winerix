-- ============================================================
-- WINERIX — P2E: Wine Lots (physical/movable quantity of wine)
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- Depends on: 006 (organisations, is_org_member, update_updated_at),
--             010 (prevent_owner_id_change), 017 (wine_batches)
--
-- PURPOSE:
--   Create public.wine_lots — the physical, movable quantity of wine (in
--   litres) originating from a wine batch. Extends the traceability chain:
--   Wine Batch -> Wine Lot. Grape-intake / harvest / planting / cultivar /
--   block / vineyard remain DERIVED via the batch and are NEVER duplicated
--   here.
--
-- SCOPE — THIS MIGRATION ONLY:
--   Creates wine_lots + FKs + indexes + CHECKs + org-based RLS + owner_id
--   immutability + updated_at trigger + a cross-organisation integrity trigger.
--   No backfill.
--
-- THIS MIGRATION DOES NOT:
--   * modify wine_batches / grape_intakes / harvest / any existing table
--   * add parent_lot_id / lot_lineage / split / merge / blend columns or tables
--   * add current_vessel_id / vessel / vessel_placements
--   * add production-event / signed-delta / loss / adjustment / bottling /
--     inventory / audit-wiring structures
--   * duplicate vineyard_id / block_id / planting_id / cultivar_id / harvest_id
--     / grape_intake_id
--   * compute volume from grape kg (the user records volume explicitly)
--   * seed / backfill any data
--
-- INTEGRITY: RLS checks only wine_lots.org_id; a SECURITY DEFINER trigger
--   additionally guarantees the referenced wine_batch is same-org (mirrors
--   012/013/014/017).
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
  IF to_regclass('public.wine_batches') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.wine_batches is missing (run 017 first).' USING ERRCODE = 'undefined_table';
  END IF;
  IF to_regclass('public.wine_lots') IS NOT NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.wine_lots already exists.' USING ERRCODE = 'duplicate_table';
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
  -- wine_batches must carry org_id for the integrity check.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='wine_batches' AND column_name='org_id'
  ) THEN
    RAISE EXCEPTION 'Pre-flight failed: wine_batches.org_id is missing (run 017 first).' USING ERRCODE = 'undefined_column';
  END IF;
END $$;

-- ============================================================
-- 1. WINE_LOTS TABLE
-- volume_litres is the current-state quantity (explicitly recorded by the
-- user). No running-delta / loss / adjustment history — that belongs to the
-- future production-event layer. lot_code is the human identity, unique per
-- organisation.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.wine_lots (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL,
  owner_id       UUID NOT NULL,
  wine_batch_id  UUID NOT NULL,
  lot_code       TEXT NOT NULL,
  volume_litres  NUMERIC(12, 2) NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active',
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_wine_lots_org
    FOREIGN KEY (org_id) REFERENCES public.organisations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_wine_lots_owner
    FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE RESTRICT,
  -- Every lot originates from exactly one batch; RESTRICT protects lot history.
  CONSTRAINT fk_wine_lots_batch
    FOREIGN KEY (wine_batch_id) REFERENCES public.wine_batches(id) ON DELETE RESTRICT,

  -- lot_code must not be blank.
  CONSTRAINT wine_lots_lot_code_not_blank
    CHECK (length(btrim(lot_code)) > 0),

  -- Volume must be non-negative (litres, the canonical bulk-wine unit).
  CONSTRAINT wine_lots_volume_non_negative
    CHECK (volume_litres >= 0),

  -- Controlled status values (P2E: exactly these five).
  CONSTRAINT wine_lots_status_check
    CHECK (status IN ('active', 'in_production', 'bottled', 'depleted', 'archived'))
);

-- lot_code is unique WITHIN an organisation (never globally).
CREATE UNIQUE INDEX IF NOT EXISTS uq_wine_lots_org_lot_code
  ON public.wine_lots(org_id, lot_code);

CREATE INDEX IF NOT EXISTS idx_wine_lots_org_id        ON public.wine_lots(org_id);
CREATE INDEX IF NOT EXISTS idx_wine_lots_owner_id      ON public.wine_lots(owner_id);
CREATE INDEX IF NOT EXISTS idx_wine_lots_wine_batch_id ON public.wine_lots(wine_batch_id);
CREATE INDEX IF NOT EXISTS idx_wine_lots_status        ON public.wine_lots(status);

-- ============================================================
-- 2. OWNER_ID IMMUTABILITY (reuse existing function from 010)
-- ============================================================
DROP TRIGGER IF EXISTS wine_lots_owner_id_immutable ON public.wine_lots;
CREATE TRIGGER wine_lots_owner_id_immutable
  BEFORE UPDATE ON public.wine_lots
  FOR EACH ROW EXECUTE FUNCTION public.prevent_owner_id_change();

-- ============================================================
-- 3. UPDATED_AT (reuse existing function from 001)
-- ============================================================
DROP TRIGGER IF EXISTS wine_lots_updated_at ON public.wine_lots;
CREATE TRIGGER wine_lots_updated_at
  BEFORE UPDATE ON public.wine_lots
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ============================================================
-- 4. CROSS-ORGANISATION INTEGRITY (authoritative, DB-enforced)
-- Guarantees the referenced wine_batch exists and belongs to the SAME
-- organisation as the lot. SECURITY DEFINER so it reads wine_batches
-- regardless of RLS; pinned search_path; static SQL. Mirrors
-- validate_batch_grape_intake_org_integrity (017).
-- ============================================================
CREATE OR REPLACE FUNCTION public.validate_wine_lot_org_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  batch_org UUID;
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

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS wine_lots_org_integrity ON public.wine_lots;
CREATE TRIGGER wine_lots_org_integrity
  BEFORE INSERT OR UPDATE ON public.wine_lots
  FOR EACH ROW EXECUTE FUNCTION public.validate_wine_lot_org_integrity();

-- ============================================================
-- 5. ROW LEVEL SECURITY (org-membership based; four permissive policies)
-- ============================================================
ALTER TABLE public.wine_lots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view organisation wine lots"
  ON public.wine_lots FOR SELECT
  USING (public.is_org_member(org_id));

CREATE POLICY "Users can insert organisation wine lots"
  ON public.wine_lots FOR INSERT
  WITH CHECK (public.is_org_member(org_id) AND owner_id = auth.uid());

CREATE POLICY "Users can update organisation wine lots"
  ON public.wine_lots FOR UPDATE
  USING (public.is_org_member(org_id))
  WITH CHECK (public.is_org_member(org_id));

CREATE POLICY "Users can delete organisation wine lots"
  ON public.wine_lots FOR DELETE
  USING (public.is_org_member(org_id));

-- ============================================================
-- 6. TABLE PRIVILEGES FOR THE `authenticated` ROLE
-- RLS still decides which rows are visible/mutable (see 016 for why explicit
-- grants are required on manually-provisioned projects).
-- ============================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON public.wine_lots TO authenticated;

-- ============================================================
-- 7. POST-CHANGE VALIDATION (catalog checks). RAISE => rollback.
-- ============================================================
DO $$
DECLARE
  n INTEGER;
  rls_on BOOLEAN;
  delete_rule_val TEXT;
BEGIN
  IF to_regclass('public.wine_lots') IS NULL THEN
    RAISE EXCEPTION 'Post-check failed: public.wine_lots was not created.' USING ERRCODE = 'raise_exception';
  END IF;

  -- Expected columns present.
  SELECT COUNT(*) INTO n FROM information_schema.columns
  WHERE table_schema='public' AND table_name='wine_lots'
    AND column_name IN ('id','org_id','owner_id','wine_batch_id','lot_code','volume_litres','status','notes','created_at','updated_at');
  IF n <> 10 THEN RAISE EXCEPTION 'Post-check failed: wine_lots columns mismatch (found %).', n USING ERRCODE = 'raise_exception'; END IF;

  -- NOT NULL columns.
  SELECT COUNT(*) INTO n FROM information_schema.columns
  WHERE table_schema='public' AND table_name='wine_lots' AND is_nullable='NO'
    AND column_name IN ('id','org_id','owner_id','wine_batch_id','lot_code','volume_litres','status','created_at','updated_at');
  IF n <> 9 THEN RAISE EXCEPTION 'Post-check failed: wine_lots NOT NULL columns mismatch (found %).', n USING ERRCODE = 'raise_exception'; END IF;

  -- Three foreign keys.
  SELECT COUNT(*) INTO n FROM information_schema.table_constraints
  WHERE table_schema='public' AND table_name='wine_lots' AND constraint_type='FOREIGN KEY';
  IF n <> 3 THEN RAISE EXCEPTION 'Post-check failed: wine_lots should have 3 FKs (found %).', n USING ERRCODE = 'raise_exception'; END IF;

  -- Batch FK uses RESTRICT.
  SELECT rc.delete_rule INTO delete_rule_val
  FROM information_schema.referential_constraints rc
  JOIN information_schema.table_constraints tc
    ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema
  WHERE tc.table_schema='public' AND tc.table_name='wine_lots' AND tc.constraint_name='fk_wine_lots_batch';
  IF delete_rule_val IS NULL THEN
    RAISE EXCEPTION 'Post-check failed: fk_wine_lots_batch is missing.' USING ERRCODE = 'raise_exception';
  END IF;
  IF delete_rule_val <> 'NO ACTION' AND delete_rule_val <> 'RESTRICT' THEN
    RAISE EXCEPTION 'Post-check failed: batch FK must be RESTRICT (found %).', delete_rule_val USING ERRCODE = 'raise_exception';
  END IF;

  -- CHECK constraints.
  SELECT COUNT(*) INTO n FROM information_schema.table_constraints
  WHERE table_schema='public' AND table_name='wine_lots' AND constraint_type='CHECK'
    AND constraint_name IN ('wine_lots_lot_code_not_blank','wine_lots_volume_non_negative','wine_lots_status_check');
  IF n <> 3 THEN RAISE EXCEPTION 'Post-check failed: wine_lots CHECK constraints missing (found %).', n USING ERRCODE = 'raise_exception'; END IF;

  -- Org-scoped unique lot_code index present.
  SELECT COUNT(*) INTO n FROM pg_indexes
  WHERE schemaname='public' AND tablename='wine_lots' AND indexname='uq_wine_lots_org_lot_code';
  IF n <> 1 THEN RAISE EXCEPTION 'Post-check failed: uq_wine_lots_org_lot_code missing.' USING ERRCODE = 'raise_exception'; END IF;

  SELECT COUNT(*) INTO n FROM pg_indexes
  WHERE schemaname='public' AND tablename='wine_lots'
    AND indexname IN ('idx_wine_lots_org_id','idx_wine_lots_owner_id','idx_wine_lots_wine_batch_id','idx_wine_lots_status');
  IF n <> 4 THEN RAISE EXCEPTION 'Post-check failed: wine_lots indexes missing (found %).', n USING ERRCODE = 'raise_exception'; END IF;

  -- RLS enabled.
  SELECT relrowsecurity INTO rls_on FROM pg_class WHERE oid='public.wine_lots'::regclass;
  IF NOT COALESCE(rls_on, false) THEN
    RAISE EXCEPTION 'Post-check failed: RLS not enabled on wine_lots.' USING ERRCODE = 'raise_exception';
  END IF;

  -- Exactly four policies, none owner-based.
  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='wine_lots';
  IF n <> 4 THEN RAISE EXCEPTION 'Post-check failed: wine_lots has % policies (expected 4).', n USING ERRCODE = 'raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_policies
  WHERE schemaname='public' AND tablename='wine_lots' AND policyname LIKE 'Users can % own %';
  IF n > 0 THEN RAISE EXCEPTION 'Post-check failed: wine_lots has % owner-based policy(ies).', n USING ERRCODE = 'raise_exception'; END IF;

  -- Triggers: owner immutability, updated_at, cross-org integrity.
  SELECT COUNT(*) INTO n FROM pg_trigger
  WHERE tgrelid='public.wine_lots'::regclass AND NOT tgisinternal
    AND tgname IN ('wine_lots_owner_id_immutable','wine_lots_updated_at','wine_lots_org_integrity');
  IF n <> 3 THEN RAISE EXCEPTION 'Post-check failed: wine_lots triggers missing (found %).', n USING ERRCODE = 'raise_exception'; END IF;

  -- Integrity function exists and is SECURITY DEFINER.
  IF to_regprocedure('public.validate_wine_lot_org_integrity()') IS NULL THEN
    RAISE EXCEPTION 'Post-check failed: validate_wine_lot_org_integrity() missing.' USING ERRCODE = 'raise_exception';
  END IF;
  SELECT COUNT(*) INTO n FROM pg_proc
  WHERE oid='public.validate_wine_lot_org_integrity()'::regprocedure AND prosecdef = true;
  IF n <> 1 THEN RAISE EXCEPTION 'Post-check failed: validate_wine_lot_org_integrity() must be SECURITY DEFINER.' USING ERRCODE = 'raise_exception'; END IF;

  -- Table starts empty (no backfill).
  SELECT COUNT(*) INTO n FROM public.wine_lots;
  IF n <> 0 THEN RAISE EXCEPTION 'Post-check failed: wine_lots must start empty (found % rows).', n USING ERRCODE = 'raise_exception'; END IF;
END $$;

COMMIT;
