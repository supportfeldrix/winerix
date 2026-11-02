-- ============================================================
-- WINERIX — P2O-Finance (058): Posting RPCs
-- The SECURITY DEFINER write layer for auto-posted finance entries, plus an
-- atomic "create machinery + post its purchase expense" RPC. This migration
-- creates functions ONLY; it posts nothing on its own and is not yet wired into
-- the delivery/dispatch/return flows (that is 059).
--
-- Depends on: 006 (organisations, is_org_member, has_org_role), 021 (audit
--             writer — finance/machinery now mapped via 057), 057 (finance
--             source-link columns + idempotency index; machinery purchase_cost).
--
-- LOCKED DECISIONS (P2O-Finance review v2):
--   * Auto rows are written ONLY by post_finance_entry() (SECURITY DEFINER,
--     pinned search_path). It is internal: REVOKEd from PUBLIC, not granted to
--     authenticated (only other SECURITY DEFINER RPCs in 059 call it).
--   * Idempotent: ON CONFLICT on uq_finance_autopost_source
--     (source_type, source_id, type) WHERE auto_generated -> DO NOTHING, so a
--     retried economic event never double-posts. Returns the existing or new row.
--   * create_machinery(...) is a NEW client-callable RPC (OWNER/ADMIN) that
--     inserts the machinery row and, when purchase_cost > 0, posts ONE expense
--     entry in the SAME transaction (atomic). The existing direct-insert path is
--     left intact for backward compatibility; the UI will prefer this RPC.
--   * Amounts are stored as given (net). The finance table has no tax column;
--     tax handling is out of scope (future commercial-finance phase).
--
-- THIS MIGRATION DOES NOT: change RLS, touch org_id/owner_id, modify the
--   delivery/dispatch/return RPCs (059), or seed data.
-- ============================================================

BEGIN;

-- ============================================================
-- 0. PRE-FLIGHT
-- ============================================================
DO $$
BEGIN
  IF to_regclass('public.finance') IS NULL THEN RAISE EXCEPTION 'Pre-flight: finance missing (005).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.machinery') IS NULL THEN RAISE EXCEPTION 'Pre-flight: machinery missing (005).' USING ERRCODE='undefined_table'; END IF;
  IF to_regprocedure('public.is_org_member(uuid)') IS NULL THEN RAISE EXCEPTION 'Pre-flight: is_org_member missing (006).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.has_org_role(uuid, text[])') IS NULL THEN RAISE EXCEPTION 'Pre-flight: has_org_role missing (006).' USING ERRCODE='undefined_function'; END IF;
  -- 057 columns must be present.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='finance' AND column_name='auto_generated') THEN
    RAISE EXCEPTION 'Pre-flight: finance.auto_generated missing — run 057 first.' USING ERRCODE='raise_exception';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='machinery' AND column_name='purchase_cost') THEN
    RAISE EXCEPTION 'Pre-flight: machinery.purchase_cost missing — run 057 first.' USING ERRCODE='raise_exception';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='uq_finance_autopost_source') THEN
    RAISE EXCEPTION 'Pre-flight: uq_finance_autopost_source missing — run 057 first.' USING ERRCODE='raise_exception';
  END IF;
END $$;

-- ============================================================
-- 1. post_finance_entry — internal idempotent auto-post writer.
-- Inserts one auto_generated finance row for an economic event. Idempotent on
-- (source_type, source_id, type). Returns the finance row (existing or new).
-- Internal: REVOKEd from PUBLIC, NOT granted to authenticated — only the
-- SECURITY DEFINER event RPCs (059) call it. It derives nothing from the client.
-- ============================================================
CREATE OR REPLACE FUNCTION public.post_finance_entry(
  p_org_id              UUID,
  p_actor              UUID,
  p_type               TEXT,     -- 'income' | 'expense'
  p_category           TEXT,
  p_title              TEXT,
  p_amount             NUMERIC,
  p_entry_date         DATE,
  p_source_type        TEXT,     -- 'machinery' | 'sales_delivery' | 'dispatch_reversal' | 'return_credit'
  p_source_id          UUID,
  p_reverses_finance_id UUID DEFAULT NULL
)
RETURNS public.finance
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row public.finance;
BEGIN
  IF p_org_id IS NULL THEN RAISE EXCEPTION 'post_finance_entry: org is required.' USING ERRCODE='raise_exception'; END IF;
  IF p_type NOT IN ('income','expense') THEN RAISE EXCEPTION 'post_finance_entry: invalid type %.', p_type USING ERRCODE='raise_exception'; END IF;
  IF p_source_type IS NULL OR p_source_type = 'manual' THEN RAISE EXCEPTION 'post_finance_entry: an auto source_type is required.' USING ERRCODE='raise_exception'; END IF;
  IF p_source_id IS NULL THEN RAISE EXCEPTION 'post_finance_entry: source_id is required.' USING ERRCODE='raise_exception'; END IF;
  IF p_amount IS NULL OR p_amount < 0 THEN RAISE EXCEPTION 'post_finance_entry: amount must be >= 0.' USING ERRCODE='raise_exception'; END IF;

  -- A zero-amount event posts nothing (e.g. unpriced line / no machinery cost).
  IF p_amount = 0 THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.finance
    (org_id, owner_id, title, type, category, amount, entry_date,
     source_type, source_id, auto_generated, reverses_finance_id)
  VALUES
    (p_org_id, p_actor, p_title, p_type, p_category, round(p_amount::numeric, 2),
     COALESCE(p_entry_date, CURRENT_DATE), p_source_type, p_source_id, true, p_reverses_finance_id)
  ON CONFLICT (source_type, source_id, type) WHERE auto_generated DO NOTHING
  RETURNING * INTO v_row;

  -- If the conflict fired (already posted), fetch and return the existing row.
  IF v_row.id IS NULL THEN
    SELECT * INTO v_row FROM public.finance
    WHERE source_type = p_source_type AND source_id = p_source_id AND type = p_type AND auto_generated
    LIMIT 1;
  END IF;

  RETURN v_row;
END;
$$;
REVOKE ALL ON FUNCTION public.post_finance_entry(UUID, UUID, TEXT, TEXT, TEXT, NUMERIC, DATE, TEXT, UUID, UUID) FROM PUBLIC;

-- ============================================================
-- 2. create_manual_finance_entry — client-callable wrapper for MANUAL entries.
-- Keeps manual entry working through an RPC that enforces org membership + role
-- and sets owner_id = caller, org_id = given (validated). auto_generated=false.
-- (The existing direct-insert client path also still works under the org RLS
-- from 010; this RPC is provided for parity and future UI use.)
-- ============================================================
CREATE OR REPLACE FUNCTION public.create_manual_finance_entry(
  p_org_id      UUID,
  p_type        TEXT,
  p_category    TEXT,
  p_title       TEXT,
  p_amount      NUMERIC,
  p_entry_date  DATE DEFAULT NULL,
  p_vineyard_id UUID DEFAULT NULL,
  p_block_id    UUID DEFAULT NULL
)
RETURNS public.finance
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_row public.finance;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated.' USING ERRCODE='raise_exception'; END IF;
  IF NOT public.is_org_member(p_org_id) THEN RAISE EXCEPTION 'Not a member of the target organisation.' USING ERRCODE='raise_exception'; END IF;
  IF NOT public.has_org_role(p_org_id, ARRAY['OWNER','ADMIN','SALES']) THEN
    RAISE EXCEPTION 'Creating a finance entry requires an Owner, Admin or Sales role.' USING ERRCODE='raise_exception';
  END IF;
  IF p_type NOT IN ('income','expense') THEN RAISE EXCEPTION 'Invalid finance type %.', p_type USING ERRCODE='raise_exception'; END IF;
  IF p_title IS NULL OR length(btrim(p_title)) = 0 THEN RAISE EXCEPTION 'A title is required.' USING ERRCODE='raise_exception'; END IF;
  IF p_amount IS NULL OR p_amount < 0 THEN RAISE EXCEPTION 'Amount must be >= 0.' USING ERRCODE='raise_exception'; END IF;

  INSERT INTO public.finance
    (org_id, owner_id, vineyard_id, block_id, title, type, category, amount, entry_date,
     source_type, auto_generated)
  VALUES
    (p_org_id, v_uid, p_vineyard_id, p_block_id, btrim(p_title), p_type, p_category,
     round(p_amount::numeric, 2), COALESCE(p_entry_date, CURRENT_DATE), 'manual', false)
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;
REVOKE ALL ON FUNCTION public.create_manual_finance_entry(UUID, TEXT, TEXT, TEXT, NUMERIC, DATE, UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_manual_finance_entry(UUID, TEXT, TEXT, TEXT, NUMERIC, DATE, UUID, UUID) TO authenticated;

-- ============================================================
-- 3. create_machinery — atomic create + auto-post purchase expense.
-- OWNER/ADMIN. Inserts the machinery row (owner_id = caller) and, when
-- purchase_cost > 0, posts ONE expense entry (category 'equipment') linked to
-- the machinery id, in the SAME transaction. Idempotent on the finance side via
-- post_finance_entry (machinery id is unique, so one expense per machine).
-- ============================================================
CREATE OR REPLACE FUNCTION public.create_machinery(
  p_org_id        UUID,
  p_name          TEXT,
  p_category      TEXT DEFAULT NULL,
  p_registration  TEXT DEFAULT NULL,
  p_status        TEXT DEFAULT 'operational',
  p_vineyard_id   UUID DEFAULT NULL,
  p_purchase_cost NUMERIC DEFAULT NULL,
  p_purchase_date DATE DEFAULT NULL,
  p_last_service_date DATE DEFAULT NULL
)
RETURNS public.machinery
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_machine public.machinery;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated.' USING ERRCODE='raise_exception'; END IF;
  IF NOT public.is_org_member(p_org_id) THEN RAISE EXCEPTION 'Not a member of the target organisation.' USING ERRCODE='raise_exception'; END IF;
  IF NOT public.has_org_role(p_org_id, ARRAY['OWNER','ADMIN']) THEN
    RAISE EXCEPTION 'Adding machinery requires an Owner or Admin role.' USING ERRCODE='raise_exception';
  END IF;
  IF p_name IS NULL OR length(btrim(p_name)) = 0 THEN RAISE EXCEPTION 'A machinery name is required.' USING ERRCODE='raise_exception'; END IF;
  IF p_purchase_cost IS NOT NULL AND p_purchase_cost < 0 THEN RAISE EXCEPTION 'Purchase cost must be >= 0.' USING ERRCODE='raise_exception'; END IF;

  INSERT INTO public.machinery
    (org_id, owner_id, vineyard_id, name, category, registration, status,
     purchase_cost, purchase_date, last_service_date)
  VALUES
    (p_org_id, v_uid, p_vineyard_id, btrim(p_name), p_category, p_registration,
     COALESCE(NULLIF(btrim(COALESCE(p_status,'')), ''), 'operational'),
     p_purchase_cost, p_purchase_date, p_last_service_date)
  RETURNING * INTO v_machine;

  -- Auto-post the purchase expense when a positive cost is supplied.
  IF p_purchase_cost IS NOT NULL AND p_purchase_cost > 0 THEN
    PERFORM public.post_finance_entry(
      p_org_id, v_uid, 'expense', 'equipment',
      format('Machinery purchase: %s', v_machine.name),
      p_purchase_cost, COALESCE(p_purchase_date, CURRENT_DATE),
      'machinery', v_machine.id, NULL
    );
  END IF;

  RETURN v_machine;
END;
$$;
REVOKE ALL ON FUNCTION public.create_machinery(UUID, TEXT, TEXT, TEXT, TEXT, UUID, NUMERIC, DATE, DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_machinery(UUID, TEXT, TEXT, TEXT, TEXT, UUID, NUMERIC, DATE, DATE) TO authenticated;

-- ============================================================
-- 4. POST-VALIDATION (catalog checks). RAISE => rollback.
-- ============================================================
DO $$
DECLARE v_oid OID; v_secdef BOOLEAN; v_cfg TEXT[]; v_path BOOLEAN;
BEGIN
  -- post_finance_entry: exists, SECURITY DEFINER, pinned path, PUBLIC revoked, NOT granted to authenticated.
  v_oid := to_regprocedure('public.post_finance_entry(uuid, uuid, text, text, text, numeric, date, text, uuid, uuid)');
  IF v_oid IS NULL THEN RAISE EXCEPTION 'Post: post_finance_entry missing.' USING ERRCODE='raise_exception'; END IF;
  SELECT prosecdef INTO v_secdef FROM pg_proc WHERE oid=v_oid;
  IF NOT v_secdef THEN RAISE EXCEPTION 'Post: post_finance_entry must be SECURITY DEFINER.' USING ERRCODE='raise_exception'; END IF;
  SELECT proconfig INTO v_cfg FROM pg_proc WHERE oid=v_oid;
  v_path := EXISTS (SELECT 1 FROM unnest(COALESCE(v_cfg, ARRAY[]::TEXT[])) c WHERE c LIKE 'search_path=%' AND position('public' IN c)>0 AND position('pg_temp' IN c)>0);
  IF NOT v_path THEN RAISE EXCEPTION 'Post: post_finance_entry must pin search_path.' USING ERRCODE='raise_exception'; END IF;
  IF has_function_privilege('public', v_oid, 'EXECUTE') THEN RAISE EXCEPTION 'Post: PUBLIC must not execute post_finance_entry.' USING ERRCODE='raise_exception'; END IF;
  IF has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN RAISE EXCEPTION 'Post: authenticated must not execute post_finance_entry (internal).' USING ERRCODE='raise_exception'; END IF;

  -- create_manual_finance_entry + create_machinery: SECURITY DEFINER, pinned, PUBLIC revoked, authenticated granted.
  FOR v_oid IN SELECT unnest(ARRAY[
      to_regprocedure('public.create_manual_finance_entry(uuid, text, text, text, numeric, date, uuid, uuid)'),
      to_regprocedure('public.create_machinery(uuid, text, text, text, text, uuid, numeric, date, date)')])
  LOOP
    IF v_oid IS NULL THEN RAISE EXCEPTION 'Post: a finance client RPC is missing.' USING ERRCODE='raise_exception'; END IF;
    SELECT prosecdef INTO v_secdef FROM pg_proc WHERE oid=v_oid;
    IF NOT v_secdef THEN RAISE EXCEPTION 'Post: % must be SECURITY DEFINER.', v_oid::regprocedure USING ERRCODE='raise_exception'; END IF;
    SELECT proconfig INTO v_cfg FROM pg_proc WHERE oid=v_oid;
    v_path := EXISTS (SELECT 1 FROM unnest(COALESCE(v_cfg, ARRAY[]::TEXT[])) c WHERE c LIKE 'search_path=%' AND position('public' IN c)>0 AND position('pg_temp' IN c)>0);
    IF NOT v_path THEN RAISE EXCEPTION 'Post: % must pin search_path.', v_oid::regprocedure USING ERRCODE='raise_exception'; END IF;
    IF has_function_privilege('public', v_oid, 'EXECUTE') THEN RAISE EXCEPTION 'Post: PUBLIC must not execute %.', v_oid::regprocedure USING ERRCODE='raise_exception'; END IF;
    IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN RAISE EXCEPTION 'Post: authenticated must execute %.', v_oid::regprocedure USING ERRCODE='raise_exception'; END IF;
  END LOOP;

  RAISE NOTICE 'Post: P2O-Finance 058 posting RPCs installed — post_finance_entry (internal) + create_manual_finance_entry + create_machinery verified.';
END $$;

COMMIT;
