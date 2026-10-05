-- ============================================================
-- WINERIX — P2K-3: Finished Goods Stock Locations
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- Depends on: 001 (update_updated_at), 006 (organisations, is_org_member,
--             has_org_role), 010 (prevent_owner_id_change), 021
--             (audit_log + audit_log_row_change single writer), 034 + 038
--             (extended the audit writer to 17 mappings).
--
-- PURPOSE:
--   Establish the org-scoped physical locations where FINISHED-GOODS inventory
--   is held (finished goods store, warehouse, export store, dispatch area, ...).
--   These are NOT cellar vessels and have NO link to vessels, vessel_placements,
--   wine_lots, wine_batches, vineyards or blocks (bulk-wine side). This migration
--   creates ONLY the stock_locations table. It does NOT create stock movements,
--   stock items, receipt, transfers, adjustments, cases or pallets (later P2K).
--
-- SCOPE — THIS MIGRATION ONLY:
--   public.stock_locations table + FKs + CHECKs + unique location_code
--   (org-scoped, case-insensitive) + indexes + org-based RLS (member SELECT;
--   OWNER/ADMIN INSERT/UPDATE; NO DELETE) + owner_id immutability (reuse 010) +
--   updated_at (reuse 001) + audit wiring (extend the single writer to add
--   'stock_location', preserving all 17 existing mappings; attach the audit
--   trigger) + grants (SELECT/INSERT/UPDATE).
--
-- THIS MIGRATION DOES NOT:
--   * seed any location rows (no business data)
--   * add stock / bottles / litres / current-stock / capacity / bin / GPS /
--     address / temperature columns
--   * link to any bulk-wine/cellar entity
--   * add any DELETE policy or DELETE grant
--   * create a cross-org integrity trigger (none required: the only FKs are
--     org_id and owner_id)
--   * create a second audit writer or attach a trigger to audit_log
--   * modify finished_products or any existing table/data
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
  IF to_regclass('public.stock_locations') IS NOT NULL THEN RAISE EXCEPTION 'Pre-flight: public.stock_locations already exists.' USING ERRCODE='duplicate_table'; END IF;
END $$;

-- ============================================================
-- 1. STOCK_LOCATIONS — physical finished-goods locations
-- ============================================================
CREATE TABLE IF NOT EXISTS public.stock_locations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL,
  owner_id       UUID NOT NULL,
  location_code  TEXT NOT NULL,
  name           TEXT NOT NULL,
  location_type  TEXT NOT NULL,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_stock_locations_org
    FOREIGN KEY (org_id) REFERENCES public.organisations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_stock_locations_owner
    FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE RESTRICT,

  CONSTRAINT stock_locations_code_not_blank
    CHECK (length(btrim(location_code)) > 0),
  CONSTRAINT stock_locations_name_not_blank
    CHECK (length(btrim(name)) > 0),
  CONSTRAINT stock_locations_type_check
    CHECK (location_type IN (
      'cellar_store','finished_goods_store','warehouse','export_store','dispatch_area','other'
    ))
);

-- location_code unique WITHIN an organisation, CASE-INSENSITIVELY (never global).
CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_locations_org_code
  ON public.stock_locations(org_id, lower(location_code));

CREATE INDEX IF NOT EXISTS idx_stock_locations_org_id        ON public.stock_locations(org_id);
CREATE INDEX IF NOT EXISTS idx_stock_locations_owner_id      ON public.stock_locations(owner_id);
CREATE INDEX IF NOT EXISTS idx_stock_locations_is_active     ON public.stock_locations(is_active);
CREATE INDEX IF NOT EXISTS idx_stock_locations_location_type ON public.stock_locations(location_type);

-- ============================================================
-- 2. OWNER_ID IMMUTABILITY (reuse 010)
-- ============================================================
DROP TRIGGER IF EXISTS stock_locations_owner_id_immutable ON public.stock_locations;
CREATE TRIGGER stock_locations_owner_id_immutable
  BEFORE UPDATE ON public.stock_locations
  FOR EACH ROW EXECUTE FUNCTION public.prevent_owner_id_change();

-- ============================================================
-- 3. UPDATED_AT (reuse 001)
-- ============================================================
DROP TRIGGER IF EXISTS stock_locations_updated_at ON public.stock_locations;
CREATE TRIGGER stock_locations_updated_at
  BEFORE UPDATE ON public.stock_locations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ============================================================
-- 4. ROW LEVEL SECURITY (member SELECT; OWNER/ADMIN write; NO DELETE)
-- VIEWER, FARM, CELLAR and SALES can read but never modify.
-- ============================================================
ALTER TABLE public.stock_locations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view organisation stock locations"
  ON public.stock_locations FOR SELECT
  USING (public.is_org_member(org_id));

CREATE POLICY "Admins can insert organisation stock locations"
  ON public.stock_locations FOR INSERT
  WITH CHECK (public.is_org_member(org_id) AND owner_id = auth.uid()
    AND public.has_org_role(org_id, ARRAY['OWNER','ADMIN']));

CREATE POLICY "Admins can update organisation stock locations"
  ON public.stock_locations FOR UPDATE
  USING (public.is_org_member(org_id) AND public.has_org_role(org_id, ARRAY['OWNER','ADMIN']))
  WITH CHECK (public.is_org_member(org_id) AND public.has_org_role(org_id, ARRAY['OWNER','ADMIN']));

-- No DELETE policy (locations are retired via is_active = false).

-- ============================================================
-- 5. GRANTS — SELECT/INSERT/UPDATE only (NO DELETE)
-- ============================================================
GRANT SELECT, INSERT, UPDATE ON public.stock_locations TO authenticated;

-- ============================================================
-- 6. EXTEND THE SINGLE AUDIT WRITER (reuse 021 writer) + attach trigger
-- Adds 'stock_location', preserving ALL seventeen existing mappings. The
-- SECURITY DEFINER / pinned search_path / fail-closed ELSE / REVOKE-from-PUBLIC
-- posture is unchanged. Final CASE = 18.
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

DROP TRIGGER IF EXISTS trg_audit_stock_locations ON public.stock_locations;
CREATE TRIGGER trg_audit_stock_locations
  AFTER INSERT OR UPDATE OR DELETE ON public.stock_locations
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
  IF to_regclass('public.stock_locations') IS NULL THEN RAISE EXCEPTION 'Post: stock_locations missing.' USING ERRCODE='raise_exception'; END IF;

  -- Column set (10).
  SELECT COUNT(*) INTO n FROM information_schema.columns WHERE table_schema='public' AND table_name='stock_locations'
    AND column_name IN ('id','org_id','owner_id','location_code','name','location_type','is_active','notes','created_at','updated_at');
  IF n <> 10 THEN RAISE EXCEPTION 'Post: stock_locations columns mismatch (%).', n USING ERRCODE='raise_exception'; END IF;

  -- Exactly 2 FKs (org, owner) — no other FKs.
  SELECT COUNT(*) INTO n FROM information_schema.table_constraints WHERE table_schema='public' AND table_name='stock_locations' AND constraint_type='FOREIGN KEY';
  IF n <> 2 THEN RAISE EXCEPTION 'Post: stock_locations should have exactly 2 FKs (%).', n USING ERRCODE='raise_exception'; END IF;

  -- Org-scoped case-insensitive unique code index exists.
  IF to_regclass('public.uq_stock_locations_org_code') IS NULL THEN
    RAISE EXCEPTION 'Post: uq_stock_locations_org_code missing.' USING ERRCODE='raise_exception';
  END IF;

  -- RLS enabled.
  SELECT relrowsecurity INTO rls_on FROM pg_class WHERE oid='public.stock_locations'::regclass;
  IF NOT COALESCE(rls_on,false) THEN RAISE EXCEPTION 'Post: RLS off on stock_locations.' USING ERRCODE='raise_exception'; END IF;

  -- Exactly 3 policies (SELECT/INSERT/UPDATE), and NO DELETE policy.
  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='stock_locations';
  IF n <> 3 THEN RAISE EXCEPTION 'Post: stock_locations must have 3 policies (%).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='stock_locations' AND cmd='DELETE';
  IF n <> 0 THEN RAISE EXCEPTION 'Post: stock_locations must have no DELETE policy.' USING ERRCODE='raise_exception'; END IF;

  -- No DELETE grant to authenticated.
  SELECT COUNT(*) INTO n FROM information_schema.role_table_grants
  WHERE table_schema='public' AND table_name='stock_locations' AND grantee='authenticated' AND privilege_type='DELETE';
  IF n <> 0 THEN RAISE EXCEPTION 'Post: stock_locations must not grant DELETE.' USING ERRCODE='raise_exception'; END IF;

  -- Audit mapping present (writer resolves stock_locations) + trigger attached.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE oid='public.audit_log_row_change()'::regprocedure
      AND pg_get_functiondef(oid) ILIKE '%''stock_location''%'
  ) THEN
    RAISE EXCEPTION 'Post: audit writer missing stock_location mapping.' USING ERRCODE='raise_exception';
  END IF;
  -- The finished_product mapping (038) must still be present (nothing removed).
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE oid='public.audit_log_row_change()'::regprocedure
      AND pg_get_functiondef(oid) ILIKE '%''finished_product''%'
  ) THEN
    RAISE EXCEPTION 'Post: audit writer unexpectedly lost finished_product mapping.' USING ERRCODE='raise_exception';
  END IF;
  SELECT COUNT(*) INTO n FROM pg_trigger WHERE tgrelid='public.stock_locations'::regclass AND tgname='trg_audit_stock_locations' AND NOT tgisinternal;
  IF n <> 1 THEN RAISE EXCEPTION 'Post: trg_audit_stock_locations missing.' USING ERRCODE='raise_exception'; END IF;

  -- No location rows seeded by this migration.
  SELECT COUNT(*) INTO n FROM public.stock_locations;
  IF n <> 0 THEN RAISE EXCEPTION 'Post: stock_locations must be empty after migration (found %).', n USING ERRCODE='raise_exception'; END IF;
END $$;

COMMIT;
