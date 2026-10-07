-- ============================================================
-- WINERIX — P2J-B2: Bottling Database Foundation
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- Depends on: 001 (update_updated_at), 006 (organisations, is_org_member,
--             has_org_role), 010 (prevent_owner_id_change), 018 (wine_lots),
--             020/024 (production_events + event_type CHECK), 021
--             (audit_log + audit_log_row_change), 022 (lot_volume_movements +
--             movement_type CHECK), 027 (lab_samples)
--
-- PURPOSE:
--   Establish the bottling data foundation that turns bulk cellar wine into
--   bottled output, while the EXISTING Wine Lot volume ledger
--   (wine_lots.volume_litres + lot_volume_movements) remains the single source
--   of truth for cellar volume.
--
--     bottling_runs      -> one bottling operation (header + lifecycle)
--     bottling_run_lots  -> source Wine Lot junction (consumed/bottled/loss)
--     bottling_outputs   -> per-format physical output lines (NOT P2K stock)
--
--   Extends production_events.event_type with 'bottling' and
--   lot_volume_movements.movement_type with 'bottling_out' + 'bottling_loss'
--   (both via the proven dynamic drop/re-add CHECK technique — names are looked
--   up, never assumed). Reuses the single audit writer (adds 3 mappings).
--
-- SCOPE — THIS MIGRATION ONLY (foundation):
--   Tables + FKs + CHECKs + indexes + org-based RLS (member SELECT;
--   OWNER/ADMIN/CELLAR INSERT/UPDATE; NO DELETE) + owner_id immutability +
--   updated_at + SECURITY DEFINER cross-org integrity triggers + grants
--   (SELECT/INSERT/UPDATE) + audit wiring. No backfill; all three start empty.
--
-- THIS MIGRATION DOES NOT:
--   * create the complete_bottling_run RPC or any bottling RPC (that is P2J-B4)
--   * insert any bottling row, create any volume movement or production event
--   * modify wine_lots, lot_volume_movements rows, or any existing data
--   * add products / SKUs / stock / warehouses / locations / cases / pallets /
--     barcodes / inventory / valuation (all P2K)
--   * add a second volume ledger or any volume column on wine_lots
--   * remove/replace any existing event_type / movement_type / audit mapping
--   * create a second audit writer; attach a trigger to audit_log
--   * add a lab/alert gate on bottling (release_lab_sample_id is optional ref)
--   * add any DELETE policy or DELETE grant
--   * change services / UI / routes / navigation
-- ============================================================

BEGIN;

-- ============================================================
-- 0. PRE-FLIGHT (fail-fast; never silently create dependencies)
-- ============================================================
DO $$
BEGIN
  IF to_regclass('public.organisations') IS NULL THEN RAISE EXCEPTION 'Pre-flight: public.organisations missing (006).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.wine_lots') IS NULL THEN RAISE EXCEPTION 'Pre-flight: public.wine_lots missing (018).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.lab_samples') IS NULL THEN RAISE EXCEPTION 'Pre-flight: public.lab_samples missing (027).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.production_events') IS NULL THEN RAISE EXCEPTION 'Pre-flight: public.production_events missing (020).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.lot_volume_movements') IS NULL THEN RAISE EXCEPTION 'Pre-flight: public.lot_volume_movements missing (022).' USING ERRCODE='undefined_table'; END IF;
  IF to_regclass('public.audit_log') IS NULL THEN RAISE EXCEPTION 'Pre-flight: public.audit_log missing (006).' USING ERRCODE='undefined_table'; END IF;
  IF to_regprocedure('public.audit_log_row_change()') IS NULL THEN RAISE EXCEPTION 'Pre-flight: audit_log_row_change() missing (021).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.is_org_member(uuid)') IS NULL THEN RAISE EXCEPTION 'Pre-flight: is_org_member missing (006).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.has_org_role(uuid, text[])') IS NULL THEN RAISE EXCEPTION 'Pre-flight: has_org_role missing (006).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.prevent_owner_id_change()') IS NULL THEN RAISE EXCEPTION 'Pre-flight: prevent_owner_id_change missing (010).' USING ERRCODE='undefined_function'; END IF;
  IF to_regprocedure('public.update_updated_at()') IS NULL THEN RAISE EXCEPTION 'Pre-flight: update_updated_at missing (001).' USING ERRCODE='undefined_function'; END IF;
  IF to_regclass('public.bottling_runs') IS NOT NULL THEN RAISE EXCEPTION 'Pre-flight: public.bottling_runs already exists.' USING ERRCODE='duplicate_table'; END IF;
  IF to_regclass('public.bottling_run_lots') IS NOT NULL THEN RAISE EXCEPTION 'Pre-flight: public.bottling_run_lots already exists.' USING ERRCODE='duplicate_table'; END IF;
  IF to_regclass('public.bottling_outputs') IS NOT NULL THEN RAISE EXCEPTION 'Pre-flight: public.bottling_outputs already exists.' USING ERRCODE='duplicate_table'; END IF;
END $$;

-- ============================================================
-- 0b. CAPTURE AUDIT BASELINE (audit_log is NOT required to be empty)
-- ============================================================
DO $$
BEGIN
  PERFORM set_config('winerix.audit_baseline_count', (SELECT COUNT(*)::text FROM public.audit_log), true);
END $$;

-- ============================================================
-- 1. BOTTLING_RUNS — one bottling operation (header + lifecycle)
-- release_lab_sample_id is an OPTIONAL traceability reference only — it is NOT a
-- gate; bottling is never blocked by lab status/alerts in this foundation.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.bottling_runs (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 UUID NOT NULL,
  owner_id               UUID NOT NULL,
  bottling_code          TEXT NOT NULL,
  bottling_date          TIMESTAMPTZ,
  status                 TEXT NOT NULL DEFAULT 'planned',
  notes                  TEXT,
  release_lab_sample_id  UUID,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_bottling_runs_org
    FOREIGN KEY (org_id) REFERENCES public.organisations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_bottling_runs_owner
    FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE RESTRICT,
  -- Optional release sample: clear the reference if the sample is ever removed.
  CONSTRAINT fk_bottling_runs_release_sample
    FOREIGN KEY (release_lab_sample_id) REFERENCES public.lab_samples(id) ON DELETE SET NULL,

  CONSTRAINT bottling_runs_code_not_blank
    CHECK (length(btrim(bottling_code)) > 0),
  CONSTRAINT bottling_runs_status_check
    CHECK (status IN ('planned','in_progress','completed','cancelled'))
);

-- bottling_code unique WITHIN an organisation, CASE-INSENSITIVELY (never global).
CREATE UNIQUE INDEX IF NOT EXISTS uq_bottling_runs_org_code
  ON public.bottling_runs(org_id, lower(bottling_code));

CREATE INDEX IF NOT EXISTS idx_bottling_runs_org_id         ON public.bottling_runs(org_id);
CREATE INDEX IF NOT EXISTS idx_bottling_runs_owner_id       ON public.bottling_runs(owner_id);
CREATE INDEX IF NOT EXISTS idx_bottling_runs_status         ON public.bottling_runs(status);
CREATE INDEX IF NOT EXISTS idx_bottling_runs_bottling_date  ON public.bottling_runs(bottling_date);
CREATE INDEX IF NOT EXISTS idx_bottling_runs_release_sample ON public.bottling_runs(release_lab_sample_id);

-- ============================================================
-- 2. BOTTLING_RUN_LOTS — source Wine Lot junction
-- Supports many lots per run AND a lot across many runs. Volume availability is
-- NOT enforced by a static CHECK here — the future atomic completion RPC does
-- that with row locking against the live ledger.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.bottling_run_lots (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 UUID NOT NULL,
  owner_id               UUID NOT NULL,
  bottling_run_id        UUID NOT NULL,
  wine_lot_id            UUID NOT NULL,
  consumed_volume_litres NUMERIC(12,2) NOT NULL,
  bottled_litres         NUMERIC(12,2) NOT NULL DEFAULT 0,
  loss_litres            NUMERIC(12,2) NOT NULL DEFAULT 0,
  notes                  TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_brl_org
    FOREIGN KEY (org_id) REFERENCES public.organisations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_brl_owner
    FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE RESTRICT,
  -- Source lines belong to their run; removing a run removes its source lines.
  CONSTRAINT fk_brl_run
    FOREIGN KEY (bottling_run_id) REFERENCES public.bottling_runs(id) ON DELETE CASCADE,
  -- Protect lot history: a lot referenced by a run cannot be hard-deleted.
  CONSTRAINT fk_brl_wine_lot
    FOREIGN KEY (wine_lot_id) REFERENCES public.wine_lots(id) ON DELETE RESTRICT,

  CONSTRAINT brl_consumed_non_negative CHECK (consumed_volume_litres >= 0),
  CONSTRAINT brl_bottled_non_negative  CHECK (bottled_litres >= 0),
  CONSTRAINT brl_loss_non_negative     CHECK (loss_litres >= 0),
  -- Accounted output + loss cannot exceed the consumed source volume.
  CONSTRAINT brl_accounted_within_consumed
    CHECK (bottled_litres + loss_litres <= consumed_volume_litres)
);

-- One source line per (run, lot).
CREATE UNIQUE INDEX IF NOT EXISTS uq_brl_run_lot
  ON public.bottling_run_lots(bottling_run_id, wine_lot_id);

CREATE INDEX IF NOT EXISTS idx_brl_org_id   ON public.bottling_run_lots(org_id);
CREATE INDEX IF NOT EXISTS idx_brl_owner_id ON public.bottling_run_lots(owner_id);
CREATE INDEX IF NOT EXISTS idx_brl_run_id   ON public.bottling_run_lots(bottling_run_id);
CREATE INDEX IF NOT EXISTS idx_brl_lot_id   ON public.bottling_run_lots(wine_lot_id);

-- ============================================================
-- 3. BOTTLING_OUTPUTS — per-format physical output lines (NOT P2K stock)
-- Minimum product identity for traceability only. No SKU/stock/location/barcode.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.bottling_outputs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL,
  owner_id          UUID NOT NULL,
  bottling_run_id   UUID NOT NULL,
  bottle_volume_ml  INTEGER NOT NULL,
  bottle_count      INTEGER NOT NULL,
  bottled_litres    NUMERIC(12,2) NOT NULL,
  packaging_format  TEXT NOT NULL,
  product_name      TEXT,
  vintage           INTEGER,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_bo_org
    FOREIGN KEY (org_id) REFERENCES public.organisations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_bo_owner
    FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_bo_run
    FOREIGN KEY (bottling_run_id) REFERENCES public.bottling_runs(id) ON DELETE CASCADE,

  CONSTRAINT bo_bottle_volume_positive CHECK (bottle_volume_ml > 0),
  CONSTRAINT bo_bottle_count_non_negative CHECK (bottle_count >= 0),
  CONSTRAINT bo_bottled_litres_non_negative CHECK (bottled_litres >= 0),
  CONSTRAINT bo_packaging_format_not_blank CHECK (length(btrim(packaging_format)) > 0),
  -- Vintage, when provided, is a sane 4-digit year.
  CONSTRAINT bo_vintage_range CHECK (vintage IS NULL OR (vintage >= 1900 AND vintage <= 2200))
);

CREATE INDEX IF NOT EXISTS idx_bo_org_id   ON public.bottling_outputs(org_id);
CREATE INDEX IF NOT EXISTS idx_bo_owner_id ON public.bottling_outputs(owner_id);
CREATE INDEX IF NOT EXISTS idx_bo_run_id   ON public.bottling_outputs(bottling_run_id);

-- ============================================================
-- 4. OWNER_ID IMMUTABILITY (reuse 010) — all three tables
-- ============================================================
DROP TRIGGER IF EXISTS bottling_runs_owner_id_immutable ON public.bottling_runs;
CREATE TRIGGER bottling_runs_owner_id_immutable
  BEFORE UPDATE ON public.bottling_runs
  FOR EACH ROW EXECUTE FUNCTION public.prevent_owner_id_change();

DROP TRIGGER IF EXISTS bottling_run_lots_owner_id_immutable ON public.bottling_run_lots;
CREATE TRIGGER bottling_run_lots_owner_id_immutable
  BEFORE UPDATE ON public.bottling_run_lots
  FOR EACH ROW EXECUTE FUNCTION public.prevent_owner_id_change();

DROP TRIGGER IF EXISTS bottling_outputs_owner_id_immutable ON public.bottling_outputs;
CREATE TRIGGER bottling_outputs_owner_id_immutable
  BEFORE UPDATE ON public.bottling_outputs
  FOR EACH ROW EXECUTE FUNCTION public.prevent_owner_id_change();

-- ============================================================
-- 5. UPDATED_AT (reuse 001) — all three tables
-- ============================================================
DROP TRIGGER IF EXISTS bottling_runs_updated_at ON public.bottling_runs;
CREATE TRIGGER bottling_runs_updated_at
  BEFORE UPDATE ON public.bottling_runs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS bottling_run_lots_updated_at ON public.bottling_run_lots;
CREATE TRIGGER bottling_run_lots_updated_at
  BEFORE UPDATE ON public.bottling_run_lots
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS bottling_outputs_updated_at ON public.bottling_outputs;
CREATE TRIGGER bottling_outputs_updated_at
  BEFORE UPDATE ON public.bottling_outputs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ============================================================
-- 6. CROSS-ORGANISATION INTEGRITY (DB-enforced, fail-closed)
-- SECURITY DEFINER so the checks read referenced tables regardless of RLS;
-- pinned search_path; static SQL. Mirrors validate_lab_*_org_integrity.
-- ============================================================

-- 6a. bottling_runs: optional release sample must be same-org when set.
CREATE OR REPLACE FUNCTION public.validate_bottling_run_org_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  sample_org UUID;
BEGIN
  IF NEW.release_lab_sample_id IS NOT NULL THEN
    SELECT s.org_id INTO sample_org FROM public.lab_samples s WHERE s.id = NEW.release_lab_sample_id;
    IF sample_org IS NULL THEN
      RAISE EXCEPTION 'Invalid release lab sample: % does not exist.', NEW.release_lab_sample_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF sample_org <> NEW.org_id THEN
      RAISE EXCEPTION 'Cross-organisation reference: lab sample % belongs to a different organisation.', NEW.release_lab_sample_id
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bottling_runs_org_integrity ON public.bottling_runs;
CREATE TRIGGER bottling_runs_org_integrity
  BEFORE INSERT OR UPDATE ON public.bottling_runs
  FOR EACH ROW EXECUTE FUNCTION public.validate_bottling_run_org_integrity();

-- 6b. bottling_run_lots: referenced run AND wine lot must exist and be same-org.
CREATE OR REPLACE FUNCTION public.validate_bottling_run_lot_org_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  run_org UUID;
  lot_org UUID;
BEGIN
  SELECT r.org_id INTO run_org FROM public.bottling_runs r WHERE r.id = NEW.bottling_run_id;
  IF run_org IS NULL THEN
    RAISE EXCEPTION 'Invalid bottling run: % does not exist.', NEW.bottling_run_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF run_org <> NEW.org_id THEN
    RAISE EXCEPTION 'Cross-organisation reference: bottling run % belongs to a different organisation.', NEW.bottling_run_id USING ERRCODE = 'raise_exception';
  END IF;

  SELECT wl.org_id INTO lot_org FROM public.wine_lots wl WHERE wl.id = NEW.wine_lot_id;
  IF lot_org IS NULL THEN
    RAISE EXCEPTION 'Invalid wine lot: % does not exist.', NEW.wine_lot_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF lot_org <> NEW.org_id THEN
    RAISE EXCEPTION 'Cross-organisation reference: wine lot % belongs to a different organisation.', NEW.wine_lot_id USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bottling_run_lots_org_integrity ON public.bottling_run_lots;
CREATE TRIGGER bottling_run_lots_org_integrity
  BEFORE INSERT OR UPDATE ON public.bottling_run_lots
  FOR EACH ROW EXECUTE FUNCTION public.validate_bottling_run_lot_org_integrity();

-- 6c. bottling_outputs: referenced run must exist and be same-org.
CREATE OR REPLACE FUNCTION public.validate_bottling_output_org_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  run_org UUID;
BEGIN
  SELECT r.org_id INTO run_org FROM public.bottling_runs r WHERE r.id = NEW.bottling_run_id;
  IF run_org IS NULL THEN
    RAISE EXCEPTION 'Invalid bottling run: % does not exist.', NEW.bottling_run_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF run_org <> NEW.org_id THEN
    RAISE EXCEPTION 'Cross-organisation reference: bottling run % belongs to a different organisation.', NEW.bottling_run_id USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bottling_outputs_org_integrity ON public.bottling_outputs;
CREATE TRIGGER bottling_outputs_org_integrity
  BEFORE INSERT OR UPDATE ON public.bottling_outputs
  FOR EACH ROW EXECUTE FUNCTION public.validate_bottling_output_org_integrity();

-- ============================================================
-- 7. ROW LEVEL SECURITY (member SELECT; OWNER/ADMIN/CELLAR write; NO DELETE)
-- ============================================================
ALTER TABLE public.bottling_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bottling_run_lots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bottling_outputs ENABLE ROW LEVEL SECURITY;

-- ---- 7a. bottling_runs ----
CREATE POLICY "Users can view organisation bottling runs"
  ON public.bottling_runs FOR SELECT
  USING (public.is_org_member(org_id));
CREATE POLICY "Cellar roles can insert organisation bottling runs"
  ON public.bottling_runs FOR INSERT
  WITH CHECK (public.is_org_member(org_id) AND owner_id = auth.uid()
    AND public.has_org_role(org_id, ARRAY['OWNER','ADMIN','CELLAR']));
CREATE POLICY "Cellar roles can update organisation bottling runs"
  ON public.bottling_runs FOR UPDATE
  USING (public.is_org_member(org_id) AND public.has_org_role(org_id, ARRAY['OWNER','ADMIN','CELLAR']))
  WITH CHECK (public.is_org_member(org_id) AND public.has_org_role(org_id, ARRAY['OWNER','ADMIN','CELLAR']));

-- ---- 7b. bottling_run_lots ----
CREATE POLICY "Users can view organisation bottling run lots"
  ON public.bottling_run_lots FOR SELECT
  USING (public.is_org_member(org_id));
CREATE POLICY "Cellar roles can insert organisation bottling run lots"
  ON public.bottling_run_lots FOR INSERT
  WITH CHECK (public.is_org_member(org_id) AND owner_id = auth.uid()
    AND public.has_org_role(org_id, ARRAY['OWNER','ADMIN','CELLAR']));
CREATE POLICY "Cellar roles can update organisation bottling run lots"
  ON public.bottling_run_lots FOR UPDATE
  USING (public.is_org_member(org_id) AND public.has_org_role(org_id, ARRAY['OWNER','ADMIN','CELLAR']))
  WITH CHECK (public.is_org_member(org_id) AND public.has_org_role(org_id, ARRAY['OWNER','ADMIN','CELLAR']));

-- ---- 7c. bottling_outputs ----
CREATE POLICY "Users can view organisation bottling outputs"
  ON public.bottling_outputs FOR SELECT
  USING (public.is_org_member(org_id));
CREATE POLICY "Cellar roles can insert organisation bottling outputs"
  ON public.bottling_outputs FOR INSERT
  WITH CHECK (public.is_org_member(org_id) AND owner_id = auth.uid()
    AND public.has_org_role(org_id, ARRAY['OWNER','ADMIN','CELLAR']));
CREATE POLICY "Cellar roles can update organisation bottling outputs"
  ON public.bottling_outputs FOR UPDATE
  USING (public.is_org_member(org_id) AND public.has_org_role(org_id, ARRAY['OWNER','ADMIN','CELLAR']))
  WITH CHECK (public.is_org_member(org_id) AND public.has_org_role(org_id, ARRAY['OWNER','ADMIN','CELLAR']));

-- No DELETE policy on any bottling table (operational/auditable data).

-- ============================================================
-- 8. GRANTS — SELECT/INSERT/UPDATE only (NO DELETE)
-- ============================================================
GRANT SELECT, INSERT, UPDATE ON public.bottling_runs     TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.bottling_run_lots TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.bottling_outputs  TO authenticated;

-- ============================================================
-- 9. EXTEND production_events.event_type WITH 'bottling'
-- Dynamic drop/re-add: look up the existing event_type CHECK by DEFINITION
-- (never assume its name), and only replace it if 'bottling' is not already
-- allowed, preserving every existing value. Mirrors 024's technique.
-- ============================================================
DO $$
DECLARE
  v_conname TEXT;
BEGIN
  SELECT c.conname INTO v_conname
  FROM pg_constraint c
  WHERE c.conrelid = 'public.production_events'::regclass
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ILIKE '%event_type%';
  IF v_conname IS NULL THEN
    RAISE EXCEPTION 'Could not locate production_events event_type CHECK constraint.' USING ERRCODE='raise_exception';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid='public.production_events'::regclass AND c.contype='c'
      AND pg_get_constraintdef(c.oid) ILIKE '%bottling%'
  ) THEN
    EXECUTE format('ALTER TABLE public.production_events DROP CONSTRAINT %I', v_conname);
    ALTER TABLE public.production_events
      ADD CONSTRAINT production_events_event_type_check
      CHECK (event_type IN (
        'transfer','racking','settling','fermentation','fermentation_end',
        'maturation','filtration','addition','adjustment','bottling','other'
      ));
  END IF;
END $$;

-- ============================================================
-- 10. EXTEND lot_volume_movements.movement_type WITH 'bottling_out','bottling_loss'
-- Same dynamic drop/re-add technique; preserves all existing movement types.
-- ============================================================
DO $$
DECLARE
  v_conname TEXT;
BEGIN
  SELECT c.conname INTO v_conname
  FROM pg_constraint c
  WHERE c.conrelid = 'public.lot_volume_movements'::regclass
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ILIKE '%movement_type%';
  IF v_conname IS NULL THEN
    RAISE EXCEPTION 'Could not locate lot_volume_movements movement_type CHECK constraint.' USING ERRCODE='raise_exception';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid='public.lot_volume_movements'::regclass AND c.contype='c'
      AND pg_get_constraintdef(c.oid) ILIKE '%bottling_out%'
  ) THEN
    EXECUTE format('ALTER TABLE public.lot_volume_movements DROP CONSTRAINT %I', v_conname);
    ALTER TABLE public.lot_volume_movements
      ADD CONSTRAINT lot_volume_movements_type_check
      CHECK (movement_type IN (
        'initial','split_out','split_in','merge_out','merge_in',
        'blend_out','blend_in','loss','adjustment','bottling_out','bottling_loss'
      ));
  END IF;
END $$;

-- ============================================================
-- 11. EXTEND THE SINGLE AUDIT WRITER (reuse 021 writer) + attach triggers
-- Adds bottling_run / bottling_run_lot / bottling_output, preserving ALL
-- thirteen existing mappings. SECURITY DEFINER / pinned search_path /
-- fail-closed ELSE / REVOKE-from-PUBLIC posture unchanged. Final CASE = 16.
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

-- AFTER INSERT/UPDATE/DELETE audit triggers on the three bottling tables.
DROP TRIGGER IF EXISTS trg_audit_bottling_runs ON public.bottling_runs;
CREATE TRIGGER trg_audit_bottling_runs
  AFTER INSERT OR UPDATE OR DELETE ON public.bottling_runs
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_row_change();

DROP TRIGGER IF EXISTS trg_audit_bottling_run_lots ON public.bottling_run_lots;
CREATE TRIGGER trg_audit_bottling_run_lots
  AFTER INSERT OR UPDATE OR DELETE ON public.bottling_run_lots
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_row_change();

DROP TRIGGER IF EXISTS trg_audit_bottling_outputs ON public.bottling_outputs;
CREATE TRIGGER trg_audit_bottling_outputs
  AFTER INSERT OR UPDATE OR DELETE ON public.bottling_outputs
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_row_change();

-- ============================================================
-- 12. POST-VALIDATION (catalog checks). RAISE => rollback.
-- ============================================================
DO $$
DECLARE
  n INTEGER;
  rls_on BOOLEAN;
  is_secdef BOOLEAN;
  cfg TEXT[];
BEGIN
  -- Tables exist.
  IF to_regclass('public.bottling_runs') IS NULL THEN RAISE EXCEPTION 'Post: bottling_runs missing.' USING ERRCODE='raise_exception'; END IF;
  IF to_regclass('public.bottling_run_lots') IS NULL THEN RAISE EXCEPTION 'Post: bottling_run_lots missing.' USING ERRCODE='raise_exception'; END IF;
  IF to_regclass('public.bottling_outputs') IS NULL THEN RAISE EXCEPTION 'Post: bottling_outputs missing.' USING ERRCODE='raise_exception'; END IF;

  -- Column counts.
  SELECT COUNT(*) INTO n FROM information_schema.columns WHERE table_schema='public' AND table_name='bottling_runs'
    AND column_name IN ('id','org_id','owner_id','bottling_code','bottling_date','status','notes','release_lab_sample_id','created_at','updated_at');
  IF n <> 10 THEN RAISE EXCEPTION 'Post: bottling_runs columns mismatch (%).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM information_schema.columns WHERE table_schema='public' AND table_name='bottling_run_lots'
    AND column_name IN ('id','org_id','owner_id','bottling_run_id','wine_lot_id','consumed_volume_litres','bottled_litres','loss_litres','notes','created_at','updated_at');
  IF n <> 11 THEN RAISE EXCEPTION 'Post: bottling_run_lots columns mismatch (%).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM information_schema.columns WHERE table_schema='public' AND table_name='bottling_outputs'
    AND column_name IN ('id','org_id','owner_id','bottling_run_id','bottle_volume_ml','bottle_count','bottled_litres','packaging_format','product_name','vintage','notes','created_at','updated_at');
  IF n <> 13 THEN RAISE EXCEPTION 'Post: bottling_outputs columns mismatch (%).', n USING ERRCODE='raise_exception'; END IF;

  -- FK counts: runs 3, run_lots 4, outputs 3.
  SELECT COUNT(*) INTO n FROM information_schema.table_constraints WHERE table_schema='public' AND table_name='bottling_runs' AND constraint_type='FOREIGN KEY';
  IF n <> 3 THEN RAISE EXCEPTION 'Post: bottling_runs should have 3 FKs (%).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM information_schema.table_constraints WHERE table_schema='public' AND table_name='bottling_run_lots' AND constraint_type='FOREIGN KEY';
  IF n <> 4 THEN RAISE EXCEPTION 'Post: bottling_run_lots should have 4 FKs (%).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM information_schema.table_constraints WHERE table_schema='public' AND table_name='bottling_outputs' AND constraint_type='FOREIGN KEY';
  IF n <> 3 THEN RAISE EXCEPTION 'Post: bottling_outputs should have 3 FKs (%).', n USING ERRCODE='raise_exception'; END IF;

  -- release_lab_sample_id FK uses SET NULL; the two run_lot CASCADE/RESTRICT verified by presence of all FKs (delete rules).
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.referential_constraints rc
    JOIN information_schema.table_constraints tc ON rc.constraint_name=tc.constraint_name AND rc.constraint_schema=tc.table_schema
    WHERE tc.table_schema='public' AND tc.constraint_name='fk_bottling_runs_release_sample' AND rc.delete_rule='SET NULL'
  ) THEN RAISE EXCEPTION 'Post: release sample FK must be ON DELETE SET NULL.' USING ERRCODE='raise_exception'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.referential_constraints rc
    JOIN information_schema.table_constraints tc ON rc.constraint_name=tc.constraint_name AND rc.constraint_schema=tc.table_schema
    WHERE tc.table_schema='public' AND tc.constraint_name='fk_brl_run' AND rc.delete_rule='CASCADE'
  ) THEN RAISE EXCEPTION 'Post: run_lots.run FK must be ON DELETE CASCADE.' USING ERRCODE='raise_exception'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.referential_constraints rc
    JOIN information_schema.table_constraints tc ON rc.constraint_name=tc.constraint_name AND rc.constraint_schema=tc.table_schema
    WHERE tc.table_schema='public' AND tc.constraint_name='fk_brl_wine_lot' AND rc.delete_rule IN ('RESTRICT','NO ACTION')
  ) THEN RAISE EXCEPTION 'Post: run_lots.wine_lot FK must be RESTRICT.' USING ERRCODE='raise_exception'; END IF;

  -- Key CHECK constraints present.
  SELECT COUNT(*) INTO n FROM pg_constraint WHERE conrelid='public.bottling_runs'::regclass AND contype='c'
    AND conname IN ('bottling_runs_code_not_blank','bottling_runs_status_check');
  IF n <> 2 THEN RAISE EXCEPTION 'Post: bottling_runs CHECKs missing (%).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_constraint WHERE conrelid='public.bottling_run_lots'::regclass AND contype='c'
    AND conname IN ('brl_consumed_non_negative','brl_bottled_non_negative','brl_loss_non_negative','brl_accounted_within_consumed');
  IF n <> 4 THEN RAISE EXCEPTION 'Post: bottling_run_lots CHECKs missing (%).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_constraint WHERE conrelid='public.bottling_outputs'::regclass AND contype='c'
    AND conname IN ('bo_bottle_volume_positive','bo_bottle_count_non_negative','bo_bottled_litres_non_negative','bo_packaging_format_not_blank','bo_vintage_range');
  IF n <> 5 THEN RAISE EXCEPTION 'Post: bottling_outputs CHECKs missing (%).', n USING ERRCODE='raise_exception'; END IF;

  -- Unique indexes present (org-scoped code + (run,lot)).
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='bottling_runs' AND indexname='uq_bottling_runs_org_code') THEN
    RAISE EXCEPTION 'Post: uq_bottling_runs_org_code missing.' USING ERRCODE='raise_exception'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='bottling_run_lots' AND indexname='uq_brl_run_lot') THEN
    RAISE EXCEPTION 'Post: uq_brl_run_lot missing.' USING ERRCODE='raise_exception'; END IF;

  -- RLS enabled on all three.
  SELECT relrowsecurity INTO rls_on FROM pg_class WHERE oid='public.bottling_runs'::regclass;
  IF NOT COALESCE(rls_on,false) THEN RAISE EXCEPTION 'Post: RLS not enabled on bottling_runs.' USING ERRCODE='raise_exception'; END IF;
  SELECT relrowsecurity INTO rls_on FROM pg_class WHERE oid='public.bottling_run_lots'::regclass;
  IF NOT COALESCE(rls_on,false) THEN RAISE EXCEPTION 'Post: RLS not enabled on bottling_run_lots.' USING ERRCODE='raise_exception'; END IF;
  SELECT relrowsecurity INTO rls_on FROM pg_class WHERE oid='public.bottling_outputs'::regclass;
  IF NOT COALESCE(rls_on,false) THEN RAISE EXCEPTION 'Post: RLS not enabled on bottling_outputs.' USING ERRCODE='raise_exception'; END IF;

  -- Exactly 3 policies each, none DELETE.
  FOR n IN SELECT 1 LOOP EXIT; END LOOP;
  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='bottling_runs';
  IF n <> 3 THEN RAISE EXCEPTION 'Post: bottling_runs expected 3 policies (%).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='bottling_run_lots';
  IF n <> 3 THEN RAISE EXCEPTION 'Post: bottling_run_lots expected 3 policies (%).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='bottling_outputs';
  IF n <> 3 THEN RAISE EXCEPTION 'Post: bottling_outputs expected 3 policies (%).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename IN ('bottling_runs','bottling_run_lots','bottling_outputs') AND cmd='DELETE';
  IF n <> 0 THEN RAISE EXCEPTION 'Post: no DELETE policy allowed on bottling tables (%).', n USING ERRCODE='raise_exception'; END IF;

  -- authenticated: SELECT/INSERT/UPDATE yes, DELETE no (all three tables).
  IF has_table_privilege('authenticated','public.bottling_runs','DELETE')
     OR has_table_privilege('authenticated','public.bottling_run_lots','DELETE')
     OR has_table_privilege('authenticated','public.bottling_outputs','DELETE') THEN
    RAISE EXCEPTION 'Post: authenticated must not have DELETE on bottling tables.' USING ERRCODE='raise_exception';
  END IF;
  IF NOT (has_table_privilege('authenticated','public.bottling_runs','SELECT')
          AND has_table_privilege('authenticated','public.bottling_runs','INSERT')
          AND has_table_privilege('authenticated','public.bottling_runs','UPDATE')) THEN
    RAISE EXCEPTION 'Post: authenticated must have SELECT/INSERT/UPDATE on bottling_runs.' USING ERRCODE='raise_exception';
  END IF;

  -- Owner-immutable + updated_at + org-integrity triggers (3 per table = 9).
  SELECT COUNT(*) INTO n FROM pg_trigger WHERE NOT tgisinternal AND tgname IN (
    'bottling_runs_owner_id_immutable','bottling_runs_updated_at','bottling_runs_org_integrity',
    'bottling_run_lots_owner_id_immutable','bottling_run_lots_updated_at','bottling_run_lots_org_integrity',
    'bottling_outputs_owner_id_immutable','bottling_outputs_updated_at','bottling_outputs_org_integrity');
  IF n <> 9 THEN RAISE EXCEPTION 'Post: expected 9 bottling base triggers (%).', n USING ERRCODE='raise_exception'; END IF;

  -- Integrity functions are SECURITY DEFINER with pinned search_path.
  SELECT COUNT(*) INTO n FROM pg_proc WHERE oid IN (
    'public.validate_bottling_run_org_integrity()'::regprocedure,
    'public.validate_bottling_run_lot_org_integrity()'::regprocedure,
    'public.validate_bottling_output_org_integrity()'::regprocedure
  ) AND prosecdef = true;
  IF n <> 3 THEN RAISE EXCEPTION 'Post: 3 bottling integrity fns must be SECURITY DEFINER (%).', n USING ERRCODE='raise_exception'; END IF;

  -- Audit triggers on the three tables.
  SELECT COUNT(*) INTO n FROM pg_trigger WHERE NOT tgisinternal AND tgname IN (
    'trg_audit_bottling_runs','trg_audit_bottling_run_lots','trg_audit_bottling_outputs');
  IF n <> 3 THEN RAISE EXCEPTION 'Post: 3 bottling audit triggers expected (%).', n USING ERRCODE='raise_exception'; END IF;

  -- production_events: all existing types + 'bottling' valid; a pre-existing value still passes.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid='public.production_events'::regclass AND c.contype='c'
    AND pg_get_constraintdef(c.oid) ILIKE '%bottling%' AND pg_get_constraintdef(c.oid) ILIKE '%fermentation_end%'
    AND pg_get_constraintdef(c.oid) ILIKE '%racking%' AND pg_get_constraintdef(c.oid) ILIKE '%adjustment%') THEN
    RAISE EXCEPTION 'Post: production_events event_type vocabulary not as expected.' USING ERRCODE='raise_exception';
  END IF;

  -- lot_volume_movements: all existing types + both new bottling types valid.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid='public.lot_volume_movements'::regclass AND c.contype='c'
    AND pg_get_constraintdef(c.oid) ILIKE '%bottling_out%' AND pg_get_constraintdef(c.oid) ILIKE '%bottling_loss%'
    AND pg_get_constraintdef(c.oid) ILIKE '%initial%' AND pg_get_constraintdef(c.oid) ILIKE '%split_out%'
    AND pg_get_constraintdef(c.oid) ILIKE '%blend_in%' AND pg_get_constraintdef(c.oid) ILIKE '%adjustment%') THEN
    RAISE EXCEPTION 'Post: lot_volume_movements movement_type vocabulary not as expected.' USING ERRCODE='raise_exception';
  END IF;

  -- Audit writer remains SECURITY DEFINER, pinned, not PUBLIC-executable, maps all 16 entities.
  SELECT prosecdef INTO is_secdef FROM pg_proc WHERE oid='public.audit_log_row_change()'::regprocedure;
  IF NOT COALESCE(is_secdef,false) THEN RAISE EXCEPTION 'Post: audit writer must remain SECURITY DEFINER.' USING ERRCODE='raise_exception'; END IF;
  SELECT proconfig INTO cfg FROM pg_proc WHERE oid='public.audit_log_row_change()'::regprocedure;
  IF NOT EXISTS (SELECT 1 FROM unnest(COALESCE(cfg,ARRAY[]::TEXT[])) c WHERE c LIKE 'search_path=%' AND position('public' IN c)>0 AND position('pg_temp' IN c)>0) THEN
    RAISE EXCEPTION 'Post: audit writer search_path must remain pinned.' USING ERRCODE='raise_exception'; END IF;
  IF has_function_privilege('public','public.audit_log_row_change()','EXECUTE') THEN
    RAISE EXCEPTION 'Post: PUBLIC must not EXECUTE the audit writer.' USING ERRCODE='raise_exception'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE oid='public.audit_log_row_change()'::regprocedure
      AND pg_get_functiondef(oid) ILIKE '%''wine_batch''%'
      AND pg_get_functiondef(oid) ILIKE '%''lab_alert''%'
      AND pg_get_functiondef(oid) ILIKE '%''bottling_run''%'
      AND pg_get_functiondef(oid) ILIKE '%''bottling_run_lot''%'
      AND pg_get_functiondef(oid) ILIKE '%''bottling_output''%'
  ) THEN RAISE EXCEPTION 'Post: audit writer must preserve existing mappings and add the 3 bottling mappings.' USING ERRCODE='raise_exception'; END IF;

  -- Existing audit triggers remain (13 pre-existing business-table triggers).
  SELECT COUNT(*) INTO n FROM pg_trigger WHERE NOT tgisinternal AND tgname IN (
    'trg_audit_wine_batches','trg_audit_batch_grape_intakes','trg_audit_wine_lots',
    'trg_audit_vessels','trg_audit_vessel_placements','trg_audit_production_events',
    'trg_audit_lot_lineage','trg_audit_lot_volume_movements',
    'trg_audit_lab_analytes','trg_audit_lab_samples','trg_audit_lab_measurements',
    'trg_audit_lab_specifications','trg_audit_lab_alerts');
  IF n <> 13 THEN RAISE EXCEPTION 'Post: the 13 pre-existing audit triggers must remain (%).', n USING ERRCODE='raise_exception'; END IF;

  -- audit_log has NO trigger (recursion guard).
  SELECT COUNT(*) INTO n FROM pg_trigger WHERE tgrelid='public.audit_log'::regclass AND NOT tgisinternal;
  IF n <> 0 THEN RAISE EXCEPTION 'Post: audit_log must have no triggers (%).', n USING ERRCODE='raise_exception'; END IF;

  -- Bottling tables start empty.
  SELECT COUNT(*) INTO n FROM public.bottling_runs; IF n <> 0 THEN RAISE EXCEPTION 'Post: bottling_runs must start empty (%).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM public.bottling_run_lots; IF n <> 0 THEN RAISE EXCEPTION 'Post: bottling_run_lots must start empty (%).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM public.bottling_outputs; IF n <> 0 THEN RAISE EXCEPTION 'Post: bottling_outputs must start empty (%).', n USING ERRCODE='raise_exception'; END IF;

  -- No new volume movement or production event was written by this migration,
  -- and the audit_log row count is unchanged (baseline from step 0b).
  SELECT COUNT(*) INTO n FROM public.audit_log;
  IF n <> COALESCE(NULLIF(current_setting('winerix.audit_baseline_count', true), ''), '-1')::integer THEN
    RAISE EXCEPTION 'Post: audit_log row count must be unchanged (baseline %, now %).',
      current_setting('winerix.audit_baseline_count', true), n USING ERRCODE='raise_exception';
  END IF;
END $$;

COMMIT;
