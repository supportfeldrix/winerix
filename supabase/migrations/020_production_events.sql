-- ============================================================
-- WINERIX — P2G-1: Production Events (immutable cellar processing history)
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- Depends on: 006 (organisations, is_org_member, has_org_role),
--             018 (wine_lots), 019 (vessels, vessel_placements)
--
-- PURPOSE:
--   Create public.production_events — an IMMUTABLE, per-wine-lot record of
--   cellar operations ("what happened to this lot, when, optionally in which
--   vessel/placement"). Extends traceability: Wine Lot -> Production Event ->
--   optional Vessel / Vessel Placement.
--
--   Production events are DESCRIPTIVE HISTORY ONLY. They are NOT a source of
--   truth for wine volume, vessel location, inventory, or lot lineage. Those
--   remain:
--     LOCATION -> vessel_placements
--     VOLUME   -> wine_lots.volume_litres
--   Events NEVER mutate wine_lots.volume_litres and NEVER create/close/modify
--   vessel_placements.
--
-- SCOPE — THIS MIGRATION ONLY:
--   Creates production_events + FKs + indexes + a controlled event_type CHECK +
--   org-based, ROLE-SCOPED, APPEND-ONLY RLS + a cross-organisation / relational
--   integrity trigger. No backfill.
--
-- IMMUTABILITY (append-only): the table grants only SELECT + INSERT to the
--   `authenticated` role and defines only SELECT + INSERT policies. There is no
--   UPDATE or DELETE grant and no UPDATE/DELETE policy, so events cannot be
--   altered or removed by ordinary clients once created. Because there is no
--   UPDATE path, the owner_id-immutability and updated_at triggers used by
--   mutable tables are intentionally NOT attached here (they would be dead
--   code). updated_at exists only to mirror the standard row shape and always
--   equals created_at.
--
-- THIS MIGRATION DOES NOT:
--   * modify wine_lots / vessels / vessel_placements / audit_log / any existing
--     table (no audit wiring — that is P2G-2)
--   * add volume_delta / quantity / resulting_volume / parent_lot_id /
--     child_lot_id / batch_id / current_vessel_id / inventory / blend / bottling
--     fields
--   * add crush / press / blend / split / merge / loss event types
--   * mutate volume or placements
--   * seed / backfill any data
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
  IF to_regclass('public.vessels') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.vessels is missing (run 019 first).' USING ERRCODE = 'undefined_table';
  END IF;
  IF to_regclass('public.vessel_placements') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.vessel_placements is missing (run 019 first).' USING ERRCODE = 'undefined_table';
  END IF;
  IF to_regclass('public.production_events') IS NOT NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.production_events already exists.' USING ERRCODE = 'duplicate_table';
  END IF;
  IF to_regprocedure('public.is_org_member(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.is_org_member(uuid) is missing (run 006 first).' USING ERRCODE = 'undefined_function';
  END IF;
  IF to_regprocedure('public.has_org_role(uuid, text[])') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.has_org_role(uuid, text[]) is missing (run 006 first).' USING ERRCODE = 'undefined_function';
  END IF;
  -- wine_lots / vessels / vessel_placements must carry org_id for integrity checks.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='wine_lots' AND column_name='org_id') THEN
    RAISE EXCEPTION 'Pre-flight failed: wine_lots.org_id is missing (run 018 first).' USING ERRCODE = 'undefined_column';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='vessel_placements' AND column_name='wine_lot_id') THEN
    RAISE EXCEPTION 'Pre-flight failed: vessel_placements.wine_lot_id is missing (run 019 first).' USING ERRCODE = 'undefined_column';
  END IF;
END $$;

-- ============================================================
-- 1. PRODUCTION_EVENTS TABLE
-- One row = one cellar operation performed on one wine lot at a point in time.
-- No volume/quantity columns — events do not control volume.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.production_events (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               UUID NOT NULL,
  owner_id             UUID NOT NULL,
  wine_lot_id          UUID NOT NULL,
  vessel_id            UUID,
  vessel_placement_id  UUID,
  event_type           TEXT NOT NULL,
  event_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_pe_org
    FOREIGN KEY (org_id) REFERENCES public.organisations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_pe_owner
    FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_pe_wine_lot
    FOREIGN KEY (wine_lot_id) REFERENCES public.wine_lots(id) ON DELETE RESTRICT,
  CONSTRAINT fk_pe_vessel
    FOREIGN KEY (vessel_id) REFERENCES public.vessels(id) ON DELETE RESTRICT,
  CONSTRAINT fk_pe_vessel_placement
    FOREIGN KEY (vessel_placement_id) REFERENCES public.vessel_placements(id) ON DELETE RESTRICT,

  -- Controlled event vocabulary (P2G-1: exactly these; NO crush/press/blend/
  -- split/merge/loss — those belong to later architecture).
  CONSTRAINT production_events_event_type_check
    CHECK (event_type IN (
      'transfer','racking','settling','fermentation','maturation',
      'filtration','addition','adjustment','other'
    ))
);

CREATE INDEX IF NOT EXISTS idx_pe_org_id              ON public.production_events(org_id);
CREATE INDEX IF NOT EXISTS idx_pe_owner_id            ON public.production_events(owner_id);
CREATE INDEX IF NOT EXISTS idx_pe_wine_lot_id         ON public.production_events(wine_lot_id);
CREATE INDEX IF NOT EXISTS idx_pe_vessel_id           ON public.production_events(vessel_id);
CREATE INDEX IF NOT EXISTS idx_pe_vessel_placement_id ON public.production_events(vessel_placement_id);
CREATE INDEX IF NOT EXISTS idx_pe_event_type          ON public.production_events(event_type);
CREATE INDEX IF NOT EXISTS idx_pe_event_at            ON public.production_events(event_at);

-- ============================================================
-- 2. CROSS-ORGANISATION / RELATIONAL INTEGRITY (authoritative, DB-enforced)
-- SECURITY DEFINER so it reads wine_lots/vessels/vessel_placements regardless of
-- RLS; pinned search_path; static SQL. BEFORE INSERT (events are append-only, so
-- no UPDATE path to validate). Mirrors the 017/019 integrity pattern.
-- ============================================================
CREATE OR REPLACE FUNCTION public.validate_production_event_org_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  lot_org         UUID;
  vessel_org      UUID;
  placement_org   UUID;
  placement_lot   UUID;
  placement_vessel UUID;
BEGIN
  -- 1/2. wine_lot exists and is same-org.
  SELECT wl.org_id INTO lot_org FROM public.wine_lots wl WHERE wl.id = NEW.wine_lot_id;
  IF lot_org IS NULL THEN
    RAISE EXCEPTION 'Invalid wine lot: lot % does not exist.', NEW.wine_lot_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF lot_org <> NEW.org_id THEN
    RAISE EXCEPTION 'Cross-organisation reference: wine lot % belongs to a different organisation.', NEW.wine_lot_id
      USING ERRCODE = 'raise_exception';
  END IF;

  -- 3/4. vessel (optional) exists and is same-org.
  IF NEW.vessel_id IS NOT NULL THEN
    SELECT v.org_id INTO vessel_org FROM public.vessels v WHERE v.id = NEW.vessel_id;
    IF vessel_org IS NULL THEN
      RAISE EXCEPTION 'Invalid vessel: vessel % does not exist.', NEW.vessel_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF vessel_org <> NEW.org_id THEN
      RAISE EXCEPTION 'Cross-organisation reference: vessel % belongs to a different organisation.', NEW.vessel_id
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;

  -- 5/6/7. placement (optional) exists, is same-org, and belongs to this lot.
  IF NEW.vessel_placement_id IS NOT NULL THEN
    SELECT vp.org_id, vp.wine_lot_id, vp.vessel_id
      INTO placement_org, placement_lot, placement_vessel
    FROM public.vessel_placements vp WHERE vp.id = NEW.vessel_placement_id;
    IF placement_org IS NULL THEN
      RAISE EXCEPTION 'Invalid placement: placement % does not exist.', NEW.vessel_placement_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF placement_org <> NEW.org_id THEN
      RAISE EXCEPTION 'Cross-organisation reference: placement % belongs to a different organisation.', NEW.vessel_placement_id
        USING ERRCODE = 'raise_exception';
    END IF;
    IF placement_lot <> NEW.wine_lot_id THEN
      RAISE EXCEPTION 'Placement mismatch: placement % does not belong to wine lot %.', NEW.vessel_placement_id, NEW.wine_lot_id
        USING ERRCODE = 'raise_exception';
    END IF;
    -- 8. if both vessel and placement supplied, the placement must be in that vessel.
    IF NEW.vessel_id IS NOT NULL AND placement_vessel <> NEW.vessel_id THEN
      RAISE EXCEPTION 'Placement/vessel mismatch: placement % is not in vessel %.', NEW.vessel_placement_id, NEW.vessel_id
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS production_events_org_integrity ON public.production_events;
CREATE TRIGGER production_events_org_integrity
  BEFORE INSERT ON public.production_events
  FOR EACH ROW EXECUTE FUNCTION public.validate_production_event_org_integrity();

-- ============================================================
-- 3. ROW LEVEL SECURITY — APPEND-ONLY, ROLE-SCOPED WRITES
-- SELECT: any active org member may read history.
-- INSERT: only OWNER / ADMIN / CELLAR may record events.
-- No UPDATE or DELETE policy is defined => events are immutable to clients
-- (combined with withholding UPDATE/DELETE grants below).
-- ============================================================
ALTER TABLE public.production_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view organisation production events"
  ON public.production_events FOR SELECT
  USING (public.is_org_member(org_id));

CREATE POLICY "Cellar roles can insert organisation production events"
  ON public.production_events FOR INSERT
  WITH CHECK (
    public.is_org_member(org_id)
    AND owner_id = auth.uid()
    AND public.has_org_role(org_id, ARRAY['OWNER','ADMIN','CELLAR'])
  );

-- ============================================================
-- 4. TABLE PRIVILEGES — SELECT + INSERT ONLY (append-only)
-- No UPDATE / DELETE grant: reinforces immutability at the privilege layer as
-- well as the policy layer. (See 016 for why explicit grants are required.)
-- ============================================================
GRANT SELECT, INSERT ON public.production_events TO authenticated;

-- ============================================================
-- 5. POST-CHANGE VALIDATION (catalog checks). RAISE => rollback.
-- ============================================================
DO $$
DECLARE
  n INTEGER;
  rls_on BOOLEAN;
BEGIN
  IF to_regclass('public.production_events') IS NULL THEN
    RAISE EXCEPTION 'Post-check failed: public.production_events was not created.' USING ERRCODE = 'raise_exception';
  END IF;

  -- Expected columns present.
  SELECT COUNT(*) INTO n FROM information_schema.columns
  WHERE table_schema='public' AND table_name='production_events'
    AND column_name IN ('id','org_id','owner_id','wine_lot_id','vessel_id','vessel_placement_id','event_type','event_at','notes','created_at','updated_at');
  IF n <> 11 THEN RAISE EXCEPTION 'Post-check failed: production_events columns mismatch (found %).', n USING ERRCODE = 'raise_exception'; END IF;

  -- NOT NULL columns.
  SELECT COUNT(*) INTO n FROM information_schema.columns
  WHERE table_schema='public' AND table_name='production_events' AND is_nullable='NO'
    AND column_name IN ('id','org_id','owner_id','wine_lot_id','event_type','event_at','created_at','updated_at');
  IF n <> 8 THEN RAISE EXCEPTION 'Post-check failed: production_events NOT NULL columns mismatch (found %).', n USING ERRCODE = 'raise_exception'; END IF;

  -- vessel_id / vessel_placement_id are nullable.
  SELECT COUNT(*) INTO n FROM information_schema.columns
  WHERE table_schema='public' AND table_name='production_events' AND is_nullable='YES'
    AND column_name IN ('vessel_id','vessel_placement_id','notes');
  IF n <> 3 THEN RAISE EXCEPTION 'Post-check failed: production_events nullable columns mismatch (found %).', n USING ERRCODE = 'raise_exception'; END IF;

  -- Five foreign keys.
  SELECT COUNT(*) INTO n FROM information_schema.table_constraints
  WHERE table_schema='public' AND table_name='production_events' AND constraint_type='FOREIGN KEY';
  IF n <> 5 THEN RAISE EXCEPTION 'Post-check failed: production_events should have 5 FKs (found %).', n USING ERRCODE = 'raise_exception'; END IF;

  -- event_type CHECK.
  SELECT COUNT(*) INTO n FROM information_schema.table_constraints
  WHERE table_schema='public' AND table_name='production_events' AND constraint_type='CHECK'
    AND constraint_name='production_events_event_type_check';
  IF n <> 1 THEN RAISE EXCEPTION 'Post-check failed: production_events_event_type_check missing.' USING ERRCODE = 'raise_exception'; END IF;

  -- Indexes.
  SELECT COUNT(*) INTO n FROM pg_indexes
  WHERE schemaname='public' AND tablename='production_events'
    AND indexname IN ('idx_pe_org_id','idx_pe_owner_id','idx_pe_wine_lot_id','idx_pe_vessel_id','idx_pe_vessel_placement_id','idx_pe_event_type','idx_pe_event_at');
  IF n <> 7 THEN RAISE EXCEPTION 'Post-check failed: production_events indexes missing (found %).', n USING ERRCODE = 'raise_exception'; END IF;

  -- RLS enabled.
  SELECT relrowsecurity INTO rls_on FROM pg_class WHERE oid='public.production_events'::regclass;
  IF NOT COALESCE(rls_on, false) THEN
    RAISE EXCEPTION 'Post-check failed: RLS not enabled on production_events.' USING ERRCODE = 'raise_exception';
  END IF;

  -- Exactly two policies (SELECT + INSERT), none owner-based, and specifically
  -- NO update/delete policy (append-only).
  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='production_events';
  IF n <> 2 THEN RAISE EXCEPTION 'Post-check failed: production_events must have exactly 2 policies (SELECT+INSERT); found %.', n USING ERRCODE = 'raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_policies
  WHERE schemaname='public' AND tablename='production_events' AND cmd IN ('UPDATE','DELETE');
  IF n <> 0 THEN RAISE EXCEPTION 'Post-check failed: production_events must NOT have UPDATE/DELETE policies (found %).', n USING ERRCODE = 'raise_exception'; END IF;

  -- No UPDATE/DELETE privilege granted to authenticated (append-only).
  SELECT COUNT(*) INTO n FROM information_schema.role_table_grants
  WHERE table_schema='public' AND table_name='production_events'
    AND grantee='authenticated' AND privilege_type IN ('UPDATE','DELETE');
  IF n <> 0 THEN RAISE EXCEPTION 'Post-check failed: authenticated must NOT have UPDATE/DELETE on production_events (found %).', n USING ERRCODE = 'raise_exception'; END IF;

  -- SELECT + INSERT grants present.
  SELECT COUNT(*) INTO n FROM information_schema.role_table_grants
  WHERE table_schema='public' AND table_name='production_events'
    AND grantee='authenticated' AND privilege_type IN ('SELECT','INSERT');
  IF n <> 2 THEN RAISE EXCEPTION 'Post-check failed: authenticated must have SELECT+INSERT on production_events (found %).', n USING ERRCODE = 'raise_exception'; END IF;

  -- Integrity trigger + function present and SECURITY DEFINER.
  SELECT COUNT(*) INTO n FROM pg_trigger
  WHERE tgrelid='public.production_events'::regclass AND NOT tgisinternal
    AND tgname='production_events_org_integrity';
  IF n <> 1 THEN RAISE EXCEPTION 'Post-check failed: production_events_org_integrity trigger missing.' USING ERRCODE = 'raise_exception'; END IF;

  IF to_regprocedure('public.validate_production_event_org_integrity()') IS NULL THEN
    RAISE EXCEPTION 'Post-check failed: validate_production_event_org_integrity() missing.' USING ERRCODE = 'raise_exception';
  END IF;
  SELECT COUNT(*) INTO n FROM pg_proc
  WHERE oid='public.validate_production_event_org_integrity()'::regprocedure AND prosecdef = true;
  IF n <> 1 THEN RAISE EXCEPTION 'Post-check failed: validate_production_event_org_integrity() must be SECURITY DEFINER.' USING ERRCODE = 'raise_exception'; END IF;

  -- Table starts empty (no backfill).
  SELECT COUNT(*) INTO n FROM public.production_events;
  IF n <> 0 THEN RAISE EXCEPTION 'Post-check failed: production_events must start empty (found % rows).', n USING ERRCODE = 'raise_exception'; END IF;
END $$;

COMMIT;
