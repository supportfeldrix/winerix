import { supabase } from './supabase';
import { getActiveOrgId } from './activeOrg';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Production Event Service (P2G-1)
// A production event is an IMMUTABLE, per-wine-lot record of a cellar operation
// ("what happened to this lot, when, optionally in which vessel/placement").
// Events are DESCRIPTIVE HISTORY ONLY — they never mutate wine_lots.volume_litres
// and never create/close/modify vessel_placements. Location remains owned by
// vessel_placements and volume by wine_lots.
//
// Append-only: the table grants only SELECT + INSERT; there is no update or
// delete path (and this service exposes none). Creates set org_id = active org
// and owner_id = the authenticated user; neither is taken from the UI.
// Schema: supabase/migrations/020_production_events.sql
// ─────────────────────────────────────────────────────────────────────────────

// Controlled event vocabulary (shared with the form UI). P2G-1: exactly these.
export const PRODUCTION_EVENT_TYPES = [
  { value: 'transfer', label: 'Transfer' },
  { value: 'racking', label: 'Racking' },
  { value: 'settling', label: 'Settling' },
  { value: 'fermentation', label: 'Fermentation' },
  { value: 'maturation', label: 'Maturation' },
  { value: 'filtration', label: 'Filtration' },
  { value: 'addition', label: 'Addition' },
  { value: 'adjustment', label: 'Adjustment' },
  { value: 'other', label: 'Other' },
];

// Human label for an event-type value.
export function productionEventTypeLabel(type) {
  const found = PRODUCTION_EVENT_TYPES.find((t) => t.value === type);
  return found ? found.label : type || '—';
}

/**
 * Translate a Supabase/PostgREST error into a friendly, non-technical message.
 * @param {object|null} error
 * @returns {string}
 */
export function friendlyProductionEventError(error) {
  if (!error) return 'Something went wrong. Please try again.';
  const code = error.code;
  const msg = (error.message || '').toLowerCase();
  const details = (error.details || '').toLowerCase();
  const hint = (error.hint || '').toLowerCase();
  if (code === '42P01' || code === 'PGRST205' || msg.includes('does not exist')) {
    return 'The production events database is not set up yet. Please run the latest migration.';
  }
  // Transient PostgREST relationship / schema-cache messages — not fatal.
  if (
    typeof code === 'string' && code.startsWith('PGRST2') &&
    (msg.includes('relationship') || details.includes('relationship') || hint.includes('relationship'))
  ) {
    return 'Production data is still loading. Please refresh in a moment.';
  }
  if (msg.includes('cross-organisation')) {
    return 'The selected wine lot, vessel or placement belongs to a different organisation.';
  }
  if (msg.includes('placement mismatch')) {
    return 'The selected placement does not belong to this wine lot.';
  }
  if (msg.includes('placement/vessel mismatch')) {
    return 'The selected placement is not in the selected vessel.';
  }
  if (msg.includes('invalid wine lot')) return 'The wine lot could not be found.';
  if (msg.includes('invalid vessel')) return 'The vessel could not be found.';
  if (msg.includes('invalid placement')) return 'The placement could not be found.';
  if (code === '23514' || msg.includes('check constraint')) {
    return 'Please choose a valid event type.';
  }
  if (code === '23503') {
    return 'The selected wine lot, vessel or placement could not be found.';
  }
  if (code === '23502') return 'Please fill in all required fields.';
  if (code === '42501' || msg.includes('row-level security') || msg.includes('permission')) {
    return 'You do not have permission to record production events. This requires an Owner, Admin or Cellar role.';
  }
  if (msg.includes('network') || msg.includes('fetch')) {
    return 'Network error. Please check your connection and try again.';
  }
  return 'Something went wrong. Please try again.';
}

// Normalise a raw production_events row (with joined vessel/placement/lot context).
function normalise(e) {
  if (!e) return null;
  const vessel = e.vessel || null;
  const placement = e.vessel_placement || null;
  const lot = e.wine_lot || null;
  return {
    id: e.id,
    wineLotId: e.wine_lot_id,
    vesselId: e.vessel_id,
    vesselPlacementId: e.vessel_placement_id,
    eventType: e.event_type,
    eventAt: e.event_at,
    notes: e.notes,
    ownerId: e.owner_id,
    createdAt: e.created_at,
    // Derived context (read-only).
    vesselCode: vessel ? vessel.vessel_code : null,
    vesselName: vessel ? vessel.name : null,
    placementPlacedAt: placement ? placement.placed_at : null,
    lotCode: lot ? lot.lot_code : null,
  };
}

const SELECT =
  'id, wine_lot_id, vessel_id, vessel_placement_id, event_type, event_at, notes, owner_id, created_at, ' +
  'vessel:vessels(id, vessel_code, name), ' +
  'vessel_placement:vessel_placements(id, placed_at), ' +
  'wine_lot:wine_lots(id, lot_code)';

/**
 * Fetch a wine lot's production events (newest first). Active-org scoped.
 * @param {string} wineLotId
 * @returns {Promise<{ data: Array|null, error: object|null }>}
 */
export async function getProductionEventsByLot(wineLotId) {
  const orgId = getActiveOrgId();
  if (!orgId || !wineLotId) return { data: [], error: null };
  const { data, error } = await supabase
    .from('production_events')
    .select(SELECT)
    .eq('org_id', orgId)
    .eq('wine_lot_id', wineLotId)
    .order('event_at', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) return { data: null, error };
  return { data: (data || []).map(normalise), error: null };
}

/**
 * Fetch the production events referencing a vessel (newest first). Active-org scoped.
 * @param {string} vesselId
 * @returns {Promise<{ data: Array|null, error: object|null }>}
 */
export async function getProductionEventsByVessel(vesselId) {
  const orgId = getActiveOrgId();
  if (!orgId || !vesselId) return { data: [], error: null };
  const { data, error } = await supabase
    .from('production_events')
    .select(SELECT)
    .eq('org_id', orgId)
    .eq('vessel_id', vesselId)
    .order('event_at', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) return { data: null, error };
  return { data: (data || []).map(normalise), error: null };
}

/**
 * Fetch a single production event by id (active-org scoped).
 * @param {string} id
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function getProductionEvent(id) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };
  const { data, error } = await supabase
    .from('production_events')
    .select(SELECT)
    .eq('id', id)
    .eq('org_id', orgId)
    .single();
  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

/**
 * Create a production event (append-only). Sets org_id = active org and
 * owner_id = the authenticated user (never from the payload). The DB
 * cross-org/relational trigger is the authoritative guard for the optional
 * vessel/placement references.
 * @param {{ wineLotId: string, eventType: string, eventAt: string,
 *   vesselId?: string|null, vesselPlacementId?: string|null, notes?: string|null }} input
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function createProductionEvent(input) {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) {
    return { data: null, error: userError || { message: 'Not authenticated' } };
  }
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };
  if (!input.wineLotId) return { data: null, error: { message: 'A wine lot is required.' } };
  if (!input.eventType) return { data: null, error: { message: 'An event type is required.' } };

  const row = {
    org_id: orgId,
    owner_id: userData.user.id,
    wine_lot_id: input.wineLotId,
    vessel_id: input.vesselId || null,
    vessel_placement_id: input.vesselPlacementId || null,
    event_type: input.eventType,
    event_at: input.eventAt || new Date().toISOString(),
    notes: input.notes || null,
  };

  const { data, error } = await supabase
    .from('production_events')
    .insert(row)
    .select(SELECT)
    .single();
  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}
