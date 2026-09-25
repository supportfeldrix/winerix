-- ============================================================
-- WINERIX — P2F: Cellar Vessels + Wine Lot Vessel Placement
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- Depends on: 006 (organisations, is_org_member, update_updated_at),
--             010 (prevent_owner_id_change), 018 (wine_lots)
--
-- PURPOSE:
--   Create public.vessels — durable cellar assets (tanks/barrels/other) — and
--   public.vessel_placements — the append-only history of which wine lot
--   occupies which vessel and when. Extends the traceability chain:
--   Wine Lot -> Vessel Placement -> Vessel.
--
--   The CURRENT vessel of a lot is derived from its OPEN placement
--   (removed_at IS NULL). There is deliberately NO current_vessel_id on
--   wine_lots — the placement history is the single source of truth.
--
-- SCOPE — THIS MIGRATION ONLY:
--   Creates vessels + vessel_placements + FKs + indexes + CHECKs + org-based
--   RLS + owner_id immutability + updated_at triggers + a cross-organisation
--   integrity trigger on placements + a partial unique index enforcing at most
--   one OPEN placement per wine lot. No backfill.
--
-- THIS MIGRATION DOES NOT:
--   * modify wine_lots / wine_batches / any existing table
--   * add current_vessel_id / vessel_id / mutable current_volume anywhere
--   * add parent_lot_id / split / merge / blend / production-event / bottling /
--     stock / inventory / audit-wiring structures
--   * restrict multiple lots from coexisting in one vessel (the open-placement
--     uniqueness is PER LOT, not per vessel)
--   * enforce capacity as a hard constraint (capacity is a UI/service warning)
--   * seed / backfill any data
--
-- INTEGRITY: RLS checks only <table>.org_id; a SECURITY DEFINER trigger
--   additionally guarantees a placement's wine_lot AND vessel are same-org
--   (mirrors 012/013/014/017/018).
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
  IF to_regclass('public.vessels') IS NOT NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.vessels already exists.' USING ERRCODE = 'duplicate_table';
  END IF;
  IF to_regclass('public.vessel_placements') IS NOT NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.vessel_placements already exists.' USING ERRCODE = 'duplicate_table';
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
  -- wine_lots must carry org_id for the integrity check.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='wine_lots' AND column_name='org_id'
  ) THEN
    RAISE EXCEPTION 'Pre-flight failed: wine_lots.org_id is missing (run 018 first).' USING ERRCODE = 'undefined_column';
  END IF;
END $$;

-- ============================================================
-- 1. VESSELS TABLE
-- Durable cellar assets. NO mutable current_volume column — current volume is
-- always derived by summing OPEN placements for the vessel.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.vessels (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL,
  owner_id        UUID NOT NULL,
  vessel_code     TEXT NOT NULL,
  name            TEXT,
  vessel_type     TEXT NOT NULL DEFAULT 'tank',
  capacity_litres NUMERIC(12, 2),
  location        TEXT,
  status          TEXT NOT NULL DEFAULT 'active',
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_vessels_org
    FOREIGN KEY (org_id) REFERENCES public.organisations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_vessels_owner
    FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE RESTRICT,

  -- vessel_code must not be blank.
  CONSTRAINT vessels_vessel_code_not_blank
    CHECK (length(btrim(vessel_code)) > 0),

  -- Capacity must be non-negative when provided.
  CONSTRAINT vessels_capacity_non_negative
    CHECK (capacity_litres IS NULL OR capacity_litres >= 0),

  -- Controlled vessel types (P2F: exactly these three).
  CONSTRAINT vessels_vessel_type_check
    CHECK (vessel_type IN ('tank', 'barrel', 'other')),

  -- Controlled status values (P2F: exactly these four).
  CONSTRAINT vessels_status_check
    CHECK (status IN ('active', 'inactive', 'maintenance', 'retired'))
);

-- vessel_code is unique WITHIN an organisation, case-insensitively (never global).
CREATE UNIQUE INDEX IF NOT EXISTS uq_vessels_org_vessel_code
  ON public.vessels(org_id, lower(vessel_code));

CREATE INDEX IF NOT EXISTS idx_vessels_org_id      ON public.vessels(org_id);
CREATE INDEX IF NOT EXISTS idx_vessels_owner_id    ON public.vessels(owner_id);
CREATE INDEX IF NOT EXISTS idx_vessels_vessel_type ON public.vessels(vessel_type);
CREATE INDEX IF NOT EXISTS idx_vessels_status      ON public.vessels(status);

-- ============================================================
-- 2. VESSEL_PLACEMENTS TABLE (append-only occupancy history)
-- An OPEN placement (removed_at IS NULL) means the lot currently occupies the
-- vessel. A partial unique index enforces at most ONE open placement per lot
-- (per lot, NOT per vessel — many lots may share a vessel).
-- ============================================================
CREATE TABLE IF NOT EXISTS public.vessel_placements (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL,
  owner_id       UUID NOT NULL,
  wine_lot_id    UUID NOT NULL,
  vessel_id      UUID NOT NULL,
  volume_litres  NUMERIC(12, 2) NOT NULL,
  placed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  removed_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_vp_org
    FOREIGN KEY (org_id) REFERENCES public.organisations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_vp_owner
    FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_vp_wine_lot
    FOREIGN KEY (wine_lot_id) REFERENCES public.wine_lots(id) ON DELETE RESTRICT,
  CONSTRAINT fk_vp_vessel
    FOREIGN KEY (vessel_id) REFERENCES public.vessels(id) ON DELETE RESTRICT,

  -- Volume must be non-negative.
  CONSTRAINT vp_volume_non_negative
    CHECK (volume_litres >= 0),

  -- removed_at, when present, must not precede placed_at.
  CONSTRAINT vp_removed_after_placed
    CHECK (removed_at IS NULL OR removed_at >= placed_at)
);

CREATE INDEX IF NOT EXISTS idx_vp_org_id      ON public.vessel_placements(org_id);
CREATE INDEX IF NOT EXISTS idx_vp_wine_lot_id ON public.vessel_placements(wine_lot_id);
CREATE INDEX IF NOT EXISTS idx_vp_vessel_id   ON public.vessel_placements(vessel_id);
CREATE INDEX IF NOT EXISTS idx_vp_placed_at   ON public.vessel_placements(placed_at);
CREATE INDEX IF NOT EXISTS idx_vp_removed_at  ON public.vessel_placements(removed_at);

-- CRITICAL: at most one OPEN placement per wine lot (per lot, not per vessel).
CREATE UNIQUE INDEX IF NOT EXISTS uq_vp_one_open_per_lot
  ON public.vessel_placements(wine_lot_id)
  WHERE removed_at IS NULL;

-- ============================================================
-- 3. OWNER_ID IMMUTABILITY (reuse existing function from 010)
-- ============================================================
DROP TRIGGER IF EXISTS vessels_owner_id_immutable ON public.vessels;
CREATE TRIGGER vessels_owner_id_immutable
  BEFORE UPDATE ON public.vessels
  FOR EACH ROW EXECUTE FUNCTION public.prevent_owner_id_change();

DROP TRIGGER IF EXISTS vessel_placements_owner_id_immutable ON public.vessel_placements;
CREATE TRIGGER vessel_placements_owner_id_immutable
  BEFORE UPDATE ON public.vessel_placements
  FOR EACH ROW EXECUTE FUNCTION public.prevent_owner_id_change();

-- ============================================================
-- 4. UPDATED_AT (reuse existing function from 001)
-- ============================================================
DROP TRIGGER IF EXISTS vessels_updated_at ON public.vessels;
CREATE TRIGGER vessels_updated_at
  BEFORE UPDATE ON public.vessels
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS vessel_placements_updated_at ON public.vessel_placements;
CREATE TRIGGER vessel_placements_updated_at
  BEFORE UPDATE ON public.vessel_placements
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ============================================================
-- 5. CROSS-ORGANISATION INTEGRITY (authoritative, DB-enforced)
-- Guarantees the referenced wine_lot AND vessel both exist and belong to the
-- SAME organisation as the placement. SECURITY DEFINER so it reads
-- wine_lots/vessels regardless of RLS; pinned search_path; static SQL.
-- Mirrors validate_batch_grape_intake_org_integrity (017).
-- ============================================================
CREATE OR REPLACE FUNCTION public.validate_vessel_placement_org_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  lot_org    UUID;
  vessel_org UUID;
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

  SELECT v.org_id INTO vessel_org FROM public.vessels v WHERE v.id = NEW.vessel_id;
  IF vessel_org IS NULL THEN
    RAISE EXCEPTION 'Invalid vessel: vessel % does not exist.', NEW.vessel_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF vessel_org <> NEW.org_id THEN
    RAISE EXCEPTION 'Cross-organisation reference: vessel % belongs to a different organisation.', NEW.vessel_id
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS vessel_placements_org_integrity ON public.vessel_placements;
CREATE TRIGGER vessel_placements_org_integrity
  BEFORE INSERT OR UPDATE ON public.vessel_placements
  FOR EACH ROW EXECUTE FUNCTION public.validate_vessel_placement_org_integrity();

-- ============================================================
-- 6. ROW LEVEL SECURITY (org-membership based; four permissive policies each)
-- ============================================================
ALTER TABLE public.vessels ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view organisation vessels"
  ON public.vessels FOR SELECT
  USING (public.is_org_member(org_id));

CREATE POLICY "Users can insert organisation vessels"
  ON public.vessels FOR INSERT
  WITH CHECK (public.is_org_member(org_id) AND owner_id = auth.uid());

CREATE POLICY "Users can update organisation vessels"
  ON public.vessels FOR UPDATE
  USING (public.is_org_member(org_id))
  WITH CHECK (public.is_org_member(org_id));

CREATE POLICY "Users can delete organisation vessels"
  ON public.vessels FOR DELETE
  USING (public.is_org_member(org_id));

ALTER TABLE public.vessel_placements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view organisation vessel placements"
  ON public.vessel_placements FOR SELECT
  USING (public.is_org_member(org_id));

CREATE POLICY "Users can insert organisation vessel placements"
  ON public.vessel_placements FOR INSERT
  WITH CHECK (public.is_org_member(org_id) AND owner_id = auth.uid());

CREATE POLICY "Users can update organisation vessel placements"
  ON public.vessel_placements FOR UPDATE
  USING (public.is_org_member(org_id))
  WITH CHECK (public.is_org_member(org_id));

CREATE POLICY "Users can delete organisation vessel placements"
  ON public.vessel_placements FOR DELETE
  USING (public.is_org_member(org_id));

-- ============================================================
-- 7. TABLE PRIVILEGES FOR THE `authenticated` ROLE
-- RLS still decides which rows are visible/mutable (see 016 for why explicit
-- grants are required on manually-provisioned projects).
-- ============================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON public.vessels           TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.vessel_placements TO authenticated;

-- ============================================================
-- 8. POST-CHANGE VALIDATION (catalog checks). RAISE => rollback.
-- ============================================================
DO $$
DECLARE
  n INTEGER;
  rls_on BOOLEAN;
BEGIN
  -- ---- vessels ---------------------------------------------------------
  IF to_regclass('public.vessels') IS NULL THEN
    RAISE EXCEPTION 'Post-check failed: public.vessels was not created.' USING ERRCODE = 'raise_exception';
  END IF;

  SELECT COUNT(*) INTO n FROM information_schema.columns
  WHERE table_schema='public' AND table_name='vessels'
    AND column_name IN ('id','org_id','owner_id','vessel_code','name','vessel_type','capacity_litres','location','status','notes','created_at','updated_at');
  IF n <> 12 THEN RAISE EXCEPTION 'Post-check failed: vessels columns mismatch (found %).', n USING ERRCODE = 'raise_exception'; END IF;

  SELECT COUNT(*) INTO n FROM information_schema.columns
  WHERE table_schema='public' AND table_name='vessels' AND is_nullable='NO'
    AND column_name IN ('id','org_id','owner_id','vessel_code','vessel_type','status','created_at','updated_at');
  IF n <> 8 THEN RAISE EXCEPTION 'Post-check failed: vessels NOT NULL columns mismatch (found %).', n USING ERRCODE = 'raise_exception'; END IF;

  SELECT COUNT(*) INTO n FROM information_schema.table_constraints
  WHERE table_schema='public' AND table_name='vessels' AND constraint_type='FOREIGN KEY';
  IF n <> 2 THEN RAISE EXCEPTION 'Post-check failed: vessels should have 2 FKs (found %).', n USING ERRCODE = 'raise_exception'; END IF;

  SELECT COUNT(*) INTO n FROM information_schema.table_constraints
  WHERE table_schema='public' AND table_name='vessels' AND constraint_type='CHECK'
    AND constraint_name IN ('vessels_vessel_code_not_blank','vessels_capacity_non_negative','vessels_vessel_type_check','vessels_status_check');
  IF n <> 4 THEN RAISE EXCEPTION 'Post-check failed: vessels CHECK constraints missing (found %).', n USING ERRCODE = 'raise_exception'; END IF;

  SELECT COUNT(*) INTO n FROM pg_indexes
  WHERE schemaname='public' AND tablename='vessels' AND indexname='uq_vessels_org_vessel_code';
  IF n <> 1 THEN RAISE EXCEPTION 'Post-check failed: uq_vessels_org_vessel_code missing.' USING ERRCODE = 'raise_exception'; END IF;

  SELECT COUNT(*) INTO n FROM pg_indexes
  WHERE schemaname='public' AND tablename='vessels'
    AND indexname IN ('idx_vessels_org_id','idx_vessels_owner_id','idx_vessels_vessel_type','idx_vessels_status');
  IF n <> 4 THEN RAISE EXCEPTION 'Post-check failed: vessels indexes missing (found %).', n USING ERRCODE = 'raise_exception'; END IF;

  SELECT relrowsecurity INTO rls_on FROM pg_class WHERE oid='public.vessels'::regclass;
  IF NOT COALESCE(rls_on, false) THEN
    RAISE EXCEPTION 'Post-check failed: RLS not enabled on vessels.' USING ERRCODE = 'raise_exception';
  END IF;

  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='vessels';
  IF n <> 4 THEN RAISE EXCEPTION 'Post-check failed: vessels has % policies (expected 4).', n USING ERRCODE = 'raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_policies
  WHERE schemaname='public' AND tablename='vessels' AND policyname LIKE 'Users can % own %';
  IF n > 0 THEN RAISE EXCEPTION 'Post-check failed: vessels has % owner-based policy(ies).', n USING ERRCODE = 'raise_exception'; END IF;

  SELECT COUNT(*) INTO n FROM pg_trigger
  WHERE tgrelid='public.vessels'::regclass AND NOT tgisinternal
    AND tgname IN ('vessels_owner_id_immutable','vessels_updated_at');
  IF n <> 2 THEN RAISE EXCEPTION 'Post-check failed: vessels triggers missing (found %).', n USING ERRCODE = 'raise_exception'; END IF;

  SELECT COUNT(*) INTO n FROM public.vessels;
  IF n <> 0 THEN RAISE EXCEPTION 'Post-check failed: vessels must start empty (found % rows).', n USING ERRCODE = 'raise_exception'; END IF;

  -- ---- vessel_placements ----------------------------------------------
  IF to_regclass('public.vessel_placements') IS NULL THEN
    RAISE EXCEPTION 'Post-check failed: public.vessel_placements was not created.' USING ERRCODE = 'raise_exception';
  END IF;

  SELECT COUNT(*) INTO n FROM information_schema.columns
  WHERE table_schema='public' AND table_name='vessel_placements'
    AND column_name IN ('id','org_id','owner_id','wine_lot_id','vessel_id','volume_litres','placed_at','removed_at','created_at','updated_at');
  IF n <> 10 THEN RAISE EXCEPTION 'Post-check failed: vessel_placements columns mismatch (found %).', n USING ERRCODE = 'raise_exception'; END IF;

  SELECT COUNT(*) INTO n FROM information_schema.columns
  WHERE table_schema='public' AND table_name='vessel_placements' AND is_nullable='NO'
    AND column_name IN ('id','org_id','owner_id','wine_lot_id','vessel_id','volume_litres','placed_at','created_at','updated_at');
  IF n <> 9 THEN RAISE EXCEPTION 'Post-check failed: vessel_placements NOT NULL columns mismatch (found %).', n USING ERRCODE = 'raise_exception'; END IF;

  SELECT COUNT(*) INTO n FROM information_schema.table_constraints
  WHERE table_schema='public' AND table_name='vessel_placements' AND constraint_type='FOREIGN KEY';
  IF n <> 4 THEN RAISE EXCEPTION 'Post-check failed: vessel_placements should have 4 FKs (found %).', n USING ERRCODE = 'raise_exception'; END IF;

  SELECT COUNT(*) INTO n FROM information_schema.table_constraints
  WHERE table_schema='public' AND table_name='vessel_placements' AND constraint_type='CHECK'
    AND constraint_name IN ('vp_volume_non_negative','vp_removed_after_placed');
  IF n <> 2 THEN RAISE EXCEPTION 'Post-check failed: vessel_placements CHECK constraints missing (found %).', n USING ERRCODE = 'raise_exception'; END IF;

  SELECT COUNT(*) INTO n FROM pg_indexes
  WHERE schemaname='public' AND tablename='vessel_placements'
    AND indexname IN ('idx_vp_org_id','idx_vp_wine_lot_id','idx_vp_vessel_id','idx_vp_placed_at','idx_vp_removed_at');
  IF n <> 5 THEN RAISE EXCEPTION 'Post-check failed: vessel_placements indexes missing (found %).', n USING ERRCODE = 'raise_exception'; END IF;

  -- Partial unique index for one open placement per lot.
  SELECT COUNT(*) INTO n FROM pg_indexes
  WHERE schemaname='public' AND tablename='vessel_placements' AND indexname='uq_vp_one_open_per_lot';
  IF n <> 1 THEN RAISE EXCEPTION 'Post-check failed: uq_vp_one_open_per_lot missing.' USING ERRCODE = 'raise_exception'; END IF;

  SELECT relrowsecurity INTO rls_on FROM pg_class WHERE oid='public.vessel_placements'::regclass;
  IF NOT COALESCE(rls_on, false) THEN
    RAISE EXCEPTION 'Post-check failed: RLS not enabled on vessel_placements.' USING ERRCODE = 'raise_exception';
  END IF;

  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='vessel_placements';
  IF n <> 4 THEN RAISE EXCEPTION 'Post-check failed: vessel_placements has % policies (expected 4).', n USING ERRCODE = 'raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_policies
  WHERE schemaname='public' AND tablename='vessel_placements' AND policyname LIKE 'Users can % own %';
  IF n > 0 THEN RAISE EXCEPTION 'Post-check failed: vessel_placements has % owner-based policy(ies).', n USING ERRCODE = 'raise_exception'; END IF;

  SELECT COUNT(*) INTO n FROM pg_trigger
  WHERE tgrelid='public.vessel_placements'::regclass AND NOT tgisinternal
    AND tgname IN ('vessel_placements_owner_id_immutable','vessel_placements_updated_at','vessel_placements_org_integrity');
  IF n <> 3 THEN RAISE EXCEPTION 'Post-check failed: vessel_placements triggers missing (found %).', n USING ERRCODE = 'raise_exception'; END IF;

  IF to_regprocedure('public.validate_vessel_placement_org_integrity()') IS NULL THEN
    RAISE EXCEPTION 'Post-check failed: validate_vessel_placement_org_integrity() missing.' USING ERRCODE = 'raise_exception';
  END IF;
  SELECT COUNT(*) INTO n FROM pg_proc
  WHERE oid='public.validate_vessel_placement_org_integrity()'::regprocedure AND prosecdef = true;
  IF n <> 1 THEN RAISE EXCEPTION 'Post-check failed: validate_vessel_placement_org_integrity() must be SECURITY DEFINER.' USING ERRCODE = 'raise_exception'; END IF;

  SELECT COUNT(*) INTO n FROM public.vessel_placements;
  IF n <> 0 THEN RAISE EXCEPTION 'Post-check failed: vessel_placements must start empty (found % rows).', n USING ERRCODE = 'raise_exception'; END IF;
END $$;

COMMIT;
