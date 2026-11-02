-- ============================================================
-- WINERIX — P2O-Finance (057): Auto-posting foundation (columns + audit)
-- Additive schema to let finance entries be auto-posted from real economic
-- events (machinery purchase -> expense; wine sale -> income) in later
-- migrations (058 RPC, 059 hooks). This migration ONLY adds columns, a CHECK,
-- an idempotency index, and audit wiring. It posts NOTHING and changes NO RLS.
--
-- Depends on: 001 (update_updated_at), 005 (finance, machinery — base tables),
--             006 (organisations, is_org_member), 009 (finance.org_id +
--             machinery.org_id already added, backfilled, NOT NULL),
--             010 (org-based RLS + owner-immutability already on both tables),
--             021 (audit_log + audit_log_row_change single writer).
--             After 056 the audit writer has 32 mappings; this migration -> 34.
--
-- CONTEXT (verified against 009/010): finance and machinery are ALREADY
-- org-scoped (org_id NOT NULL, FK RESTRICT) with org-based RLS
-- (is_org_member(org_id)) and owner_id immutability triggers. This migration
-- does NOT touch org_id, RLS, or owner immutability — only adds new columns.
--
-- SCOPE — THIS MIGRATION ONLY:
--   finance:   + source_type, source_id, auto_generated, reverses_finance_id
--              + CHECK (auto rows must carry a source) + partial unique index
--                for idempotency of auto-posted rows.
--   machinery: + purchase_cost, purchase_date.
--   audit:     extend the single writer with finance->finance_entry and
--              machinery->machinery; attach audit triggers (INSERT+UPDATE).
--
-- THIS MIGRATION DOES NOT: post any finance entry, create any RPC, change RLS,
--   change org_id/owner_id, alter existing triggers other than re-creating the
--   shared audit writer (preserving all mappings), or seed data.
-- ============================================================

BEGIN;

-- ============================================================
-- 0. PRE-FLIGHT (fail-fast)
-- ============================================================
DO $$
BEGIN
  IF to_regclass('public.finance') IS NULL THEN RAISE EXCEPTION 'Pre-flight: finance missing (005).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.machinery') IS NULL THEN RAISE EXCEPTION 'Pre-flight: machinery missing (005).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.audit_log') IS NULL THEN RAISE EXCEPTION 'Pre-flight: audit_log missing (006).' USING ERRCODE='undefined_table'; END IF;
  IF to_regprocedure('public.audit_log_row_change()') IS NULL THEN RAISE EXCEPTION 'Pre-flight: audit_log_row_change missing (021).' USING ERRCODE='undefined_function'; END IF;
  -- Confirm the org model is already in place (009/010): org_id must exist on both.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='finance' AND column_name='org_id') THEN
    RAISE EXCEPTION 'Pre-flight: finance.org_id missing — expected from 009.' USING ERRCODE='raise_exception';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='machinery' AND column_name='org_id') THEN
    RAISE EXCEPTION 'Pre-flight: machinery.org_id missing — expected from 009.' USING ERRCODE='raise_exception';
  END IF;
END $$;

-- ============================================================
-- 1. FINANCE — add source-link + auto-post columns (additive, nullable).
-- ============================================================
ALTER TABLE public.finance ADD COLUMN IF NOT EXISTS source_type         TEXT;
ALTER TABLE public.finance ADD COLUMN IF NOT EXISTS source_id           UUID;
ALTER TABLE public.finance ADD COLUMN IF NOT EXISTS auto_generated      BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.finance ADD COLUMN IF NOT EXISTS reverses_finance_id UUID;

-- Self-FK: a compensating entry points at the entry it reverses.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_finance_reverses') THEN
    ALTER TABLE public.finance
      ADD CONSTRAINT fk_finance_reverses
      FOREIGN KEY (reverses_finance_id) REFERENCES public.finance(id) ON DELETE RESTRICT;
  END IF;
END $$;

-- source_type vocabulary (free-form 'manual' allowed; auto rows use the others).
ALTER TABLE public.finance DROP CONSTRAINT IF EXISTS finance_source_type_check;
ALTER TABLE public.finance
  ADD CONSTRAINT finance_source_type_check CHECK (
    source_type IS NULL OR source_type IN (
      'manual','machinery','sales_delivery','dispatch_reversal','return_credit'
    )
  );

-- An auto-generated row MUST carry a source; a manual row must not be auto.
ALTER TABLE public.finance DROP CONSTRAINT IF EXISTS finance_auto_requires_source;
ALTER TABLE public.finance
  ADD CONSTRAINT finance_auto_requires_source CHECK (
    (auto_generated = false)
    OR (auto_generated = true AND source_type IS NOT NULL AND source_type <> 'manual' AND source_id IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS idx_finance_source      ON public.finance(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_finance_reverses    ON public.finance(reverses_finance_id);
CREATE INDEX IF NOT EXISTS idx_finance_auto        ON public.finance(auto_generated);

-- Idempotency: at most ONE auto row per (source_type, source_id, type).
-- A given economic event posts at most one income and one expense row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_finance_autopost_source
  ON public.finance(source_type, source_id, type)
  WHERE auto_generated;

-- ============================================================
-- 2. MACHINERY — add purchase cost + date (additive, nullable).
-- ============================================================
ALTER TABLE public.machinery ADD COLUMN IF NOT EXISTS purchase_cost NUMERIC(14,2);
ALTER TABLE public.machinery ADD COLUMN IF NOT EXISTS purchase_date DATE;

ALTER TABLE public.machinery DROP CONSTRAINT IF EXISTS machinery_purchase_cost_non_negative;
ALTER TABLE public.machinery
  ADD CONSTRAINT machinery_purchase_cost_non_negative
  CHECK (purchase_cost IS NULL OR purchase_cost >= 0);

-- ============================================================
-- 3. EXTEND THE SINGLE AUDIT WRITER (reuse 021) + attach triggers.
-- Adds finance->finance_entry and machinery->machinery, preserving ALL 32
-- existing mappings (final = 34). Both audited INSERT + UPDATE. Neither table
-- was audited before this migration.
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
    WHEN 'stock_allocations'    THEN 'stock_allocation'
    WHEN 'dispatches'           THEN 'dispatch'
    WHEN 'dispatch_lines'       THEN 'dispatch_line'
    WHEN 'delivery_confirmations'      THEN 'delivery_confirmation'
    WHEN 'delivery_confirmation_lines' THEN 'delivery_confirmation_line'
    WHEN 'returns'              THEN 'return'
    WHEN 'return_lines'         THEN 'return_line'
    WHEN 'finance'              THEN 'finance_entry'
    WHEN 'machinery'            THEN 'machinery'
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

DROP TRIGGER IF EXISTS trg_audit_finance ON public.finance;
CREATE TRIGGER trg_audit_finance
  AFTER INSERT OR UPDATE ON public.finance
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_row_change();
DROP TRIGGER IF EXISTS trg_audit_machinery ON public.machinery;
CREATE TRIGGER trg_audit_machinery
  AFTER INSERT OR UPDATE ON public.machinery
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_row_change();

-- ============================================================
-- 4. POST-VALIDATION (catalog checks). RAISE => rollback. No seed data.
-- ============================================================
DO $$
DECLARE n INTEGER;
BEGIN
  -- finance new columns.
  SELECT COUNT(*) INTO n FROM information_schema.columns WHERE table_schema='public' AND table_name='finance'
    AND column_name IN ('source_type','source_id','auto_generated','reverses_finance_id');
  IF n <> 4 THEN RAISE EXCEPTION 'Post: finance auto-post columns mismatch (%).', n USING ERRCODE='raise_exception'; END IF;

  -- machinery new columns.
  SELECT COUNT(*) INTO n FROM information_schema.columns WHERE table_schema='public' AND table_name='machinery'
    AND column_name IN ('purchase_cost','purchase_date');
  IF n <> 2 THEN RAISE EXCEPTION 'Post: machinery purchase columns mismatch (%).', n USING ERRCODE='raise_exception'; END IF;

  -- CHECKs present.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='finance_source_type_check' AND conrelid='public.finance'::regclass) THEN
    RAISE EXCEPTION 'Post: finance_source_type_check missing.' USING ERRCODE='raise_exception'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='finance_auto_requires_source' AND conrelid='public.finance'::regclass) THEN
    RAISE EXCEPTION 'Post: finance_auto_requires_source missing.' USING ERRCODE='raise_exception'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='machinery_purchase_cost_non_negative' AND conrelid='public.machinery'::regclass) THEN
    RAISE EXCEPTION 'Post: machinery_purchase_cost_non_negative missing.' USING ERRCODE='raise_exception'; END IF;

  -- Self-FK present.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_finance_reverses' AND contype='f') THEN
    RAISE EXCEPTION 'Post: fk_finance_reverses missing.' USING ERRCODE='raise_exception'; END IF;

  -- Idempotency unique index present.
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='uq_finance_autopost_source') THEN
    RAISE EXCEPTION 'Post: uq_finance_autopost_source index missing.' USING ERRCODE='raise_exception'; END IF;

  -- Audit mappings present + prior preserved (sample).
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.audit_log_row_change()'::regprocedure
      AND pg_get_functiondef(oid) ILIKE '%''finance_entry''%'
      AND pg_get_functiondef(oid) ILIKE '%WHEN ''machinery''%'
      AND pg_get_functiondef(oid) ILIKE '%''return''%'
      AND pg_get_functiondef(oid) ILIKE '%''stock_movement''%'
      AND pg_get_functiondef(oid) ILIKE '%''sales_order''%') THEN
    RAISE EXCEPTION 'Post: audit writer missing finance/machinery mapping or lost a prior mapping.' USING ERRCODE='raise_exception'; END IF;

  -- Audit triggers attached.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.finance'::regclass AND tgname='trg_audit_finance' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'Post: trg_audit_finance missing.' USING ERRCODE='raise_exception'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.machinery'::regclass AND tgname='trg_audit_machinery' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'Post: trg_audit_machinery missing.' USING ERRCODE='raise_exception'; END IF;

  RAISE NOTICE 'Post: P2O-Finance 057 foundation installed — finance/machinery auto-post columns + audit wiring verified.';
END $$;

COMMIT;
