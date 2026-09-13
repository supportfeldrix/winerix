-- ============================================================
-- WINERIX — P0 Step 2B: Add & Backfill org_id on business tables
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- Depends on: 002_vineyards.sql, 003_irrigation.sql, 004_spray_programme.sql,
--             005_phase1_modules.sql (the nine business tables + owner_id)
--             006_tenancy_foundation.sql (organisations)
--             008_backfill_personal_organisations.sql (one personal org +
--                 active OWNER membership per profile)
--
-- PURPOSE:
--   Add a NULLABLE org_id to each of the nine business tables, add the FK to
--   organisations(id), index it, deterministically backfill org_id from
--   owner_id -> the owner's personal organisation, VALIDATE, then SET NOT NULL.
--
-- SCOPE — THIS MIGRATION ONLY:
--   ADD -> BACKFILL -> VALIDATE -> NOT NULL, on exactly nine tables.
--
-- THIS MIGRATION DOES NOT:
--   * change or remove owner_id (retained as creator/attribution)
--   * alter any existing foreign key (vineyard_id / block_id relationships)
--   * change any RLS policy, enable/disable RLS, or touch tenancy helpers
--   * modify existing updated_at triggers or create duplicates
--   * modify application code
--
-- DETERMINISTIC MAPPING:
--   business_table.owner_id  ->  organisations.created_by
--   WHERE organisations.is_personal = true
--   Step 2A guarantees exactly one personal org per profile; this migration
--   still validates the mapping explicitly before enforcing NOT NULL.
--
-- ON DELETE CHOICE FOR org_id -> organisations(id):  RESTRICT
--   Rationale: org_id is the authoritative tenant boundary and becomes
--   NOT NULL. SET NULL would orphan tenant data (and violate NOT NULL);
--   CASCADE would allow deleting an organisation to silently mass-delete all
--   of its business data. RESTRICT blocks deleting an organisation while any
--   business row still references it, so tenant deletion must be an explicit,
--   ordered operation handled later — no silent orphaning, no accidental
--   data loss. (owner_id keeps its own existing ON DELETE CASCADE to
--   auth.users, unchanged.)
-- ============================================================

BEGIN;

-- ============================================================
-- 0. PRE-FLIGHT GATES (fail before any structural change)
-- ============================================================
DO $$
DECLARE
  users_multi_personal INTEGER;
BEGIN
  -- 0.1 No user may have more than one personal organisation (ambiguous map).
  SELECT COUNT(*) INTO users_multi_personal
  FROM (
    SELECT created_by
    FROM public.organisations
    WHERE is_personal = true
    GROUP BY created_by
    HAVING COUNT(*) > 1
  ) d;

  IF users_multi_personal > 0 THEN
    RAISE EXCEPTION
      'Aborting: % user(s) have multiple personal organisations; owner_id -> org mapping is ambiguous.',
      users_multi_personal USING ERRCODE = 'data_exception';
  END IF;
END $$;

-- 0.2 Every owner_id present in ANY business table must have a personal org.
--     If any owner_id has no personal organisation, abort — do NOT invent one.
DO $$
DECLARE
  unmapped_owners INTEGER;
BEGIN
  WITH owners AS (
    SELECT owner_id FROM public.vineyards
    UNION SELECT owner_id FROM public.blocks
    UNION SELECT owner_id FROM public.operations
    UNION SELECT owner_id FROM public.irrigation
    UNION SELECT owner_id FROM public.spray_programme
    UNION SELECT owner_id FROM public.harvest
    UNION SELECT owner_id FROM public.machinery
    UNION SELECT owner_id FROM public.finance
    UNION SELECT owner_id FROM public.planner
  )
  SELECT COUNT(*) INTO unmapped_owners
  FROM owners ow
  WHERE NOT EXISTS (
    SELECT 1 FROM public.organisations o
    WHERE o.created_by = ow.owner_id
      AND o.is_personal = true
  );

  IF unmapped_owners > 0 THEN
    RAISE EXCEPTION
      'Aborting: % business owner_id value(s) have no personal organisation. Run 008 backfill / resolve before org_id backfill.',
      unmapped_owners USING ERRCODE = 'data_exception';
  END IF;
END $$;

-- ============================================================
-- 1. ADD NULLABLE org_id + FK (RESTRICT) + INDEX  (all nine tables)
-- Idempotency-aware: IF NOT EXISTS on columns/indexes; FK guarded by a
-- catalog check so re-running does not error on an existing constraint.
-- ============================================================

-- helper block to add the FK only if it does not already exist
-- (repeated per table with distinct constraint names)

-- ---- vineyards ----
ALTER TABLE public.vineyards ADD COLUMN IF NOT EXISTS org_id UUID;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_vineyards_org') THEN
    ALTER TABLE public.vineyards
      ADD CONSTRAINT fk_vineyards_org
      FOREIGN KEY (org_id) REFERENCES public.organisations(id) ON DELETE RESTRICT;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_vineyards_org_id ON public.vineyards(org_id);

-- ---- blocks ----
ALTER TABLE public.blocks ADD COLUMN IF NOT EXISTS org_id UUID;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_blocks_org') THEN
    ALTER TABLE public.blocks
      ADD CONSTRAINT fk_blocks_org
      FOREIGN KEY (org_id) REFERENCES public.organisations(id) ON DELETE RESTRICT;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_blocks_org_id ON public.blocks(org_id);

-- ---- operations ----
ALTER TABLE public.operations ADD COLUMN IF NOT EXISTS org_id UUID;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_operations_org') THEN
    ALTER TABLE public.operations
      ADD CONSTRAINT fk_operations_org
      FOREIGN KEY (org_id) REFERENCES public.organisations(id) ON DELETE RESTRICT;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_operations_org_id ON public.operations(org_id);

-- ---- irrigation ----
ALTER TABLE public.irrigation ADD COLUMN IF NOT EXISTS org_id UUID;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_irrigation_org') THEN
    ALTER TABLE public.irrigation
      ADD CONSTRAINT fk_irrigation_org
      FOREIGN KEY (org_id) REFERENCES public.organisations(id) ON DELETE RESTRICT;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_irrigation_org_id ON public.irrigation(org_id);

-- ---- spray_programme ----
ALTER TABLE public.spray_programme ADD COLUMN IF NOT EXISTS org_id UUID;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_spray_programme_org') THEN
    ALTER TABLE public.spray_programme
      ADD CONSTRAINT fk_spray_programme_org
      FOREIGN KEY (org_id) REFERENCES public.organisations(id) ON DELETE RESTRICT;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_spray_programme_org_id ON public.spray_programme(org_id);

-- ---- harvest ----
ALTER TABLE public.harvest ADD COLUMN IF NOT EXISTS org_id UUID;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_harvest_org') THEN
    ALTER TABLE public.harvest
      ADD CONSTRAINT fk_harvest_org
      FOREIGN KEY (org_id) REFERENCES public.organisations(id) ON DELETE RESTRICT;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_harvest_org_id ON public.harvest(org_id);

-- ---- machinery ----
ALTER TABLE public.machinery ADD COLUMN IF NOT EXISTS org_id UUID;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_machinery_org') THEN
    ALTER TABLE public.machinery
      ADD CONSTRAINT fk_machinery_org
      FOREIGN KEY (org_id) REFERENCES public.organisations(id) ON DELETE RESTRICT;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_machinery_org_id ON public.machinery(org_id);

-- ---- finance ----
ALTER TABLE public.finance ADD COLUMN IF NOT EXISTS org_id UUID;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_finance_org') THEN
    ALTER TABLE public.finance
      ADD CONSTRAINT fk_finance_org
      FOREIGN KEY (org_id) REFERENCES public.organisations(id) ON DELETE RESTRICT;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_finance_org_id ON public.finance(org_id);

-- ---- planner ----
ALTER TABLE public.planner ADD COLUMN IF NOT EXISTS org_id UUID;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_planner_org') THEN
    ALTER TABLE public.planner
      ADD CONSTRAINT fk_planner_org
      FOREIGN KEY (org_id) REFERENCES public.organisations(id) ON DELETE RESTRICT;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_planner_org_id ON public.planner(org_id);

-- ============================================================
-- 2. BACKFILL org_id DETERMINISTICALLY
-- owner_id -> the owner's personal organisation (is_personal = true).
-- Uniqueness of that personal org was gated in step 0. Only rows whose org_id
-- is still NULL are updated (idempotent / safe to re-run).
-- ============================================================
UPDATE public.vineyards       t SET org_id = o.id
  FROM public.organisations o
  WHERE o.created_by = t.owner_id AND o.is_personal = true AND t.org_id IS NULL;

UPDATE public.blocks          t SET org_id = o.id
  FROM public.organisations o
  WHERE o.created_by = t.owner_id AND o.is_personal = true AND t.org_id IS NULL;

UPDATE public.operations      t SET org_id = o.id
  FROM public.organisations o
  WHERE o.created_by = t.owner_id AND o.is_personal = true AND t.org_id IS NULL;

UPDATE public.irrigation      t SET org_id = o.id
  FROM public.organisations o
  WHERE o.created_by = t.owner_id AND o.is_personal = true AND t.org_id IS NULL;

UPDATE public.spray_programme  t SET org_id = o.id
  FROM public.organisations o
  WHERE o.created_by = t.owner_id AND o.is_personal = true AND t.org_id IS NULL;

UPDATE public.harvest         t SET org_id = o.id
  FROM public.organisations o
  WHERE o.created_by = t.owner_id AND o.is_personal = true AND t.org_id IS NULL;

UPDATE public.machinery       t SET org_id = o.id
  FROM public.organisations o
  WHERE o.created_by = t.owner_id AND o.is_personal = true AND t.org_id IS NULL;

UPDATE public.finance         t SET org_id = o.id
  FROM public.organisations o
  WHERE o.created_by = t.owner_id AND o.is_personal = true AND t.org_id IS NULL;

UPDATE public.planner         t SET org_id = o.id
  FROM public.organisations o
  WHERE o.created_by = t.owner_id AND o.is_personal = true AND t.org_id IS NULL;

-- ============================================================
-- 3. BACKFILL VALIDATION GATES (before NOT NULL)
-- Any failure raises and rolls back the whole transaction.
-- ============================================================
DO $$
DECLARE
  null_orgs INTEGER;          -- A: any NULL org_id remaining
  bad_ref INTEGER;            -- B: org_id not referencing an existing org
  wrong_owner INTEGER;        -- C/D: org_id not = owner's personal org / belongs to another owner
BEGIN
  -- A. Every business row has a non-NULL org_id.
  SELECT
    (SELECT COUNT(*) FROM public.vineyards       WHERE org_id IS NULL) +
    (SELECT COUNT(*) FROM public.blocks          WHERE org_id IS NULL) +
    (SELECT COUNT(*) FROM public.operations      WHERE org_id IS NULL) +
    (SELECT COUNT(*) FROM public.irrigation      WHERE org_id IS NULL) +
    (SELECT COUNT(*) FROM public.spray_programme WHERE org_id IS NULL) +
    (SELECT COUNT(*) FROM public.harvest         WHERE org_id IS NULL) +
    (SELECT COUNT(*) FROM public.machinery       WHERE org_id IS NULL) +
    (SELECT COUNT(*) FROM public.finance         WHERE org_id IS NULL) +
    (SELECT COUNT(*) FROM public.planner         WHERE org_id IS NULL)
  INTO null_orgs;

  IF null_orgs > 0 THEN
    RAISE EXCEPTION 'Backfill validation A failed: % business row(s) still have NULL org_id.',
      null_orgs USING ERRCODE = 'data_exception';
  END IF;

  -- B. Every org_id references an existing organisation.
  SELECT
    (SELECT COUNT(*) FROM public.vineyards       t WHERE NOT EXISTS (SELECT 1 FROM public.organisations o WHERE o.id = t.org_id)) +
    (SELECT COUNT(*) FROM public.blocks          t WHERE NOT EXISTS (SELECT 1 FROM public.organisations o WHERE o.id = t.org_id)) +
    (SELECT COUNT(*) FROM public.operations      t WHERE NOT EXISTS (SELECT 1 FROM public.organisations o WHERE o.id = t.org_id)) +
    (SELECT COUNT(*) FROM public.irrigation      t WHERE NOT EXISTS (SELECT 1 FROM public.organisations o WHERE o.id = t.org_id)) +
    (SELECT COUNT(*) FROM public.spray_programme t WHERE NOT EXISTS (SELECT 1 FROM public.organisations o WHERE o.id = t.org_id)) +
    (SELECT COUNT(*) FROM public.harvest         t WHERE NOT EXISTS (SELECT 1 FROM public.organisations o WHERE o.id = t.org_id)) +
    (SELECT COUNT(*) FROM public.machinery       t WHERE NOT EXISTS (SELECT 1 FROM public.organisations o WHERE o.id = t.org_id)) +
    (SELECT COUNT(*) FROM public.finance         t WHERE NOT EXISTS (SELECT 1 FROM public.organisations o WHERE o.id = t.org_id)) +
    (SELECT COUNT(*) FROM public.planner         t WHERE NOT EXISTS (SELECT 1 FROM public.organisations o WHERE o.id = t.org_id))
  INTO bad_ref;

  IF bad_ref > 0 THEN
    RAISE EXCEPTION 'Backfill validation B failed: % business row(s) reference a non-existent organisation.',
      bad_ref USING ERRCODE = 'data_exception';
  END IF;

  -- C & D. Every org_id must be the OWNER's personal organisation, i.e. the
  --        assigned org must be is_personal = true AND created_by = owner_id.
  --        This simultaneously proves the org belongs to that owner (not a
  --        different owner) and that the correct personal org was chosen.
  SELECT
    (SELECT COUNT(*) FROM public.vineyards       t WHERE NOT EXISTS (SELECT 1 FROM public.organisations o WHERE o.id = t.org_id AND o.is_personal = true AND o.created_by = t.owner_id)) +
    (SELECT COUNT(*) FROM public.blocks          t WHERE NOT EXISTS (SELECT 1 FROM public.organisations o WHERE o.id = t.org_id AND o.is_personal = true AND o.created_by = t.owner_id)) +
    (SELECT COUNT(*) FROM public.operations      t WHERE NOT EXISTS (SELECT 1 FROM public.organisations o WHERE o.id = t.org_id AND o.is_personal = true AND o.created_by = t.owner_id)) +
    (SELECT COUNT(*) FROM public.irrigation      t WHERE NOT EXISTS (SELECT 1 FROM public.organisations o WHERE o.id = t.org_id AND o.is_personal = true AND o.created_by = t.owner_id)) +
    (SELECT COUNT(*) FROM public.spray_programme t WHERE NOT EXISTS (SELECT 1 FROM public.organisations o WHERE o.id = t.org_id AND o.is_personal = true AND o.created_by = t.owner_id)) +
    (SELECT COUNT(*) FROM public.harvest         t WHERE NOT EXISTS (SELECT 1 FROM public.organisations o WHERE o.id = t.org_id AND o.is_personal = true AND o.created_by = t.owner_id)) +
    (SELECT COUNT(*) FROM public.machinery       t WHERE NOT EXISTS (SELECT 1 FROM public.organisations o WHERE o.id = t.org_id AND o.is_personal = true AND o.created_by = t.owner_id)) +
    (SELECT COUNT(*) FROM public.finance         t WHERE NOT EXISTS (SELECT 1 FROM public.organisations o WHERE o.id = t.org_id AND o.is_personal = true AND o.created_by = t.owner_id)) +
    (SELECT COUNT(*) FROM public.planner         t WHERE NOT EXISTS (SELECT 1 FROM public.organisations o WHERE o.id = t.org_id AND o.is_personal = true AND o.created_by = t.owner_id))
  INTO wrong_owner;

  IF wrong_owner > 0 THEN
    RAISE EXCEPTION 'Backfill validation C/D failed: % business row(s) have an org_id that is not the owner''s personal organisation.',
      wrong_owner USING ERRCODE = 'data_exception';
  END IF;

  -- E. Ambiguity (multiple personal orgs per owner) was gated in step 0; the
  --    C/D check above would also fail if an owner mapped to more than one
  --    personal org, so no separate assertion is required here.
END $$;

-- ============================================================
-- 4. SET NOT NULL (only after all nine tables validated)
-- ============================================================
ALTER TABLE public.vineyards       ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE public.blocks          ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE public.operations      ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE public.irrigation      ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE public.spray_programme ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE public.harvest         ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE public.machinery       ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE public.finance         ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE public.planner         ALTER COLUMN org_id SET NOT NULL;

COMMIT;

-- ============================================================
-- NOTES:
--   * owner_id is untouched on all nine tables (name, type, and its existing
--     ON DELETE CASCADE -> auth.users are unchanged).
--   * No existing foreign key (vineyard_id / block_id relationships) was
--     altered — only NEW fk_<table>_org constraints were added.
--   * No RLS policy was created/altered/dropped; RLS was not enabled/disabled;
--     tenancy helper functions were not modified. The nine tables keep their
--     existing owner_id-based policies. (Org-based RLS is a later step.)
--   * No updated_at trigger was modified or duplicated.
-- ============================================================
