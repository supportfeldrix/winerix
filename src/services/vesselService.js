import { supabase } from './supabase';
import { getActiveOrgId } from './activeOrg';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Vessel Service (P2F)
// Vessels are durable cellar assets (tanks/barrels/other). A wine lot's current
// vessel is derived from its OPEN placement (removed_at IS NULL) in
// vessel_placements — there is no current_vessel_id on wine_lots and no mutable
// current_volume on vessels. The placement history is the source of truth.
//
// P2F supports FULL-LOT placement and FULL-LOT transfer only. Placement volume
// always comes from the wine lot's current volume; wine_lots.volume_litres is
// never modified here.
//
// Reads/writes are scoped to the active organisation (.eq('org_id', activeOrgId))
// on top of organisation-based RLS (is_org_member(org_id)) — RLS + the DB
// cross-org integrity trigger + the partial unique open-placement index remain
// authoritative. Creates set org_id = active org and owner_id = the
// authenticated user; neither is taken from the UI.
// Schema: supabase/migrations/019_vessels.sql
// ─────────────────────────────────────────────────────────────────────────────

export const VESSEL_TYPES = [
  { value: 'tank', label: 'Tank' },
  { value: 'barrel', label: 'Barrel' },
  { value: 'other', label: 'Other' },
];

export const VESSEL_STATUSES = [
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
  { value: 'maintenance', label: 'Maintenance' },
  { value: 'retired', label: 'Retired' },
];

/**
 * Translate a Supabase/PostgREST error into a friendly, non-technical message.
 * @param {object|null} error
 * @returns {string}
 */
export function friendlyVesselError(error) {
  if (!error) return 'Something went wrong. Please try again.';
  const code = error.code;
  const msg = (error.message || '').toLowerCase();
  const details = (error.details || '').toLowerCase();
  const hint = (error.hint || '').toLowerCase();
  if (code === '42P01' || code === 'PGRST205' || msg.includes('does not exist')) {
    return 'The vessels database is not set up yet. Please run the latest migration.';
  }
  // PostgREST relationship-resolution / schema-cache messages (PGRST200/201/204)
  // mention "foreign key relationship" in their message/details/hint. These are
  // transient (typically until the schema cache reloads after a migration) and
  // are NOT a genuine "record not found" — treat them as a refreshable, non-fatal
  // condition rather than the fatal FK-violation message below.
  if (
    typeof code === 'string' && code.startsWith('PGRST2') &&
    (msg.includes('relationship') || details.includes('relationship') || hint.includes('relationship'))
  ) {
    return 'Vessel data is still loading. Please refresh in a moment.';
  }
  if (code === '23505' || msg.includes('duplicate') || msg.includes('unique')) {
    if (msg.includes('one_open_per_lot')) {
      return 'This wine lot is already placed in a vessel. Transfer or remove it first.';
    }
    return 'A vessel with this code already exists in this organisation.';
  }
  if (msg.includes('cross-organisation')) {
    return 'The selected wine lot or vessel belongs to a different organisation.';
  }
  if (msg.includes('invalid wine lot')) return 'The wine lot could not be found.';
  if (msg.includes('invalid vessel')) return 'The vessel could not be found.';
  if (code === '23514' || msg.includes('check constraint')) {
    return 'Please provide valid vessel details and a non-negative volume.';
  }
  // Genuine foreign-key VIOLATION only (23503). The over-broad substring match
  // on "foreign key" was removed because it also caught PostgREST relationship
  // messages (handled above) and reported them as a false "not found".
  if (code === '23503') {
    return 'The wine lot or vessel could not be found.';
  }
  if (code === '23502') return 'Please fill in all required fields.';
  if (code === '42501' || msg.includes('row-level security') || msg.includes('permission')) {
    return 'You do not have permission to perform this action.';
  }
  if (msg.includes('network') || msg.includes('fetch')) {
    return 'Network error. Please check your connection and try again.';
  }
  return 'Something went wrong. Please try again.';
}

// ── Normalisers ────────────────────────────────────────────────────────────

function normaliseVessel(v) {
  if (!v) return null;
  return {
    id: v.id,
    vesselCode: v.vessel_code,
    name: v.name,
    vesselType: v.vessel_type,
    capacityLitres: v.capacity_litres,
    location: v.location,
    status: v.status,
    notes: v.notes,
    ownerId: v.owner_id,
    createdAt: v.created_at,
    updatedAt: v.updated_at,
  };
}

// Normalise a placement row (with optional joined lot + vessel context).
function normalisePlacement(p) {
  if (!p) return null;
  const lot = p.wine_lot || null;
  const vessel = p.vessel || null;
  return {
    id: p.id,
    wineLotId: p.wine_lot_id,
    vesselId: p.vessel_id,
    volumeLitres: p.volume_litres,
    placedAt: p.placed_at,
    removedAt: p.removed_at,
    isOpen: p.removed_at == null,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    // Derived context (read-only).
    lotCode: lot ? lot.lot_code : null,
    lotStatus: lot ? lot.status : null,
    lotVolumeLitres: lot ? lot.volume_litres : null,
    vesselCode: vessel ? vessel.vessel_code : null,
    vesselName: vessel ? vessel.name : null,
  };
}

const VESSEL_SELECT =
  'id, vessel_code, name, vessel_type, capacity_litres, location, status, notes, owner_id, created_at, updated_at';

const PLACEMENT_SELECT =
  'id, wine_lot_id, vessel_id, volume_litres, placed_at, removed_at, created_at, updated_at, ' +
  'wine_lot:wine_lots(id, lot_code, status, volume_litres), ' +
  'vessel:vessels(id, vessel_code, name)';

// ── Vessels CRUD ─────────────────────────────────────────────────────────────

/**
 * Fetch the active organisation's vessels, newest first.
 * @returns {Promise<{ data: Array|null, error: object|null }>}
 */
export async function getVessels() {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: [], error: null };
  const { data, error } = await supabase
    .from('vessels')
    .select(VESSEL_SELECT)
    .eq('org_id', orgId)
    .order('created_at', { ascending: false });
  if (error) return { data: null, error };
  return { data: (data || []).map(normaliseVessel), error: null };
}

/**
 * Fetch a single vessel by id (active-org scoped).
 * @param {string} id
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function getVessel(id) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };
  const { data, error } = await supabase
    .from('vessels')
    .select(VESSEL_SELECT)
    .eq('id', id)
    .eq('org_id', orgId)
    .single();
  if (error) return { data: null, error };
  return { data: normaliseVessel(data), error: null };
}

/**
 * Create a vessel in the active organisation. Sets org_id = active org and
 * owner_id = the authenticated user (never from the payload).
 * @param {{ vesselCode: string, name?: string|null, vesselType?: string,
 *   capacityLitres?: number|null, location?: string|null, status?: string,
 *   notes?: string|null }} input
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function createVessel(input) {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) {
    return { data: null, error: userError || { message: 'Not authenticated' } };
  }
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  const row = {
    org_id: orgId,
    owner_id: userData.user.id,
    vessel_code: input.vesselCode,
    name: input.name || null,
    vessel_type: input.vesselType || 'tank',
    capacity_litres: input.capacityLitres ?? null,
    location: input.location || null,
    status: input.status || 'active',
    notes: input.notes || null,
  };

  const { data, error } = await supabase
    .from('vessels')
    .insert(row)
    .select(VESSEL_SELECT)
    .single();
  if (error) return { data: null, error };
  return { data: normaliseVessel(data), error: null };
}

/**
 * Update a vessel (active-org scoped). org_id and owner_id are never changed
 * (owner_id immutability is also enforced by a DB trigger).
 * @param {string} id
 * @param {object} input
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function updateVessel(id, input) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  const row = {};
  if (input.vesselCode !== undefined) row.vessel_code = input.vesselCode;
  if (input.name !== undefined) row.name = input.name || null;
  if (input.vesselType !== undefined) row.vessel_type = input.vesselType;
  if (input.capacityLitres !== undefined) row.capacity_litres = input.capacityLitres ?? null;
  if (input.location !== undefined) row.location = input.location || null;
  if (input.status !== undefined) row.status = input.status;
  if (input.notes !== undefined) row.notes = input.notes || null;

  const { data, error } = await supabase
    .from('vessels')
    .update(row)
    .eq('id', id)
    .eq('org_id', orgId)
    .select(VESSEL_SELECT)
    .single();
  if (error) return { data: null, error };
  return { data: normaliseVessel(data), error: null };
}

/**
 * Delete a vessel (active-org scoped). The DB restricts deletion if any
 * placement references it (FK RESTRICT) — a friendly error is returned.
 * @param {string} id
 * @returns {Promise<{ error: object|null }>}
 */
export async function deleteVessel(id) {
  const orgId = getActiveOrgId();
  if (!orgId) return { error: { message: 'No active organisation' } };
  const { error } = await supabase
    .from('vessels')
    .delete()
    .eq('id', id)
    .eq('org_id', orgId);
  return { error };
}

// ── Placements: reads ──────────────────────────────────────────────────────

/**
 * Fetch all placements for a vessel (open + closed), newest placement first.
 * @param {string} vesselId
 * @returns {Promise<{ data: Array|null, error: object|null }>}
 */
export async function getVesselPlacements(vesselId) {
  const orgId = getActiveOrgId();
  if (!orgId || !vesselId) return { data: [], error: null };
  const { data, error } = await supabase
    .from('vessel_placements')
    .select(PLACEMENT_SELECT)
    .eq('org_id', orgId)
    .eq('vessel_id', vesselId)
    .order('placed_at', { ascending: false });
  if (error) return { data: null, error };
  return { data: (data || []).map(normalisePlacement), error: null };
}

/**
 * Fetch all placements for a wine lot (open + closed), newest first.
 * @param {string} wineLotId
 * @returns {Promise<{ data: Array|null, error: object|null }>}
 */
export async function getWineLotPlacements(wineLotId) {
  const orgId = getActiveOrgId();
  if (!orgId || !wineLotId) return { data: [], error: null };
  const { data, error } = await supabase
    .from('vessel_placements')
    .select(PLACEMENT_SELECT)
    .eq('org_id', orgId)
    .eq('wine_lot_id', wineLotId)
    .order('placed_at', { ascending: false });
  if (error) return { data: null, error };
  return { data: (data || []).map(normalisePlacement), error: null };
}

/**
 * Fetch the current (open) placement for a wine lot, or null if none.
 * @param {string} wineLotId
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function getCurrentWineLotPlacement(wineLotId) {
  const orgId = getActiveOrgId();
  if (!orgId || !wineLotId) return { data: null, error: null };
  const { data, error } = await supabase
    .from('vessel_placements')
    .select(PLACEMENT_SELECT)
    .eq('org_id', orgId)
    .eq('wine_lot_id', wineLotId)
    .is('removed_at', null)
    .maybeSingle();
  if (error) return { data: null, error };
  return { data: normalisePlacement(data), error: null };
}

/**
 * Convenience: the current vessel (normalised) for a wine lot, or null.
 * @param {string} wineLotId
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function getCurrentVesselForWineLot(wineLotId) {
  const { data: placement, error } = await getCurrentWineLotPlacement(wineLotId);
  if (error) return { data: null, error };
  if (!placement) return { data: null, error: null };
  return getVessel(placement.vesselId);
}

// ── Placements: operations ──────────────────────────────────────────────────

// Internal: resolve the active user id (for owner_id on inserts).
async function currentUserId() {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data?.user) return { userId: null, error: error || { message: 'Not authenticated' } };
  return { userId: data.user.id, error: null };
}

// Internal: fetch a lot's current volume (active-org scoped) for placement volume.
async function lotCurrentVolume(orgId, wineLotId) {
  const { data, error } = await supabase
    .from('wine_lots')
    .select('id, volume_litres')
    .eq('id', wineLotId)
    .eq('org_id', orgId)
    .single();
  if (error) return { volume: null, error };
  return { volume: data.volume_litres, error: null };
}

/**
 * Place a wine lot into a vessel (one open placement). Fails if the lot already
 * has an open placement. Volume comes from the lot's current volume — the UI
 * cannot override it, and wine_lots.volume_litres is not modified.
 * @param {string} wineLotId
 * @param {string} vesselId
 * @param {number} [volumeLitres] - ignored if provided; kept for signature parity
 * @param {string} [placedAt] - ISO timestamp; defaults to now
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function placeWineLot(wineLotId, vesselId, volumeLitres, placedAt) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };
  if (!wineLotId) return { data: null, error: { message: 'A wine lot is required.' } };
  if (!vesselId) return { data: null, error: { message: 'A vessel is required.' } };

  const { userId, error: userError } = await currentUserId();
  if (userError) return { data: null, error: userError };

  // Guard: no existing open placement (the DB partial unique index is the
  // authoritative guard; this gives a friendly early error).
  const { data: existing, error: existingError } = await getCurrentWineLotPlacement(wineLotId);
  if (existingError) return { data: null, error: existingError };
  if (existing) {
    return { data: null, error: { message: 'This wine lot is already placed in a vessel.' } };
  }

  // Volume always comes from the lot's current volume.
  const { volume, error: volError } = await lotCurrentVolume(orgId, wineLotId);
  if (volError) return { data: null, error: volError };

  const row = {
    org_id: orgId,
    owner_id: userId,
    wine_lot_id: wineLotId,
    vessel_id: vesselId,
    volume_litres: volume ?? 0,
    placed_at: placedAt || new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('vessel_placements')
    .insert(row)
    .select(PLACEMENT_SELECT)
    .single();
  if (error) return { data: null, error };
  return { data: normalisePlacement(data), error: null };
}

/**
 * Full-lot transfer: close the lot's current open placement and open a new one
 * in the destination vessel with the same volume. Treated as one logical
 * operation — if opening the new placement fails, the old one is re-opened so
 * the lot is never left with no open placement. wine_lots.volume_litres is not
 * modified.
 * @param {string} wineLotId
 * @param {string} newVesselId
 * @param {string} [transferredAt] - ISO timestamp; defaults to now
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function transferWineLot(wineLotId, newVesselId, transferredAt) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };
  if (!newVesselId) return { data: null, error: { message: 'A destination vessel is required.' } };

  const { userId, error: userError } = await currentUserId();
  if (userError) return { data: null, error: userError };

  const { data: current, error: currentError } = await getCurrentWineLotPlacement(wineLotId);
  if (currentError) return { data: null, error: currentError };
  if (!current) {
    return { data: null, error: { message: 'This wine lot is not currently in a vessel.' } };
  }
  if (current.vesselId === newVesselId) {
    return { data: null, error: { message: 'The lot is already in that vessel. Choose a different vessel.' } };
  }

  const when = transferredAt || new Date().toISOString();

  // 1. Close the current open placement.
  const { error: closeError } = await supabase
    .from('vessel_placements')
    .update({ removed_at: when })
    .eq('id', current.id)
    .eq('org_id', orgId);
  if (closeError) return { data: null, error: closeError };

  // 2. Open a new placement in the destination with the same volume.
  const row = {
    org_id: orgId,
    owner_id: userId,
    wine_lot_id: wineLotId,
    vessel_id: newVesselId,
    volume_litres: current.volumeLitres ?? 0,
    placed_at: when,
  };
  const { data, error } = await supabase
    .from('vessel_placements')
    .insert(row)
    .select(PLACEMENT_SELECT)
    .single();

  if (error) {
    // Compensate: re-open the placement we just closed so the lot is not left
    // without an open placement.
    await supabase
      .from('vessel_placements')
      .update({ removed_at: null })
      .eq('id', current.id)
      .eq('org_id', orgId);
    return { data: null, error };
  }

  return { data: normalisePlacement(data), error: null };
}

/**
 * Remove a wine lot from its current vessel by closing the open placement.
 * History is preserved (the row is not deleted). wine_lots.volume_litres is
 * not modified.
 * @param {string} wineLotId
 * @param {string} [removedAt] - ISO timestamp; defaults to now
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function removeWineLotFromVessel(wineLotId, removedAt) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  const { data: current, error: currentError } = await getCurrentWineLotPlacement(wineLotId);
  if (currentError) return { data: null, error: currentError };
  if (!current) {
    return { data: null, error: { message: 'This wine lot is not currently in a vessel.' } };
  }

  const { data, error } = await supabase
    .from('vessel_placements')
    .update({ removed_at: removedAt || new Date().toISOString() })
    .eq('id', current.id)
    .eq('org_id', orgId)
    .select(PLACEMENT_SELECT)
    .single();
  if (error) return { data: null, error };
  return { data: normalisePlacement(data), error: null };
}

// ── Selection / capacity helpers ─────────────────────────────────────────────

/**
 * Fetch selectable vessels (active only) as options for placement/transfer.
 * @returns {Promise<{ data: Array<{ id, vesselCode, name, vesselType, capacityLitres }>|null, error: object|null }>}
 */
export async function getAvailableVesselOptions() {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: [], error: null };
  const { data, error } = await supabase
    .from('vessels')
    .select('id, vessel_code, name, vessel_type, capacity_litres')
    .eq('org_id', orgId)
    .eq('status', 'active')
    .order('vessel_code', { ascending: true });
  if (error) return { data: null, error };
  return {
    data: (data || []).map((v) => ({
      id: v.id,
      vesselCode: v.vessel_code,
      name: v.name,
      vesselType: v.vessel_type,
      capacityLitres: v.capacity_litres,
    })),
    error: null,
  };
}

/**
 * Current occupied volume of a vessel = sum of its OPEN placements' volumes.
 * Active-org scoped.
 * @param {string} vesselId
 * @returns {Promise<{ data: number|null, error: object|null }>}
 */
export async function getVesselCurrentVolume(vesselId) {
  const orgId = getActiveOrgId();
  if (!orgId || !vesselId) return { data: 0, error: null };
  const { data, error } = await supabase
    .from('vessel_placements')
    .select('volume_litres')
    .eq('org_id', orgId)
    .eq('vessel_id', vesselId)
    .is('removed_at', null);
  if (error) return { data: null, error };
  const total = (data || []).reduce((s, p) => s + (Number(p.volume_litres) || 0), 0);
  return { data: total, error: null };
}

/**
 * Current occupied volume for every vessel in the active organisation, as a
 * map of vesselId -> litres (open placements only). Used by the vessel list to
 * show current volume without an N+1 query.
 * @returns {Promise<{ data: Record<string, number>|null, error: object|null }>}
 */
export async function getOpenVolumesByVessel() {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: {}, error: null };
  const { data, error } = await supabase
    .from('vessel_placements')
    .select('vessel_id, volume_litres')
    .eq('org_id', orgId)
    .is('removed_at', null);
  if (error) return { data: null, error };
  const map = {};
  (data || []).forEach((p) => {
    map[p.vessel_id] = (map[p.vessel_id] || 0) + (Number(p.volume_litres) || 0);
  });
  return { data: map, error: null };
}
