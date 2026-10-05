-- ============================================================
-- WINERIX — P2L-2: Customers (commercial customer master)
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- Depends on: 001 (update_updated_at), 006 (organisations, is_org_member,
--             has_org_role), 010 (prevent_owner_id_change), 021
--             (audit_log + audit_log_row_change single writer), 040 (extended
--             the audit writer to 20 mappings). After this migration = 21.
--
-- PURPOSE:
--   Establish the organisation-scoped commercial customer master used later by
--   Sales Orders (P2L-4+). This migration creates ONLY the customers table. It
--   does NOT create contacts, addresses, sales orders, order lines, allocations,
--   pricing, tax, dispatch, or any sales-order foreign keys (later phases).
--
-- SCOPE — THIS MIGRATION ONLY:
--   public.customers table + FKs + CHECKs + indexes + partial unique indexes
--   (active legal_name per org, case-insensitive; VAT per org when supplied) +
--   org-based RLS (member SELECT; OWNER/ADMIN/SALES INSERT/UPDATE; NO DELETE) +
--   owner_id immutability (reuse 010) + updated_at (reuse 001) + audit wiring
--   (extend the single writer to add 'customer', preserving all 20 existing
--   mappings; attach the audit trigger) + grants (SELECT/INSERT/UPDATE).
--
-- THIS MIGRATION DOES NOT:
--   * seed any customer rows (no business/demo data)
--   * create customer_contacts / customer_addresses / sales_orders / lines /
--     allocations (later P2L phases)
--   * duplicate address information into customers
--   * add any DELETE policy or DELETE grant (soft retirement via is_active)
--   * create a cross-org integrity trigger (only FKs are org_id + owner_id)
--   * create a second audit writer or attach a trigger to audit_log
--   * modify any existing table or existing data
-- ============================================================

BEGIN;

-- ============================================================
-- 0. PRE-FLIGHT (fail-fast; never silently create dependencies)
-- ============================================================
DO $$
BEGIN
  IF to_regclass('public.organisations') IS NULL THEN RAISE EXCEPTION 'Pre-flight: public.organisations missing (006).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.audit_log') IS NULL THEN RAISE EXCEPTION 'Pre-flight: public.audit_log missing (006).' USING ERRCODE='undefined_table'; END IF;
  IF to_regprocedure('public.audit_log_row_change()') IS NULL THEN RAISE EXCEPTION 'Pre-flight: audit_log_row_change() missing (021).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.is_org_member(uuid)') IS NULL THEN RAISE EXCEPTION 'Pre-flight: is_org_member missing (006).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.has_org_role(uuid, text[])') IS NULL THEN RAISE EXCEPTION 'Pre-flight: has_org_role missing (006).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.prevent_owner_id_change()') IS NULL THEN RAISE EXCEPTION 'Pre-flight: prevent_owner_id_change missing (010).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.update_updated_at()') IS NULL THEN RAISE EXCEPTION 'Pre-flight: update_updated_at missing (001).' USING ERRCODE='undefined_function'; END IF;
  IF to_regclass('public.customers') IS NOT NULL THEN RAISE EXCEPTION 'Pre-flight: public.customers already exists.' USING ERRCODE='duplicate_table'; END IF;
END $$;

-- ============================================================
-- 1. CUSTOMERS — commercial customer master
-- ============================================================
CREATE TABLE IF NOT EXISTS public.customers (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               UUID NOT NULL,
  owner_id             UUID NOT NULL,
  customer_type        TEXT NOT NULL,
  legal_name           TEXT NOT NULL,
  trading_name         TEXT,
  registration_number  TEXT,
  vat_number           TEXT,
  email                TEXT,
  phone                TEXT,
  website              TEXT,
  is_active            BOOLEAN NOT NULL DEFAULT TRUE,
  notes                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_customers_org
    FOREIGN KEY (org_id) REFERENCES public.organisations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_customers_owner
    FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE RESTRICT,

  CONSTRAINT customers_legal_name_not_blank
    CHECK (length(btrim(legal_name)) > 0),
  CONSTRAINT customers_type_check
    CHECK (customer_type IN (
      'Individual','Restaurant','Retailer','Distributor','Wholesaler','Wine Estate','Export','Other'
    ))
);

-- Active legal_name unique WITHIN an organisation, CASE-INSENSITIVELY. Partial
-- so inactive/retired records never block reuse of a legal name.
CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_active_org_legal_name
  ON public.customers(org_id, lower(btrim(legal_name)))
  WHERE is_active;

-- VAT number unique WITHIN an organisation when SUPPLIED (NULL/blank excluded).
CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_org_vat
  ON public.customers(org_id, lower(btrim(vat_number)))
  WHERE vat_number IS NOT NULL AND length(btrim(vat_number)) > 0;

CREATE INDEX IF NOT EXISTS idx_customers_org_id        ON public.customers(org_id);
CREATE INDEX IF NOT EXISTS idx_customers_owner_id      ON public.customers(owner_id);
CREATE INDEX IF NOT EXISTS idx_customers_customer_type ON public.customers(customer_type);
CREATE INDEX IF NOT EXISTS idx_customers_is_active     ON public.customers(is_active);
CREATE INDEX IF NOT EXISTS idx_customers_legal_name    ON public.customers(org_id, lower(btrim(legal_name)));

-- ============================================================
-- 2. OWNER_ID IMMUTABILITY (reuse 010)
-- ============================================================
DROP TRIGGER IF EXISTS customers_owner_id_immutable ON public.customers;
CREATE TRIGGER customers_owner_id_immutable
  BEFORE UPDATE ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.prevent_owner_id_change();

-- ============================================================
-- 3. UPDATED_AT (reuse 001)
-- ============================================================
DROP TRIGGER IF EXISTS customers_updated_at ON public.customers;
CREATE TRIGGER customers_updated_at
  BEFORE UPDATE ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ============================================================
-- 4. ROW LEVEL SECURITY (member SELECT; OWNER/ADMIN/SALES write; NO DELETE)
-- SALES is the commercial write role; VIEWER/FARM/CELLAR read-only.
-- ============================================================
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view organisation customers"
  ON public.customers FOR SELECT
  USING (public.is_org_member(org_id));

CREATE POLICY "Sales roles can insert organisation customers"
  ON public.customers FOR INSERT
  WITH CHECK (public.is_org_member(org_id) AND owner_id = auth.uid()
    AND public.has_org_role(org_id, ARRAY['OWNER','ADMIN','SALES']));

CREATE POLICY "Sales roles can update organisation customers"
  ON public.customers FOR UPDATE
  USING (public.is_org_member(org_id) AND public.has_org_role(org_id, ARRAY['OWNER','ADMIN','SALES']))
  WITH CHECK (public.is_org_member(org_id) AND public.has_org_role(org_id, ARRAY['OWNER','ADMIN','SALES']));

-- No DELETE policy (customers are retired via is_active = false). The order→
-- customer FK will be ON DELETE RESTRICT in a later phase, so hard deletion of
-- a customer with history would be blocked regardless.

-- ============================================================
-- 5. GRANTS — SELECT/INSERT/UPDATE only (NO DELETE)
-- ============================================================
GRANT SELECT, INSERT, UPDATE ON public.customers TO authenticated;

-- ============================================================
-- 6. EXTEND THE SINGLE AUDIT WRITER (reuse 021 writer) + attach trigger
-- Adds 'customer', preserving ALL twenty existing mappings. SECURITY DEFINER /
-- pinned search_path / fail-closed ELSE / REVOKE-from-PUBLIC posture unchanged.
-- Final CASE = 21.
-- ============================================================
CREATE OR REPLACE FUNCTION public.audit_log_row_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_entity_type TEXT;
  v_org_id      UUID;
  v_entity_id   UUID;
  v_old         JSONB;
  v_new         JSONB;
BEGIN
  v_entity_type := CASE TG_TABLE_NAME
    WHEN 'wine_batches'         THEN 'wine_batch'
    WHEN 'batch_grape_intakes'  THEN 'batch_grape_intake'
    WHEN 'wine_lots'            THEN 'wine_lot'
    WHEN 'vessels'              THEN 'vessel'
    WHEN 'vessel_placements'    THEN 'vessel_placement'
    WHEN 'production_events'    THEN 'production_event'
    WHEN 'lot_lineage'          THEN 'lot_lineage'
    WHEN 'lot_volume_movements' THEN 'lot_volume_movement'
    WHEN 'lab_analytes'         THEN 'lab_analyte'
    WHEN 'lab_samples'          THEN 'lab_sample'
    WHEN 'lab_measurements'     THEN 'lab_measurement'
    WHEN 'lab_specifications'   THEN 'lab_specification'
    WHEN 'lab_alerts'           THEN 'lab_alert'
    WHEN 'bottling_runs'        THEN 'bottling_run'
    WHEN 'bottling_run_lots'    THEN 'bottling_run_lot'
    WHEN 'bottling_outputs'     THEN 'bottling_output'
    WHEN 'finished_products'    THEN 'finished_product'
    WHEN 'stock_locations'      THEN 'stock_location'
    WHEN 'stock_items'          THEN 'stock_item'
    WHEN 'stock_movements'      THEN 'stock_movement'
    WHEN 'customers'            THEN 'customer'
    ELSE NULL
  END;

  IF v_entity_type IS NULL THEN
    RAISE EXCEPTION 'audit_log_row_change: unexpected table % — refusing to write an audit row.', TG_TABLE_NAME
      USING ERRCODE = 'raise_exception';
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_org_id    := NEW.org_id;
    v_entity_id := NEW.id;
    v_old       := NULL;
    v_new       := to_jsonb(NEW);
  ELSIF TG_OP = 'UPDATE' THEN
    v_org_id    := NEW.org_id;
    v_entity_id := NEW.id;
    v_old       := to_jsonb(OLD);
    v_new       := to_jsonb(NEW);
  ELSIF TG_OP = 'DELETE' THEN
    v_org_id    := OLD.org_id;
    v_entity_id := OLD.id;
    v_old       := to_jsonb(OLD);
    v_new       := NULL;
  ELSE
    RAISE EXCEPTION 'audit_log_row_change: unsupported operation %.', TG_OP
      USING ERRCODE = 'raise_exception';
  END IF;

  INSERT INTO public.audit_log
    (org_id, actor_user_id, action, entity_type, entity_id, old_data, new_data, metadata)
  VALUES
    (v_org_id, auth.uid(), TG_OP, v_entity_type, v_entity_id, v_old, v_new, NULL);

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.audit_log_row_change() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_audit_customers ON public.customers;
CREATE TRIGGER trg_audit_customers
  AFTER INSERT OR UPDATE OR DELETE ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_row_change();

-- ============================================================
-- 7. POST-VALIDATION (catalog checks). RAISE => rollback.
-- ============================================================
DO $$
DECLARE
  n INTEGER;
  rls_on BOOLEAN;
BEGIN
  IF to_regclass('public.customers') IS NULL THEN RAISE EXCEPTION 'Post: customers missing.' USING ERRCODE='raise_exception'; END IF;

  -- Column set (15).
  SELECT COUNT(*) INTO n FROM information_schema.columns WHERE table_schema='public' AND table_name='customers'
    AND column_name IN ('id','org_id','owner_id','customer_type','legal_name','trading_name','registration_number','vat_number','email','phone','website','is_active','notes','created_at','updated_at');
  IF n <> 15 THEN RAISE EXCEPTION 'Post: customers columns mismatch (%).', n USING ERRCODE='raise_exception'; END IF;

  -- NOT NULL on org_id, owner_id, legal_name, customer_type, is_active.
  SELECT COUNT(*) INTO n FROM information_schema.columns WHERE table_schema='public' AND table_name='customers'
    AND column_name IN ('org_id','owner_id','legal_name','customer_type','is_active') AND is_nullable='NO';
  IF n <> 5 THEN RAISE EXCEPTION 'Post: customers NOT NULL columns mismatch (%).', n USING ERRCODE='raise_exception'; END IF;

  -- Exactly 2 FKs (org, owner).
  SELECT COUNT(*) INTO n FROM information_schema.table_constraints WHERE table_schema='public' AND table_name='customers' AND constraint_type='FOREIGN KEY';
  IF n <> 2 THEN RAISE EXCEPTION 'Post: customers should have exactly 2 FKs (%).', n USING ERRCODE='raise_exception'; END IF;

  -- CHECK constraints: type + legal_name not blank.
  SELECT COUNT(*) INTO n FROM pg_constraint WHERE conrelid='public.customers'::regclass AND contype='c'
    AND conname IN ('customers_type_check','customers_legal_name_not_blank');
  IF n <> 2 THEN RAISE EXCEPTION 'Post: customers CHECK constraints missing (%).', n USING ERRCODE='raise_exception'; END IF;

  -- Partial unique indexes present.
  IF to_regclass('public.uq_customers_active_org_legal_name') IS NULL THEN RAISE EXCEPTION 'Post: active legal_name unique index missing.' USING ERRCODE='raise_exception'; END IF;
  IF to_regclass('public.uq_customers_org_vat') IS NULL THEN RAISE EXCEPTION 'Post: VAT unique index missing.' USING ERRCODE='raise_exception'; END IF;

  -- RLS enabled.
  SELECT relrowsecurity INTO rls_on FROM pg_class WHERE oid='public.customers'::regclass;
  IF NOT COALESCE(rls_on,false) THEN RAISE EXCEPTION 'Post: RLS off on customers.' USING ERRCODE='raise_exception'; END IF;

  -- Exactly 3 policies (SELECT/INSERT/UPDATE), and NO DELETE policy.
  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='customers';
  IF n <> 3 THEN RAISE EXCEPTION 'Post: customers must have 3 policies (%).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='customers' AND cmd='DELETE';
  IF n <> 0 THEN RAISE EXCEPTION 'Post: customers must have no DELETE policy.' USING ERRCODE='raise_exception'; END IF;

  -- No DELETE grant to authenticated.
  SELECT COUNT(*) INTO n FROM information_schema.role_table_grants
  WHERE table_schema='public' AND table_name='customers' AND grantee='authenticated' AND privilege_type='DELETE';
  IF n <> 0 THEN RAISE EXCEPTION 'Post: customers must not grant DELETE.' USING ERRCODE='raise_exception'; END IF;

  -- Triggers: owner immutability + updated_at + audit.
  SELECT COUNT(*) INTO n FROM pg_trigger WHERE tgrelid='public.customers'::regclass AND NOT tgisinternal
    AND tgname IN ('customers_owner_id_immutable','customers_updated_at','trg_audit_customers');
  IF n <> 3 THEN RAISE EXCEPTION 'Post: customers triggers mismatch (%).', n USING ERRCODE='raise_exception'; END IF;

  -- Audit mapping present + prior mappings preserved.
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.audit_log_row_change()'::regprocedure
      AND pg_get_functiondef(oid) ILIKE '%''customer''%'
      AND pg_get_functiondef(oid) ILIKE '%''stock_movement''%'
      AND pg_get_functiondef(oid) ILIKE '%''finished_product''%'
      AND pg_get_functiondef(oid) ILIKE '%''wine_lot''%') THEN
    RAISE EXCEPTION 'Post: audit writer missing one or more required mappings.' USING ERRCODE='raise_exception';
  END IF;

  -- No customer rows seeded by this migration.
  SELECT COUNT(*) INTO n FROM public.customers;
  IF n <> 0 THEN RAISE EXCEPTION 'Post: customers must be empty after migration (found %).', n USING ERRCODE='raise_exception'; END IF;
END $$;

COMMIT;
