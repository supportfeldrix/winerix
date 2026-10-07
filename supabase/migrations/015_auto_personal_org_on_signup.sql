-- ============================================================
-- WINERIX — P0 fix: auto-create a personal organisation on signup
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- Depends on: 001 (profiles + handle_new_user), 006 (organisations,
--             organisation_members), 008 (one-time personal-org backfill)
--
-- WHY:
--   Migration 008 backfilled personal organisations + OWNER memberships for
--   users that EXISTED when it ran. Users who sign up AFTER 008 (e.g. the first
--   user on a fresh Supabase project) get a profile via handle_new_user() but
--   NO organisation and NO membership. With organisation-based RLS (010), such
--   a user fails is_org_member(org_id) on every business table -> 403 Forbidden
--   on all reads, an empty dashboard, and failing creates.
--
--   This migration makes personal-org provisioning AUTOMATIC and permanent:
--   a trigger on auth.users creates exactly one personal organisation and an
--   active OWNER membership for each NEW user — the same shape 008 produced.
--
-- SCOPE — THIS MIGRATION ONLY:
--   * adds public.provision_personal_org() (SECURITY DEFINER)
--   * adds an AFTER INSERT trigger on auth.users
--   * (idempotent) provisions any EXISTING profiles that still lack a personal
--     organisation, so already-registered users are fixed too
--
-- THIS MIGRATION DOES NOT:
--   * modify existing migrations, business tables, RLS policies, or the
--     existing handle_new_user() trigger
--   * touch business data
--
-- IDENTITY (matches 006/008): personal org = is_personal=true AND
--   created_by=<user>; slug = 'personal-' || replace(user_id::text,'-','').
-- ============================================================

BEGIN;

-- ============================================================
-- 0. PRE-FLIGHT
-- ============================================================
DO $$
BEGIN
  IF to_regclass('public.organisations') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.organisations is missing (run 006 first).' USING ERRCODE = 'undefined_table';
  END IF;
  IF to_regclass('public.organisation_members') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.organisation_members is missing (run 006 first).' USING ERRCODE = 'undefined_table';
  END IF;
END $$;

-- ============================================================
-- 1. PROVISIONING FUNCTION (SECURITY DEFINER, idempotent per user)
-- Creates one personal organisation + one active OWNER membership for the
-- given user if they do not already have a personal organisation.
-- ============================================================
CREATE OR REPLACE FUNCTION public.provision_personal_org(target_user UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  existing_org UUID;
  new_org UUID;
BEGIN
  IF target_user IS NULL THEN
    RETURN;
  END IF;

  -- Already has a personal organisation? Nothing to do (idempotent).
  SELECT o.id INTO existing_org
  FROM public.organisations o
  WHERE o.created_by = target_user AND o.is_personal = true
  LIMIT 1;

  IF existing_org IS NULL THEN
    INSERT INTO public.organisations (name, slug, type, is_personal, created_by)
    VALUES (
      'Personal Organisation',
      'personal-' || replace(target_user::text, '-', ''),
      'personal',
      true,
      target_user
    )
    RETURNING id INTO new_org;
  ELSE
    new_org := existing_org;
  END IF;

  -- Ensure an active OWNER membership exists for the creator (idempotent via
  -- the UNIQUE(org_id, user_id) constraint / NOT EXISTS guard).
  INSERT INTO public.organisation_members (org_id, user_id, role, status, created_by)
  SELECT new_org, target_user, 'OWNER', 'active', target_user
  WHERE NOT EXISTS (
    SELECT 1 FROM public.organisation_members m
    WHERE m.org_id = new_org AND m.user_id = target_user
  );
END;
$$;

-- ============================================================
-- 2. SIGNUP TRIGGER (auth.users AFTER INSERT)
-- Mirrors the existing handle_new_user() profile trigger. Runs for every new
-- user so personal-org provisioning is automatic on any signup path.
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_new_user_org()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public.provision_personal_org(NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created_org ON auth.users;
CREATE TRIGGER on_auth_user_created_org
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_org();

-- ============================================================
-- 3. BACKFILL EXISTING USERS THAT STILL LACK A PERSONAL ORG
-- Source of truth: public.profiles (1:1 with auth.users). Safe/idempotent.
-- Fixes users who already registered on this project before this migration.
-- ============================================================
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT p.id
    FROM public.profiles p
    WHERE NOT EXISTS (
      SELECT 1 FROM public.organisations o
      WHERE o.created_by = p.id AND o.is_personal = true
    )
  LOOP
    PERFORM public.provision_personal_org(r.id);
  END LOOP;
END $$;

-- ============================================================
-- 4. POST-VALIDATION: every profile now has a personal org + active OWNER.
-- ============================================================
DO $$
DECLARE
  missing_org INTEGER;
  missing_owner INTEGER;
BEGIN
  SELECT COUNT(*) INTO missing_org
  FROM public.profiles p
  WHERE NOT EXISTS (
    SELECT 1 FROM public.organisations o
    WHERE o.created_by = p.id AND o.is_personal = true
  );
  IF missing_org > 0 THEN
    RAISE EXCEPTION 'Post-check failed: % profile(s) still lack a personal organisation.', missing_org
      USING ERRCODE = 'data_exception';
  END IF;

  SELECT COUNT(*) INTO missing_owner
  FROM public.organisations o
  WHERE o.is_personal = true
    AND NOT EXISTS (
      SELECT 1 FROM public.organisation_members m
      WHERE m.org_id = o.id AND m.user_id = o.created_by
        AND m.role = 'OWNER' AND m.status = 'active'
    );
  IF missing_owner > 0 THEN
    RAISE EXCEPTION 'Post-check failed: % personal organisation(s) lack an active OWNER membership.', missing_owner
      USING ERRCODE = 'data_exception';
  END IF;
END $$;

COMMIT;
