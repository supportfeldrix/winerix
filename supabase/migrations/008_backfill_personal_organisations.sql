-- ============================================================
-- WINERIX — P0 Step 2A: Backfill Personal Organisations
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- Depends on: 001_profiles.sql (public.profiles, auth.users)
--             006_tenancy_foundation.sql (organisations, organisation_members,
--                                          constraints, helpers, last-owner guard)
--
-- PURPOSE:
--   Create exactly ONE personal organisation per existing user (source of
--   truth: public.profiles) and exactly ONE active OWNER membership for that
--   user, so a later migration (007) can deterministically backfill org_id on
--   the nine business tables via owner_id -> the user's personal organisation.
--
-- SCOPE — THIS MIGRATION ONLY:
--   * INSERTs into public.organisations (is_personal = true) and
--     public.organisation_members (role OWNER, status active).
--   * Idempotent and safe to re-run.
--   * Fails safely (rolls back) on ambiguous / conflicting state.
--
-- THIS MIGRATION DOES NOT:
--   * add org_id to any table (that is migration 007)
--   * modify any of the nine business tables or their data
--   * modify any existing RLS policy, helper function, grant, or trigger
--   * write audit_log rows (see AUDIT NOTE below)
--
-- Personal-organisation identity (there is intentionally NO DB unique
-- constraint on (created_by, is_personal) in 006, so uniqueness is enforced
-- here by guarded, NOT-EXISTS INSERTs plus post-insert validation gates):
--     organisations.is_personal = true  AND  organisations.created_by = <user>
--
-- Slug: deterministic, globally unique, non-blank, satisfies the 006
--       organisations_slug_not_blank + uq_organisations_slug constraints:
--           'personal-' || replace(user_id::text, '-', '')
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 0. PRE-FLIGHT AMBIGUITY GATE
-- If any user ALREADY has more than one personal organisation, the tenant
-- mapping is ambiguous. Do NOT silently pick one — abort the whole migration
-- so a human can resolve it. (Edge case C.)
-- ------------------------------------------------------------
DO $$
DECLARE
  ambiguous_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO ambiguous_count
  FROM (
    SELECT created_by
    FROM public.organisations
    WHERE is_personal = true
    GROUP BY created_by
    HAVING COUNT(*) > 1
  ) dup;

  IF ambiguous_count > 0 THEN
    RAISE EXCEPTION
      'Aborting: % user(s) already have multiple personal organisations. Resolve manually before backfill.',
      ambiguous_count
      USING ERRCODE = 'data_exception';
  END IF;
END $$;

-- ------------------------------------------------------------
-- 1. CREATE MISSING PERSONAL ORGANISATIONS
-- One per profile that does not yet have a personal organisation.
-- Source of truth is public.profiles (so users with no business rows are
-- still covered — edge case A). Guarded by NOT EXISTS on the personal-org
-- identity (created_by + is_personal), so re-running creates nothing new
-- (idempotency + edge case B).
-- ------------------------------------------------------------
INSERT INTO public.organisations (name, slug, type, is_personal, created_by)
SELECT
  'Personal Organisation',
  'personal-' || replace(p.id::text, '-', ''),
  'personal',
  true,
  p.id
FROM public.profiles p
WHERE NOT EXISTS (
  SELECT 1
  FROM public.organisations o
  WHERE o.created_by = p.id
    AND o.is_personal = true
);

-- ------------------------------------------------------------
-- 2. CREATE MISSING OWNER MEMBERSHIPS
-- Ensure the creator of each personal organisation has an active OWNER
-- membership. Guarded by NOT EXISTS on (org_id, user_id) so it is idempotent
-- and creates the membership even if a prior run created the org but not the
-- membership (edge case D). It NEVER modifies an existing membership row
-- (edge cases E/F left untouched) — conflicts are caught by the gate below.
-- ------------------------------------------------------------
INSERT INTO public.organisation_members (org_id, user_id, role, status, created_by)
SELECT
  o.id,
  o.created_by,
  'OWNER',
  'active',
  o.created_by
FROM public.organisations o
WHERE o.is_personal = true
  AND NOT EXISTS (
    SELECT 1
    FROM public.organisation_members m
    WHERE m.org_id = o.id
      AND m.user_id = o.created_by
  );

-- ------------------------------------------------------------
-- 3. MEMBERSHIP CONFLICT GATE (edge case E)
-- If a personal organisation has a creator membership row that is NOT the
-- intended bootstrap state (active OWNER), do NOT silently overwrite access —
-- abort so it can be reviewed. (A row created by steps 1–2 is always active
-- OWNER; this only trips on pre-existing, inconsistent rows.)
-- ------------------------------------------------------------
DO $$
DECLARE
  conflict_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO conflict_count
  FROM public.organisations o
  JOIN public.organisation_members m
    ON m.org_id = o.id
   AND m.user_id = o.created_by
  WHERE o.is_personal = true
    AND (m.role <> 'OWNER' OR m.status <> 'active');

  IF conflict_count > 0 THEN
    RAISE EXCEPTION
      'Aborting: % personal organisation(s) have a creator membership that is not active OWNER. Resolve manually.',
      conflict_count
      USING ERRCODE = 'data_exception';
  END IF;
END $$;

-- ------------------------------------------------------------
-- 4. VALIDATION GATES
-- Guarantee the intended end state before COMMIT. Any failure raises an
-- exception and rolls back the whole transaction (nothing is left half-done).
-- ------------------------------------------------------------
DO $$
DECLARE
  profiles_without_personal INTEGER;
  users_with_multiple_personal INTEGER;
  personal_orgs_without_owner INTEGER;
  personal_orgs_wrong_owner_count INTEGER;
BEGIN
  -- 4.1 Every profile must have exactly one personal organisation.
  SELECT COUNT(*) INTO profiles_without_personal
  FROM public.profiles p
  WHERE NOT EXISTS (
    SELECT 1 FROM public.organisations o
    WHERE o.created_by = p.id AND o.is_personal = true
  );

  IF profiles_without_personal > 0 THEN
    RAISE EXCEPTION 'Validation failed: % profile(s) have no personal organisation.',
      profiles_without_personal USING ERRCODE = 'data_exception';
  END IF;

  -- 4.2 No user may have more than one personal organisation (no duplicates).
  SELECT COUNT(*) INTO users_with_multiple_personal
  FROM (
    SELECT created_by
    FROM public.organisations
    WHERE is_personal = true
    GROUP BY created_by
    HAVING COUNT(*) > 1
  ) d;

  IF users_with_multiple_personal > 0 THEN
    RAISE EXCEPTION 'Validation failed: % user(s) have multiple personal organisations.',
      users_with_multiple_personal USING ERRCODE = 'data_exception';
  END IF;

  -- 4.3 Every personal organisation must have exactly one active OWNER
  --     membership for its creator.
  SELECT COUNT(*) INTO personal_orgs_without_owner
  FROM public.organisations o
  WHERE o.is_personal = true
    AND NOT EXISTS (
      SELECT 1 FROM public.organisation_members m
      WHERE m.org_id = o.id
        AND m.user_id = o.created_by
        AND m.role = 'OWNER'
        AND m.status = 'active'
    );

  IF personal_orgs_without_owner > 0 THEN
    RAISE EXCEPTION 'Validation failed: % personal organisation(s) lack an active OWNER membership for the creator.',
      personal_orgs_without_owner USING ERRCODE = 'data_exception';
  END IF;

  -- 4.4 Each personal organisation must have exactly one OWNER membership
  --     row for its creator (UNIQUE(org_id,user_id) already guarantees this,
  --     but we assert it explicitly).
  SELECT COUNT(*) INTO personal_orgs_wrong_owner_count
  FROM (
    SELECT o.id
    FROM public.organisations o
    JOIN public.organisation_members m
      ON m.org_id = o.id AND m.user_id = o.created_by
    WHERE o.is_personal = true
    GROUP BY o.id
    HAVING COUNT(*) <> 1
  ) d;

  IF personal_orgs_wrong_owner_count > 0 THEN
    RAISE EXCEPTION 'Validation failed: % personal organisation(s) have an unexpected creator-membership count.',
      personal_orgs_wrong_owner_count USING ERRCODE = 'data_exception';
  END IF;
END $$;

COMMIT;

-- ============================================================
-- AUDIT NOTE:
--   Migration 006 established the audit_log TABLE but no audit convention or
--   write mechanism for data changes (audit trigger wiring is an explicitly
--   later P0 step, and audit_log has no INSERT policy). This system backfill
--   therefore intentionally writes NO audit_log rows — inventing an audit
--   convention here would pre-empt that later step. The backfill is fully
--   reconstructable/idempotent from public.profiles, so no audit entry is
--   required for correctness.
--
-- ORPHAN / INTEGRITY NOTES:
--   * Business rows whose owner_id has no matching profile are NEVER given an
--     organisation here — this migration only iterates public.profiles, so no
--     organisation is invented for an orphan owner_id (edge case H).
--   * profiles.id references auth.users(id) (001), so a profile without an
--     auth user cannot exist under the current schema; no invented data
--     (edge case I).
--   * Users with additional (non-personal) memberships are untouched; the
--     personal org remains uniquely identifiable by created_by + is_personal
--     (edge cases F/G).
-- ============================================================
