-- ============================================================
-- WINERIX — P2L-4: Sales Order Foundation + Order Numbering + Draft Orders
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- Depends on: 001 (update_updated_at), 006 (organisations, is_org_member,
--             has_org_role), 010 (prevent_owner_id_change), 021
--             (audit_log + audit_log_row_change single writer), 044 (customers),
--             045 (customer_addresses). After 045 the audit writer has 23
--             mappings; this migration -> 24.
--
-- PURPOSE:
--   Establish the Sales Order header + a concurrency-safe per-org/per-year order
--   numbering mechanism (SO-YYYY-NNNN). This migration creates ONLY:
--     sales_order_sequences  — per (org, year) counter
--     sales_orders           — order header (draft foundation)
--     next_sales_order_number(uuid) — SECURITY DEFINER numbering RPC
--   It does NOT create sales_order_lines, pricing, tax, allocation, dispatch,
--   invoices or payments (later phases). Totals exist as columns but remain 0
--   for drafts (no line calculations here). Address snapshot columns exist but
--   stay NULL (populated at confirmation in P2L-5).
--
-- SCOPE — THIS MIGRATION ONLY:
--   Two tables + FKs + CHECKs + indexes + unique order_number per org + RLS
--   (member SELECT; OWNER/ADMIN/SALES INSERT/UPDATE; NO DELETE) + owner_id
--   immutability (010) + updated_at (001) + SECURITY DEFINER cross-org/
--   cross-customer integrity trigger + audit wiring (add sales_order) + grants +
--   the numbering RPC. No seed data.
--
-- THIS MIGRATION DOES NOT:
--   * create sales_order_lines / pricing / tax / allocation / dispatch
--   * implement confirmation or address-snapshot population
--   * add any DELETE policy or DELETE grant
--   * modify customers / customer_addresses / stock / earlier tables
--   * create a second audit writer or modify audit_log
-- ============================================================

BEGIN;

-- ============================================================
-- 0. PRE-FLIGHT
-- ============================================================
DO $$
BEGIN
  IF to_regclass('public.organisations') IS NULL THEN RAISE EXCEPTION 'Pre-flight: organisations missing (006).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.customers') IS NULL THEN RAISE EXCEPTION 'Pre-flight: customers missing (044).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.customer_addresses') IS NULL THEN RAISE EXCEPTION 'Pre-flight: customer_addresses missing (045).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.audit_log') IS NULL THEN RAISE EXCEPTION 'Pre-flight: audit_log missing (006).' USING ERRCODE='undefined_table'; END IF;
  IF to_regprocedure('public.audit_log_row_change()') IS NULL THEN RAISE EXCEPTION 'Pre-flight: audit_log_row_change() missing (021).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.is_org_member(uuid)') IS NULL THEN RAISE EXCEPTION 'Pre-flight: is_org_member missing (006).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.has_org_role(uuid, text[])') IS NULL THEN RAISE EXCEPTION 'Pre-flight: has_org_role missing (006).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.prevent_owner_id_change()') IS NULL THEN RAISE EXCEPTION 'Pre-flight: prevent_owner_id_change missing (010).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.update_updated_at()') IS NULL THEN RAISE EXCEPTION 'Pre-flight: update_updated_at missing (001).' USING ERRCODE='undefined_function'; END IF;
  IF to_regclass('public.sales_orders') IS NOT NULL THEN RAISE EXCEPTION 'Pre-flight: sales_orders already exists.' USING ERRCODE='duplicate_table'; END IF;
  IF to_regclass('public.sales_order_sequences') IS NOT NULL THEN RAISE EXCEPTION 'Pre-flight: sales_order_sequences already exists.' USING ERRCODE='duplicate_table'; END IF;
END $$;

-- ============================================================
-- 1. SALES_ORDER_SEQUENCES — per (org, year) counter for SO-YYYY-NNNN
-- Written only by the numbering RPC (no direct client write policy/grant).
-- ============================================================
CREATE TABLE IF NOT EXISTS public.sales_order_sequences (
  org_id       UUID NOT NULL,
  order_year   INTEGER NOT NULL,
  last_number  INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT pk_sales_order_sequences PRIMARY KEY (org_id, order_year),
  CONSTRAINT fk_sos_org FOREIGN KEY (org_id) REFERENCES public.organisations(id) ON DELETE RESTRICT,
  CONSTRAINT sos_last_number_non_negative CHECK (last_number >= 0),
  CONSTRAINT sos_year_sane CHECK (order_year >= 2000 AND order_year <= 2200)
);

ALTER TABLE public.sales_order_sequences ENABLE ROW LEVEL SECURITY;
-- Members may read their org's sequence counters; writes are RPC-only.
CREATE POLICY "Users can view organisation sales order sequences"
  ON public.sales_order_sequences FOR SELECT
  USING (public.is_org_member(org_id));
GRANT SELECT ON public.sales_order_sequences TO authenticated;

-- ============================================================
-- 2. SALES_ORDERS — order header (draft foundation)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.sales_orders (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                    UUID NOT NULL,
  owner_id                  UUID NOT NULL,
  customer_id               UUID NOT NULL,
  order_number              TEXT NOT NULL,
  order_date                DATE NOT NULL DEFAULT CURRENT_DATE,
  requested_delivery_date   DATE,
  status                    TEXT NOT NULL DEFAULT 'draft',
  currency                  TEXT NOT NULL DEFAULT 'ZAR',
  billing_address_id        UUID,
  shipping_address_id       UUID,
  billing_address_snapshot  JSONB,
  shipping_address_snapshot JSONB,
  subtotal                  NUMERIC(14,2) NOT NULL DEFAULT 0,
  discount_total            NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax_total                 NUMERIC(14,2) NOT NULL DEFAULT 0,
  total                     NUMERIC(14,2) NOT NULL DEFAULT 0,
  notes                     TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_so_org      FOREIGN KEY (org_id) REFERENCES public.organisations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_so_owner    FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_so_customer FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE RESTRICT,
  CONSTRAINT fk_so_billing  FOREIGN KEY (billing_address_id) REFERENCES public.customer_addresses(id) ON DELETE SET NULL,
  CONSTRAINT fk_so_shipping FOREIGN KEY (shipping_address_id) REFERENCES public.customer_addresses(id) ON DELETE SET NULL,

  CONSTRAINT so_order_number_not_blank CHECK (length(btrim(order_number)) > 0),
  CONSTRAINT so_currency_not_blank CHECK (length(btrim(currency)) > 0),
  -- Full approved P2L lifecycle so future phases need no column redesign.
  CONSTRAINT so_status_check CHECK (status IN (
    'draft','confirmed','allocated','partially_allocated','ready_to_dispatch','cancelled'
  )),
  CONSTRAINT so_delivery_not_before_order
    CHECK (requested_delivery_date IS NULL OR requested_delivery_date >= order_date),
  CONSTRAINT so_subtotal_non_negative CHECK (subtotal >= 0),
  CONSTRAINT so_discount_non_negative CHECK (discount_total >= 0),
  CONSTRAINT so_tax_non_negative CHECK (tax_total >= 0),
  CONSTRAINT so_total_non_negative CHECK (total >= 0)
);

-- order_number unique WITHIN an organisation.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_orders_org_number
  ON public.sales_orders(org_id, order_number);

CREATE INDEX IF NOT EXISTS idx_so_org_id        ON public.sales_orders(org_id);
CREATE INDEX IF NOT EXISTS idx_so_owner_id      ON public.sales_orders(owner_id);
CREATE INDEX IF NOT EXISTS idx_so_customer_id   ON public.sales_orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_so_order_number  ON public.sales_orders(order_number);
CREATE INDEX IF NOT EXISTS idx_so_order_date    ON public.sales_orders(order_date);
CREATE INDEX IF NOT EXISTS idx_so_req_delivery  ON public.sales_orders(requested_delivery_date);
CREATE INDEX IF NOT EXISTS idx_so_status        ON public.sales_orders(status);
CREATE INDEX IF NOT EXISTS idx_so_billing_addr  ON public.sales_orders(billing_address_id);
CREATE INDEX IF NOT EXISTS idx_so_shipping_addr ON public.sales_orders(shipping_address_id);

-- ============================================================
-- 3. OWNER_ID IMMUTABILITY (010) + UPDATED_AT (001)
-- ============================================================
DROP TRIGGER IF EXISTS so_owner_id_immutable ON public.sales_orders;
CREATE TRIGGER so_owner_id_immutable BEFORE UPDATE ON public.sales_orders
  FOR EACH ROW EXECUTE FUNCTION public.prevent_owner_id_change();
DROP TRIGGER IF EXISTS so_updated_at ON public.sales_orders;
CREATE TRIGGER so_updated_at BEFORE UPDATE ON public.sales_orders
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS sos_updated_at ON public.sales_order_sequences;
CREATE TRIGGER sos_updated_at BEFORE UPDATE ON public.sales_order_sequences
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ============================================================
-- 4. CROSS-ORG / CROSS-CUSTOMER INTEGRITY (SECURITY DEFINER, pinned search_path)
-- customer must be same org as the order; each supplied address must belong to
-- the SAME org AND the SAME customer as the order.
-- ============================================================
CREATE OR REPLACE FUNCTION public.validate_sales_order_org_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  cust_org  UUID;
  addr_org  UUID;
  addr_cust UUID;
BEGIN
  SELECT c.org_id INTO cust_org FROM public.customers c WHERE c.id = NEW.customer_id;
  IF cust_org IS NULL THEN
    RAISE EXCEPTION 'Invalid customer: % does not exist.', NEW.customer_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF cust_org <> NEW.org_id THEN
    RAISE EXCEPTION 'Cross-organisation reference: customer % belongs to a different organisation.', NEW.customer_id USING ERRCODE = 'raise_exception';
  END IF;

  IF NEW.billing_address_id IS NOT NULL THEN
    SELECT a.org_id, a.customer_id INTO addr_org, addr_cust FROM public.customer_addresses a WHERE a.id = NEW.billing_address_id;
    IF addr_org IS NULL THEN
      RAISE EXCEPTION 'Invalid billing address: % does not exist.', NEW.billing_address_id USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF addr_org <> NEW.org_id THEN
      RAISE EXCEPTION 'Cross-organisation reference: billing address % belongs to a different organisation.', NEW.billing_address_id USING ERRCODE = 'raise_exception';
    END IF;
    IF addr_cust <> NEW.customer_id THEN
      RAISE EXCEPTION 'Billing address % does not belong to the order customer.', NEW.billing_address_id USING ERRCODE = 'raise_exception';
    END IF;
  END IF;

  IF NEW.shipping_address_id IS NOT NULL THEN
    SELECT a.org_id, a.customer_id INTO addr_org, addr_cust FROM public.customer_addresses a WHERE a.id = NEW.shipping_address_id;
    IF addr_org IS NULL THEN
      RAISE EXCEPTION 'Invalid shipping address: % does not exist.', NEW.shipping_address_id USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF addr_org <> NEW.org_id THEN
      RAISE EXCEPTION 'Cross-organisation reference: shipping address % belongs to a different organisation.', NEW.shipping_address_id USING ERRCODE = 'raise_exception';
    END IF;
    IF addr_cust <> NEW.customer_id THEN
      RAISE EXCEPTION 'Shipping address % does not belong to the order customer.', NEW.shipping_address_id USING ERRCODE = 'raise_exception';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS so_org_integrity ON public.sales_orders;
CREATE TRIGGER so_org_integrity
  BEFORE INSERT OR UPDATE ON public.sales_orders
  FOR EACH ROW EXECUTE FUNCTION public.validate_sales_order_org_integrity();

-- ============================================================
-- 5. ROW LEVEL SECURITY (member SELECT; OWNER/ADMIN/SALES write; NO DELETE)
-- ============================================================
ALTER TABLE public.sales_orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view organisation sales orders"
  ON public.sales_orders FOR SELECT
  USING (public.is_org_member(org_id));
CREATE POLICY "Sales roles can insert organisation sales orders"
  ON public.sales_orders FOR INSERT
  WITH CHECK (public.is_org_member(org_id) AND owner_id = auth.uid()
    AND public.has_org_role(org_id, ARRAY['OWNER','ADMIN','SALES']));
CREATE POLICY "Sales roles can update organisation sales orders"
  ON public.sales_orders FOR UPDATE
  USING (public.is_org_member(org_id) AND public.has_org_role(org_id, ARRAY['OWNER','ADMIN','SALES']))
  WITH CHECK (public.is_org_member(org_id) AND public.has_org_role(org_id, ARRAY['OWNER','ADMIN','SALES']));

-- No DELETE policy (orders are cancelled via status in a later phase).

-- ============================================================
-- 6. GRANTS — SELECT/INSERT/UPDATE only (NO DELETE)
-- ============================================================
GRANT SELECT, INSERT, UPDATE ON public.sales_orders TO authenticated;

-- ============================================================
-- 7. EXTEND THE SINGLE AUDIT WRITER (reuse 021) + attach trigger
-- Adds sales_order, preserving all 23 existing mappings. Final CASE = 24.
-- (sales_order_sequences is NOT audited — it is an internal counter, written
-- only by the numbering RPC; it has no audit mapping and no audit trigger.)
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
    WHEN 'sales_orders'         THEN 'sales_order'
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

DROP TRIGGER IF EXISTS trg_audit_sales_orders ON public.sales_orders;
CREATE TRIGGER trg_audit_sales_orders
  AFTER INSERT OR UPDATE OR DELETE ON public.sales_orders
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_row_change();

-- ============================================================
-- 8. next_sales_order_number — concurrency-safe SO-YYYY-NNNN allocator
-- SECURITY DEFINER; auth + membership checked; the (org, year) sequence row is
-- locked FOR UPDATE (created if missing) and incremented atomically. Gaps are
-- acceptable (a rolled-back insert still consumes a number). Returns the number.
-- ============================================================
CREATE OR REPLACE FUNCTION public.next_sales_order_number(p_org_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid   UUID := auth.uid();
  v_year  INTEGER := EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER;
  v_next  INTEGER;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.' USING ERRCODE = 'raise_exception';
  END IF;
  IF NOT public.is_org_member(p_org_id) THEN
    RAISE EXCEPTION 'Not a member of the target organisation.' USING ERRCODE = 'raise_exception';
  END IF;

  -- Ensure the (org, year) row exists, then lock it and bump atomically. The
  -- ON CONFLICT upsert + FOR UPDATE serialises concurrent allocators.
  INSERT INTO public.sales_order_sequences (org_id, order_year, last_number)
  VALUES (p_org_id, v_year, 0)
  ON CONFLICT (org_id, order_year) DO NOTHING;

  SELECT last_number + 1 INTO v_next
  FROM public.sales_order_sequences
  WHERE org_id = p_org_id AND order_year = v_year
  FOR UPDATE;

  UPDATE public.sales_order_sequences
     SET last_number = v_next
   WHERE org_id = p_org_id AND order_year = v_year;

  RETURN format('SO-%s-%s', v_year, lpad(v_next::text, 4, '0'));
END;
$$;
REVOKE ALL ON FUNCTION public.next_sales_order_number(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.next_sales_order_number(UUID) TO authenticated;

-- ============================================================
-- 9. POST-VALIDATION. RAISE => rollback.
-- ============================================================
DO $$
DECLARE n INTEGER; rls_on BOOLEAN; is_secdef BOOLEAN; cfg TEXT[];
BEGIN
  -- Tables exist.
  IF to_regclass('public.sales_orders') IS NULL THEN RAISE EXCEPTION 'Post: sales_orders missing.' USING ERRCODE='raise_exception'; END IF;
  IF to_regclass('public.sales_order_sequences') IS NULL THEN RAISE EXCEPTION 'Post: sales_order_sequences missing.' USING ERRCODE='raise_exception'; END IF;

  -- sales_orders column set (20).
  SELECT COUNT(*) INTO n FROM information_schema.columns WHERE table_schema='public' AND table_name='sales_orders'
    AND column_name IN ('id','org_id','owner_id','customer_id','order_number','order_date','requested_delivery_date','status','currency','billing_address_id','shipping_address_id','billing_address_snapshot','shipping_address_snapshot','subtotal','discount_total','tax_total','total','notes','created_at','updated_at');
  IF n <> 20 THEN RAISE EXCEPTION 'Post: sales_orders columns mismatch (%).', n USING ERRCODE='raise_exception'; END IF;

  -- NOT NULLs.
  SELECT COUNT(*) INTO n FROM information_schema.columns WHERE table_schema='public' AND table_name='sales_orders'
    AND column_name IN ('org_id','owner_id','customer_id','order_number','order_date','status','currency','subtotal','discount_total','tax_total','total') AND is_nullable='NO';
  IF n <> 11 THEN RAISE EXCEPTION 'Post: sales_orders NOT NULL mismatch (%).', n USING ERRCODE='raise_exception'; END IF;

  -- 5 FKs.
  SELECT COUNT(*) INTO n FROM information_schema.table_constraints WHERE table_schema='public' AND table_name='sales_orders' AND constraint_type='FOREIGN KEY';
  IF n <> 5 THEN RAISE EXCEPTION 'Post: sales_orders should have 5 FKs (%).', n USING ERRCODE='raise_exception'; END IF;

  -- ON DELETE behaviours: customer RESTRICT; billing/shipping SET NULL.
  IF (SELECT confdeltype FROM pg_constraint WHERE conname='fk_so_customer') <> 'r' THEN RAISE EXCEPTION 'Post: customer FK must be RESTRICT.' USING ERRCODE='raise_exception'; END IF;
  IF (SELECT confdeltype FROM pg_constraint WHERE conname='fk_so_billing') <> 'n' THEN RAISE EXCEPTION 'Post: billing FK must be SET NULL.' USING ERRCODE='raise_exception'; END IF;
  IF (SELECT confdeltype FROM pg_constraint WHERE conname='fk_so_shipping') <> 'n' THEN RAISE EXCEPTION 'Post: shipping FK must be SET NULL.' USING ERRCODE='raise_exception'; END IF;

  -- Unique order_number per org.
  IF to_regclass('public.uq_sales_orders_org_number') IS NULL THEN RAISE EXCEPTION 'Post: order_number unique index missing.' USING ERRCODE='raise_exception'; END IF;

  -- status CHECK includes the full approved lifecycle.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.sales_orders'::regclass AND contype='c' AND conname='so_status_check'
    AND pg_get_constraintdef(oid) ILIKE '%draft%' AND pg_get_constraintdef(oid) ILIKE '%ready_to_dispatch%' AND pg_get_constraintdef(oid) ILIKE '%cancelled%') THEN
    RAISE EXCEPTION 'Post: sales_orders status CHECK missing/incomplete.' USING ERRCODE='raise_exception';
  END IF;

  -- RLS + 3 policies + no DELETE policy/grant.
  SELECT relrowsecurity INTO rls_on FROM pg_class WHERE oid='public.sales_orders'::regclass;
  IF NOT COALESCE(rls_on,false) THEN RAISE EXCEPTION 'Post: RLS off on sales_orders.' USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='sales_orders';
  IF n <> 3 THEN RAISE EXCEPTION 'Post: sales_orders must have 3 policies (%).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='sales_orders' AND cmd='DELETE';
  IF n <> 0 THEN RAISE EXCEPTION 'Post: no DELETE policy allowed.' USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM information_schema.role_table_grants
  WHERE table_schema='public' AND table_name='sales_orders' AND grantee='authenticated' AND privilege_type='DELETE';
  IF n <> 0 THEN RAISE EXCEPTION 'Post: no DELETE grant allowed.' USING ERRCODE='raise_exception'; END IF;

  -- Triggers (owner immutability + updated_at + org integrity + audit).
  SELECT COUNT(*) INTO n FROM pg_trigger WHERE tgrelid='public.sales_orders'::regclass AND NOT tgisinternal
    AND tgname IN ('so_owner_id_immutable','so_updated_at','so_org_integrity','trg_audit_sales_orders');
  IF n <> 4 THEN RAISE EXCEPTION 'Post: sales_orders triggers mismatch (%).', n USING ERRCODE='raise_exception'; END IF;

  -- Audit mapping present + prior preserved.
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.audit_log_row_change()'::regprocedure
      AND pg_get_functiondef(oid) ILIKE '%''sales_order''%'
      AND pg_get_functiondef(oid) ILIKE '%''customer''%'
      AND pg_get_functiondef(oid) ILIKE '%''customer_address''%') THEN
    RAISE EXCEPTION 'Post: audit writer missing required mappings.' USING ERRCODE='raise_exception';
  END IF;

  -- Sequence table: PK (org, year) + RLS + no write grant.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='pk_sales_order_sequences' AND contype='p') THEN
    RAISE EXCEPTION 'Post: sales_order_sequences PK (org, year) missing.' USING ERRCODE='raise_exception';
  END IF;
  SELECT relrowsecurity INTO rls_on FROM pg_class WHERE oid='public.sales_order_sequences'::regclass;
  IF NOT COALESCE(rls_on,false) THEN RAISE EXCEPTION 'Post: RLS off on sales_order_sequences.' USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM information_schema.role_table_grants
  WHERE table_schema='public' AND table_name='sales_order_sequences' AND grantee='authenticated' AND privilege_type IN ('INSERT','UPDATE','DELETE');
  IF n <> 0 THEN RAISE EXCEPTION 'Post: sales_order_sequences must not grant write to authenticated (%).', n USING ERRCODE='raise_exception'; END IF;

  -- Numbering RPC: SECURITY DEFINER + pinned search_path + authenticated-only.
  IF to_regprocedure('public.next_sales_order_number(uuid)') IS NULL THEN RAISE EXCEPTION 'Post: next_sales_order_number missing.' USING ERRCODE='raise_exception'; END IF;
  SELECT prosecdef INTO is_secdef FROM pg_proc WHERE oid='public.next_sales_order_number(uuid)'::regprocedure;
  IF NOT COALESCE(is_secdef,false) THEN RAISE EXCEPTION 'Post: next_sales_order_number must be SECURITY DEFINER.' USING ERRCODE='raise_exception'; END IF;
  SELECT proconfig INTO cfg FROM pg_proc WHERE oid='public.next_sales_order_number(uuid)'::regprocedure;
  IF NOT EXISTS (SELECT 1 FROM unnest(COALESCE(cfg,ARRAY[]::TEXT[])) c WHERE c LIKE 'search_path=%' AND position('public' IN c)>0 AND position('pg_temp' IN c)>0) THEN
    RAISE EXCEPTION 'Post: next_sales_order_number must pin search_path.' USING ERRCODE='raise_exception';
  END IF;
  IF has_function_privilege('public','public.next_sales_order_number(uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'Post: PUBLIC must not EXECUTE next_sales_order_number.' USING ERRCODE='raise_exception'; END IF;
  IF NOT has_function_privilege('authenticated','public.next_sales_order_number(uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'Post: authenticated must EXECUTE next_sales_order_number.' USING ERRCODE='raise_exception'; END IF;

  -- No seed data.
  SELECT COUNT(*) INTO n FROM public.sales_orders;
  IF n <> 0 THEN RAISE EXCEPTION 'Post: sales_orders must be empty (%).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM public.sales_order_sequences;
  IF n <> 0 THEN RAISE EXCEPTION 'Post: sales_order_sequences must be empty (%).', n USING ERRCODE='raise_exception'; END IF;
END $$;

COMMIT;
