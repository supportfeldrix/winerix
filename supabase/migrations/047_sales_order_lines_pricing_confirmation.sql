-- ============================================================
-- WINERIX — P2L-5: Sales Order Lines + Pricing/Tax + Confirmation + Address Snapshots
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- Depends on: 001 (update_updated_at), 006 (organisations, is_org_member,
--             has_org_role), 010 (prevent_owner_id_change), 021 (audit writer),
--             038 (finished_products), 046 (sales_orders + sequence + numbering).
--             After 046 the audit writer has 24 mappings; this migration -> 25.
--
-- PURPOSE:
--   Turn draft sales orders into commercially usable orders:
--     sales_order_lines — product line items with per-line pricing + tax, each
--       carrying commercial SNAPSHOTS (sku, name, bottle volume, unit price, tax
--       rate) plus an FK to finished_products for traceability.
--   Line money is SERVER-AUTHORITATIVE: a BEFORE INSERT/UPDATE trigger recomputes
--   tax_amount and line_total from quantity/unit_price/line_discount/tax_rate so
--   a client can never persist wrong figures. Order totals are derived from the
--   lines by recalculate_sales_order_totals(). Confirmation (confirm_sales_order)
--   recalculates totals, snapshots the chosen billing/shipping addresses to JSONB,
--   and flips status draft -> confirmed, atomically.
--
-- SCOPE — THIS MIGRATION ONLY:
--   sales_order_lines table (+ FKs/CHECKs/indexes/unique) + line money trigger +
--   org integrity trigger + owner immutability + updated_at + RLS (member SELECT;
--   OWNER/ADMIN/SALES INSERT/UPDATE; DELETE only while parent order is draft) +
--   grants + audit (add sales_order_line) + TIGHTEN the sales_orders UPDATE
--   policy to draft-only (replace, not OR) + recalculate_sales_order_totals RPC +
--   confirm_sales_order RPC + post-validation. No seed data.
--
-- THIS MIGRATION DOES NOT:
--   * allocate stock, create stock_movements, or touch P2K / stock_items
--   * implement allocation / ready_to_dispatch / dispatch / invoices / payments
--   * create price lists or customer-specific pricing
--   * implement SARS excise / wine excise / export taxes
--   * modify finished_products, customers, customer_addresses or earlier tables
--     (other than replacing the one sales_orders UPDATE policy)
-- ============================================================

BEGIN;

-- ============================================================
-- 0. PRE-FLIGHT
-- ============================================================
DO $$
BEGIN
  IF to_regclass('public.sales_orders') IS NULL THEN RAISE EXCEPTION 'Pre-flight: sales_orders missing (046).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.finished_products') IS NULL THEN RAISE EXCEPTION 'Pre-flight: finished_products missing (038).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.customer_addresses') IS NULL THEN RAISE EXCEPTION 'Pre-flight: customer_addresses missing (045).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.audit_log') IS NULL THEN RAISE EXCEPTION 'Pre-flight: audit_log missing (006).' USING ERRCODE='undefined_table'; END IF;
  IF to_regprocedure('public.audit_log_row_change()') IS NULL THEN RAISE EXCEPTION 'Pre-flight: audit_log_row_change() missing (021).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.is_org_member(uuid)') IS NULL THEN RAISE EXCEPTION 'Pre-flight: is_org_member missing (006).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.has_org_role(uuid, text[])') IS NULL THEN RAISE EXCEPTION 'Pre-flight: has_org_role missing (006).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.prevent_owner_id_change()') IS NULL THEN RAISE EXCEPTION 'Pre-flight: prevent_owner_id_change missing (010).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.update_updated_at()') IS NULL THEN RAISE EXCEPTION 'Pre-flight: update_updated_at missing (001).' USING ERRCODE='undefined_function'; END IF;
  IF to_regclass('public.sales_order_lines') IS NOT NULL THEN RAISE EXCEPTION 'Pre-flight: sales_order_lines already exists.' USING ERRCODE='duplicate_table'; END IF;
END $$;

-- ============================================================
-- 1. SALES_ORDER_LINES
-- ============================================================
CREATE TABLE IF NOT EXISTS public.sales_order_lines (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                    UUID NOT NULL,
  owner_id                  UUID NOT NULL,
  sales_order_id            UUID NOT NULL,
  finished_product_id       UUID NOT NULL,
  line_number               INTEGER NOT NULL,
  sku_code_snapshot         TEXT NOT NULL,
  product_name_snapshot     TEXT NOT NULL,
  bottle_volume_ml_snapshot INTEGER NOT NULL,
  quantity_bottles          INTEGER NOT NULL,
  unit_price                NUMERIC(14,2) NOT NULL,
  line_discount             NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax_rate                  NUMERIC(7,4) NOT NULL DEFAULT 0,
  tax_amount                NUMERIC(14,2) NOT NULL DEFAULT 0,
  line_total                NUMERIC(14,2) NOT NULL DEFAULT 0,
  notes                     TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_sol_org      FOREIGN KEY (org_id) REFERENCES public.organisations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_sol_owner    FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_sol_order    FOREIGN KEY (sales_order_id) REFERENCES public.sales_orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_sol_product  FOREIGN KEY (finished_product_id) REFERENCES public.finished_products(id) ON DELETE RESTRICT,

  CONSTRAINT sol_sku_not_blank  CHECK (length(btrim(sku_code_snapshot)) > 0),
  CONSTRAINT sol_name_not_blank CHECK (length(btrim(product_name_snapshot)) > 0),
  CONSTRAINT sol_bottle_vol_positive CHECK (bottle_volume_ml_snapshot > 0),
  CONSTRAINT sol_quantity_positive   CHECK (quantity_bottles > 0),
  CONSTRAINT sol_unit_price_non_negative CHECK (unit_price >= 0),
  CONSTRAINT sol_discount_non_negative   CHECK (line_discount >= 0),
  CONSTRAINT sol_tax_rate_non_negative   CHECK (tax_rate >= 0),
  CONSTRAINT sol_tax_amount_non_negative CHECK (tax_amount >= 0),
  CONSTRAINT sol_line_total_non_negative CHECK (line_total >= 0),
  -- Discount cannot exceed the gross (quantity * unit_price).
  CONSTRAINT sol_discount_within_gross
    CHECK (line_discount <= quantity_bottles * unit_price)
);

-- Line numbers unique within an order (and org-scoped per spec).
CREATE UNIQUE INDEX IF NOT EXISTS uq_sol_order_line_number
  ON public.sales_order_lines(org_id, sales_order_id, line_number);

CREATE INDEX IF NOT EXISTS idx_sol_org_id       ON public.sales_order_lines(org_id);
CREATE INDEX IF NOT EXISTS idx_sol_owner_id     ON public.sales_order_lines(owner_id);
CREATE INDEX IF NOT EXISTS idx_sol_order_id     ON public.sales_order_lines(sales_order_id);
CREATE INDEX IF NOT EXISTS idx_sol_product_id   ON public.sales_order_lines(finished_product_id);
CREATE INDEX IF NOT EXISTS idx_sol_line_number  ON public.sales_order_lines(line_number);

-- ============================================================
-- 2. SERVER-AUTHORITATIVE LINE MONEY (BEFORE INSERT/UPDATE)
-- Recompute tax_amount and line_total from the inputs — the client can never
-- persist a wrong total. net = gross - discount; tax = net * rate/100;
-- line_total = net + tax. NUMERIC throughout; round money to 2dp.
-- ============================================================
CREATE OR REPLACE FUNCTION public.compute_sales_order_line_money()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_gross NUMERIC(14,2);
  v_net   NUMERIC(14,2);
BEGIN
  v_gross := round((NEW.quantity_bottles::numeric * NEW.unit_price)::numeric, 2);
  v_net   := round((v_gross - NEW.line_discount)::numeric, 2);
  IF v_net < 0 THEN
    RAISE EXCEPTION 'Line discount exceeds the gross line amount.' USING ERRCODE = 'raise_exception';
  END IF;
  NEW.tax_amount := round((v_net * NEW.tax_rate / 100)::numeric, 2);
  NEW.line_total := round((v_net + NEW.tax_amount)::numeric, 2);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sol_compute_money ON public.sales_order_lines;
CREATE TRIGGER sol_compute_money
  BEFORE INSERT OR UPDATE ON public.sales_order_lines
  FOR EACH ROW EXECUTE FUNCTION public.compute_sales_order_line_money();

-- ============================================================
-- 3. OWNER_ID IMMUTABILITY (010) + UPDATED_AT (001)
-- ============================================================
DROP TRIGGER IF EXISTS sol_owner_id_immutable ON public.sales_order_lines;
CREATE TRIGGER sol_owner_id_immutable BEFORE UPDATE ON public.sales_order_lines
  FOR EACH ROW EXECUTE FUNCTION public.prevent_owner_id_change();
DROP TRIGGER IF EXISTS sol_updated_at ON public.sales_order_lines;
CREATE TRIGGER sol_updated_at BEFORE UPDATE ON public.sales_order_lines
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ============================================================
-- 4. CROSS-ORG / CROSS-ORDER INTEGRITY (SECURITY DEFINER, pinned search_path)
-- Order and product must be the SAME org as the line; the order must be same-org.
-- ============================================================
CREATE OR REPLACE FUNCTION public.validate_sales_order_line_org_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  order_org   UUID;
  product_org UUID;
BEGIN
  SELECT so.org_id INTO order_org FROM public.sales_orders so WHERE so.id = NEW.sales_order_id;
  IF order_org IS NULL THEN
    RAISE EXCEPTION 'Invalid sales order: % does not exist.', NEW.sales_order_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF order_org <> NEW.org_id THEN
    RAISE EXCEPTION 'Cross-organisation reference: sales order % belongs to a different organisation.', NEW.sales_order_id USING ERRCODE = 'raise_exception';
  END IF;

  SELECT fp.org_id INTO product_org FROM public.finished_products fp WHERE fp.id = NEW.finished_product_id;
  IF product_org IS NULL THEN
    RAISE EXCEPTION 'Invalid finished product: % does not exist.', NEW.finished_product_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF product_org <> NEW.org_id THEN
    RAISE EXCEPTION 'Cross-organisation reference: finished product % belongs to a different organisation.', NEW.finished_product_id USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sol_org_integrity ON public.sales_order_lines;
CREATE TRIGGER sol_org_integrity
  BEFORE INSERT OR UPDATE ON public.sales_order_lines
  FOR EACH ROW EXECUTE FUNCTION public.validate_sales_order_line_org_integrity();

-- ============================================================
-- 5. ROW LEVEL SECURITY — sales_order_lines
-- member SELECT; OWNER/ADMIN/SALES INSERT/UPDATE; DELETE only while the PARENT
-- order is draft (and same role). Writes still require the parent order to be
-- draft (enforced in the service + the DELETE policy; INSERT/UPDATE draft-gating
-- is enforced by the service, since RLS cannot easily see the parent status on
-- INSERT without a subquery — we add the subquery guard to be safe).
-- ============================================================
ALTER TABLE public.sales_order_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view organisation sales order lines"
  ON public.sales_order_lines FOR SELECT
  USING (public.is_org_member(org_id));

CREATE POLICY "Sales roles can insert draft sales order lines"
  ON public.sales_order_lines FOR INSERT
  WITH CHECK (
    public.is_org_member(org_id) AND owner_id = auth.uid()
    AND public.has_org_role(org_id, ARRAY['OWNER','ADMIN','SALES'])
    AND EXISTS (SELECT 1 FROM public.sales_orders so WHERE so.id = sales_order_id AND so.org_id = org_id AND so.status = 'draft')
  );

CREATE POLICY "Sales roles can update draft sales order lines"
  ON public.sales_order_lines FOR UPDATE
  USING (
    public.is_org_member(org_id) AND public.has_org_role(org_id, ARRAY['OWNER','ADMIN','SALES'])
    AND EXISTS (SELECT 1 FROM public.sales_orders so WHERE so.id = sales_order_id AND so.org_id = org_id AND so.status = 'draft')
  )
  WITH CHECK (
    public.is_org_member(org_id) AND public.has_org_role(org_id, ARRAY['OWNER','ADMIN','SALES'])
    AND EXISTS (SELECT 1 FROM public.sales_orders so WHERE so.id = sales_order_id AND so.org_id = org_id AND so.status = 'draft')
  );

CREATE POLICY "Sales roles can delete draft sales order lines"
  ON public.sales_order_lines FOR DELETE
  USING (
    public.is_org_member(org_id) AND public.has_org_role(org_id, ARRAY['OWNER','ADMIN','SALES'])
    AND EXISTS (SELECT 1 FROM public.sales_orders so WHERE so.id = sales_order_id AND so.org_id = org_id AND so.status = 'draft')
  );

-- ============================================================
-- 6. GRANTS — SELECT/INSERT/UPDATE/DELETE (DELETE gated by the draft policy)
-- ============================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sales_order_lines TO authenticated;

-- ============================================================
-- 7. TIGHTEN sales_orders UPDATE POLICY TO DRAFT-ONLY
-- Replace (NOT OR-add) the P2L-4 update policy so confirmed orders cannot be
-- edited via the normal path. Status transitions happen only via confirm RPC
-- (SECURITY DEFINER, bypasses RLS). SELECT + INSERT policies are untouched.
-- ============================================================
DROP POLICY IF EXISTS "Sales roles can update organisation sales orders" ON public.sales_orders;
CREATE POLICY "Sales roles can update draft sales orders"
  ON public.sales_orders FOR UPDATE
  USING (public.is_org_member(org_id) AND status = 'draft'
    AND public.has_org_role(org_id, ARRAY['OWNER','ADMIN','SALES']))
  WITH CHECK (public.is_org_member(org_id) AND status = 'draft'
    AND public.has_org_role(org_id, ARRAY['OWNER','ADMIN','SALES']));

-- ============================================================
-- 8. EXTEND THE SINGLE AUDIT WRITER (reuse 021) + attach trigger
-- Adds sales_order_line, preserving all 24 existing mappings. Final CASE = 25.
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
    WHEN 'sales_order_lines'    THEN 'sales_order_line'
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

DROP TRIGGER IF EXISTS trg_audit_sales_order_lines ON public.sales_order_lines;
CREATE TRIGGER trg_audit_sales_order_lines
  AFTER INSERT OR UPDATE OR DELETE ON public.sales_order_lines
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_row_change();

-- ============================================================
-- 9. recalculate_sales_order_totals — derive order totals from its lines
-- SECURITY DEFINER; auth + membership; locks the order row; sums lines; updates
-- the order (its UPDATE is audited by trg_audit_sales_orders from 046). Returns
-- the recalculated order row.
-- ============================================================
CREATE OR REPLACE FUNCTION public.recalculate_sales_order_totals(p_sales_order_id UUID)
RETURNS public.sales_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid       UUID := auth.uid();
  v_order     public.sales_orders;
  v_subtotal  NUMERIC(14,2);
  v_discount  NUMERIC(14,2);
  v_tax       NUMERIC(14,2);
  v_total     NUMERIC(14,2);
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated.' USING ERRCODE='raise_exception'; END IF;

  SELECT * INTO v_order FROM public.sales_orders WHERE id = p_sales_order_id FOR UPDATE;
  IF v_order.id IS NULL THEN RAISE EXCEPTION 'Sales order % not found.', p_sales_order_id USING ERRCODE='raise_exception'; END IF;
  IF NOT public.is_org_member(v_order.org_id) THEN
    RAISE EXCEPTION 'Not a member of the order organisation.' USING ERRCODE='raise_exception';
  END IF;

  SELECT
    COALESCE(SUM(round(l.quantity_bottles::numeric * l.unit_price, 2) - l.line_discount), 0)::NUMERIC(14,2),
    COALESCE(SUM(l.line_discount), 0)::NUMERIC(14,2),
    COALESCE(SUM(l.tax_amount), 0)::NUMERIC(14,2),
    COALESCE(SUM(l.line_total), 0)::NUMERIC(14,2)
  INTO v_subtotal, v_discount, v_tax, v_total
  FROM public.sales_order_lines l
  WHERE l.sales_order_id = v_order.id;

  UPDATE public.sales_orders
     SET subtotal = v_subtotal, discount_total = v_discount, tax_total = v_tax, total = v_total
   WHERE id = v_order.id
   RETURNING * INTO v_order;

  RETURN v_order;
END;
$$;
REVOKE ALL ON FUNCTION public.recalculate_sales_order_totals(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.recalculate_sales_order_totals(UUID) TO authenticated;

-- ============================================================
-- 10. confirm_sales_order — atomic draft -> confirmed with snapshots
-- SECURITY DEFINER; auth + OWNER/ADMIN/SALES; locks order; requires draft +
-- >=1 line; validates line values; recalculates totals; snapshots billing/
-- shipping addresses to JSONB; sets status='confirmed'. Does NOT touch stock.
-- Line commercial snapshots are already stored on each line (set at add/edit),
-- so confirmation does not need to rewrite them — it only finalises the order.
-- ============================================================
CREATE OR REPLACE FUNCTION public.confirm_sales_order(p_sales_order_id UUID)
RETURNS public.sales_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid        UUID := auth.uid();
  v_order      public.sales_orders;
  v_line_count INTEGER;
  v_bad_lines  INTEGER;
  v_bill       JSONB;
  v_ship       JSONB;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated.' USING ERRCODE='raise_exception'; END IF;

  SELECT * INTO v_order FROM public.sales_orders WHERE id = p_sales_order_id FOR UPDATE;
  IF v_order.id IS NULL THEN RAISE EXCEPTION 'Sales order % not found.', p_sales_order_id USING ERRCODE='raise_exception'; END IF;
  IF NOT public.is_org_member(v_order.org_id) OR NOT public.has_org_role(v_order.org_id, ARRAY['OWNER','ADMIN','SALES']) THEN
    RAISE EXCEPTION 'This operation requires an Owner, Admin or Sales role.' USING ERRCODE='raise_exception';
  END IF;

  IF v_order.status <> 'draft' THEN
    RAISE EXCEPTION 'Only a draft sales order can be confirmed (status is "%").', v_order.status USING ERRCODE='raise_exception';
  END IF;

  SELECT COUNT(*) INTO v_line_count FROM public.sales_order_lines WHERE sales_order_id = v_order.id;
  IF v_line_count = 0 THEN
    RAISE EXCEPTION 'A sales order must have at least one line before confirmation.' USING ERRCODE='raise_exception';
  END IF;

  -- Validate line values (the money trigger keeps tax/total consistent; this is
  -- a final guard against any invalid stored values).
  SELECT COUNT(*) INTO v_bad_lines FROM public.sales_order_lines
  WHERE sales_order_id = v_order.id
    AND (quantity_bottles <= 0 OR unit_price < 0 OR line_discount < 0 OR tax_rate < 0
         OR line_discount > round(quantity_bottles::numeric * unit_price, 2)
         OR tax_amount < 0 OR line_total < 0);
  IF v_bad_lines > 0 THEN
    RAISE EXCEPTION 'One or more order lines have invalid values.' USING ERRCODE='raise_exception';
  END IF;

  -- Snapshot the chosen billing/shipping addresses to JSONB (NULL if none).
  IF v_order.billing_address_id IS NOT NULL THEN
    SELECT to_jsonb(a) INTO v_bill
    FROM (
      SELECT address_type, label, company_name, address_line_1, address_line_2,
             city, province, postal_code, country
      FROM public.customer_addresses WHERE id = v_order.billing_address_id
    ) a;
  END IF;
  IF v_order.shipping_address_id IS NOT NULL THEN
    SELECT to_jsonb(a) INTO v_ship
    FROM (
      SELECT address_type, label, company_name, address_line_1, address_line_2,
             city, province, postal_code, country
      FROM public.customer_addresses WHERE id = v_order.shipping_address_id
    ) a;
  END IF;

  -- Recalculate totals from the lines, snapshot addresses, flip to confirmed.
  UPDATE public.sales_orders so
     SET subtotal = sub.subtotal,
         discount_total = sub.discount,
         tax_total = sub.tax,
         total = sub.total,
         billing_address_snapshot = v_bill,
         shipping_address_snapshot = v_ship,
         status = 'confirmed'
  FROM (
    SELECT
      COALESCE(SUM(round(l.quantity_bottles::numeric * l.unit_price, 2) - l.line_discount), 0)::NUMERIC(14,2) AS subtotal,
      COALESCE(SUM(l.line_discount), 0)::NUMERIC(14,2) AS discount,
      COALESCE(SUM(l.tax_amount), 0)::NUMERIC(14,2) AS tax,
      COALESCE(SUM(l.line_total), 0)::NUMERIC(14,2) AS total
    FROM public.sales_order_lines l WHERE l.sales_order_id = v_order.id
  ) sub
  WHERE so.id = v_order.id
  RETURNING so.* INTO v_order;

  RETURN v_order;
END;
$$;
REVOKE ALL ON FUNCTION public.confirm_sales_order(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.confirm_sales_order(UUID) TO authenticated;

-- ============================================================
-- 11. POST-VALIDATION. RAISE => rollback.
-- ============================================================
DO $$
DECLARE n INTEGER; rls_on BOOLEAN; is_secdef BOOLEAN; cfg TEXT[]; sig TEXT;
BEGIN
  IF to_regclass('public.sales_order_lines') IS NULL THEN RAISE EXCEPTION 'Post: sales_order_lines missing.' USING ERRCODE='raise_exception'; END IF;

  -- Column set (18).
  SELECT COUNT(*) INTO n FROM information_schema.columns WHERE table_schema='public' AND table_name='sales_order_lines'
    AND column_name IN ('id','org_id','owner_id','sales_order_id','finished_product_id','line_number','sku_code_snapshot','product_name_snapshot','bottle_volume_ml_snapshot','quantity_bottles','unit_price','line_discount','tax_rate','tax_amount','line_total','notes','created_at','updated_at');
  IF n <> 18 THEN RAISE EXCEPTION 'Post: sales_order_lines columns mismatch (%).', n USING ERRCODE='raise_exception'; END IF;

  -- 4 FKs + ON DELETE behaviours (order CASCADE, product RESTRICT).
  SELECT COUNT(*) INTO n FROM information_schema.table_constraints WHERE table_schema='public' AND table_name='sales_order_lines' AND constraint_type='FOREIGN KEY';
  IF n <> 4 THEN RAISE EXCEPTION 'Post: sales_order_lines should have 4 FKs (%).', n USING ERRCODE='raise_exception'; END IF;
  IF (SELECT confdeltype FROM pg_constraint WHERE conname='fk_sol_order') <> 'c' THEN RAISE EXCEPTION 'Post: order FK must be CASCADE.' USING ERRCODE='raise_exception'; END IF;
  IF (SELECT confdeltype FROM pg_constraint WHERE conname='fk_sol_product') <> 'r' THEN RAISE EXCEPTION 'Post: product FK must be RESTRICT.' USING ERRCODE='raise_exception'; END IF;

  -- Unique line number + key CHECKs.
  IF to_regclass('public.uq_sol_order_line_number') IS NULL THEN RAISE EXCEPTION 'Post: line-number unique index missing.' USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_constraint WHERE conrelid='public.sales_order_lines'::regclass AND contype='c'
    AND conname IN ('sol_quantity_positive','sol_unit_price_non_negative','sol_discount_non_negative','sol_tax_rate_non_negative','sol_discount_within_gross','sol_line_total_non_negative','sol_tax_amount_non_negative');
  IF n <> 7 THEN RAISE EXCEPTION 'Post: sales_order_lines CHECKs missing (%).', n USING ERRCODE='raise_exception'; END IF;

  -- RLS + 4 policies (SELECT/INSERT/UPDATE/DELETE).
  SELECT relrowsecurity INTO rls_on FROM pg_class WHERE oid='public.sales_order_lines'::regclass;
  IF NOT COALESCE(rls_on,false) THEN RAISE EXCEPTION 'Post: RLS off on sales_order_lines.' USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='sales_order_lines';
  IF n <> 4 THEN RAISE EXCEPTION 'Post: sales_order_lines must have 4 policies (%).', n USING ERRCODE='raise_exception'; END IF;
  -- The DELETE policy must be gated by draft parent status.
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='sales_order_lines' AND cmd='DELETE'
                 AND qual ILIKE '%draft%') THEN
    RAISE EXCEPTION 'Post: sales_order_lines DELETE policy must be draft-gated.' USING ERRCODE='raise_exception';
  END IF;

  -- Triggers (money + owner immutability + updated_at + org integrity + audit).
  SELECT COUNT(*) INTO n FROM pg_trigger WHERE tgrelid='public.sales_order_lines'::regclass AND NOT tgisinternal
    AND tgname IN ('sol_compute_money','sol_owner_id_immutable','sol_updated_at','sol_org_integrity','trg_audit_sales_order_lines');
  IF n <> 5 THEN RAISE EXCEPTION 'Post: sales_order_lines triggers mismatch (%).', n USING ERRCODE='raise_exception'; END IF;

  -- Audit mapping present + prior preserved.
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.audit_log_row_change()'::regprocedure
      AND pg_get_functiondef(oid) ILIKE '%''sales_order_line''%'
      AND pg_get_functiondef(oid) ILIKE '%''sales_order''%'
      AND pg_get_functiondef(oid) ILIKE '%''customer''%') THEN
    RAISE EXCEPTION 'Post: audit writer missing required mappings.' USING ERRCODE='raise_exception';
  END IF;

  -- sales_orders UPDATE policy is now draft-gated; SELECT + INSERT preserved; still 3 policies.
  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='sales_orders';
  IF n <> 3 THEN RAISE EXCEPTION 'Post: sales_orders must still have 3 policies (%).', n USING ERRCODE='raise_exception'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='sales_orders' AND cmd='UPDATE' AND qual ILIKE '%draft%') THEN
    RAISE EXCEPTION 'Post: sales_orders UPDATE policy must be draft-gated.' USING ERRCODE='raise_exception';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='sales_orders' AND cmd='SELECT') THEN
    RAISE EXCEPTION 'Post: sales_orders SELECT policy must be preserved.' USING ERRCODE='raise_exception';
  END IF;

  -- RPCs: SECURITY DEFINER + pinned search_path + authenticated-only.
  FOREACH sig IN ARRAY ARRAY[
    'public.recalculate_sales_order_totals(uuid)',
    'public.confirm_sales_order(uuid)'
  ] LOOP
    IF to_regprocedure(sig) IS NULL THEN RAISE EXCEPTION 'Post: % missing.', sig USING ERRCODE='raise_exception'; END IF;
    SELECT prosecdef INTO is_secdef FROM pg_proc WHERE oid=to_regprocedure(sig);
    IF NOT COALESCE(is_secdef,false) THEN RAISE EXCEPTION 'Post: % must be SECURITY DEFINER.', sig USING ERRCODE='raise_exception'; END IF;
    SELECT proconfig INTO cfg FROM pg_proc WHERE oid=to_regprocedure(sig);
    IF NOT EXISTS (SELECT 1 FROM unnest(COALESCE(cfg,ARRAY[]::TEXT[])) c WHERE c LIKE 'search_path=%' AND position('public' IN c)>0 AND position('pg_temp' IN c)>0) THEN
      RAISE EXCEPTION 'Post: % must pin search_path.', sig USING ERRCODE='raise_exception';
    END IF;
    IF has_function_privilege('public', to_regprocedure(sig), 'EXECUTE') THEN
      RAISE EXCEPTION 'Post: PUBLIC must not EXECUTE %.', sig USING ERRCODE='raise_exception'; END IF;
    IF NOT has_function_privilege('authenticated', to_regprocedure(sig), 'EXECUTE') THEN
      RAISE EXCEPTION 'Post: authenticated must EXECUTE %.', sig USING ERRCODE='raise_exception'; END IF;
  END LOOP;

  -- No seed data.
  SELECT COUNT(*) INTO n FROM public.sales_order_lines;
  IF n <> 0 THEN RAISE EXCEPTION 'Post: sales_order_lines must be empty (%).', n USING ERRCODE='raise_exception'; END IF;
END $$;

COMMIT;
