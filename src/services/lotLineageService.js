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

  const parentsQ = supabase
    .from('lot_lineage')
    .select('id, parent_lot_id, child_lot_id, relation_type, volume_litres, created_at, parent:wine_lots!lot_lineage_parent_lot_id_fkey(id, lot_code)')
    .eq('org_id', orgId)
    .eq('child_lot_id', wineLotId)
    .order('created_at', { ascending: true });

  const childrenQ = supabase
    .from('lot_lineage')
    .select('id, parent_lot_id, child_lot_id, relation_type, volume_litres, created_at, child:wine_lots!lot_lineage_child_lot_id_fkey(id, lot_code)')
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
