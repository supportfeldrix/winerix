-- ============================================================
-- WINERIX — Repair: table GRANTs to `authenticated` + finish 010 owner-policy drop
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
--
-- WHY:
--   On a manually-provisioned Supabase project (tables/RLS created by running
--   the migration SQL by hand), the base table privileges that Supabase
--   normally auto-grants to the `authenticated` (and `anon`) roles were never
--   issued. RLS and GRANTs are SEPARATE layers: a query must first pass the
--   table-level privilege check, THEN RLS filters rows. With no SELECT/INSERT/
--   UPDATE/DELETE grant, PostgREST returns "permission denied" (HTTP 403)
--   BEFORE RLS runs — which blocked reading public.organisation_members and
--   therefore stranded the whole application (no active organisation resolved).
--
--   Additionally, migration 010 (organisation-based RLS cutover) did not fully
--   apply on this project: vineyards / blocks / operations still carried the
--   old owner-based ("... own ...") policies alongside the org-based ones.
--   Permissive policies OR-combine, so leaving the owner policies is a tenant-
--   isolation hole. This migration drops those leftovers.
--
-- SAFETY:
--   * GRANTs are a coarse "may touch this table" gate; organisation-based RLS
--     still governs WHICH rows each user can see/modify. Granting DML to
--     `authenticated` does NOT weaken tenant isolation.
--   * audit_log remains SELECT-only for users (writes come from triggers /
--     service role), matching the design.
--   * Idempotent: GRANT is repeatable; policy drops use IF EXISTS.
--
-- THIS MIGRATION DOES NOT:
--   * create/alter tables, columns, RLS policies (other than dropping the
--     leftover owner policies), functions, or triggers
--   * change any data
-- ============================================================

BEGIN;

-- ============================================================
-- 1. TABLE PRIVILEGES FOR THE `authenticated` ROLE
-- RLS still decides which rows are visible/mutable.
-- ============================================================

-- Tenancy tables
GRANT SELECT, INSERT, UPDATE, DELETE ON public.organisations        TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.organisation_members TO authenticated;
GRANT SELECT                          ON public.audit_log            TO authenticated;

-- Business tables
GRANT SELECT, INSERT, UPDATE, DELETE ON public.vineyards        TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.blocks           TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.operations       TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.irrigation       TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.spray_programme  TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.harvest          TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.machinery        TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.finance          TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.planner          TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cultivars        TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.plantings        TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.grape_intakes    TO authenticated;

-- ============================================================
-- 2. FINISH 010 — DROP LEFTOVER OWNER-BASED POLICIES
-- (vineyards / blocks / operations only; the other six business tables
-- already had their owner policies dropped by 010.)
-- ============================================================
DROP POLICY IF EXISTS "Users can view own vineyards"   ON public.vineyards;
DROP POLICY IF EXISTS "Users can insert own vineyards" ON public.vineyards;
DROP POLICY IF EXISTS "Users can update own vineyards" ON public.vineyards;
DROP POLICY IF EXISTS "Users can delete own vineyards" ON public.vineyards;

DROP POLICY IF EXISTS "Users can view own blocks"   ON public.blocks;
DROP POLICY IF EXISTS "Users can insert own blocks" ON public.blocks;
DROP POLICY IF EXISTS "Users can update own blocks" ON public.blocks;
DROP POLICY IF EXISTS "Users can delete own blocks" ON public.blocks;

DROP POLICY IF EXISTS "Users can view own operations"   ON public.operations;
DROP POLICY IF EXISTS "Users can insert own operations" ON public.operations;
DROP POLICY IF EXISTS "Users can update own operations" ON public.operations;
DROP POLICY IF EXISTS "Users can delete own operations" ON public.operations;

-- ============================================================
-- 3. POST-VALIDATION
-- ============================================================
DO $$
DECLARE
  n INTEGER;
  tbls TEXT[] := ARRAY[
    'organisations','organisation_members',
    'vineyards','blocks','operations','irrigation','spray_programme',
    'harvest','machinery','finance','planner','cultivars','plantings','grape_intakes'
  ];
  t TEXT;
  leftover INTEGER;
BEGIN
  -- 3.1 Every listed table now grants SELECT to authenticated.
  FOREACH t IN ARRAY tbls LOOP
    SELECT COUNT(*) INTO n
    FROM information_schema.role_table_grants
    WHERE table_schema='public' AND table_name=t
      AND grantee='authenticated' AND privilege_type='SELECT';
    IF n <> 1 THEN
      RAISE EXCEPTION 'Post-check failed: authenticated lacks SELECT on public.%.', t
        USING ERRCODE = 'raise_exception';
    END IF;
  END LOOP;

  -- 3.2 No owner-based ("... own ...") policies remain on the nine business tables.
  SELECT COUNT(*) INTO leftover
  FROM pg_policies
  WHERE schemaname='public'
    AND tablename IN ('vineyards','blocks','operations','irrigation','spray_programme',
                      'harvest','machinery','finance','planner')
    AND policyname LIKE 'Users can % own %';
  IF leftover > 0 THEN
    RAISE EXCEPTION 'Post-check failed: % leftover owner-based policy(ies) remain.', leftover
      USING ERRCODE = 'raise_exception';
  END IF;
END $$;

COMMIT;
