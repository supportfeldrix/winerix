-- ============================================================
-- WINERIX — P0 Step 1: Tenancy Foundation
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- Depends on: 001_profiles.sql (auth.users, public.update_updated_at())
--
-- SCOPE (P0 Step 1 ONLY):
--   Creates the multi-tenancy foundation — organisations,
--   organisation_members, audit_log — plus membership helper
--   functions, indexes, RLS for the NEW tables only, updated_at
--   triggers, and last-owner protection.
--
-- THIS MIGRATION DOES NOT:
--   * add org_id to existing business tables
--   * change or remove existing owner-based RLS on business tables
--   * modify any existing table, column, policy, function, trigger, or data
--   Those belong to later P0 steps (007+).
--
-- All statements are additive and idempotency-aware. No destructive
-- statements are issued against existing application tables.
-- ============================================================

BEGIN;

-- ============================================================
-- 1. ORGANISATIONS
-- Represents a winery/farm business (the tenant). Every existing user
-- will later receive a personal organisation (P0 Step 2 backfill) — this
-- migration only creates the table.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.organisations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'estate',
  is_personal BOOLEAN NOT NULL DEFAULT false,
  created_by  UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Controlled organisation type values (matches the approved P0 architecture).
  CONSTRAINT organisations_type_check
    CHECK (type IN ('estate', 'producer', 'cellar', 'personal')),

  -- Non-empty name / slug guards.
  CONSTRAINT organisations_name_not_blank CHECK (length(btrim(name)) > 0),
  CONSTRAINT organisations_slug_not_blank CHECK (length(btrim(slug)) > 0)
);

-- Slug must be globally unique.
CREATE UNIQUE INDEX IF NOT EXISTS uq_organisations_slug
  ON public.organisations(slug);

CREATE INDEX IF NOT EXISTS idx_organisations_created_by
  ON public.organisations(created_by);

-- ============================================================
-- 2. ORGANISATION MEMBERS
-- Join table: which users belong to which organisation, with a role and
-- a membership status. UNIQUE(org_id, user_id) enforces one membership
-- row per user per organisation.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.organisation_members (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'VIEWER',
  status     TEXT NOT NULL DEFAULT 'active',
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Controlled role values (approved P0 role model).
  CONSTRAINT organisation_members_role_check
    CHECK (role IN ('OWNER', 'ADMIN', 'FARM', 'CELLAR', 'SALES', 'VIEWER')),

  -- Controlled membership status values.
  CONSTRAINT organisation_members_status_check
    CHECK (status IN ('active', 'invited', 'suspended')),

  -- One membership row per (organisation, user).
  CONSTRAINT uq_organisation_members_org_user UNIQUE (org_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_organisation_members_org_id
  ON public.organisation_members(org_id);

CREATE INDEX IF NOT EXISTS idx_organisation_members_user_id
  ON public.organisation_members(user_id);

-- Speeds up the common "active membership of this user" lookup used by helpers.
CREATE INDEX IF NOT EXISTS idx_organisation_members_user_status
  ON public.organisation_members(user_id, status);

-- ============================================================
-- 3. AUDIT LOG (append-only foundation)
-- Storage foundation for the audit trail. Trigger wiring for specific
-- tables is a later P0 step; this migration only establishes the table
-- and locks it down so normal frontend users cannot write or delete it.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.audit_log (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID REFERENCES public.organisations(id) ON DELETE SET NULL,
  actor_user_id  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  action         TEXT NOT NULL,          -- e.g. INSERT / UPDATE / DELETE / ROLE_CHANGE
  entity_type    TEXT NOT NULL,          -- table / entity name
  entity_id      UUID,                   -- affected record id (nullable for non-row events)
  old_data       JSONB,                  -- previous row snapshot (nullable)
  new_data       JSONB,                  -- new row snapshot (nullable)
  metadata       JSONB,                  -- optional contextual metadata
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_org_id
  ON public.audit_log(org_id);

CREATE INDEX IF NOT EXISTS idx_audit_log_actor_user_id
  ON public.audit_log(actor_user_id);

CREATE INDEX IF NOT EXISTS idx_audit_log_created_at
  ON public.audit_log(created_at);

-- ============================================================
-- 4. HELPER FUNCTIONS
-- SECURITY DEFINER so they can read organisation_members WITHOUT invoking
-- that table's own RLS — this is what prevents RLS recursion when business
-- and tenancy policies call these helpers. search_path is pinned.
--
-- Ownership/permissions: functions are owned by the migration runner
-- (typically the privileged Supabase role). We deliberately REVOKE the
-- default PUBLIC EXECUTE grant and grant EXECUTE only to `authenticated`.
-- ============================================================

-- is_org_member(target_org): true when the current user has an ACTIVE
-- membership of target_org.
CREATE OR REPLACE FUNCTION public.is_org_member(target_org UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organisation_members m
    WHERE m.org_id = target_org
      AND m.user_id = auth.uid()
      AND m.status = 'active'
  );
$$;

-- has_org_role(target_org, allowed_roles): true when the current user has an
-- ACTIVE membership of target_org with a role in allowed_roles.
CREATE OR REPLACE FUNCTION public.has_org_role(target_org UUID, allowed_roles TEXT[])
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organisation_members m
    WHERE m.org_id = target_org
      AND m.user_id = auth.uid()
      AND m.status = 'active'
      AND m.role = ANY (allowed_roles)
  );
$$;

-- member_role(target_member_id): returns the role of an EXISTING membership
-- row by its id, read as the function owner so it does NOT re-invoke
-- organisation_members RLS (prevents recursion when an UPDATE policy needs to
-- inspect the row being modified). Returns NULL if the row does not exist.
-- Used to enforce that an ADMIN cannot act on an existing OWNER membership.
CREATE OR REPLACE FUNCTION public.member_role(target_member_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT m.role
  FROM public.organisation_members m
  WHERE m.id = target_member_id;
$$;

-- Restrict execute privileges deliberately (no broad PUBLIC execute).
REVOKE ALL ON FUNCTION public.is_org_member(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.has_org_role(UUID, TEXT[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.member_role(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_org_member(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_org_role(UUID, TEXT[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.member_role(UUID) TO authenticated;

-- ============================================================
-- 5. LAST-OWNER PROTECTION
-- A trigger that prevents an organisation from ever losing its final active
-- OWNER via UPDATE (demotion / suspension) or DELETE of the membership row.
-- Narrowly scoped to organisation_members. No invitations, switching, or
-- admin UI here.
-- ============================================================
CREATE OR REPLACE FUNCTION public.prevent_last_owner_removal()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  affected_org UUID;
  was_active_owner BOOLEAN;
  remaining_owners INTEGER;
BEGIN
  -- Identify the org and whether the OLD row was an active OWNER.
  affected_org := OLD.org_id;
  was_active_owner := (OLD.role = 'OWNER' AND OLD.status = 'active');

  IF NOT was_active_owner THEN
    -- The row being changed/removed was not an active owner; nothing to guard.
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  -- On UPDATE, if the row REMAINS an active OWNER, no protection is needed.
  IF TG_OP = 'UPDATE' AND NEW.role = 'OWNER' AND NEW.status = 'active' THEN
    RETURN NEW;
  END IF;

  -- Count OTHER active owners that would remain for this organisation.
  SELECT COUNT(*) INTO remaining_owners
  FROM public.organisation_members m
  WHERE m.org_id = affected_org
    AND m.role = 'OWNER'
    AND m.status = 'active'
    AND m.id <> OLD.id;

  IF remaining_owners = 0 THEN
    RAISE EXCEPTION 'Cannot remove or demote the last active OWNER of organisation %', affected_org
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS organisation_members_last_owner_guard ON public.organisation_members;
CREATE TRIGGER organisation_members_last_owner_guard
  BEFORE UPDATE OR DELETE ON public.organisation_members
  FOR EACH ROW EXECUTE FUNCTION public.prevent_last_owner_removal();

-- ============================================================
-- 6. UPDATED_AT TRIGGERS (reuse existing public.update_updated_at from 001)
-- ============================================================
DROP TRIGGER IF EXISTS organisations_updated_at ON public.organisations;
CREATE TRIGGER organisations_updated_at
  BEFORE UPDATE ON public.organisations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS organisation_members_updated_at ON public.organisation_members;
CREATE TRIGGER organisation_members_updated_at
  BEFORE UPDATE ON public.organisation_members
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ============================================================
-- 7. ROW LEVEL SECURITY — NEW TENANCY TABLES ONLY
-- Existing business-table RLS is intentionally left UNCHANGED.
-- ============================================================

-- ---- organisations ----------------------------------------
ALTER TABLE public.organisations ENABLE ROW LEVEL SECURITY;

-- SELECT: the creator of an organisation may see it (bootstrap visibility,
-- before the OWNER membership row exists), and any active member may see it.
-- After bootstrap, membership is the effective authority; created_by only
-- grants visibility of an organisation you created. Unrelated users see
-- nothing. NOT weakened to USING (true).
CREATE POLICY "Members can view their organisations"
  ON public.organisations FOR SELECT
  USING (
    created_by = auth.uid()
    OR public.is_org_member(id)
  );

-- INSERT: a user may create an organisation only as themselves
-- (created_by must be the authenticated user). Membership bootstrap
-- (making them OWNER) is handled by application logic / backfill inserting
-- the corresponding organisation_members row; this policy ensures a user
-- cannot forge an organisation attributed to someone else.
CREATE POLICY "Users can create organisations they own"
  ON public.organisations FOR INSERT
  WITH CHECK (created_by = auth.uid());

-- UPDATE: only OWNER/ADMIN of that organisation.
CREATE POLICY "Owners and admins can update their organisations"
  ON public.organisations FOR UPDATE
  USING (public.has_org_role(id, ARRAY['OWNER', 'ADMIN']))
  WITH CHECK (public.has_org_role(id, ARRAY['OWNER', 'ADMIN']));

-- DELETE: only OWNER of that organisation.
CREATE POLICY "Owners can delete their organisations"
  ON public.organisations FOR DELETE
  USING (public.has_org_role(id, ARRAY['OWNER']));

-- ---- organisation_members ---------------------------------
ALTER TABLE public.organisation_members ENABLE ROW LEVEL SECURITY;

-- SELECT: a user can see their own membership rows, plus (for orgs they
-- belong to) the other members of those organisations.
CREATE POLICY "Users can view relevant memberships"
  ON public.organisation_members FOR SELECT
  USING (
    user_id = auth.uid()
    OR public.is_org_member(org_id)
  );

-- INSERT bootstrap: a user may add THEMSELVES as OWNER of an organisation
-- they created (created_by on the org = auth.uid()). This enables the
-- create-org + become-owner bootstrap without allowing a user to insert
-- themselves into someone else's organisation.
CREATE POLICY "Users can bootstrap ownership of organisations they created"
  ON public.organisation_members FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND role = 'OWNER'
    AND status = 'active'
    AND EXISTS (
      SELECT 1 FROM public.organisations o
      WHERE o.id = org_id
        AND o.created_by = auth.uid()
    )
  );

-- ------------------------------------------------------------
-- MEMBER MANAGEMENT — ROLE-AWARE SECURITY BOUNDARY
--
-- OWNER is the ultimate authority; ADMIN is powerful but MUST NOT be able to
-- create, become, or touch an OWNER membership. Because PostgreSQL OR-combines
-- permissive policies for the same command, the OWNER and ADMIN grants are
-- expressed as SEPARATE policies where NEITHER grants an ADMIN any OWNER path:
--   * the OWNER policy authorises everything (any target role, incl. OWNER rows)
--   * the ADMIN policy authorises ONLY non-OWNER targets (and, for UPDATE/DELETE,
--     only non-OWNER existing rows)
-- OR-combining "everything for owners" with "non-owner-only for admins" can
-- never yield an OWNER path for an admin — the admin policy simply never
-- evaluates true for an OWNER target, and no other permissive policy does either.
--
-- To inspect the EXISTING row's role without RLS recursion, UPDATE/DELETE USING
-- clauses call the SECURITY DEFINER helper public.member_role(id).
-- ------------------------------------------------------------

-- INSERT (OWNER): an OWNER may add a member with ANY valid role, including OWNER.
CREATE POLICY "Owners can add members with any role"
  ON public.organisation_members FOR INSERT
  WITH CHECK (public.has_org_role(org_id, ARRAY['OWNER']));

-- INSERT (ADMIN): an ADMIN may add members but NEVER with role = 'OWNER'.
CREATE POLICY "Admins can add non-owner members"
  ON public.organisation_members FOR INSERT
  WITH CHECK (
    public.has_org_role(org_id, ARRAY['ADMIN'])
    AND role <> 'OWNER'
  );

-- UPDATE (OWNER): an OWNER may update any membership (incl. OWNER rows and
-- promotions to OWNER), subject to the last-owner guard trigger.
CREATE POLICY "Owners can update any member"
  ON public.organisation_members FOR UPDATE
  USING (public.has_org_role(org_id, ARRAY['OWNER']))
  WITH CHECK (public.has_org_role(org_id, ARRAY['OWNER']));

-- UPDATE (ADMIN): an ADMIN may update ONLY non-OWNER memberships, and may NOT
-- change any membership INTO an OWNER. This blocks self-promotion, promoting
-- others to OWNER, and modifying/suspending an existing OWNER row.
--   USING       → the EXISTING row must not be an OWNER (member_role(id) <> 'OWNER')
--   WITH CHECK  → the RESULTING row must not be an OWNER (NEW.role <> 'OWNER')
CREATE POLICY "Admins can update non-owner members"
  ON public.organisation_members FOR UPDATE
  USING (
    public.has_org_role(org_id, ARRAY['ADMIN'])
    AND public.member_role(id) <> 'OWNER'
  )
  WITH CHECK (
    public.has_org_role(org_id, ARRAY['ADMIN'])
    AND role <> 'OWNER'
  );

-- DELETE (OWNER): an OWNER may remove any membership, subject to the last-owner
-- guard trigger.
CREATE POLICY "Owners can remove any member"
  ON public.organisation_members FOR DELETE
  USING (public.has_org_role(org_id, ARRAY['OWNER']));

-- DELETE (ADMIN): an ADMIN may remove ONLY non-OWNER memberships.
CREATE POLICY "Admins can remove non-owner members"
  ON public.organisation_members FOR DELETE
  USING (
    public.has_org_role(org_id, ARRAY['ADMIN'])
    AND public.member_role(id) <> 'OWNER'
  );

-- ---- audit_log --------------------------------------------
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

-- SELECT: only OWNER/ADMIN of the organisation may read its audit entries.
CREATE POLICY "Owners and admins can read organisation audit log"
  ON public.audit_log FOR SELECT
  USING (
    org_id IS NOT NULL
    AND public.has_org_role(org_id, ARRAY['OWNER', 'ADMIN'])
  );

-- No INSERT / UPDATE / DELETE policies are defined for audit_log. With RLS
-- enabled and no permissive write policy, normal (authenticated / anon)
-- clients cannot INSERT, UPDATE, or DELETE rows. Audit writes will be
-- performed by SECURITY DEFINER triggers/functions in a later P0 step,
-- which bypass RLS. This makes the table effectively append-only-by-system
-- and immutable to frontend users.

COMMIT;
