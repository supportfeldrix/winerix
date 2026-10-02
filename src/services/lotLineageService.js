import { supabase } from './supabase';
import { getActiveOrgId } from './activeOrg';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Wine Lot Lineage & Volume Service (P2H-1)
// Reads the lineage graph (lot_lineage) and the append-only volume ledger
// (lot_volume_movements), and invokes the authoritative SECURITY DEFINER
// database functions for volume-changing operations (split / merge / blend /
// loss / adjustment). Those DB functions are the ONLY writers of
// wine_lots.volume_litres — the client never mutates volume directly, and never
// performs multi-step client-side "transactions".
//
// Invariant maintained server-side: SUM(lot_volume_movements deltas for a lot)
// == wine_lots.volume_litres. Location (vessel_placements) and business history
// (production_events) are unchanged by these operations.
// Schema: supabase/migrations/022_lot_lineage_and_volume.sql
// ─────────────────────────────────────────────────────────────────────────────

// Movement-type → human label (shared with the volume-history UI).
const MOVEMENT_LABELS = {
  initial: 'Initial balance',
  split_out: 'Split out',
  split_in: 'Split in',
  merge_out: 'Merge out',
  merge_in: 'Merge in',
  blend_out: 'Blend out',
  blend_in: 'Blend in',
  loss: 'Loss',
  adjustment: 'Adjustment',
};

export function movementTypeLabel(type) {
  return MOVEMENT_LABELS[type] || type || '—';
}

/**
 * Translate a Supabase/PostgREST/RPC error into a friendly message.
 * @param {object|null} error
 * @returns {string}
 */
export function friendlyLineageError(error) {
  if (!error) return 'Something went wrong. Please try again.';
  const code = error.code;
  const msg = (error.message || '').toLowerCase();
  const details = (error.details || '').toLowerCase();
  const hint = (error.hint || '').toLowerCase();
  if (code === '42P01' || code === 'PGRST205' || msg.includes('does not exist')) {
    return 'The lineage/volume database is not set up yet. Please run the latest migration.';
  }
  if (
    typeof code === 'string' && code.startsWith('PGRST2') &&
    (msg.includes('relationship') || details.includes('relationship') || hint.includes('relationship'))
  ) {
    return 'Lineage data is still loading. Please refresh in a moment.';
  }
  if (msg.includes('exceeds parent current volume') || msg.includes('exceeds current volume') || msg.includes('insufficient volume')) {
    return 'The requested volume exceeds the available volume in the lot.';
  }
  if (msg.includes('below zero')) {
    return 'That adjustment would take the lot volume below zero.';
  }
  if (msg.includes('at least two source lots')) {
    return 'A merge or blend needs at least two source lots.';
  }
  if (msg.includes('at least one child')) {
    return 'A split needs at least one child lot.';
  }
  if (msg.includes('same organisation') || msg.includes('cross-organisation')) {
    return 'All lots involved must belong to the same organisation.';
  }
  if (msg.includes('lot code') || code === '23505' || msg.includes('duplicate') || msg.includes('unique')) {
    return 'A lot with that code already exists in this organisation.';
  }
  if (msg.includes('owner, admin or cellar') || code === '42501' || msg.includes('row-level security') || msg.includes('permission') || msg.includes('not a member')) {
    return 'You do not have permission for this operation. It requires an Owner, Admin or Cellar role.';
  }
  if (msg.includes('not authenticated')) {
    return 'You are not signed in. Please sign in and try again.';
  }
  if (msg.includes('network') || msg.includes('fetch')) {
    return 'Network error. Please check your connection and try again.';
  }
  return 'Something went wrong. Please try again.';
}

// ── Reads ─────────────────────────────────────────────────────────────────────

/**
 * Fetch the lineage of a lot: edges where it is the child (parents) and edges
 * where it is the parent (children), with the related lot's code. Active-org scoped.
 * @param {string} wineLotId
 * @returns {Promise<{ data: { parents: Array, children: Array }|null, error: object|null }>}
 */
export async function getLotLineage(wineLotId) {
  const orgId = getActiveOrgId();
  if (!orgId || !wineLotId) return { data: { parents: [], children: [] }, error: null };

  // NOTE: lot_lineage has TWO FKs to wine_lots (parent_lot_id, child_lot_id),
  // so PostgREST embeds MUST be disambiguated by the actual FK constraint names
  // defined in migration 022 — fk_ll_parent / fk_ll_child — NOT the default
  // PostgREST '<table>_<column>_fkey' convention (which does not exist here and
  // caused a PGRST200 "could not find relationship" -> the false "still loading"
  // banner even though the rows exist).
  const parentsQ = supabase
    .from('lot_lineage')
    .select('id, parent_lot_id, child_lot_id, relation_type, volume_litres, created_at, parent:wine_lots!fk_ll_parent(id, lot_code)')
    .eq('org_id', orgId)
    .eq('child_lot_id', wineLotId)
    .order('created_at', { ascending: true });

  const childrenQ = supabase
    .from('lot_lineage')
    .select('id, parent_lot_id, child_lot_id, relation_type, volume_litres, created_at, child:wine_lots!fk_ll_child(id, lot_code)')
    .eq('org_id', orgId)
    .eq('parent_lot_id', wineLotId)
    .order('created_at', { ascending: true });

  const [{ data: parents, error: pErr }, { data: children, error: cErr }] = await Promise.all([parentsQ, childrenQ]);
  if (pErr) return { data: null, error: pErr };
  if (cErr) return { data: null, error: cErr };

  return {
    data: {
      parents: (parents || []).map((e) => ({
        id: e.id,
        relationType: e.relation_type,
        volumeLitres: e.volume_litres,
        lotId: e.parent_lot_id,
        lotCode: e.parent ? e.parent.lot_code : null,
      })),
      children: (children || []).map((e) => ({
        id: e.id,
        relationType: e.relation_type,
        volumeLitres: e.volume_litres,
        lotId: e.child_lot_id,
        lotCode: e.child ? e.child.lot_code : null,
      })),
    },
    error: null,
  };
}

/**
 * Fetch a lot's volume ledger (append-only), newest first, with a running
 * balance computed oldest→newest. Active-org scoped.
 * @param {string} wineLotId
 * @returns {Promise<{ data: Array|null, error: object|null }>}
 */
export async function getLotVolumeHistory(wineLotId) {
  const orgId = getActiveOrgId();
  if (!orgId || !wineLotId) return { data: [], error: null };

  const { data, error } = await supabase
    .from('lot_volume_movements')
    .select('id, movement_type, volume_delta_litres, notes, occurred_at, created_at')
    .eq('org_id', orgId)
    .eq('wine_lot_id', wineLotId)
    .order('occurred_at', { ascending: true })
    .order('created_at', { ascending: true });

  if (error) return { data: null, error };

  // Compute running balance oldest→newest, then present newest first.
  let running = 0;
  const ordered = (data || []).map((m) => {
    running += Number(m.volume_delta_litres) || 0;
    return {
      id: m.id,
      movementType: m.movement_type,
      volumeDeltaLitres: m.volume_delta_litres,
      runningBalance: running,
      notes: m.notes,
      occurredAt: m.occurred_at,
    };
  });
  ordered.reverse();
  return { data: ordered, error: null };
}

/**
 * Summary of a lot's volume ledger: total in, total out, net, and movement count.
 * @param {string} wineLotId
 * @returns {Promise<{ data: { totalIn, totalOut, net, count }|null, error: object|null }>}
 */
export async function getLotVolumeSummary(wineLotId) {
  const { data, error } = await getLotVolumeHistory(wineLotId);
  if (error) return { data: null, error };
  let totalIn = 0;
  let totalOut = 0;
  (data || []).forEach((m) => {
    const d = Number(m.volumeDeltaLitres) || 0;
    if (d >= 0) totalIn += d; else totalOut += -d;
  });
  return { data: { totalIn, totalOut, net: totalIn - totalOut, count: (data || []).length }, error: null };
}

// ── Operations (authoritative DB functions via RPC) ──────────────────────────

/**
 * Split a parent lot into one or more child lots.
 * @param {string} parentLotId
 * @param {Array<{ lotCode: string, volumeLitres: number, notes?: string }>} children
 * @param {string} [notes]
 * @returns {Promise<{ data: Array|null, error: object|null }>}
 */
export async function splitLot(parentLotId, children, notes = null) {
  const payload = (children || []).map((c) => ({
    lot_code: c.lotCode,
    volume_litres: c.volumeLitres,
    notes: c.notes || null,
  }));
  const { data, error } = await supabase.rpc('split_wine_lot', {
    p_parent_lot_id: parentLotId,
    p_children: payload,
    p_notes: notes,
  });
  if (error) return { data: null, error };
  return { data: data || [], error: null };
}

/**
 * Merge two or more source lots into a new lot.
 * @param {Array<{ lotId: string, volumeLitres: number }>} sources
 * @param {string} newLotCode
 * @param {string} [notes]
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function mergeLots(sources, newLotCode, notes = null) {
  return combine(sources, newLotCode, 'merge', notes);
}

/**
 * Blend two or more source lots into a new lot.
 * @param {Array<{ lotId: string, volumeLitres: number }>} sources
 * @param {string} newLotCode
 * @param {string} [notes]
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function blendLots(sources, newLotCode, notes = null) {
  return combine(sources, newLotCode, 'blend', notes);
}

async function combine(sources, newLotCode, relationType, notes) {
  const payload = (sources || []).map((s) => ({
    lot_id: s.lotId,
    volume_litres: s.volumeLitres,
  }));
  const { data, error } = await supabase.rpc('combine_wine_lots', {
    p_sources: payload,
    p_new_lot_code: newLotCode,
    p_relation_type: relationType,
    p_notes: notes,
  });
  if (error) return { data: null, error };
  return { data, error: null };
}

/**
 * Record a measurable loss on a lot.
 * @param {string} lotId
 * @param {number} volume - positive litres lost
 * @param {string} [notes]
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function recordLoss(lotId, volume, notes = null) {
  const { data, error } = await supabase.rpc('record_lot_loss', {
    p_lot_id: lotId,
    p_volume: volume,
    p_notes: notes,
  });
  if (error) return { data: null, error };
  return { data, error: null };
}

/**
 * Record a signed volume adjustment on a lot.
 * @param {string} lotId
 * @param {number} delta - signed litres
 * @param {string} [notes]
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function recordAdjustment(lotId, delta, notes = null) {
  const { data, error } = await supabase.rpc('record_lot_adjustment', {
    p_lot_id: lotId,
    p_delta: delta,
    p_notes: notes,
  });
  if (error) return { data: null, error };
  return { data, error: null };
}

/**
 * Start fermentation on a lot in the given vessel (P2I cellar operation).
 * Invokes the SECURITY DEFINER RPC public.start_fermentation using the
 * authenticated browser session — the server derives org/actor from auth.uid()
 * and enforces the cellar role; nothing security-related is set client-side.
 * The RPC atomically: creates a 'fermentation' production event, places the lot
 * in the vessel, and sets wine_lots.processing_state = 'fermenting'.
 * @param {string} lotId
 * @param {string} vesselId
 * @param {string} [notes]
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function startFermentation(lotId, vesselId, notes = null) {
  const { data, error } = await supabase.rpc('start_fermentation', {
    p_lot_id: lotId,
    p_vessel_id: vesselId,
    p_notes: notes,
  });
  if (error) return { data: null, error };
  return { data, error: null };
}

/**
 * End fermentation on a lot (P2I cellar operation). Invokes the SECURITY
 * DEFINER RPC public.end_fermentation using the authenticated browser session —
 * the server derives org/actor from auth.uid(), enforces the cellar role,
 * requires the lot to be currently fermenting, and atomically: creates a
 * 'fermentation_end' production event, transitions processing_state
 * fermenting -> settling, and (if lossLitres > 0) records a measured loss via
 * the P2H ledger. The vessel placement is NOT changed. Nothing security- or
 * volume-related is computed client-side.
 * @param {string} lotId
 * @param {number|null} [lossLitres] - optional measured loss in litres (>= 0)
 * @param {string} [notes]
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function endFermentation(lotId, lossLitres = null, notes = null) {
  const { data, error } = await supabase.rpc('end_fermentation', {
    p_lot_id: lotId,
    p_loss_litres: lossLitres,
    p_notes: notes,
  });
  if (error) return { data: null, error };
  return { data, error: null };
}

/**
 * Rack a lot into another vessel (P2I cellar operation). Invokes the SECURITY
 * DEFINER RPC public.record_rack using the authenticated browser session — the
 * server derives org/actor from auth.uid(), enforces the cellar role, and
 * atomically: creates a 'racking' production event, closes the lot's current
 * open placement and opens one in the target vessel (correlating the event's
 * vessel_placement_id), and (if lossLitres > 0) records a measured loss via the
 * P2H ledger. processing_state and lineage are NOT changed. Nothing security- or
 * volume-related is computed client-side.
 * @param {string} lotId
 * @param {string} toVesselId - target vessel (must differ from the current one)
 * @param {number|null} [lossLitres] - optional measured loss in litres (>= 0)
 * @param {string} [notes]
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function rackLot(lotId, toVesselId, lossLitres = null, notes = null) {
  const { data, error } = await supabase.rpc('record_rack', {
    p_lot_id: lotId,
    p_to_vessel_id: toVesselId,
    p_loss_litres: lossLitres,
    p_notes: notes,
  });
  if (error) return { data: null, error };
  return { data, error: null };
}

/**
 * Filter a lot (P2I cellar operation). Invokes the SECURITY DEFINER RPC
 * public.record_filtration using the authenticated browser session — the server
 * derives org/actor from auth.uid(), enforces the cellar role, and atomically:
 * creates a 'filtration' production event, OPTIONALLY moves the lot to a target
 * vessel (correlating the event's vessel_placement_id when a vessel is given),
 * and (if lossLitres > 0) records a measured loss via the P2H ledger. When no
 * vessel is supplied the lot stays in place (filter in place). processing_state
 * and lineage are NOT changed. Nothing security- or volume-related is computed
 * client-side.
 * @param {string} lotId
 * @param {string|null} [toVesselId] - optional target vessel; null = filter in place
 * @param {number|null} [lossLitres] - optional measured loss in litres (>= 0)
 * @param {string} [notes]
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function filterLot(lotId, toVesselId = null, lossLitres = null, notes = null) {
  const { data, error } = await supabase.rpc('record_filtration', {
    p_lot_id: lotId,
    p_to_vessel_id: toVesselId,
    p_loss_litres: lossLitres,
    p_notes: notes,
  });
  if (error) return { data: null, error };
  return { data, error: null };
}

/**
 * Record an addition on a lot (P2I cellar operation). Invokes the SECURITY
 * DEFINER RPC public.record_addition using the authenticated browser session —
 * the server derives org/actor from auth.uid(), enforces the cellar role, and
 * atomically: creates an 'addition' production event and (when a non-zero
 * volume delta is given) applies the volume change through the P2H ledger,
 * correlated to the event. Addition does NOT move vessels, change lineage, or
 * change processing_state. It is a documented cellar operation distinct from a
 * corrective Adjustment (different production_events.event_type). Nothing
 * security- or volume-related is computed client-side.
 * @param {string} lotId
 * @param {number} volumeDeltaLitres - positive litres added (UI requires > 0)
 * @param {string} [notes]
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function addToLot(lotId, volumeDeltaLitres, notes = null) {
  const { data, error } = await supabase.rpc('record_addition', {
    p_lot_id: lotId,
    p_volume_delta_litres: volumeDeltaLitres,
    p_notes: notes,
  });
  if (error) return { data: null, error };
  return { data, error: null };
}
