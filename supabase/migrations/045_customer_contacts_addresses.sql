-- ============================================================
-- WINERIX — P2L-3: Customer Contacts & Addresses
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- Depends on: 001 (update_updated_at), 006 (organisations, is_org_member,
--             has_org_role), 010 (prevent_owner_id_change), 021
--             (audit_log + audit_log_row_change single writer), 044 (customers).
--             After 044 the audit writer has 21 mappings; this migration -> 23.
--
-- PURPOSE:
--   Add the two child tables of the commercial customer master:
--     customer_contacts   — people at a customer (buyer, accounts, logistics…)
--     customer_addresses  — billing / shipping / other addresses
--   Both are org-scoped, FK to customers ON DELETE CASCADE (no independent
--   meaning without their customer; the customer itself is soft-retired, never
--   hard-deleted while it has history). Each enforces ONE active primary per
--   customer via a partial unique index. Two atomic SECURITY DEFINER RPCs make
--   "set as primary" safe (clear old + set new in one transaction).
--
-- SCOPE — THIS MIGRATION ONLY:
--   Two tables + FKs + CHECKs + indexes + partial unique "one active primary"
--   indexes + org-based RLS (member SELECT; OWNER/ADMIN/SALES INSERT/UPDATE; NO
--   DELETE) + owner_id immutability (010) + updated_at (001) + SECURITY DEFINER
--   cross-org integrity triggers + audit wiring (add customer_contact +
--   customer_address, preserving all 21 existing mappings) + grants + two
--   set-primary RPCs. No seed data. customers table NOT altered.
--
-- THIS MIGRATION DOES NOT:
--   * create sales orders / lines / allocations / pricing / tax / dispatch
--   * embed contacts/addresses as JSON on customers
--   * add any DELETE policy or DELETE grant (soft retirement via is_active)
--   * create a second audit writer or modify audit_log
--   * modify customers, finished_products, stock, or any earlier table
-- ============================================================

BEGIN;

-- ============================================================
-- 0. PRE-FLIGHT
-- ============================================================
DO $$
BEGIN
  IF to_regclass('public.organisations') IS NULL THEN RAISE EXCEPTION 'Pre-flight: organisations missing (006).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.customers') IS NULL THEN RAISE EXCEPTION 'Pre-flight: customers missing (044).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.audit_log') IS NULL THEN RAISE EXCEPTION 'Pre-flight: audit_log missing (006).' USING ERRCODE='undefined_table'; END IF;
  IF to_regprocedure('public.audit_log_row_change()') IS NULL THEN RAISE EXCEPTION 'Pre-flight: audit_log_row_change() missing (021).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.is_org_member(uuid)') IS NULL THEN RAISE EXCEPTION 'Pre-flight: is_org_member missing (006).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.has_org_role(uuid, text[])') IS NULL THEN RAISE EXCEPTION 'Pre-flight: has_org_role missing (006).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.prevent_owner_id_change()') IS NULL THEN RAISE EXCEPTION 'Pre-flight: prevent_owner_id_change missing (010).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.update_updated_at()') IS NULL THEN RAISE EXCEPTION 'Pre-flight: update_updated_at missing (001).' USING ERRCODE='undefined_function'; END IF;
  IF to_regclass('public.customer_contacts') IS NOT NULL THEN RAISE EXCEPTION 'Pre-flight: customer_contacts already exists.' USING ERRCODE='duplicate_table'; END IF;
  IF to_regclass('public.customer_addresses') IS NOT NULL THEN RAISE EXCEPTION 'Pre-flight: customer_addresses already exists.' USING ERRCODE='duplicate_table'; END IF;
END $$;

-- ============================================================
-- 1. CUSTOMER_CONTACTS
-- ============================================================
CREATE TABLE IF NOT EXISTS public.customer_contacts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL,
  customer_id  UUID NOT NULL,
  owner_id     UUID NOT NULL,
  first_name   TEXT NOT NULL,
  last_name    TEXT NOT NULL,
  job_title    TEXT,
  email        TEXT,
  phone        TEXT,
  mobile       TEXT,
  is_primary   BOOLEAN NOT NULL DEFAULT FALSE,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_cc_org
    FOREIGN KEY (org_id) REFERENCES public.organisations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_cc_owner
    FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_cc_customer
    FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE,

  CONSTRAINT cc_first_name_not_blank CHECK (length(btrim(first_name)) > 0),
  CONSTRAINT cc_last_name_not_blank  CHECK (length(btrim(last_name)) > 0)
);

-- One ACTIVE primary contact per customer (inactive primaries don't block).
CREATE UNIQUE INDEX IF NOT EXISTS uq_cc_one_active_primary
  ON public.customer_contacts(customer_id)
  WHERE is_primary AND is_active;

CREATE INDEX IF NOT EXISTS idx_cc_org_id      ON public.customer_contacts(org_id);
CREATE INDEX IF NOT EXISTS idx_cc_owner_id    ON public.customer_contacts(owner_id);
CREATE INDEX IF NOT EXISTS idx_cc_customer_id ON public.customer_contacts(customer_id);
CREATE INDEX IF NOT EXISTS idx_cc_is_active   ON public.customer_contacts(is_active);

-- ============================================================
-- 2. CUSTOMER_ADDRESSES
-- ============================================================
CREATE TABLE IF NOT EXISTS public.customer_addresses (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL,
  customer_id     UUID NOT NULL,
  owner_id        UUID NOT NULL,
  address_type    TEXT NOT NULL,
  label           TEXT,
  company_name    TEXT,
  address_line_1  TEXT NOT NULL,
  address_line_2  TEXT,
  city            TEXT NOT NULL,
  province        TEXT,
  postal_code     TEXT,
  country         TEXT NOT NULL DEFAULT 'South Africa',
  is_primary      BOOLEAN NOT NULL DEFAULT FALSE,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_ca_org
    FOREIGN KEY (org_id) REFERENCES public.organisations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_ca_owner
    FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_ca_customer
    FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE,

  CONSTRAINT ca_type_check CHECK (address_type IN ('Billing','Shipping','Other')),
  CONSTRAINT ca_line1_not_blank   CHECK (length(btrim(address_line_1)) > 0),
  CONSTRAINT ca_city_not_blank    CHECK (length(btrim(city)) > 0),
  CONSTRAINT ca_country_not_blank CHECK (length(btrim(country)) > 0)
);

-- One ACTIVE primary address per customer (inactive primaries don't block).
CREATE UNIQUE INDEX IF NOT EXISTS uq_ca_one_active_primary
  ON public.customer_addresses(customer_id)
  WHERE is_primary AND is_active;

CREATE INDEX IF NOT EXISTS idx_ca_org_id       ON public.customer_addresses(org_id);
CREATE INDEX IF NOT EXISTS idx_ca_owner_id     ON public.customer_addresses(owner_id);
CREATE INDEX IF NOT EXISTS idx_ca_customer_id  ON public.customer_addresses(customer_id);
CREATE INDEX IF NOT EXISTS idx_ca_is_active    ON public.customer_addresses(is_active);
CREATE INDEX IF NOT EXISTS idx_ca_address_type ON public.customer_addresses(address_type);

-- ============================================================
-- 3. OWNER_ID IMMUTABILITY (reuse 010) + UPDATED_AT (reuse 001)
-- ============================================================
DROP TRIGGER IF EXISTS cc_owner_id_immutable ON public.customer_contacts;
CREATE TRIGGER cc_owner_id_immutable BEFORE UPDATE ON public.customer_contacts
  FOR EACH ROW EXECUTE FUNCTION public.prevent_owner_id_change();
DROP TRIGGER IF EXISTS cc_updated_at ON public.customer_contacts;
CREATE TRIGGER cc_updated_at BEFORE UPDATE ON public.customer_contacts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS ca_owner_id_immutable ON public.customer_addresses;
CREATE TRIGGER ca_owner_id_immutable BEFORE UPDATE ON public.customer_addresses
  FOR EACH ROW EXECUTE FUNCTION public.prevent_owner_id_change();
DROP TRIGGER IF EXISTS ca_updated_at ON public.customer_addresses;
CREATE TRIGGER ca_updated_at BEFORE UPDATE ON public.customer_addresses
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ============================================================
-- 4. CROSS-ORGANISATION INTEGRITY (SECURITY DEFINER, pinned search_path)
-- The referenced customer must exist and be the SAME org as the child row.
-- ============================================================
CREATE OR REPLACE FUNCTION public.validate_customer_contact_org_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  cust_org UUID;
BEGIN
  SELECT c.org_id INTO cust_org FROM public.customers c WHERE c.id = NEW.customer_id;
  IF cust_org IS NULL THEN
    RAISE EXCEPTION 'Invalid customer: % does not exist.', NEW.customer_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF cust_org <> NEW.org_id THEN
    RAISE EXCEPTION 'Cross-organisation reference: customer % belongs to a different organisation.', NEW.customer_id USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS cc_org_integrity ON public.customer_contacts;
CREATE TRIGGER cc_org_integrity
  BEFORE INSERT OR UPDATE ON public.customer_contacts
  FOR EACH ROW EXECUTE FUNCTION public.validate_customer_contact_org_integrity();

CREATE OR REPLACE FUNCTION public.validate_customer_address_org_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  cust_org UUID;
BEGIN
  SELECT c.org_id INTO cust_org FROM public.customers c WHERE c.id = NEW.customer_id;
  IF cust_org IS NULL THEN
    RAISE EXCEPTION 'Invalid customer: % does not exist.', NEW.customer_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF cust_org <> NEW.org_id THEN
    RAISE EXCEPTION 'Cross-organisation reference: customer % belongs to a different organisation.', NEW.customer_id USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ca_org_integrity ON public.customer_addresses;
CREATE TRIGGER ca_org_integrity
  BEFORE INSERT OR UPDATE ON public.customer_addresses
  FOR EACH ROW EXECUTE FUNCTION public.validate_customer_address_org_integrity();

-- ============================================================
-- 5. ROW LEVEL SECURITY (member SELECT; OWNER/ADMIN/SALES write; NO DELETE)
-- ============================================================
ALTER TABLE public.customer_contacts  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_addresses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view organisation customer contacts"
  ON public.customer_contacts FOR SELECT USING (public.is_org_member(org_id));
CREATE POLICY "Sales roles can insert organisation customer contacts"
  ON public.customer_contacts FOR INSERT
  WITH CHECK (public.is_org_member(org_id) AND owner_id = auth.uid()
    AND public.has_org_role(org_id, ARRAY['OWNER','ADMIN','SALES']));
CREATE POLICY "Sales roles can update organisation customer contacts"
  ON public.customer_contacts FOR UPDATE
  USING (public.is_org_member(org_id) AND public.has_org_role(org_id, ARRAY['OWNER','ADMIN','SALES']))
  WITH CHECK (public.is_org_member(org_id) AND public.has_org_role(org_id, ARRAY['OWNER','ADMIN','SALES']));

CREATE POLICY "Users can view organisation customer addresses"
  ON public.customer_addresses FOR SELECT USING (public.is_org_member(org_id));
CREATE POLICY "Sales roles can insert organisation customer addresses"
  ON public.customer_addresses FOR INSERT
  WITH CHECK (public.is_org_member(org_id) AND owner_id = auth.uid()
    AND public.has_org_role(org_id, ARRAY['OWNER','ADMIN','SALES']));
CREATE POLICY "Sales roles can update organisation customer addresses"
  ON public.customer_addresses FOR UPDATE
  USING (public.is_org_member(org_id) AND public.has_org_role(org_id, ARRAY['OWNER','ADMIN','SALES']))
  WITH CHECK (public.is_org_member(org_id) AND public.has_org_role(org_id, ARRAY['OWNER','ADMIN','SALES']));

-- No DELETE policy on either table (soft retirement via is_active).

-- ============================================================
-- 6. GRANTS — SELECT/INSERT/UPDATE only (NO DELETE)
-- ============================================================
GRANT SELECT, INSERT, UPDATE ON public.customer_contacts  TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.customer_addresses TO authenticated;

-- ============================================================
-- 7. EXTEND THE SINGLE AUDIT WRITER (reuse 021) + attach triggers
-- Adds customer_contact + customer_address, preserving all 21 existing mappings.
-- Final CASE = 23. Posture unchanged.
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
    WHEN 'customer_contacts'    THEN 'customer_contact'
    WHEN 'customer_addresses'   THEN 'customer_address'
    ELSE NULL
  END;

  IF v_entity_type IS NULL THEN
    RAISE EXCEPTION 'audit_log_row_change: unexpected table % — refusing to write an audit row.', TG_TABLE_NAME
      USING ERRCODE = 'raise_exception';
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_org_id := NEW.org_id; v_entity_id := NEW.id; v_old := NULL; v_new := to_jsonb(NEW);
  ELSIF TG_OP = 'UPDATE' THEN
    v_org_id := NEW.org_id; v_entity_id := NEW.id; v_old := to_jsonb(OLD); v_new := to_jsonb(NEW);
  ELSIF TG_OP = 'DELETE' THEN
    v_org_id := OLD.org_id; v_entity_id := OLD.id; v_old := to_jsonb(OLD); v_new := NULL;
  ELSE
    RAISE EXCEPTION 'audit_log_row_change: unsupported operation %.', TG_OP USING ERRCODE = 'raise_exception';
  END IF;

  INSERT INTO public.audit_log
    (org_id, actor_user_id, action, entity_type, entity_id, old_data, new_data, metadata)
  VALUES
    (v_org_id, auth.uid(), TG_OP, v_entity_type, v_entity_id, v_old, v_new, NULL);

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.audit_log_row_change() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_audit_customer_contacts ON public.customer_contacts;
CREATE TRIGGER trg_audit_customer_contacts
  AFTER INSERT OR UPDATE OR DELETE ON public.customer_contacts
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_row_change();

DROP TRIGGER IF EXISTS trg_audit_customer_addresses ON public.customer_addresses;
CREATE TRIGGER trg_audit_customer_addresses
  AFTER INSERT OR UPDATE OR DELETE ON public.customer_addresses
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_row_change();

-- ============================================================
-- 8. ATOMIC "SET PRIMARY" RPCs (SECURITY DEFINER)
-- Clear any current active primary and set the target primary in ONE
-- transaction, avoiding a partial-unique-index collision from two client
-- updates. Org/role enforced; the target must be active.
-- ============================================================
CREATE OR REPLACE FUNCTION public.set_primary_customer_contact(p_contact_id UUID)
RETURNS public.customer_contacts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid     UUID := auth.uid();
  v_row     public.customer_contacts;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated.' USING ERRCODE='raise_exception'; END IF;
  SELECT * INTO v_row FROM public.customer_contacts WHERE id = p_contact_id FOR UPDATE;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'Contact % not found.', p_contact_id USING ERRCODE='raise_exception'; END IF;
  IF NOT public.is_org_member(v_row.org_id) OR NOT public.has_org_role(v_row.org_id, ARRAY['OWNER','ADMIN','SALES']) THEN
    RAISE EXCEPTION 'This operation requires an Owner, Admin or Sales role.' USING ERRCODE='raise_exception';
  END IF;
  IF NOT v_row.is_active THEN RAISE EXCEPTION 'An inactive contact cannot be made primary.' USING ERRCODE='raise_exception'; END IF;

  -- Clear the current active primary (if any, other than this row), then set.
  UPDATE public.customer_contacts
     SET is_primary = FALSE
   WHERE customer_id = v_row.customer_id AND is_primary AND is_active AND id <> p_contact_id;
  UPDATE public.customer_contacts
     SET is_primary = TRUE
   WHERE id = p_contact_id
   RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;
REVOKE ALL ON FUNCTION public.set_primary_customer_contact(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_primary_customer_contact(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_primary_customer_address(p_address_id UUID)
RETURNS public.customer_addresses
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_row public.customer_addresses;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated.' USING ERRCODE='raise_exception'; END IF;
  SELECT * INTO v_row FROM public.customer_addresses WHERE id = p_address_id FOR UPDATE;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'Address % not found.', p_address_id USING ERRCODE='raise_exception'; END IF;
  IF NOT public.is_org_member(v_row.org_id) OR NOT public.has_org_role(v_row.org_id, ARRAY['OWNER','ADMIN','SALES']) THEN
    RAISE EXCEPTION 'This operation requires an Owner, Admin or Sales role.' USING ERRCODE='raise_exception';
  END IF;
  IF NOT v_row.is_active THEN RAISE EXCEPTION 'An inactive address cannot be made primary.' USING ERRCODE='raise_exception'; END IF;

  UPDATE public.customer_addresses
     SET is_primary = FALSE
   WHERE customer_id = v_row.customer_id AND is_primary AND is_active AND id <> p_address_id;
  UPDATE public.customer_addresses
     SET is_primary = TRUE
   WHERE id = p_address_id
   RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;
REVOKE ALL ON FUNCTION public.set_primary_customer_address(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_primary_customer_address(UUID) TO authenticated;

-- ============================================================
-- 9. POST-VALIDATION. RAISE => rollback.
-- ============================================================
DO $$
DECLARE n INTEGER; rls_on BOOLEAN;
BEGIN
  -- Tables exist.
  IF to_regclass('public.customer_contacts') IS NULL THEN RAISE EXCEPTION 'Post: customer_contacts missing.' USING ERRCODE='raise_exception'; END IF;
  IF to_regclass('public.customer_addresses') IS NULL THEN RAISE EXCEPTION 'Post: customer_addresses missing.' USING ERRCODE='raise_exception'; END IF;

  -- Column counts.
  SELECT COUNT(*) INTO n FROM information_schema.columns WHERE table_schema='public' AND table_name='customer_contacts'
    AND column_name IN ('id','org_id','customer_id','owner_id','first_name','last_name','job_title','email','phone','mobile','is_primary','is_active','notes','created_at','updated_at');
  IF n <> 15 THEN RAISE EXCEPTION 'Post: customer_contacts columns mismatch (%).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM information_schema.columns WHERE table_schema='public' AND table_name='customer_addresses'
    AND column_name IN ('id','org_id','customer_id','owner_id','address_type','label','company_name','address_line_1','address_line_2','city','province','postal_code','country','is_primary','is_active','notes','created_at','updated_at');
  IF n <> 18 THEN RAISE EXCEPTION 'Post: customer_addresses columns mismatch (%).', n USING ERRCODE='raise_exception'; END IF;

  -- 3 FKs each (org, owner, customer).
  SELECT COUNT(*) INTO n FROM information_schema.table_constraints WHERE table_schema='public' AND table_name='customer_contacts' AND constraint_type='FOREIGN KEY';
  IF n <> 3 THEN RAISE EXCEPTION 'Post: customer_contacts should have 3 FKs (%).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM information_schema.table_constraints WHERE table_schema='public' AND table_name='customer_addresses' AND constraint_type='FOREIGN KEY';
  IF n <> 3 THEN RAISE EXCEPTION 'Post: customer_addresses should have 3 FKs (%).', n USING ERRCODE='raise_exception'; END IF;

  -- customer FK is ON DELETE CASCADE on both.
  SELECT COUNT(*) INTO n FROM pg_constraint
    WHERE conname IN ('fk_cc_customer','fk_ca_customer') AND confdeltype='c';
  IF n <> 2 THEN RAISE EXCEPTION 'Post: customer FK must be ON DELETE CASCADE on both tables (found % cascade).', n USING ERRCODE='raise_exception'; END IF;

  -- CHECK constraints.
  SELECT COUNT(*) INTO n FROM pg_constraint WHERE conrelid='public.customer_contacts'::regclass AND contype='c'
    AND conname IN ('cc_first_name_not_blank','cc_last_name_not_blank');
  IF n <> 2 THEN RAISE EXCEPTION 'Post: customer_contacts name CHECKs missing (%).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_constraint WHERE conrelid='public.customer_addresses'::regclass AND contype='c'
    AND conname IN ('ca_type_check','ca_line1_not_blank','ca_city_not_blank','ca_country_not_blank');
  IF n <> 4 THEN RAISE EXCEPTION 'Post: customer_addresses CHECKs missing (%).', n USING ERRCODE='raise_exception'; END IF;

  -- Primary partial unique indexes.
  IF to_regclass('public.uq_cc_one_active_primary') IS NULL THEN RAISE EXCEPTION 'Post: contact primary unique index missing.' USING ERRCODE='raise_exception'; END IF;
  IF to_regclass('public.uq_ca_one_active_primary') IS NULL THEN RAISE EXCEPTION 'Post: address primary unique index missing.' USING ERRCODE='raise_exception'; END IF;

  -- RLS enabled.
  SELECT relrowsecurity INTO rls_on FROM pg_class WHERE oid='public.customer_contacts'::regclass;
  IF NOT COALESCE(rls_on,false) THEN RAISE EXCEPTION 'Post: RLS off on customer_contacts.' USING ERRCODE='raise_exception'; END IF;
  SELECT relrowsecurity INTO rls_on FROM pg_class WHERE oid='public.customer_addresses'::regclass;
  IF NOT COALESCE(rls_on,false) THEN RAISE EXCEPTION 'Post: RLS off on customer_addresses.' USING ERRCODE='raise_exception'; END IF;

  -- 3 policies each; no DELETE policy.
  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='customer_contacts';
  IF n <> 3 THEN RAISE EXCEPTION 'Post: customer_contacts must have 3 policies (%).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='customer_addresses';
  IF n <> 3 THEN RAISE EXCEPTION 'Post: customer_addresses must have 3 policies (%).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename IN ('customer_contacts','customer_addresses') AND cmd='DELETE';
  IF n <> 0 THEN RAISE EXCEPTION 'Post: no DELETE policy allowed.' USING ERRCODE='raise_exception'; END IF;

  -- No DELETE grant.
  SELECT COUNT(*) INTO n FROM information_schema.role_table_grants
  WHERE table_schema='public' AND table_name IN ('customer_contacts','customer_addresses')
    AND grantee='authenticated' AND privilege_type='DELETE';
  IF n <> 0 THEN RAISE EXCEPTION 'Post: no DELETE grant allowed (%).', n USING ERRCODE='raise_exception'; END IF;

  -- Triggers present (owner immutability + updated_at + org integrity + audit) on each.
  SELECT COUNT(*) INTO n FROM pg_trigger WHERE tgrelid='public.customer_contacts'::regclass AND NOT tgisinternal
    AND tgname IN ('cc_owner_id_immutable','cc_updated_at','cc_org_integrity','trg_audit_customer_contacts');
  IF n <> 4 THEN RAISE EXCEPTION 'Post: customer_contacts triggers mismatch (%).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_trigger WHERE tgrelid='public.customer_addresses'::regclass AND NOT tgisinternal
    AND tgname IN ('ca_owner_id_immutable','ca_updated_at','ca_org_integrity','trg_audit_customer_addresses');
  IF n <> 4 THEN RAISE EXCEPTION 'Post: customer_addresses triggers mismatch (%).', n USING ERRCODE='raise_exception'; END IF;

  -- Audit mappings present (both new) + a prior mapping preserved.
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.audit_log_row_change()'::regprocedure
      AND pg_get_functiondef(oid) ILIKE '%''customer_contact''%'
      AND pg_get_functiondef(oid) ILIKE '%''customer_address''%'
      AND pg_get_functiondef(oid) ILIKE '%''customer''%'
      AND pg_get_functiondef(oid) ILIKE '%''stock_movement''%') THEN
    RAISE EXCEPTION 'Post: audit writer missing required mappings.' USING ERRCODE='raise_exception';
  END IF;

  -- Set-primary RPCs present + SECURITY DEFINER + authenticated-only.
  IF to_regprocedure('public.set_primary_customer_contact(uuid)') IS NULL THEN RAISE EXCEPTION 'Post: set_primary_customer_contact missing.' USING ERRCODE='raise_exception'; END IF;
  IF to_regprocedure('public.set_primary_customer_address(uuid)') IS NULL THEN RAISE EXCEPTION 'Post: set_primary_customer_address missing.' USING ERRCODE='raise_exception'; END IF;
  IF has_function_privilege('public','public.set_primary_customer_contact(uuid)','EXECUTE')
     OR has_function_privilege('public','public.set_primary_customer_address(uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'Post: PUBLIC must not EXECUTE the set-primary RPCs.' USING ERRCODE='raise_exception';
  END IF;

  -- No seed data.
  SELECT COUNT(*) INTO n FROM public.customer_contacts;
  IF n <> 0 THEN RAISE EXCEPTION 'Post: customer_contacts must be empty (%).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM public.customer_addresses;
  IF n <> 0 THEN RAISE EXCEPTION 'Post: customer_addresses must be empty (%).', n USING ERRCODE='raise_exception'; END IF;
END $$;

COMMIT;
