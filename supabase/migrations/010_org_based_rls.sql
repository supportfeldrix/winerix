-- ============================================================
-- WINERIX — P0 Step 4B: Organisation-based RLS cutover
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- Depends on: 002/003/004/005 (nine business tables + owner-based RLS)
--             006_tenancy_foundation.sql (organisations, is_org_member)
--             009_add_org_id_to_business_tables.sql (org_id NOT NULL + FK)
--
-- PURPOSE:
--   Replace the owner-based RLS (auth.uid() = owner_id) on all nine business
--   tables with organisation-membership-based RLS (public.is_org_member(org_id)),
--   and add an owner_id-immutability trigger so any active member may edit a
--   record without being able to reassign creator attribution.
--
-- TENANT BOUNDARY after this migration:
--   org_id + ACTIVE membership  (NOT owner_id).
--   owner_id remains creator/attribution only and is protected from change.
--
-- ATOMICITY:
--   Whole migration is one transaction. For each table the old four policies
--   are DROPPed and the new four CREATEd within the SAME transaction, so there
--   is never a committed state where old (owner-based) and new (org-based)
--   permissive policies coexist. Permissive policies OR-combine, so coexistence
--   would let owner_id bypass tenant isolation — this migration prevents that.
--
-- THIS MIGRATION DOES NOT:
--   * modify any business-row data (owner_id / org_id values untouched)
--   * alter existing foreign keys, indexes, or updated_at triggers
--   * modify or re-grant is_org_member / has_org_role / member_role
--   * change tenancy-table (organisations / organisation_members / audit_log) RLS
--   * backfill anything (009 already did)
--   * modify application code
--
-- ROLLBACK:
--   Any validation failure RAISEs and rolls back the entire transaction. To
--   revert AFTER a successful apply, a separate rollback migration can drop the
--   org-based policies and recreate the four owner-based policies per table
--   (and drop the owner_id-immutability triggers). That rollback migration is
--   intentionally NOT authored here.
-- ============================================================

BEGIN;

-- ============================================================
-- 1. PRE-FLIGHT VALIDATION (schema + data). RAISE => rollback.
-- ============================================================
DO $$
DECLARE
  tbls TEXT[] := ARRAY[
    'vineyards','blocks','operations','irrigation','spray_programme',
    'harvest','machinery','finance','planner'
  ];
  t TEXT;
  n INTEGER;
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    -- A. Table exists (in public).
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE EXCEPTION 'Pre-flight failed: table public.% does not exist.', t
        USING ERRCODE = 'undefined_table';
    END IF;

    -- B. owner_id exists, UUID, NOT NULL.
    SELECT COUNT(*) INTO n
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = t
      AND column_name = 'owner_id' AND data_type = 'uuid' AND is_nullable = 'NO';
    IF n <> 1 THEN
      RAISE EXCEPTION 'Pre-flight failed: %.owner_id must be UUID NOT NULL.', t
        USING ERRCODE = 'invalid_table_definition';
    END IF;

    -- B. org_id exists, UUID, NOT NULL.
    SELECT COUNT(*) INTO n
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = t
      AND column_name = 'org_id' AND data_type = 'uuid' AND is_nullable = 'NO';
    IF n <> 1 THEN
      RAISE EXCEPTION 'Pre-flight failed: %.org_id must be UUID NOT NULL.', t
        USING ERRCODE = 'invalid_table_definition';
    END IF;

    -- C. org_id has a FK to public.organisations.
    SELECT COUNT(*) INTO n
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public' AND tc.table_name = t
      AND kcu.column_name = 'org_id'
      AND ccu.table_name = 'organisations' AND ccu.column_name = 'id';
    IF n < 1 THEN
      RAISE EXCEPTION 'Pre-flight failed: %.org_id has no FK to public.organisations(id).', t
        USING ERRCODE = 'invalid_table_definition';
    END IF;
  END LOOP;

  -- D & E & F. Every business row has a non-NULL org_id referencing an existing
  -- organisation. (NOT NULL is already enforced by 009; this also proves the
  -- reference resolves — no orphaned org_id.)
  SELECT
    (SELECT COUNT(*) FROM public.vineyards       x WHERE x.org_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.organisations o WHERE o.id = x.org_id)) +
    (SELECT COUNT(*) FROM public.blocks          x WHERE x.org_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.organisations o WHERE o.id = x.org_id)) +
    (SELECT COUNT(*) FROM public.operations      x WHERE x.org_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.organisations o WHERE o.id = x.org_id)) +
    (SELECT COUNT(*) FROM public.irrigation      x WHERE x.org_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.organisations o WHERE o.id = x.org_id)) +
    (SELECT COUNT(*) FROM public.spray_programme x WHERE x.org_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.organisations o WHERE o.id = x.org_id)) +
    (SELECT COUNT(*) FROM public.harvest         x WHERE x.org_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.organisations o WHERE o.id = x.org_id)) +
    (SELECT COUNT(*) FROM public.machinery       x WHERE x.org_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.organisations o WHERE o.id = x.org_id)) +
    (SELECT COUNT(*) FROM public.finance         x WHERE x.org_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.organisations o WHERE o.id = x.org_id)) +
    (SELECT COUNT(*) FROM public.planner         x WHERE x.org_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.organisations o WHERE o.id = x.org_id))
  INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION 'Pre-flight failed: % business row(s) have a missing/invalid org_id.', n
      USING ERRCODE = 'data_exception';
  END IF;
END $$;

-- ============================================================
-- 2. VERIFY REQUIRED HELPER FUNCTIONS EXIST (do NOT modify them).
-- ============================================================
DO $$
BEGIN
  IF to_regprocedure('public.is_org_member(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.is_org_member(uuid) is missing.'
      USING ERRCODE = 'undefined_function';
  END IF;
END $$;

-- ============================================================
-- 3. OWNER_ID IMMUTABILITY FUNCTION
-- Rejects any UPDATE that changes owner_id; allows all other column updates.
-- Generic and reused across all nine tables. Plain trigger function — it reads
-- only OLD/NEW, needs no elevated privileges, so it is NOT SECURITY DEFINER.
-- ============================================================
CREATE OR REPLACE FUNCTION public.prevent_owner_id_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
    RAISE EXCEPTION 'owner_id is immutable and cannot be reassigned (creator attribution).'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- ============================================================
-- 4. OWNER_ID IMMUTABILITY TRIGGERS (all nine business tables)
-- DROP IF EXISTS then CREATE => idempotent, no duplicates.
-- ============================================================
DROP TRIGGER IF EXISTS vineyards_owner_id_immutable       ON public.vineyards;
CREATE TRIGGER vineyards_owner_id_immutable       BEFORE UPDATE ON public.vineyards       FOR EACH ROW EXECUTE FUNCTION public.prevent_owner_id_change();

DROP TRIGGER IF EXISTS blocks_owner_id_immutable          ON public.blocks;
CREATE TRIGGER blocks_owner_id_immutable          BEFORE UPDATE ON public.blocks          FOR EACH ROW EXECUTE FUNCTION public.prevent_owner_id_change();

DROP TRIGGER IF EXISTS operations_owner_id_immutable      ON public.operations;
CREATE TRIGGER operations_owner_id_immutable      BEFORE UPDATE ON public.operations      FOR EACH ROW EXECUTE FUNCTION public.prevent_owner_id_change();

DROP TRIGGER IF EXISTS irrigation_owner_id_immutable      ON public.irrigation;
CREATE TRIGGER irrigation_owner_id_immutable      BEFORE UPDATE ON public.irrigation      FOR EACH ROW EXECUTE FUNCTION public.prevent_owner_id_change();

DROP TRIGGER IF EXISTS spray_programme_owner_id_immutable ON public.spray_programme;
CREATE TRIGGER spray_programme_owner_id_immutable BEFORE UPDATE ON public.spray_programme FOR EACH ROW EXECUTE FUNCTION public.prevent_owner_id_change();

DROP TRIGGER IF EXISTS harvest_owner_id_immutable         ON public.harvest;
CREATE TRIGGER harvest_owner_id_immutable         BEFORE UPDATE ON public.harvest         FOR EACH ROW EXECUTE FUNCTION public.prevent_owner_id_change();

DROP TRIGGER IF EXISTS machinery_owner_id_immutable       ON public.machinery;
CREATE TRIGGER machinery_owner_id_immutable       BEFORE UPDATE ON public.machinery       FOR EACH ROW EXECUTE FUNCTION public.prevent_owner_id_change();

DROP TRIGGER IF EXISTS finance_owner_id_immutable         ON public.finance;
CREATE TRIGGER finance_owner_id_immutable         BEFORE UPDATE ON public.finance         FOR EACH ROW EXECUTE FUNCTION public.prevent_owner_id_change();

DROP TRIGGER IF EXISTS planner_owner_id_immutable         ON public.planner;
CREATE TRIGGER planner_owner_id_immutable         BEFORE UPDATE ON public.planner         FOR EACH ROW EXECUTE FUNCTION public.prevent_owner_id_change();

-- ============================================================
-- 5. REPLACE POLICIES — per table, DROP old four then CREATE new four.
-- Old names (from 002/003/004/005): "Users can {view|insert|update|delete} own <table>"
-- New names:                        "Users can {view|insert|update|delete} organisation <table>"
-- ============================================================

-- ---- vineyards ----
DROP POLICY IF EXISTS "Users can view own vineyards"   ON public.vineyards;
DROP POLICY IF EXISTS "Users can insert own vineyards" ON public.vineyards;
DROP POLICY IF EXISTS "Users can update own vineyards" ON public.vineyards;
DROP POLICY IF EXISTS "Users can delete own vineyards" ON public.vineyards;
CREATE POLICY "Users can view organisation vineyards"   ON public.vineyards FOR SELECT USING (public.is_org_member(org_id));
CREATE POLICY "Users can insert organisation vineyards" ON public.vineyards FOR INSERT WITH CHECK (public.is_org_member(org_id) AND owner_id = auth.uid());
CREATE POLICY "Users can update organisation vineyards" ON public.vineyards FOR UPDATE USING (public.is_org_member(org_id)) WITH CHECK (public.is_org_member(org_id));
CREATE POLICY "Users can delete organisation vineyards" ON public.vineyards FOR DELETE USING (public.is_org_member(org_id));

-- ---- blocks ----
DROP POLICY IF EXISTS "Users can view own blocks"   ON public.blocks;
DROP POLICY IF EXISTS "Users can insert own blocks" ON public.blocks;
DROP POLICY IF EXISTS "Users can update own blocks" ON public.blocks;
DROP POLICY IF EXISTS "Users can delete own blocks" ON public.blocks;
CREATE POLICY "Users can view organisation blocks"   ON public.blocks FOR SELECT USING (public.is_org_member(org_id));
CREATE POLICY "Users can insert organisation blocks" ON public.blocks FOR INSERT WITH CHECK (public.is_org_member(org_id) AND owner_id = auth.uid());
CREATE POLICY "Users can update organisation blocks" ON public.blocks FOR UPDATE USING (public.is_org_member(org_id)) WITH CHECK (public.is_org_member(org_id));
CREATE POLICY "Users can delete organisation blocks" ON public.blocks FOR DELETE USING (public.is_org_member(org_id));

-- ---- operations ----
DROP POLICY IF EXISTS "Users can view own operations"   ON public.operations;
DROP POLICY IF EXISTS "Users can insert own operations" ON public.operations;
DROP POLICY IF EXISTS "Users can update own operations" ON public.operations;
DROP POLICY IF EXISTS "Users can delete own operations" ON public.operations;
CREATE POLICY "Users can view organisation operations"   ON public.operations FOR SELECT USING (public.is_org_member(org_id));
CREATE POLICY "Users can insert organisation operations" ON public.operations FOR INSERT WITH CHECK (public.is_org_member(org_id) AND owner_id = auth.uid());
CREATE POLICY "Users can update organisation operations" ON public.operations FOR UPDATE USING (public.is_org_member(org_id)) WITH CHECK (public.is_org_member(org_id));
CREATE POLICY "Users can delete organisation operations" ON public.operations FOR DELETE USING (public.is_org_member(org_id));

-- ---- irrigation ----
DROP POLICY IF EXISTS "Users can view own irrigation"   ON public.irrigation;
DROP POLICY IF EXISTS "Users can insert own irrigation" ON public.irrigation;
DROP POLICY IF EXISTS "Users can update own irrigation" ON public.irrigation;
DROP POLICY IF EXISTS "Users can delete own irrigation" ON public.irrigation;
CREATE POLICY "Users can view organisation irrigation"   ON public.irrigation FOR SELECT USING (public.is_org_member(org_id));
CREATE POLICY "Users can insert organisation irrigation" ON public.irrigation FOR INSERT WITH CHECK (public.is_org_member(org_id) AND owner_id = auth.uid());
CREATE POLICY "Users can update organisation irrigation" ON public.irrigation FOR UPDATE USING (public.is_org_member(org_id)) WITH CHECK (public.is_org_member(org_id));
CREATE POLICY "Users can delete organisation irrigation" ON public.irrigation FOR DELETE USING (public.is_org_member(org_id));

-- ---- spray_programme ----
DROP POLICY IF EXISTS "Users can view own spray programme"   ON public.spray_programme;
DROP POLICY IF EXISTS "Users can insert own spray programme" ON public.spray_programme;
DROP POLICY IF EXISTS "Users can update own spray programme" ON public.spray_programme;
DROP POLICY IF EXISTS "Users can delete own spray programme" ON public.spray_programme;
CREATE POLICY "Users can view organisation spray programme"   ON public.spray_programme FOR SELECT USING (public.is_org_member(org_id));
CREATE POLICY "Users can insert organisation spray programme" ON public.spray_programme FOR INSERT WITH CHECK (public.is_org_member(org_id) AND owner_id = auth.uid());
CREATE POLICY "Users can update organisation spray programme" ON public.spray_programme FOR UPDATE USING (public.is_org_member(org_id)) WITH CHECK (public.is_org_member(org_id));
CREATE POLICY "Users can delete organisation spray programme" ON public.spray_programme FOR DELETE USING (public.is_org_member(org_id));

-- ---- harvest ----
DROP POLICY IF EXISTS "Users can view own harvest"   ON public.harvest;
DROP POLICY IF EXISTS "Users can insert own harvest" ON public.harvest;
DROP POLICY IF EXISTS "Users can update own harvest" ON public.harvest;
DROP POLICY IF EXISTS "Users can delete own harvest" ON public.harvest;
CREATE POLICY "Users can view organisation harvest"   ON public.harvest FOR SELECT USING (public.is_org_member(org_id));
CREATE POLICY "Users can insert organisation harvest" ON public.harvest FOR INSERT WITH CHECK (public.is_org_member(org_id) AND owner_id = auth.uid());
CREATE POLICY "Users can update organisation harvest" ON public.harvest FOR UPDATE USING (public.is_org_member(org_id)) WITH CHECK (public.is_org_member(org_id));
CREATE POLICY "Users can delete organisation harvest" ON public.harvest FOR DELETE USING (public.is_org_member(org_id));

-- ---- machinery ----
DROP POLICY IF EXISTS "Users can view own machinery"   ON public.machinery;
DROP POLICY IF EXISTS "Users can insert own machinery" ON public.machinery;
DROP POLICY IF EXISTS "Users can update own machinery" ON public.machinery;
DROP POLICY IF EXISTS "Users can delete own machinery" ON public.machinery;
CREATE POLICY "Users can view organisation machinery"   ON public.machinery FOR SELECT USING (public.is_org_member(org_id));
CREATE POLICY "Users can insert organisation machinery" ON public.machinery FOR INSERT WITH CHECK (public.is_org_member(org_id) AND owner_id = auth.uid());
CREATE POLICY "Users can update organisation machinery" ON public.machinery FOR UPDATE USING (public.is_org_member(org_id)) WITH CHECK (public.is_org_member(org_id));
CREATE POLICY "Users can delete organisation machinery" ON public.machinery FOR DELETE USING (public.is_org_member(org_id));

-- ---- finance ----
DROP POLICY IF EXISTS "Users can view own finance"   ON public.finance;
DROP POLICY IF EXISTS "Users can insert own finance" ON public.finance;
DROP POLICY IF EXISTS "Users can update own finance" ON public.finance;
DROP POLICY IF EXISTS "Users can delete own finance" ON public.finance;
CREATE POLICY "Users can view organisation finance"   ON public.finance FOR SELECT USING (public.is_org_member(org_id));
CREATE POLICY "Users can insert organisation finance" ON public.finance FOR INSERT WITH CHECK (public.is_org_member(org_id) AND owner_id = auth.uid());
CREATE POLICY "Users can update organisation finance" ON public.finance FOR UPDATE USING (public.is_org_member(org_id)) WITH CHECK (public.is_org_member(org_id));
CREATE POLICY "Users can delete organisation finance" ON public.finance FOR DELETE USING (public.is_org_member(org_id));

-- ---- planner ----
DROP POLICY IF EXISTS "Users can view own planner"   ON public.planner;
DROP POLICY IF EXISTS "Users can insert own planner" ON public.planner;
DROP POLICY IF EXISTS "Users can update own planner" ON public.planner;
DROP POLICY IF EXISTS "Users can delete own planner" ON public.planner;
CREATE POLICY "Users can view organisation planner"   ON public.planner FOR SELECT USING (public.is_org_member(org_id));
CREATE POLICY "Users can insert organisation planner" ON public.planner FOR INSERT WITH CHECK (public.is_org_member(org_id) AND owner_id = auth.uid());
CREATE POLICY "Users can update organisation planner" ON public.planner FOR UPDATE USING (public.is_org_member(org_id)) WITH CHECK (public.is_org_member(org_id));
CREATE POLICY "Users can delete organisation planner" ON public.planner FOR DELETE USING (public.is_org_member(org_id));

-- ============================================================
-- 6. POST-CHANGE VALIDATION (catalog checks). RAISE => rollback.
-- ============================================================
DO $$
DECLARE
  tbls TEXT[] := ARRAY[
    'vineyards','blocks','operations','irrigation','spray_programme',
    'harvest','machinery','finance','planner'
  ];
  t TEXT;
  n INTEGER;
  txt TEXT;
  rls_on BOOLEAN;
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    -- A. RLS still enabled.
    SELECT c.relrowsecurity INTO rls_on
    FROM pg_class c
    WHERE c.oid = ('public.' || t)::regclass;
    IF NOT COALESCE(rls_on, false) THEN
      RAISE EXCEPTION 'Post-check failed: RLS not enabled on %.', t
        USING ERRCODE = 'raise_exception';
    END IF;

    -- B. Exactly four policies on the table.
    SELECT COUNT(*) INTO n FROM pg_policies
    WHERE schemaname = 'public' AND tablename = t;
    IF n <> 4 THEN
      RAISE EXCEPTION 'Post-check failed: % has % policies (expected 4).', t, n
        USING ERRCODE = 'raise_exception';
    END IF;

    -- H. No old owner-based policy names remain.
    SELECT COUNT(*) INTO n FROM pg_policies
    WHERE schemaname = 'public' AND tablename = t
      AND policyname LIKE 'Users can % own %';
    IF n > 0 THEN
      RAISE EXCEPTION 'Post-check failed: % still has % owner-based policy(ies).', t, n
        USING ERRCODE = 'raise_exception';
    END IF;

    -- C. SELECT policy references is_org_member.
    SELECT qual INTO txt FROM pg_policies
    WHERE schemaname = 'public' AND tablename = t AND cmd = 'SELECT';
    IF txt IS NULL OR position('is_org_member' IN txt) = 0 THEN
      RAISE EXCEPTION 'Post-check failed: % SELECT policy does not reference is_org_member.', t
        USING ERRCODE = 'raise_exception';
    END IF;

    -- D. INSERT policy references is_org_member AND owner_id = auth.uid().
    SELECT with_check INTO txt FROM pg_policies
    WHERE schemaname = 'public' AND tablename = t AND cmd = 'INSERT';
    IF txt IS NULL
       OR position('is_org_member' IN txt) = 0
       OR position('owner_id' IN txt) = 0
       OR position('auth.uid()' IN txt) = 0 THEN
      RAISE EXCEPTION 'Post-check failed: % INSERT policy missing is_org_member/owner_id/auth.uid().', t
        USING ERRCODE = 'raise_exception';
    END IF;

    -- E & F. UPDATE policy: USING and WITH CHECK reference is_org_member, and
    --        it does NOT require owner_id = auth.uid() in either clause.
    SELECT qual INTO txt FROM pg_policies
    WHERE schemaname = 'public' AND tablename = t AND cmd = 'UPDATE';
    IF txt IS NULL OR position('is_org_member' IN txt) = 0 THEN
      RAISE EXCEPTION 'Post-check failed: % UPDATE USING does not reference is_org_member.', t
        USING ERRCODE = 'raise_exception';
    END IF;
    IF position('owner_id' IN txt) > 0 THEN
      RAISE EXCEPTION 'Post-check failed: % UPDATE USING must not reference owner_id.', t
        USING ERRCODE = 'raise_exception';
    END IF;

    SELECT with_check INTO txt FROM pg_policies
    WHERE schemaname = 'public' AND tablename = t AND cmd = 'UPDATE';
    IF txt IS NULL OR position('is_org_member' IN txt) = 0 THEN
      RAISE EXCEPTION 'Post-check failed: % UPDATE WITH CHECK does not reference is_org_member.', t
        USING ERRCODE = 'raise_exception';
    END IF;
    IF position('owner_id' IN txt) > 0 THEN
      RAISE EXCEPTION 'Post-check failed: % UPDATE WITH CHECK must not reference owner_id.', t
        USING ERRCODE = 'raise_exception';
    END IF;

    -- G. DELETE policy references is_org_member.
    SELECT qual INTO txt FROM pg_policies
    WHERE schemaname = 'public' AND tablename = t AND cmd = 'DELETE';
    IF txt IS NULL OR position('is_org_member' IN txt) = 0 THEN
      RAISE EXCEPTION 'Post-check failed: % DELETE policy does not reference is_org_member.', t
        USING ERRCODE = 'raise_exception';
    END IF;

    -- I. owner_id immutability trigger exists on the table.
    SELECT COUNT(*) INTO n FROM pg_trigger
    WHERE tgrelid = ('public.' || t)::regclass
      AND tgname = t || '_owner_id_immutable'
      AND NOT tgisinternal;
    IF n <> 1 THEN
      RAISE EXCEPTION 'Post-check failed: % missing owner_id immutability trigger.', t
        USING ERRCODE = 'raise_exception';
    END IF;
  END LOOP;

  -- J. Existing helper still present (must not have been dropped).
  IF to_regprocedure('public.is_org_member(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Post-check failed: public.is_org_member(uuid) is missing.'
      USING ERRCODE = 'undefined_function';
  END IF;
END $$;

COMMIT;

-- ============================================================
-- SECURITY GUARANTEE (why owner_id can no longer bypass isolation):
--   Every business-table policy authorises solely on public.is_org_member(org_id),
--   which is true only for an ACTIVE membership of the row's organisation. No
--   policy grants access via owner_id. Therefore a user who is an active member
--   of Org A but NOT of Org B cannot SELECT/UPDATE/DELETE a Org B row — even one
--   they created (owner_id = auth.uid()) — and cannot INSERT into Org B (INSERT
--   WITH CHECK requires is_org_member(org_id)). The UPDATE WITH CHECK re-checks
--   the RESULTING org_id, so a row cannot be moved into an org the user does not
--   actively belong to. owner_id is immutable (trigger), preserving attribution.
-- ============================================================
