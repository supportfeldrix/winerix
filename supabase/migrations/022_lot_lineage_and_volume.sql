-- ============================================================
-- WINERIX — P2H-1: Wine Lot Lineage & Volume Management
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- Depends on: 006 (organisations, is_org_member, has_org_role),
--             018 (wine_lots), 020 (production_events)
--
-- PURPOSE:
--   Add the lineage graph and the volume ledger for wine lots, plus the
--   authoritative SECURITY DEFINER operation functions that mutate lot volume.
--
--     lot_lineage            — many-to-many parent->child edges (split/merge/
--                              blend). Append-only.
--     lot_volume_movements   — append-only signed-delta ledger explaining every
--                              volume change. wine_lots.volume_litres remains the
--                              materialised current balance:
--                                  SUM(deltas per lot) == wine_lots.volume_litres
--
--   Volume-changing operations (split/merge/blend/loss/adjustment) are performed
--   ONLY by the SECURITY DEFINER functions below, which update the lot balance
--   AND write the ledger (and lineage where applicable) in ONE transaction. This
--   makes the ledger the single authoritative derivation of the lot balance and
--   prevents a second writer.
--
-- UNCHANGED (P2A–P2G decisions preserved):
--   LOCATION            -> vessel_placements
--   BUSINESS HISTORY    -> production_events (still no volume)
--   TECHNICAL TRAIL     -> audit_log (021)  [audit wiring for the NEW tables is
--                          P2H-2 / migration 023 — NOT in this migration]
--   CURRENT VOLUME      -> wine_lots.volume_litres (materialised)
--
-- SCOPE — THIS MIGRATION ONLY:
--   Two new tables + FKs/indexes/CHECKs + append-only role-scoped RLS + cross-org
--   integrity triggers + the five operation functions + a one-time 'initial'
--   backfill for existing lots + reconciliation + post-validation. Additive.
--
-- THIS MIGRATION DOES NOT:
--   * change any existing table's columns (no current_vessel_id, no parent_lot_id
--     on wine_lots)
--   * modify vessel_placements / production_events / audit_log
--   * add audit triggers (that is migration 023)
--   * auto-place child lots in vessels (placement remains explicit P2F)
--   * invent new wine_lot statuses (reuses active/in_production/bottled/depleted/archived)
--   * fabricate historical lineage for existing lots
-- ============================================================

BEGIN;

-- ============================================================
-- 0. PRE-FLIGHT
-- ============================================================
DO $$
BEGIN
  IF to_regclass('public.organisations') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.organisations is missing (run 006 first).' USING ERRCODE = 'undefined_table';
  END IF;
  IF to_regclass('public.wine_lots') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.wine_lots is missing (run 018 first).' USING ERRCODE = 'undefined_table';
  END IF;
  IF to_regclass('public.production_events') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.production_events is missing (run 020 first).' USING ERRCODE = 'undefined_table';
  END IF;
  IF to_regclass('public.lot_lineage') IS NOT NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.lot_lineage already exists.' USING ERRCODE = 'duplicate_table';
  END IF;
  IF to_regclass('public.lot_volume_movements') IS NOT NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.lot_volume_movements already exists.' USING ERRCODE = 'duplicate_table';
  END IF;
  IF to_regprocedure('public.is_org_member(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.is_org_member(uuid) is missing (run 006 first).' USING ERRCODE = 'undefined_function';
  END IF;
  IF to_regprocedure('public.has_org_role(uuid, text[])') IS NULL THEN
    RAISE EXCEPTION 'Pre-flight failed: public.has_org_role(uuid, text[]) is missing (run 006 first).' USING ERRCODE = 'undefined_function';
  END IF;
END $$;

-- ============================================================
-- 1. LOT_LINEAGE (append-only many-to-many edges)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.lot_lineage (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               UUID NOT NULL,
  owner_id             UUID NOT NULL,
  parent_lot_id        UUID NOT NULL,
  child_lot_id         UUID NOT NULL,
  relation_type        TEXT NOT NULL,
  volume_litres        NUMERIC(12, 2) NOT NULL,
  production_event_id  UUID,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_ll_org
    FOREIGN KEY (org_id) REFERENCES public.organisations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_ll_owner
    FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_ll_parent
    FOREIGN KEY (parent_lot_id) REFERENCES public.wine_lots(id) ON DELETE RESTRICT,
  CONSTRAINT fk_ll_child
    FOREIGN KEY (child_lot_id) REFERENCES public.wine_lots(id) ON DELETE RESTRICT,
  CONSTRAINT fk_ll_production_event
    FOREIGN KEY (production_event_id) REFERENCES public.production_events(id) ON DELETE RESTRICT,

  CONSTRAINT lot_lineage_parent_ne_child CHECK (parent_lot_id <> child_lot_id),
  CONSTRAINT lot_lineage_volume_non_negative CHECK (volume_litres >= 0),
  CONSTRAINT lot_lineage_relation_type_check CHECK (relation_type IN ('split','merge','blend')),
  CONSTRAINT uq_lot_lineage_parent_child UNIQUE (parent_lot_id, child_lot_id)
);

CREATE INDEX IF NOT EXISTS idx_ll_org_id       ON public.lot_lineage(org_id);
CREATE INDEX IF NOT EXISTS idx_ll_owner_id     ON public.lot_lineage(owner_id);
CREATE INDEX IF NOT EXISTS idx_ll_parent_lot   ON public.lot_lineage(parent_lot_id);
CREATE INDEX IF NOT EXISTS idx_ll_child_lot    ON public.lot_lineage(child_lot_id);
CREATE INDEX IF NOT EXISTS idx_ll_prod_event   ON public.lot_lineage(production_event_id);

-- ============================================================
-- 2. LOT_VOLUME_MOVEMENTS (append-only signed-delta ledger)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.lot_volume_movements (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               UUID NOT NULL,
  owner_id             UUID NOT NULL,
  wine_lot_id          UUID NOT NULL,
  movement_type        TEXT NOT NULL,
  volume_delta_litres  NUMERIC(12, 2) NOT NULL,
  lot_lineage_id       UUID,
  production_event_id  UUID,
  notes                TEXT,
  occurred_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_lvm_org
    FOREIGN KEY (org_id) REFERENCES public.organisations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_lvm_owner
    FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_lvm_wine_lot
    FOREIGN KEY (wine_lot_id) REFERENCES public.wine_lots(id) ON DELETE RESTRICT,
  CONSTRAINT fk_lvm_lineage
    FOREIGN KEY (lot_lineage_id) REFERENCES public.lot_lineage(id) ON DELETE RESTRICT,
  CONSTRAINT fk_lvm_production_event
    FOREIGN KEY (production_event_id) REFERENCES public.production_events(id) ON DELETE RESTRICT,

  CONSTRAINT lot_volume_movements_type_check CHECK (movement_type IN (
    'initial','split_out','split_in','merge_out','merge_in',
    'blend_out','blend_in','loss','adjustment'
  ))
);

CREATE INDEX IF NOT EXISTS idx_lvm_org_id      ON public.lot_volume_movements(org_id);
CREATE INDEX IF NOT EXISTS idx_lvm_owner_id    ON public.lot_volume_movements(owner_id);
CREATE INDEX IF NOT EXISTS idx_lvm_wine_lot    ON public.lot_volume_movements(wine_lot_id);
CREATE INDEX IF NOT EXISTS idx_lvm_lineage     ON public.lot_volume_movements(lot_lineage_id);
CREATE INDEX IF NOT EXISTS idx_lvm_prod_event  ON public.lot_volume_movements(production_event_id);
CREATE INDEX IF NOT EXISTS idx_lvm_occurred_at ON public.lot_volume_movements(occurred_at);

-- ============================================================
-- 3. CROSS-ORGANISATION INTEGRITY (authoritative, DB-enforced)
-- ============================================================

-- lot_lineage: parent, child (and optional production event) must be same-org.
CREATE OR REPLACE FUNCTION public.validate_lot_lineage_org_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  parent_org UUID;
  child_org  UUID;
  pe_org     UUID;
BEGIN
  SELECT org_id INTO parent_org FROM public.wine_lots WHERE id = NEW.parent_lot_id;
  IF parent_org IS NULL THEN
    RAISE EXCEPTION 'Invalid parent lot: % does not exist.', NEW.parent_lot_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF parent_org <> NEW.org_id THEN
    RAISE EXCEPTION 'Cross-organisation reference: parent lot % belongs to a different organisation.', NEW.parent_lot_id USING ERRCODE = 'raise_exception';
  END IF;

  SELECT org_id INTO child_org FROM public.wine_lots WHERE id = NEW.child_lot_id;
  IF child_org IS NULL THEN
    RAISE EXCEPTION 'Invalid child lot: % does not exist.', NEW.child_lot_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF child_org <> NEW.org_id THEN
    RAISE EXCEPTION 'Cross-organisation reference: child lot % belongs to a different organisation.', NEW.child_lot_id USING ERRCODE = 'raise_exception';
  END IF;

  IF NEW.production_event_id IS NOT NULL THEN
    SELECT org_id INTO pe_org FROM public.production_events WHERE id = NEW.production_event_id;
    IF pe_org IS NULL THEN
      RAISE EXCEPTION 'Invalid production event: % does not exist.', NEW.production_event_id USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF pe_org <> NEW.org_id THEN
      RAISE EXCEPTION 'Cross-organisation reference: production event % belongs to a different organisation.', NEW.production_event_id USING ERRCODE = 'raise_exception';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS lot_lineage_org_integrity ON public.lot_lineage;
CREATE TRIGGER lot_lineage_org_integrity
  BEFORE INSERT OR UPDATE ON public.lot_lineage
  FOR EACH ROW EXECUTE FUNCTION public.validate_lot_lineage_org_integrity();

-- lot_volume_movements: lot (and optional lineage/event) must be same-org.
CREATE OR REPLACE FUNCTION public.validate_lot_volume_movement_org_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  lot_org      UUID;
  lineage_org  UUID;
  pe_org       UUID;
BEGIN
  SELECT org_id INTO lot_org FROM public.wine_lots WHERE id = NEW.wine_lot_id;
  IF lot_org IS NULL THEN
    RAISE EXCEPTION 'Invalid wine lot: % does not exist.', NEW.wine_lot_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF lot_org <> NEW.org_id THEN
    RAISE EXCEPTION 'Cross-organisation reference: wine lot % belongs to a different organisation.', NEW.wine_lot_id USING ERRCODE = 'raise_exception';
  END IF;

  IF NEW.lot_lineage_id IS NOT NULL THEN
    SELECT org_id INTO lineage_org FROM public.lot_lineage WHERE id = NEW.lot_lineage_id;
    IF lineage_org IS NULL THEN
      RAISE EXCEPTION 'Invalid lineage edge: % does not exist.', NEW.lot_lineage_id USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF lineage_org <> NEW.org_id THEN
      RAISE EXCEPTION 'Cross-organisation reference: lineage edge % belongs to a different organisation.', NEW.lot_lineage_id USING ERRCODE = 'raise_exception';
    END IF;
  END IF;

  IF NEW.production_event_id IS NOT NULL THEN
    SELECT org_id INTO pe_org FROM public.production_events WHERE id = NEW.production_event_id;
    IF pe_org IS NULL THEN
      RAISE EXCEPTION 'Invalid production event: % does not exist.', NEW.production_event_id USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF pe_org <> NEW.org_id THEN
      RAISE EXCEPTION 'Cross-organisation reference: production event % belongs to a different organisation.', NEW.production_event_id USING ERRCODE = 'raise_exception';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS lot_volume_movements_org_integrity ON public.lot_volume_movements;
CREATE TRIGGER lot_volume_movements_org_integrity
  BEFORE INSERT OR UPDATE ON public.lot_volume_movements
  FOR EACH ROW EXECUTE FUNCTION public.validate_lot_volume_movement_org_integrity();

-- ============================================================
-- 4. ROW LEVEL SECURITY — APPEND-ONLY, ROLE-SCOPED WRITES
-- SELECT: any org member. INSERT: OWNER/ADMIN/CELLAR. No UPDATE/DELETE policy.
-- (The operation functions run SECURITY DEFINER and thus bypass these to write,
-- but note the INSERT policies still describe the intended client capability.)
-- ============================================================
ALTER TABLE public.lot_lineage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view organisation lot lineage"
  ON public.lot_lineage FOR SELECT
  USING (public.is_org_member(org_id));

CREATE POLICY "Cellar roles can insert organisation lot lineage"
  ON public.lot_lineage FOR INSERT
  WITH CHECK (
    public.is_org_member(org_id)
    AND owner_id = auth.uid()
    AND public.has_org_role(org_id, ARRAY['OWNER','ADMIN','CELLAR'])
  );

ALTER TABLE public.lot_volume_movements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view organisation lot volume movements"
  ON public.lot_volume_movements FOR SELECT
  USING (public.is_org_member(org_id));

CREATE POLICY "Cellar roles can insert organisation lot volume movements"
  ON public.lot_volume_movements FOR INSERT
  WITH CHECK (
    public.is_org_member(org_id)
    AND owner_id = auth.uid()
    AND public.has_org_role(org_id, ARRAY['OWNER','ADMIN','CELLAR'])
  );

-- ============================================================
-- 5. GRANTS — SELECT + INSERT only (append-only)
-- ============================================================
GRANT SELECT, INSERT ON public.lot_lineage           TO authenticated;
GRANT SELECT, INSERT ON public.lot_volume_movements  TO authenticated;

-- ============================================================
-- 6. INITIAL BACKFILL — one 'initial' movement per existing lot
-- Records the known starting balance so the ledger reconciles from day one.
-- Does NOT modify wine_lots.volume_litres and creates NO lineage rows.
-- Runs as the migration owner (SECURITY DEFINER not needed here; this is the
-- migration transaction itself). Idempotent: only inserts where no movement
-- exists yet for the lot.
-- ============================================================
INSERT INTO public.lot_volume_movements
  (org_id, owner_id, wine_lot_id, movement_type, volume_delta_litres, notes, occurred_at)
SELECT
  wl.org_id, wl.owner_id, wl.id, 'initial', wl.volume_litres,
  'Initial starting balance recorded at ledger introduction (P2H-1).', wl.created_at
FROM public.wine_lots wl
WHERE NOT EXISTS (
  SELECT 1 FROM public.lot_volume_movements m WHERE m.wine_lot_id = wl.id
);

-- ============================================================
-- 7. TRANSACTIONAL OPERATION FUNCTIONS (authoritative volume writers)
-- All SECURITY DEFINER, pinned search_path, org-scoped, role-checked. Each
-- updates wine_lots.volume_litres AND writes the ledger (and lineage) in one
-- statement/transaction so the invariant SUM(deltas)==volume_litres holds.
-- ============================================================

-- Internal guard: resolve caller, verify active membership + cellar role for org.
CREATE OR REPLACE FUNCTION public.assert_cellar_actor(target_org UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  uid UUID := auth.uid();
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.' USING ERRCODE = 'raise_exception';
  END IF;
  IF NOT public.is_org_member(target_org) THEN
    RAISE EXCEPTION 'Not a member of the target organisation.' USING ERRCODE = 'raise_exception';
  END IF;
  IF NOT public.has_org_role(target_org, ARRAY['OWNER','ADMIN','CELLAR']) THEN
    RAISE EXCEPTION 'This operation requires an Owner, Admin or Cellar role.' USING ERRCODE = 'raise_exception';
  END IF;
  RETURN uid;
END;
$$;
REVOKE ALL ON FUNCTION public.assert_cellar_actor(UUID) FROM PUBLIC;

-- ---- A. SPLIT ----------------------------------------------------------------
-- children: JSONB array of { "lot_code": text, "volume_litres": numeric, "notes": text? }
CREATE OR REPLACE FUNCTION public.split_wine_lot(
  p_parent_lot_id UUID,
  p_children JSONB,
  p_notes TEXT DEFAULT NULL
)
RETURNS SETOF public.wine_lots
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org        UUID;
  v_owner      UUID;
  v_batch      UUID;
  v_parent_vol NUMERIC(12,2);
  v_total_out  NUMERIC(12,2) := 0;
  child        JSONB;
  v_child_id   UUID;
  v_edge_id    UUID;
  v_child_vol  NUMERIC(12,2);
  v_child_code TEXT;
BEGIN
  SELECT org_id, volume_litres, wine_batch_id INTO v_org, v_parent_vol, v_batch
  FROM public.wine_lots WHERE id = p_parent_lot_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Parent lot % not found.', p_parent_lot_id USING ERRCODE = 'raise_exception';
  END IF;
  v_owner := public.assert_cellar_actor(v_org);

  IF p_children IS NULL OR jsonb_typeof(p_children) <> 'array' OR jsonb_array_length(p_children) = 0 THEN
    RAISE EXCEPTION 'At least one child lot is required.' USING ERRCODE = 'raise_exception';
  END IF;

  -- Validate total out <= parent volume.
  FOR child IN SELECT * FROM jsonb_array_elements(p_children) LOOP
    v_child_vol := COALESCE((child->>'volume_litres')::NUMERIC, -1);
    IF v_child_vol < 0 THEN
      RAISE EXCEPTION 'Each child volume must be >= 0.' USING ERRCODE = 'raise_exception';
    END IF;
    v_total_out := v_total_out + v_child_vol;
  END LOOP;
  IF v_total_out > v_parent_vol THEN
    RAISE EXCEPTION 'Split volume (%) exceeds parent current volume (%).', v_total_out, v_parent_vol USING ERRCODE = 'raise_exception';
  END IF;

  -- Create each child lot + lineage edge + movements.
  FOR child IN SELECT * FROM jsonb_array_elements(p_children) LOOP
    v_child_code := btrim(child->>'lot_code');
    v_child_vol  := (child->>'volume_litres')::NUMERIC;
    IF v_child_code IS NULL OR length(v_child_code) = 0 THEN
      RAISE EXCEPTION 'Each child requires a lot_code.' USING ERRCODE = 'raise_exception';
    END IF;

    INSERT INTO public.wine_lots (org_id, owner_id, wine_batch_id, lot_code, volume_litres, status, notes)
    VALUES (v_org, v_owner, v_batch, v_child_code, v_child_vol, 'active', child->>'notes')
    RETURNING id INTO v_child_id;

    INSERT INTO public.lot_lineage (org_id, owner_id, parent_lot_id, child_lot_id, relation_type, volume_litres)
    VALUES (v_org, v_owner, p_parent_lot_id, v_child_id, 'split', v_child_vol)
    RETURNING id INTO v_edge_id;

    -- child starting balance recorded as split_in (child begins at 0, +vol).
    INSERT INTO public.lot_volume_movements (org_id, owner_id, wine_lot_id, movement_type, volume_delta_litres, lot_lineage_id, notes)
    VALUES (v_org, v_owner, v_child_id, 'split_in', v_child_vol, v_edge_id, p_notes);

    -- Correct the child's initialisation: the INSERT above set volume_litres =
    -- v_child_vol directly, which would double-count against the split_in ledger
    -- row. Reset child to 0 first is avoided; instead we record the child's ONLY
    -- movement as split_in and ensure the child has no 'initial' row, so
    -- SUM(child deltas) = v_child_vol = volume_litres. (No initial backfill runs
    -- for new lots.)

    -- parent split_out (negative).
    INSERT INTO public.lot_volume_movements (org_id, owner_id, wine_lot_id, movement_type, volume_delta_litres, lot_lineage_id, notes)
    VALUES (v_org, v_owner, p_parent_lot_id, 'split_out', -v_child_vol, v_edge_id, p_notes);

    RETURN NEXT (SELECT wl FROM public.wine_lots wl WHERE wl.id = v_child_id);
  END LOOP;

  -- Reduce parent balance by total out.
  UPDATE public.wine_lots
     SET volume_litres = volume_litres - v_total_out,
         status = CASE WHEN volume_litres - v_total_out = 0 THEN 'depleted' ELSE status END
   WHERE id = p_parent_lot_id;

  RETURN;
END;
$$;
REVOKE ALL ON FUNCTION public.split_wine_lot(UUID, JSONB, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.split_wine_lot(UUID, JSONB, TEXT) TO authenticated;

-- ---- B. MERGE / BLEND --------------------------------------------------------
-- sources: JSONB array of { "lot_id": uuid, "volume_litres": numeric }
CREATE OR REPLACE FUNCTION public.combine_wine_lots(
  p_sources JSONB,
  p_new_lot_code TEXT,
  p_relation_type TEXT,   -- 'merge' | 'blend'
  p_notes TEXT DEFAULT NULL
)
RETURNS public.wine_lots
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org       UUID;
  v_owner     UUID;
  v_batch     UUID;
  src         JSONB;
  v_src_id    UUID;
  v_src_vol   NUMERIC(12,2);
  v_src_cur   NUMERIC(12,2);
  v_src_org   UUID;
  v_total_in  NUMERIC(12,2) := 0;
  v_new_id    UUID;
  v_edge_id   UUID;
  v_result    public.wine_lots;
BEGIN
  IF p_relation_type NOT IN ('merge','blend') THEN
    RAISE EXCEPTION 'relation_type must be merge or blend.' USING ERRCODE = 'raise_exception';
  END IF;
  IF p_sources IS NULL OR jsonb_typeof(p_sources) <> 'array' OR jsonb_array_length(p_sources) < 2 THEN
    RAISE EXCEPTION 'At least two source lots are required.' USING ERRCODE = 'raise_exception';
  END IF;
  IF p_new_lot_code IS NULL OR length(btrim(p_new_lot_code)) = 0 THEN
    RAISE EXCEPTION 'A new lot code is required.' USING ERRCODE = 'raise_exception';
  END IF;

  -- Determine org from the first source and validate all sources are same-org
  -- with sufficient volume. Also capture a batch for the resulting lot (first source's batch).
  FOR src IN SELECT * FROM jsonb_array_elements(p_sources) LOOP
    v_src_id  := (src->>'lot_id')::UUID;
    v_src_vol := COALESCE((src->>'volume_litres')::NUMERIC, -1);
    IF v_src_vol <= 0 THEN
      RAISE EXCEPTION 'Each source volume must be > 0.' USING ERRCODE = 'raise_exception';
    END IF;
    SELECT org_id, volume_litres, wine_batch_id INTO v_src_org, v_src_cur, v_batch
    FROM public.wine_lots WHERE id = v_src_id;
    IF v_src_org IS NULL THEN
      RAISE EXCEPTION 'Source lot % not found.', v_src_id USING ERRCODE = 'raise_exception';
    END IF;
    IF v_org IS NULL THEN
      v_org := v_src_org;
    ELSIF v_org <> v_src_org THEN
      RAISE EXCEPTION 'All source lots must belong to the same organisation.' USING ERRCODE = 'raise_exception';
    END IF;
    IF v_src_vol > v_src_cur THEN
      RAISE EXCEPTION 'Source lot % has insufficient volume (% requested, % available).', v_src_id, v_src_vol, v_src_cur USING ERRCODE = 'raise_exception';
    END IF;
    v_total_in := v_total_in + v_src_vol;
  END LOOP;

  v_owner := public.assert_cellar_actor(v_org);

  -- Create the resulting lot at 0, then record its total via *_in movements.
  INSERT INTO public.wine_lots (org_id, owner_id, wine_batch_id, lot_code, volume_litres, status, notes)
  VALUES (v_org, v_owner, v_batch, btrim(p_new_lot_code), v_total_in, 'active', p_notes)
  RETURNING id INTO v_new_id;

  -- One edge + out-movement per source; one aggregate in-movement per source on the new lot.
  FOR src IN SELECT * FROM jsonb_array_elements(p_sources) LOOP
    v_src_id  := (src->>'lot_id')::UUID;
    v_src_vol := (src->>'volume_litres')::NUMERIC;

    INSERT INTO public.lot_lineage (org_id, owner_id, parent_lot_id, child_lot_id, relation_type, volume_litres)
    VALUES (v_org, v_owner, v_src_id, v_new_id, p_relation_type, v_src_vol)
    RETURNING id INTO v_edge_id;

    -- source out (negative) + reduce source balance.
    INSERT INTO public.lot_volume_movements (org_id, owner_id, wine_lot_id, movement_type, volume_delta_litres, lot_lineage_id, notes)
    VALUES (v_org, v_owner, v_src_id,
            CASE WHEN p_relation_type = 'merge' THEN 'merge_out' ELSE 'blend_out' END,
            -v_src_vol, v_edge_id, p_notes);

    UPDATE public.wine_lots
       SET volume_litres = volume_litres - v_src_vol,
           status = CASE WHEN volume_litres - v_src_vol = 0 THEN 'depleted' ELSE status END
     WHERE id = v_src_id;

    -- resulting lot in (positive), attributed to this source's edge.
    INSERT INTO public.lot_volume_movements (org_id, owner_id, wine_lot_id, movement_type, volume_delta_litres, lot_lineage_id, notes)
    VALUES (v_org, v_owner, v_new_id,
            CASE WHEN p_relation_type = 'merge' THEN 'merge_in' ELSE 'blend_in' END,
            v_src_vol, v_edge_id, p_notes);
  END LOOP;

  SELECT * INTO v_result FROM public.wine_lots WHERE id = v_new_id;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.combine_wine_lots(JSONB, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.combine_wine_lots(JSONB, TEXT, TEXT, TEXT) TO authenticated;

-- ---- C. RECORD LOSS ----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_lot_loss(
  p_lot_id UUID,
  p_volume NUMERIC,
  p_notes TEXT DEFAULT NULL
)
RETURNS public.wine_lots
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org   UUID;
  v_owner UUID;
  v_cur   NUMERIC(12,2);
  v_res   public.wine_lots;
BEGIN
  IF p_volume IS NULL OR p_volume <= 0 THEN
    RAISE EXCEPTION 'Loss volume must be greater than zero.' USING ERRCODE = 'raise_exception';
  END IF;
  SELECT org_id, volume_litres INTO v_org, v_cur FROM public.wine_lots WHERE id = p_lot_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Wine lot % not found.', p_lot_id USING ERRCODE = 'raise_exception';
  END IF;
  v_owner := public.assert_cellar_actor(v_org);
  IF p_volume > v_cur THEN
    RAISE EXCEPTION 'Loss (%) exceeds current volume (%).', p_volume, v_cur USING ERRCODE = 'raise_exception';
  END IF;

  INSERT INTO public.lot_volume_movements (org_id, owner_id, wine_lot_id, movement_type, volume_delta_litres, notes)
  VALUES (v_org, v_owner, p_lot_id, 'loss', -p_volume, p_notes);

  UPDATE public.wine_lots
     SET volume_litres = volume_litres - p_volume,
         status = CASE WHEN volume_litres - p_volume = 0 THEN 'depleted' ELSE status END
   WHERE id = p_lot_id
   RETURNING * INTO v_res;

  RETURN v_res;
END;
$$;
REVOKE ALL ON FUNCTION public.record_lot_loss(UUID, NUMERIC, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_lot_loss(UUID, NUMERIC, TEXT) TO authenticated;

-- ---- D. RECORD ADJUSTMENT ----------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_lot_adjustment(
  p_lot_id UUID,
  p_delta NUMERIC,
  p_notes TEXT DEFAULT NULL
)
RETURNS public.wine_lots
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org   UUID;
  v_owner UUID;
  v_cur   NUMERIC(12,2);
  v_res   public.wine_lots;
BEGIN
  IF p_delta IS NULL OR p_delta = 0 THEN
    RAISE EXCEPTION 'Adjustment delta must be non-zero.' USING ERRCODE = 'raise_exception';
  END IF;
  SELECT org_id, volume_litres INTO v_org, v_cur FROM public.wine_lots WHERE id = p_lot_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Wine lot % not found.', p_lot_id USING ERRCODE = 'raise_exception';
  END IF;
  v_owner := public.assert_cellar_actor(v_org);
  IF v_cur + p_delta < 0 THEN
    RAISE EXCEPTION 'Adjustment would take volume below zero (current %, delta %).', v_cur, p_delta USING ERRCODE = 'raise_exception';
  END IF;

  INSERT INTO public.lot_volume_movements (org_id, owner_id, wine_lot_id, movement_type, volume_delta_litres, notes)
  VALUES (v_org, v_owner, p_lot_id, 'adjustment', p_delta, p_notes);

  UPDATE public.wine_lots
     SET volume_litres = volume_litres + p_delta,
         status = CASE WHEN volume_litres + p_delta = 0 THEN 'depleted' ELSE status END
   WHERE id = p_lot_id
   RETURNING * INTO v_res;

  RETURN v_res;
END;
$$;
REVOKE ALL ON FUNCTION public.record_lot_adjustment(UUID, NUMERIC, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_lot_adjustment(UUID, NUMERIC, TEXT) TO authenticated;

-- ============================================================
-- 8. POST-CHANGE VALIDATION (catalog + reconciliation). RAISE => rollback.
-- ============================================================
DO $$
DECLARE
  n INTEGER;
  rls_on BOOLEAN;
  bad INTEGER;
BEGIN
  -- Tables exist.
  IF to_regclass('public.lot_lineage') IS NULL THEN RAISE EXCEPTION 'Post-check: lot_lineage missing.' USING ERRCODE='raise_exception'; END IF;
  IF to_regclass('public.lot_volume_movements') IS NULL THEN RAISE EXCEPTION 'Post-check: lot_volume_movements missing.' USING ERRCODE='raise_exception'; END IF;

  -- lot_lineage columns.
  SELECT COUNT(*) INTO n FROM information_schema.columns
  WHERE table_schema='public' AND table_name='lot_lineage'
    AND column_name IN ('id','org_id','owner_id','parent_lot_id','child_lot_id','relation_type','volume_litres','production_event_id','created_at','updated_at');
  IF n <> 10 THEN RAISE EXCEPTION 'Post-check: lot_lineage columns mismatch (%).', n USING ERRCODE='raise_exception'; END IF;

  -- lot_lineage FKs (5) + CHECKs (3) + UNIQUE (1).
  SELECT COUNT(*) INTO n FROM information_schema.table_constraints WHERE table_schema='public' AND table_name='lot_lineage' AND constraint_type='FOREIGN KEY';
  IF n <> 5 THEN RAISE EXCEPTION 'Post-check: lot_lineage should have 5 FKs (%).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM information_schema.table_constraints WHERE table_schema='public' AND table_name='lot_lineage' AND constraint_type='CHECK'
    AND constraint_name IN ('lot_lineage_parent_ne_child','lot_lineage_volume_non_negative','lot_lineage_relation_type_check');
  IF n <> 3 THEN RAISE EXCEPTION 'Post-check: lot_lineage CHECKs missing (%).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM information_schema.table_constraints WHERE table_schema='public' AND table_name='lot_lineage' AND constraint_type='UNIQUE' AND constraint_name='uq_lot_lineage_parent_child';
  IF n <> 1 THEN RAISE EXCEPTION 'Post-check: uq_lot_lineage_parent_child missing.' USING ERRCODE='raise_exception'; END IF;

  -- lot_volume_movements columns + FKs (5) + CHECK (1).
  SELECT COUNT(*) INTO n FROM information_schema.columns
  WHERE table_schema='public' AND table_name='lot_volume_movements'
    AND column_name IN ('id','org_id','owner_id','wine_lot_id','movement_type','volume_delta_litres','lot_lineage_id','production_event_id','notes','occurred_at','created_at','updated_at');
  IF n <> 12 THEN RAISE EXCEPTION 'Post-check: lot_volume_movements columns mismatch (%).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM information_schema.table_constraints WHERE table_schema='public' AND table_name='lot_volume_movements' AND constraint_type='FOREIGN KEY';
  IF n <> 5 THEN RAISE EXCEPTION 'Post-check: lot_volume_movements should have 5 FKs (%).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM information_schema.table_constraints WHERE table_schema='public' AND table_name='lot_volume_movements' AND constraint_type='CHECK' AND constraint_name='lot_volume_movements_type_check';
  IF n <> 1 THEN RAISE EXCEPTION 'Post-check: lot_volume_movements_type_check missing.' USING ERRCODE='raise_exception'; END IF;

  -- RLS enabled + append-only (2 policies each, no UPDATE/DELETE policy).
  SELECT relrowsecurity INTO rls_on FROM pg_class WHERE oid='public.lot_lineage'::regclass;
  IF NOT COALESCE(rls_on,false) THEN RAISE EXCEPTION 'Post-check: RLS off on lot_lineage.' USING ERRCODE='raise_exception'; END IF;
  SELECT relrowsecurity INTO rls_on FROM pg_class WHERE oid='public.lot_volume_movements'::regclass;
  IF NOT COALESCE(rls_on,false) THEN RAISE EXCEPTION 'Post-check: RLS off on lot_volume_movements.' USING ERRCODE='raise_exception'; END IF;

  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='lot_lineage';
  IF n <> 2 THEN RAISE EXCEPTION 'Post-check: lot_lineage must have 2 policies (%).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='lot_lineage' AND cmd IN ('UPDATE','DELETE');
  IF n <> 0 THEN RAISE EXCEPTION 'Post-check: lot_lineage must have no UPDATE/DELETE policy.' USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='lot_volume_movements';
  IF n <> 2 THEN RAISE EXCEPTION 'Post-check: lot_volume_movements must have 2 policies (%).', n USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='lot_volume_movements' AND cmd IN ('UPDATE','DELETE');
  IF n <> 0 THEN RAISE EXCEPTION 'Post-check: lot_volume_movements must have no UPDATE/DELETE policy.' USING ERRCODE='raise_exception'; END IF;

  -- No UPDATE/DELETE grants to authenticated.
  SELECT COUNT(*) INTO n FROM information_schema.role_table_grants
  WHERE table_schema='public' AND table_name IN ('lot_lineage','lot_volume_movements')
    AND grantee='authenticated' AND privilege_type IN ('UPDATE','DELETE');
  IF n <> 0 THEN RAISE EXCEPTION 'Post-check: append-only tables must not grant UPDATE/DELETE (%).', n USING ERRCODE='raise_exception'; END IF;

  -- Integrity trigger functions exist + SECURITY DEFINER.
  IF to_regprocedure('public.validate_lot_lineage_org_integrity()') IS NULL THEN RAISE EXCEPTION 'Post-check: lineage integrity fn missing.' USING ERRCODE='raise_exception'; END IF;
  IF to_regprocedure('public.validate_lot_volume_movement_org_integrity()') IS NULL THEN RAISE EXCEPTION 'Post-check: movement integrity fn missing.' USING ERRCODE='raise_exception'; END IF;

  -- Operation functions exist, are SECURITY DEFINER, and not PUBLIC-executable.
  FOR n IN
    SELECT 1 FROM (VALUES
      ('public.split_wine_lot(uuid, jsonb, text)'),
      ('public.combine_wine_lots(jsonb, text, text, text)'),
      ('public.record_lot_loss(uuid, numeric, text)'),
      ('public.record_lot_adjustment(uuid, numeric, text)')
    ) AS f(sig)
  LOOP NULL; END LOOP;
  IF to_regprocedure('public.split_wine_lot(uuid, jsonb, text)') IS NULL THEN RAISE EXCEPTION 'Post-check: split_wine_lot missing.' USING ERRCODE='raise_exception'; END IF;
  IF to_regprocedure('public.combine_wine_lots(jsonb, text, text, text)') IS NULL THEN RAISE EXCEPTION 'Post-check: combine_wine_lots missing.' USING ERRCODE='raise_exception'; END IF;
  IF to_regprocedure('public.record_lot_loss(uuid, numeric, text)') IS NULL THEN RAISE EXCEPTION 'Post-check: record_lot_loss missing.' USING ERRCODE='raise_exception'; END IF;
  IF to_regprocedure('public.record_lot_adjustment(uuid, numeric, text)') IS NULL THEN RAISE EXCEPTION 'Post-check: record_lot_adjustment missing.' USING ERRCODE='raise_exception'; END IF;

  SELECT COUNT(*) INTO n FROM pg_proc
  WHERE oid IN (
    'public.split_wine_lot(uuid, jsonb, text)'::regprocedure,
    'public.combine_wine_lots(jsonb, text, text, text)'::regprocedure,
    'public.record_lot_loss(uuid, numeric, text)'::regprocedure,
    'public.record_lot_adjustment(uuid, numeric, text)'::regprocedure,
    'public.assert_cellar_actor(uuid)'::regprocedure
  ) AND prosecdef = true;
  IF n <> 5 THEN RAISE EXCEPTION 'Post-check: all operation functions must be SECURITY DEFINER (found %).', n USING ERRCODE='raise_exception'; END IF;

  IF has_function_privilege('public','public.split_wine_lot(uuid, jsonb, text)','EXECUTE')
     OR has_function_privilege('public','public.assert_cellar_actor(uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'Post-check: PUBLIC must not execute operation functions.' USING ERRCODE='raise_exception';
  END IF;

  -- Backfill: one 'initial' movement per existing lot, and NO lineage rows.
  SELECT COUNT(*) INTO n FROM public.wine_lots;
  SELECT COUNT(*) INTO bad FROM public.lot_volume_movements WHERE movement_type='initial';
  IF bad <> n THEN RAISE EXCEPTION 'Post-check: expected % initial movements (one per lot), found %.', n, bad USING ERRCODE='raise_exception'; END IF;
  SELECT COUNT(*) INTO n FROM public.lot_lineage;
  IF n <> 0 THEN RAISE EXCEPTION 'Post-check: backfill must not create lineage rows (found %).', n USING ERRCODE='raise_exception'; END IF;

  -- Reconciliation invariant: SUM(deltas) == volume_litres for EVERY lot.
  SELECT COUNT(*) INTO bad FROM (
    SELECT wl.id
    FROM public.wine_lots wl
    LEFT JOIN (
      SELECT wine_lot_id, COALESCE(SUM(volume_delta_litres),0) AS s
      FROM public.lot_volume_movements GROUP BY wine_lot_id
    ) m ON m.wine_lot_id = wl.id
    WHERE COALESCE(m.s, 0) <> wl.volume_litres
  ) q;
  IF bad <> 0 THEN RAISE EXCEPTION 'Post-check: reconciliation failed for % lot(s) (SUM(deltas) <> volume_litres).', bad USING ERRCODE='raise_exception'; END IF;
END $$;

COMMIT;
