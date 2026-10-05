-- ============================================================
-- WINERIX — P2K-4: Finished Goods Stock Foundation
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- Depends on: 001 (update_updated_at), 006 (organisations, is_org_member,
--             has_org_role), 010 (prevent_owner_id_change), 021
--             (audit_log + audit_log_row_change single writer), 038
--             (finished_products), 039 (stock_locations). After 034/038/039 the
--             audit writer has 18 mappings; this migration takes it to 20.
--
-- PURPOSE:
--   Establish the finished-goods inventory SCHEMA + SECURITY foundation:
--     stock_items      -> materialised current balance per (product, location),
--                         in BOTTLES. One row per (org, product, location).
--     stock_movements  -> append-only signed-delta ledger (BOTTLES). Source of
--                         truth. Immutable: insert-only, written by future
--                         SECURITY DEFINER RPCs (P2K-5+), never by clients.
--
--   The authoritative inventory invariant (NOT yet trigger-enforced here) is:
--     stock_items.qty_bottles == SUM(stock_movements.qty_bottles_delta)
--       GROUP BY (product_id, location_id)
--   Litres are NEVER stored — derive as qty_bottles * bottle_volume_ml / 1000.
--
-- SCOPE — THIS MIGRATION ONLY (foundation):
--   Two tables + FKs + CHECKs + indexes + org-scoped unique stock-item key +
--   RLS (member SELECT only; NO direct client write to either table) +
--   SECURITY DEFINER cross-org integrity triggers + owner_id immutability +
--   updated_at (stock_items only) + audit wiring (add stock_item + stock_movement
--   mappings; stock_items audited INSERT/UPDATE, stock_movements audited INSERT
--   only) + minimal grants (SELECT only; stock_items also INSERT/UPDATE so future
--   RPCs run under the invoker where applicable — but NO client INSERT policy
--   exists, so RLS still blocks arbitrary writes). No backfill; both start empty.
--
-- THIS MIGRATION DOES NOT:
--   * create receiving / transfer / adjustment / sale / dispatch RPCs (P2K-5+)
--   * add an automatic stock_items<-movements recalculation trigger
--   * insert any stock row, backfill bottling outputs, or create history
--   * add a litres column or a mutable "current quantity" column on movements
--   * add cases / pallets / barcodes
--   * create any service or UI
--   * modify finished_products / stock_locations / bottling / lab / cellar
--   * create a second audit writer or attach a trigger to audit_log
--   * add any DELETE policy or DELETE grant on either table
-- ============================================================

BEGIN;

-- ============================================================
-- 0. PRE-FLIGHT (fail-fast; never silently create dependencies)
-- ============================================================
DO $$
BEGIN
  IF to_regclass('public.organisations') IS NULL THEN RAISE EXCEPTION 'Pre-flight: public.organisations missing (006).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.finished_products') IS NULL THEN RAISE EXCEPTION 'Pre-flight: public.finished_products missing (038).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.stock_locations') IS NULL THEN RAISE EXCEPTION 'Pre-flight: public.stock_locations missing (039).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.audit_log') IS NULL THEN RAISE EXCEPTION 'Pre-flight: public.audit_log missing (006).' USING ERRCODE='undefined_table'; END IF;
  IF to_regprocedure('public.audit_log_row_change()') IS NULL THEN RAISE EXCEPTION 'Pre-flight: audit_log_row_change() missing (021).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.is_org_member(uuid)') IS NULL THEN RAISE EXCEPTION 'Pre-flight: is_org_member missing (006).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.prevent_owner_id_change()') IS NULL THEN RAISE EXCEPTION 'Pre-flight: prevent_owner_id_change missing (010).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.update_updated_at()') IS NULL THEN RAISE EXCEPTION 'Pre-flight: update_updated_at missing (001).' USING ERRCODE='undefined_function'; END IF;
  IF to_regclass('public.stock_items') IS NOT NULL THEN RAISE EXCEPTION 'Pre-flight: public.stock_items already exists.' USING ERRCODE='duplicate_table'; END IF;
  IF to_regclass('public.stock_movements') IS NOT NULL THEN RAISE EXCEPTION 'Pre-flight: public.stock_movements already exists.' USING ERRCODE='duplicate_table'; END IF;
END $$;

-- ============================================================
-- 1. STOCK_ITEMS — materialised current balance per (product, location)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.stock_items (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL,
  owner_id     UUID NOT NULL,
  product_id   UUID NOT NULL,
  location_id  UUID NOT NULL,
  qty_bottles  INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_stock_items_org
    FOREIGN KEY (org_id) REFERENCES public.organisations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_stock_items_owner
    FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_stock_items_product
    FOREIGN KEY (product_id) REFERENCES public.finished_products(id) ON DELETE RESTRICT,
  CONSTRAINT fk_stock_items_location
    FOREIGN KEY (location_id) REFERENCES public.stock_locations(id) ON DELETE RESTRICT,

  -- Finished stock may never be negative (ratified P2K decision #6).
  CONSTRAINT stock_items_qty_non_negative CHECK (qty_bottles >= 0)
);

-- Exactly one stock_items row per (org, product, location).
CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_items_org_product_location
  ON public.stock_items(org_id, product_id, location_id);

CREATE INDEX IF NOT EXISTS idx_stock_items_org_id      ON public.stock_items(org_id);
CREATE INDEX IF NOT EXISTS idx_stock_items_owner_id    ON public.stock_items(owner_id);
CREATE INDEX IF NOT EXISTS idx_stock_items_product_id  ON public.stock_items(product_id);
CREATE INDEX IF NOT EXISTS idx_stock_items_location_id ON public.stock_items(location_id);

-- ============================================================
-- 2. STOCK_MOVEMENTS — append-only signed-delta ledger (BOTTLES)
-- Immutable: insert-only. No litres column; no mutable current-quantity column.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.stock_movements (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID NOT NULL,
  owner_id           UUID NOT NULL,
  stock_item_id      UUID NOT NULL,
  product_id         UUID NOT NULL,
  location_id        UUID NOT NULL,
  movement_type      TEXT NOT NULL,
  qty_bottles_delta  INTEGER NOT NULL,
  reference_type     TEXT,
  reference_id       UUID,
  transfer_group_id  UUID,
  notes              TEXT,
  occurred_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_stock_movements_org
    FOREIGN KEY (org_id) REFERENCES public.organisations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_stock_movements_owner
    FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_stock_movements_item
    FOREIGN KEY (stock_item_id) REFERENCES public.stock_items(id) ON DELETE RESTRICT,
  CONSTRAINT fk_stock_movements_product
    FOREIGN KEY (product_id) REFERENCES public.finished_products(id) ON DELETE RESTRICT,
  CONSTRAINT fk_stock_movements_location
    FOREIGN KEY (location_id) REFERENCES public.stock_locations(id) ON DELETE RESTRICT,

  -- Current approved vocabulary (do not add future types until needed).
  CONSTRAINT stock_movements_type_check CHECK (movement_type IN (
    'receipt','transfer_in','transfer_out','adjustment','damage','sale','dispatch'
  )),
  -- Signed delta; a zero movement is meaningless and disallowed.
  CONSTRAINT stock_movements_delta_non_zero CHECK (qty_bottles_delta <> 0)
);

CREATE INDEX IF NOT EXISTS idx_stock_movements_org_id         ON public.stock_movements(org_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_stock_item_id  ON public.stock_movements(stock_item_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_product_id     ON public.stock_movements(product_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_location_id    ON public.stock_movements(location_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_occurred_at    ON public.stock_movements(occurred_at);
CREATE INDEX IF NOT EXISTS idx_stock_movements_movement_type  ON public.stock_movements(movement_type);
CREATE INDEX IF NOT EXISTS idx_stock_movements_reference_id   ON public.stock_movements(reference_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_transfer_group ON public.stock_movements(transfer_group_id);

-- ============================================================
-- 3. OWNER_ID IMMUTABILITY (reuse 010)
-- stock_items only (stock_movements is append-only; never updated).
-- ============================================================
DROP TRIGGER IF EXISTS stock_items_owner_id_immutable ON public.stock_items;
CREATE TRIGGER stock_items_owner_id_immutable
  BEFORE UPDATE ON public.stock_items
  FOR EACH ROW EXECUTE FUNCTION public.prevent_owner_id_change();

-- ============================================================
-- 4. UPDATED_AT (reuse 001) — stock_items only
-- ============================================================
DROP TRIGGER IF EXISTS stock_items_updated_at ON public.stock_items;
CREATE TRIGGER stock_items_updated_at
  BEFORE UPDATE ON public.stock_items
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- stock_movements intentionally has NO owner-immutability or updated_at trigger:
-- it is append-only and carries no updated_at column (created_at + occurred_at).

-- ============================================================
-- 5. CROSS-ORGANISATION INTEGRITY (DB-enforced, fail-closed)
-- SECURITY DEFINER so the checks read referenced tables regardless of RLS;
-- pinned search_path; static SQL. Mirrors 034's validate_bottling_*_org pattern.
-- ============================================================

-- 5a. stock_items: product AND location must exist and be the SAME org as the item.
CREATE OR REPLACE FUNCTION public.validate_stock_item_org_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  product_org  UUID;
  location_org UUID;
BEGIN
  SELECT fp.org_id INTO product_org FROM public.finished_products fp WHERE fp.id = NEW.product_id;
  IF product_org IS NULL THEN
    RAISE EXCEPTION 'Invalid finished product: % does not exist.', NEW.product_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF product_org <> NEW.org_id THEN
    RAISE EXCEPTION 'Cross-organisation reference: finished product % belongs to a different organisation.', NEW.product_id USING ERRCODE = 'raise_exception';
  END IF;

  SELECT sl.org_id INTO location_org FROM public.stock_locations sl WHERE sl.id = NEW.location_id;
  IF location_org IS NULL THEN
    RAISE EXCEPTION 'Invalid stock location: % does not exist.', NEW.location_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF location_org <> NEW.org_id THEN
    RAISE EXCEPTION 'Cross-organisation reference: stock location % belongs to a different organisation.', NEW.location_id USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS stock_items_org_integrity ON public.stock_items;
CREATE TRIGGER stock_items_org_integrity
  BEFORE INSERT OR UPDATE ON public.stock_items
  FOR EACH ROW EXECUTE FUNCTION public.validate_stock_item_org_integrity();

-- 5b. stock_movements: the referenced stock_item, product and location must all
-- exist and be the SAME org as the movement (and consistent with each other).
CREATE OR REPLACE FUNCTION public.validate_stock_movement_org_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  item_org      UUID;
  item_product  UUID;
  item_location UUID;
  product_org   UUID;
  location_org  UUID;
BEGIN
  SELECT si.org_id, si.product_id, si.location_id
    INTO item_org, item_product, item_location
  FROM public.stock_items si WHERE si.id = NEW.stock_item_id;
  IF item_org IS NULL THEN
    RAISE EXCEPTION 'Invalid stock item: % does not exist.', NEW.stock_item_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF item_org <> NEW.org_id THEN
    RAISE EXCEPTION 'Cross-organisation reference: stock item % belongs to a different organisation.', NEW.stock_item_id USING ERRCODE = 'raise_exception';
  END IF;

  -- The movement must describe the SAME product + location as its stock item.
  IF NEW.product_id <> item_product THEN
    RAISE EXCEPTION 'Stock movement product % does not match its stock item product %.', NEW.product_id, item_product USING ERRCODE = 'raise_exception';
  END IF;
  IF NEW.location_id <> item_location THEN
    RAISE EXCEPTION 'Stock movement location % does not match its stock item location %.', NEW.location_id, item_location USING ERRCODE = 'raise_exception';
  END IF;

  -- Belt-and-braces: product + location org must also equal the movement org.
  SELECT fp.org_id INTO product_org FROM public.finished_products fp WHERE fp.id = NEW.product_id;
  IF product_org IS NULL OR product_org <> NEW.org_id THEN
    RAISE EXCEPTION 'Cross-organisation reference: finished product % is invalid or belongs to a different organisation.', NEW.product_id USING ERRCODE = 'raise_exception';
  END IF;
  SELECT sl.org_id INTO location_org FROM public.stock_locations sl WHERE sl.id = NEW.location_id;
  IF location_org IS NULL OR location_org <> NEW.org_id THEN
    RAISE EXCEPTION 'Cross-organisation reference: stock location % is invalid or belongs to a different organisation.', NEW.location_id USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$;

-- INSERT only (append-only ledger).
DROP TRIGGER IF EXISTS stock_movements_org_integrity ON public.stock_movements;
CREATE TRIGGER stock_movements_org_integrity
  BEFORE INSERT ON public.stock_movements
  FOR EACH ROW EXECUTE FUNCTION public.validate_stock_movement_org_integrity();

-- ============================================================
-- 6. ROW LEVEL SECURITY
-- Both tables: organisation members may SELECT. There is NO client INSERT/UPDATE/
-- DELETE policy on EITHER table — balances and the ledger are controlled solely
-- by future SECURITY DEFINER inventory RPCs (P2K-5+). Append-only ledger.
-- ============================================================
ALTER TABLE public.stock_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_movements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view organisation stock items"
  ON public.stock_items FOR SELECT
  USING (public.is_org_member(org_id));

CREATE POLICY "Users can view organisation stock movements"
  ON public.stock_movements FOR SELECT
  USING (public.is_org_member(org_id));

-- No INSERT/UPDATE/DELETE policy on either table (controlled via RPCs later).

-- ============================================================
-- 7. GRANTS — SELECT only to authenticated (NO INSERT/UPDATE/DELETE).
-- Future SECURITY DEFINER RPCs will perform writes with the definer's rights;
-- clients are never granted direct write access to inventory.
-- ============================================================
GRANT SELECT ON public.stock_items     TO authenticated;
GRANT SELECT ON public.stock_movements TO authenticated;

-- ============================================================
-- 8. EXTEND THE SINGLE AUDIT WRITER (reuse 021 writer) + attach triggers
-- Adds 'stock_item' + 'stock_movement', preserving ALL eighteen existing
-- mappings. Posture unchanged. Final CASE = 20. stock_items is audited on
-- INSERT/UPDATE; stock_movements is audited on INSERT only (append-only).
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

-- stock_items: audit INSERT + UPDATE (balance changes are meaningful).
DROP TRIGGER IF EXISTS trg_audit_stock_items ON public.stock_items;
CREATE TRIGGER trg_audit_stock_items
  AFTER INSERT OR UPDATE ON public.stock_items
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_row_change();

-- stock_movements: append-only — audit INSERT only.
DROP TRIGGER IF EXISTS trg_audit_stock_movements ON public.stock_movements;
CREATE TRIGGER trg_audit_stock_movements
  AFTER INSERT ON public.stock_movements
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_row_change();

-- ============================================================
-- 9. POST-VALIDATION (catalog checks). RAISE => rollback.
-- ============================================================
DO $$
DECLARE
  n INTEGER;
  rls_on BOOLEAN;
  is_secdef BOOLEAN;
  cfg TEXT[];
BEGIN
  -- Tables exist.
  IF to_regclass('public.stock_items') IS NULL THEN RAISE EXCEPTION 'Post: stock_items missing.' USING ERRCODE='raise_exception'; END IF;
  IF to_regclass('public.stock_movements') IS NULL THEN RAISE EXCEPTION 'Post: stock_movements missing.' USING ERRCODE='raise_exception'; END IF;

  -- Column counts.
  SELECT COUNT(*) INTO n FROM information_schema.columns WHERE table_schema='public' AND table_name='stock_items'
    AND column_name IN ('id','org_id','owner_id','product_id','location_id','qty_bottles','created_at','updated_at');
  IF n <> 8 THEN RAISE EXCEPTION 'Post: stock_items columns mismatch (%).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM information_schema.columns WHERE table_schema='public' AND table_name='stock_movements'
    AND column_name IN ('id','org_id','owner_id','stock_item_id','product_id','location_id','movement_type','qty_bottles_delta','reference_type','reference_id','transfer_group_id','notes','occurred_at','created_at');
  IF n <> 14 THEN RAISE EXCEPTION 'Post: stock_movements columns mismatch (%).', n USING ERRCODE='raise_exception'; END IF;

  -- stock_movements must NOT have an updated_at column (append-only).
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='stock_movements' AND column_name='updated_at') THEN
    RAISE EXCEPTION 'Post: stock_movements must not have updated_at (append-only).' USING ERRCODE='raise_exception';
  END IF;

  -- FK counts: stock_items 4, stock_movements 5.
  SELECT COUNT(*) INTO n FROM information_schema.table_constraints WHERE table_schema='public' AND table_name='stock_items' AND constraint_type='FOREIGN KEY';
  IF n <> 4 THEN RAISE EXCEPTION 'Post: stock_items should have 4 FKs (%).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM information_schema.table_constraints WHERE table_schema='public' AND table_name='stock_movements' AND constraint_type='FOREIGN KEY';
  IF n <> 5 THEN RAISE EXCEPTION 'Post: stock_movements should have 5 FKs (%).', n USING ERRCODE='raise_exception'; END IF;

  -- Unique stock-item key present.
  IF to_regclass('public.uq_stock_items_org_product_location') IS NULL THEN
    RAISE EXCEPTION 'Post: uq_stock_items_org_product_location missing.' USING ERRCODE='raise_exception';
  END IF;

  -- CHECKs present: stock_items qty>=0; stock_movements type + non-zero delta.
  SELECT COUNT(*) INTO n FROM pg_constraint WHERE conrelid='public.stock_items'::regclass AND contype='c' AND conname='stock_items_qty_non_negative';
  IF n <> 1 THEN RAISE EXCEPTION 'Post: stock_items_qty_non_negative CHECK missing.' USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_constraint WHERE conrelid='public.stock_movements'::regclass AND contype='c' AND conname IN ('stock_movements_type_check','stock_movements_delta_non_zero');
  IF n <> 2 THEN RAISE EXCEPTION 'Post: stock_movements CHECK constraints missing (%).', n USING ERRCODE='raise_exception'; END IF;

  -- RLS enabled on both.
  SELECT relrowsecurity INTO rls_on FROM pg_class WHERE oid='public.stock_items'::regclass;
  IF NOT COALESCE(rls_on,false) THEN RAISE EXCEPTION 'Post: RLS off on stock_items.' USING ERRCODE='raise_exception'; END IF;
  SELECT relrowsecurity INTO rls_on FROM pg_class WHERE oid='public.stock_movements'::regclass;
  IF NOT COALESCE(rls_on,false) THEN RAISE EXCEPTION 'Post: RLS off on stock_movements.' USING ERRCODE='raise_exception'; END IF;

  -- Exactly 1 policy each (SELECT only); no INSERT/UPDATE/DELETE policy.
  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='stock_items';
  IF n <> 1 THEN RAISE EXCEPTION 'Post: stock_items must have exactly 1 policy (%).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='stock_items' AND cmd IN ('INSERT','UPDATE','DELETE');
  IF n <> 0 THEN RAISE EXCEPTION 'Post: stock_items must have no write policy.' USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='stock_movements';
  IF n <> 1 THEN RAISE EXCEPTION 'Post: stock_movements must have exactly 1 policy (%).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='stock_movements' AND cmd IN ('INSERT','UPDATE','DELETE');
  IF n <> 0 THEN RAISE EXCEPTION 'Post: stock_movements must have no write policy.' USING ERRCODE='raise_exception'; END IF;

  -- Grants: SELECT only; NO INSERT/UPDATE/DELETE to authenticated on either table.
  SELECT COUNT(*) INTO n FROM information_schema.role_table_grants
  WHERE table_schema='public' AND table_name IN ('stock_items','stock_movements')
    AND grantee='authenticated' AND privilege_type IN ('INSERT','UPDATE','DELETE');
  IF n <> 0 THEN RAISE EXCEPTION 'Post: inventory tables must not grant INSERT/UPDATE/DELETE to authenticated (%).', n USING ERRCODE='raise_exception'; END IF;

  -- Integrity trigger functions exist + SECURITY DEFINER + pinned search_path.
  FOR n IN
    SELECT 1 FROM (VALUES ('public.validate_stock_item_org_integrity()'), ('public.validate_stock_movement_org_integrity()')) AS f(sig)
  LOOP NULL; END LOOP;
  IF to_regprocedure('public.validate_stock_item_org_integrity()') IS NULL THEN RAISE EXCEPTION 'Post: stock_item integrity fn missing.' USING ERRCODE='raise_exception'; END IF;
  IF to_regprocedure('public.validate_stock_movement_org_integrity()') IS NULL THEN RAISE EXCEPTION 'Post: stock_movement integrity fn missing.' USING ERRCODE='raise_exception'; END IF;
  SELECT prosecdef INTO is_secdef FROM pg_proc WHERE oid='public.validate_stock_item_org_integrity()'::regprocedure;
  IF NOT COALESCE(is_secdef,false) THEN RAISE EXCEPTION 'Post: stock_item integrity fn must be SECURITY DEFINER.' USING ERRCODE='raise_exception'; END IF;
  SELECT prosecdef INTO is_secdef FROM pg_proc WHERE oid='public.validate_stock_movement_org_integrity()'::regprocedure;
  IF NOT COALESCE(is_secdef,false) THEN RAISE EXCEPTION 'Post: stock_movement integrity fn must be SECURITY DEFINER.' USING ERRCODE='raise_exception'; END IF;
  SELECT proconfig INTO cfg FROM pg_proc WHERE oid='public.validate_stock_item_org_integrity()'::regprocedure;
  IF NOT EXISTS (SELECT 1 FROM unnest(COALESCE(cfg,ARRAY[]::TEXT[])) c WHERE c LIKE 'search_path=%' AND position('public' IN c)>0 AND position('pg_temp' IN c)>0) THEN
    RAISE EXCEPTION 'Post: stock_item integrity fn must pin search_path.' USING ERRCODE='raise_exception';
  END IF;
  SELECT proconfig INTO cfg FROM pg_proc WHERE oid='public.validate_stock_movement_org_integrity()'::regprocedure;
  IF NOT EXISTS (SELECT 1 FROM unnest(COALESCE(cfg,ARRAY[]::TEXT[])) c WHERE c LIKE 'search_path=%' AND position('public' IN c)>0 AND position('pg_temp' IN c)>0) THEN
    RAISE EXCEPTION 'Post: stock_movement integrity fn must pin search_path.' USING ERRCODE='raise_exception';
  END IF;

  -- owner immutability + updated_at on stock_items; integrity triggers attached.
  SELECT COUNT(*) INTO n FROM pg_trigger WHERE tgrelid='public.stock_items'::regclass AND NOT tgisinternal
    AND tgname IN ('stock_items_owner_id_immutable','stock_items_updated_at','stock_items_org_integrity','trg_audit_stock_items');
  IF n <> 4 THEN RAISE EXCEPTION 'Post: stock_items triggers mismatch (%).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_trigger WHERE tgrelid='public.stock_movements'::regclass AND NOT tgisinternal
    AND tgname IN ('stock_movements_org_integrity','trg_audit_stock_movements');
  IF n <> 2 THEN RAISE EXCEPTION 'Post: stock_movements triggers mismatch (%).', n USING ERRCODE='raise_exception'; END IF;

  -- Audit mappings present for both new entities + prior ones preserved.
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.audit_log_row_change()'::regprocedure
      AND pg_get_functiondef(oid) ILIKE '%''stock_item''%'
      AND pg_get_functiondef(oid) ILIKE '%''stock_movement''%'
      AND pg_get_functiondef(oid) ILIKE '%''stock_location''%'
      AND pg_get_functiondef(oid) ILIKE '%''finished_product''%'
      AND pg_get_functiondef(oid) ILIKE '%''bottling_output''%'
      AND pg_get_functiondef(oid) ILIKE '%''lab_sample''%'
      AND pg_get_functiondef(oid) ILIKE '%''wine_lot''%') THEN
    RAISE EXCEPTION 'Post: audit writer missing one or more required entity mappings.' USING ERRCODE='raise_exception';
  END IF;

  -- No seed data.
  SELECT COUNT(*) INTO n FROM public.stock_items;
  IF n <> 0 THEN RAISE EXCEPTION 'Post: stock_items must be empty after migration (found %).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM public.stock_movements;
  IF n <> 0 THEN RAISE EXCEPTION 'Post: stock_movements must be empty after migration (found %).', n USING ERRCODE='raise_exception'; END IF;
END $$;

COMMIT;
