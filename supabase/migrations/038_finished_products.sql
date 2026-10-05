-- ============================================================
-- WINERIX — P2K-2: Finished Products Catalogue
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- Depends on: 001 (update_updated_at), 006 (organisations, is_org_member,
--             has_org_role), 010 (prevent_owner_id_change), 021
--             (audit_log + audit_log_row_change single writer), 034 (extended
--             the audit writer to 16 mappings).
--
-- PURPOSE:
--   Establish the reusable, sellable finished-wine IDENTITY (a catalogue SKU).
--   A finished product is NOT a bottling event: the same product may be used by
--   many bottling outputs across multiple bottling runs. This migration creates
--   ONLY the catalogue table. It does NOT create stock, locations, movements,
--   stock items, receipt, transfers, adjustments, sales, dispatch, cases or
--   pallets (those are later P2K phases).
--
-- SCOPE — THIS MIGRATION ONLY:
--   public.finished_products table + FKs + CHECKs + unique SKU (org-scoped,
--   case-insensitive) + advisory duplicate-detection index + other indexes +
--   org-based RLS (member SELECT; OWNER/ADMIN/CELLAR INSERT/UPDATE; NO DELETE)
--   + owner_id immutability (reuse 010) + updated_at (reuse 001) + audit wiring
--   (extend the single writer to add 'finished_product', preserving all 16
--   existing mappings; attach the audit trigger) + grants (SELECT/INSERT/UPDATE).
--
-- THIS MIGRATION DOES NOT:
--   * seed any product rows (no business data)
--   * add lineage FKs (vineyard/block/harvest/wine_lot/batch/cultivar) — product
--     identity is independent of individual wine lineage; traceability lives
--     downstream via bottling_output references in later phases
--   * add stock / litres / price / sales / compliance columns
--   * add any DELETE policy or DELETE grant
--   * create a cross-org integrity trigger (none required: the only FKs are
--     org_id and owner_id, both validated by the FK + RLS + owner guard)
--   * create a second audit writer or attach a trigger to audit_log
--   * change services / UI / routes (done in application code, not here)
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
  IF to_regclass('public.finished_products') IS NOT NULL THEN RAISE EXCEPTION 'Pre-flight: public.finished_products already exists.' USING ERRCODE='duplicate_table'; END IF;
END $$;

-- ============================================================
-- 1. FINISHED_PRODUCTS — reusable sellable finished-wine identity (SKU)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.finished_products (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL,
  owner_id          UUID NOT NULL,
  sku_code          TEXT NOT NULL,
  name              TEXT NOT NULL,
  vintage           INTEGER,
  bottle_volume_ml  INTEGER NOT NULL,
  packaging_format  TEXT NOT NULL,
  wine_style        TEXT,
  bottles_per_case  INTEGER,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_finished_products_org
    FOREIGN KEY (org_id) REFERENCES public.organisations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_finished_products_owner
    FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE RESTRICT,

  CONSTRAINT finished_products_sku_not_blank
    CHECK (length(btrim(sku_code)) > 0),
  CONSTRAINT finished_products_name_not_blank
    CHECK (length(btrim(name)) > 0),
  CONSTRAINT finished_products_bottle_volume_positive
    CHECK (bottle_volume_ml > 0),
  CONSTRAINT finished_products_packaging_format_not_blank
    CHECK (length(btrim(packaging_format)) > 0),
  -- Vintage, when provided, is a sane 4-digit year (matches bottling_outputs).
  CONSTRAINT finished_products_vintage_range
    CHECK (vintage IS NULL OR (vintage >= 1900 AND vintage <= 2200)),
  -- Bottles-per-case is presentation metadata only; when supplied it must be > 0.
  CONSTRAINT finished_products_bottles_per_case_positive
    CHECK (bottles_per_case IS NULL OR bottles_per_case > 0)
);

-- SKU unique WITHIN an organisation, CASE-INSENSITIVELY (never global).
CREATE UNIQUE INDEX IF NOT EXISTS uq_finished_products_org_sku
  ON public.finished_products(org_id, lower(sku_code));

-- Advisory (NON-enforcing) index to assist duplicate detection / search over
-- the soft business key. Not unique: two SKUs may legitimately share these.
CREATE INDEX IF NOT EXISTS idx_finished_products_dupe_search
  ON public.finished_products(org_id, vintage, bottle_volume_ml, lower(packaging_format), lower(name));

CREATE INDEX IF NOT EXISTS idx_finished_products_org_id    ON public.finished_products(org_id);
CREATE INDEX IF NOT EXISTS idx_finished_products_owner_id  ON public.finished_products(owner_id);
CREATE INDEX IF NOT EXISTS idx_finished_products_is_active ON public.finished_products(is_active);
CREATE INDEX IF NOT EXISTS idx_finished_products_vintage   ON public.finished_products(vintage);

-- ============================================================
-- 2. OWNER_ID IMMUTABILITY (reuse 010)
-- ============================================================
DROP TRIGGER IF EXISTS finished_products_owner_id_immutable ON public.finished_products;
CREATE TRIGGER finished_products_owner_id_immutable
  BEFORE UPDATE ON public.finished_products
  FOR EACH ROW EXECUTE FUNCTION public.prevent_owner_id_change();

-- ============================================================
-- 3. UPDATED_AT (reuse 001)
-- ============================================================
DROP TRIGGER IF EXISTS finished_products_updated_at ON public.finished_products;
CREATE TRIGGER finished_products_updated_at
  BEFORE UPDATE ON public.finished_products
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ============================================================
-- 4. ROW LEVEL SECURITY (member SELECT; OWNER/ADMIN/CELLAR write; NO DELETE)
-- VIEWER and SALES can read but never modify.
-- ============================================================
ALTER TABLE public.finished_products ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view organisation finished products"
  ON public.finished_products FOR SELECT
  USING (public.is_org_member(org_id));

CREATE POLICY "Cellar roles can insert organisation finished products"
  ON public.finished_products FOR INSERT
  WITH CHECK (public.is_org_member(org_id) AND owner_id = auth.uid()
    AND public.has_org_role(org_id, ARRAY['OWNER','ADMIN','CELLAR']));

CREATE POLICY "Cellar roles can update organisation finished products"
  ON public.finished_products FOR UPDATE
  USING (public.is_org_member(org_id) AND public.has_org_role(org_id, ARRAY['OWNER','ADMIN','CELLAR']))
  WITH CHECK (public.is_org_member(org_id) AND public.has_org_role(org_id, ARRAY['OWNER','ADMIN','CELLAR']));

-- No DELETE policy (catalogue data is retired via is_active = false).

-- ============================================================
-- 5. GRANTS — SELECT/INSERT/UPDATE only (NO DELETE)
-- ============================================================
GRANT SELECT, INSERT, UPDATE ON public.finished_products TO authenticated;

-- ============================================================
-- 6. EXTEND THE SINGLE AUDIT WRITER (reuse 021 writer) + attach trigger
-- Adds 'finished_product', preserving ALL sixteen existing mappings. The
-- SECURITY DEFINER / pinned search_path / fail-closed ELSE / REVOKE-from-PUBLIC
-- posture is unchanged. Final CASE = 17.
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

DROP TRIGGER IF EXISTS trg_audit_finished_products ON public.finished_products;
CREATE TRIGGER trg_audit_finished_products
  AFTER INSERT OR UPDATE OR DELETE ON public.finished_products
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_row_change();

-- ============================================================
-- 7. POST-VALIDATION (catalog checks). RAISE => rollback.
-- ============================================================
DO $$
DECLARE
  n INTEGER;
  rls_on BOOLEAN;
BEGIN
  -- Table exists.
  IF to_regclass('public.finished_products') IS NULL THEN RAISE EXCEPTION 'Post: finished_products missing.' USING ERRCODE='raise_exception'; END IF;

  -- Column set (14).
  SELECT COUNT(*) INTO n FROM information_schema.columns WHERE table_schema='public' AND table_name='finished_products'
    AND column_name IN ('id','org_id','owner_id','sku_code','name','vintage','bottle_volume_ml','packaging_format','wine_style','bottles_per_case','is_active','notes','created_at','updated_at');
  IF n <> 14 THEN RAISE EXCEPTION 'Post: finished_products columns mismatch (%).', n USING ERRCODE='raise_exception'; END IF;

  -- Exactly 2 FKs (org, owner) — no lineage FKs.
  SELECT COUNT(*) INTO n FROM information_schema.table_constraints WHERE table_schema='public' AND table_name='finished_products' AND constraint_type='FOREIGN KEY';
  IF n <> 2 THEN RAISE EXCEPTION 'Post: finished_products should have exactly 2 FKs (%).', n USING ERRCODE='raise_exception'; END IF;

  -- Org-scoped case-insensitive unique SKU index exists.
  IF to_regclass('public.uq_finished_products_org_sku') IS NULL THEN
    RAISE EXCEPTION 'Post: uq_finished_products_org_sku missing.' USING ERRCODE='raise_exception';
  END IF;

  -- RLS enabled.
  SELECT relrowsecurity INTO rls_on FROM pg_class WHERE oid='public.finished_products'::regclass;
  IF NOT COALESCE(rls_on,false) THEN RAISE EXCEPTION 'Post: RLS off on finished_products.' USING ERRCODE='raise_exception'; END IF;

  -- Exactly 3 policies (SELECT/INSERT/UPDATE), and NO DELETE policy.
  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='finished_products';
  IF n <> 3 THEN RAISE EXCEPTION 'Post: finished_products must have 3 policies (%).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='finished_products' AND cmd='DELETE';
  IF n <> 0 THEN RAISE EXCEPTION 'Post: finished_products must have no DELETE policy.' USING ERRCODE='raise_exception'; END IF;

  -- No DELETE grant to authenticated.
  SELECT COUNT(*) INTO n FROM information_schema.role_table_grants
  WHERE table_schema='public' AND table_name='finished_products' AND grantee='authenticated' AND privilege_type='DELETE';
  IF n <> 0 THEN RAISE EXCEPTION 'Post: finished_products must not grant DELETE.' USING ERRCODE='raise_exception'; END IF;

  -- Audit mapping present (writer resolves finished_products) + trigger attached.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE oid='public.audit_log_row_change()'::regprocedure
      AND pg_get_functiondef(oid) ILIKE '%''finished_product''%'
  ) THEN
    RAISE EXCEPTION 'Post: audit writer missing finished_product mapping.' USING ERRCODE='raise_exception';
  END IF;
  SELECT COUNT(*) INTO n FROM pg_trigger WHERE tgrelid='public.finished_products'::regclass AND tgname='trg_audit_finished_products' AND NOT tgisinternal;
  IF n <> 1 THEN RAISE EXCEPTION 'Post: trg_audit_finished_products missing.' USING ERRCODE='raise_exception'; END IF;

  -- No product rows seeded by this migration.
  SELECT COUNT(*) INTO n FROM public.finished_products;
  IF n <> 0 THEN RAISE EXCEPTION 'Post: finished_products must be empty after migration (found %).', n USING ERRCODE='raise_exception'; END IF;
END $$;

COMMIT;
