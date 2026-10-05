import { supabase } from './supabase';
import { getActiveOrgId } from './activeOrg';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Stock Location Service (P2K-3)
// A stock location is an org-scoped physical place where FINISHED-GOODS inventory
// is held (finished goods store, warehouse, export store, dispatch area, ...).
// NOT a cellar vessel — no link to vessels/wine_lots/batches/vineyards/blocks.
// Locations are added on demand (no seed) and RETIRED via is_active = false —
// there is NO delete path (history must be preserved; later stock movements will
// reference locations). location_code is unique per org CASE-INSENSITIVELY.
//
// Reads/writes are scoped to the active organisation (.eq('org_id', activeOrgId))
// on top of organisation-based RLS (is_org_member + OWNER/ADMIN writes) — RLS
// remains authoritative. Creates set org_id = active org and owner_id = the
// authenticated user; neither is taken from the UI. This service holds NO stock,
// bottles, litres, or quantity — a location only describes WHERE goods are held.
// Schema: supabase/migrations/039_stock_locations.sql
// ─────────────────────────────────────────────────────────────────────────────

// Controlled location-type vocabulary with human-friendly labels. The value set
// matches the DB CHECK exactly (039). Exported for the form/table selectors.
export const STOCK_LOCATION_TYPES = Object.freeze([
  { value: 'cellar_store', label: 'Cellar Store' },
  { value: 'finished_goods_store', label: 'Finished Goods Store' },
  { value: 'warehouse', label: 'Warehouse' },
  { value: 'export_store', label: 'Export Store' },
  { value: 'dispatch_area', label: 'Dispatch Area' },
  { value: 'other', label: 'Other' },
]);

export function stockLocationTypeLabel(type) {
  const found = STOCK_LOCATION_TYPES.find((t) => t.value === type);
  return found ? found.label : (type || '—');
}

/**
 * Translate a Supabase/PostgREST error into a friendly, non-technical message.
 * @param {object|null} error
 * @returns {string}
 */
export function friendlyStockLocationError(error) {
  if (!error) return 'Something went wrong. Please try again.';
  const code = error.code;
  const msg = (error.message || '').toLowerCase();
  if (code === '42P01' || code === 'PGRST205' || msg.includes('does not exist')) {
    return 'The stock locations database is not set up yet. Please run the latest migration.';
  }
  if (code === '23505' || msg.includes('duplicate') || msg.includes('unique')) {
    return 'A location with this code already exists in this organisation.';
  }
  if (code === '23514' || msg.includes('check constraint')) {
    if (msg.includes('location_type')) return 'Please choose a valid location type.';
    return 'Please provide a location code and name.';
  }
  if (code === '23502') return 'Please fill in all required fields.';
  if (code === '42501' || msg.includes('row-level security') || msg.includes('permission')) {
    return 'You do not have permission to manage stock locations. This requires an Owner or Admin role.';
  }
  if (msg.includes('network') || msg.includes('fetch')) {
    return 'Network error. Please check your connection and try again.';
  }
  return 'Something went wrong. Please try again.';
}

// Normalise a raw stock_locations row into camelCase.
function normalise(l) {
  if (!l) return null;
  return {
    id: l.id,
    locationCode: l.location_code,
    name: l.name,
    locationType: l.location_type,
    isActive: l.is_active,
    notes: l.notes,
    ownerId: l.owner_id,
    createdAt: l.created_at,
    updatedAt: l.updated_at,
  };
}

const SELECT =
  'id, location_code, name, location_type, is_active, notes, owner_id, created_at, updated_at';

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * Fetch the active organisation's stock locations. Active locations only by
 * default; pass { includeInactive: true } to include retired ones. Optional
 * client-side search (location_code / name) and locationType filter. Ordered by
 * name then code.
 * @param {{ includeInactive?: boolean, search?: string, locationType?: string }} [options]
 * @returns {Promise<{ data: Array|null, error: object|null }>}
 */
export async function getStockLocations(options = {}) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: [], error: null };

  let query = supabase
    .from('stock_locations')
    .select(SELECT)
    .eq('org_id', orgId);

  if (!options.includeInactive) query = query.eq('is_active', true);
  if (options.locationType) query = query.eq('location_type', options.locationType);

  const { data, error } = await query
    .order('name', { ascending: true })
    .order('location_code', { ascending: true });

  if (error) return { data: null, error };

  let rows = (data || []).map(normalise);
  const q = (options.search || '').trim().toLowerCase();
  if (q) {
    rows = rows.filter((l) =>
      (l.locationCode || '').toLowerCase().includes(q) ||
      (l.name || '').toLowerCase().includes(q)
    );
  }
  return { data: rows, error: null };
}

/**
 * Fetch a single stock location by id (active-org scoped).
 * @param {string} id
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function getStockLocation(id) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  const { data, error } = await supabase
    .from('stock_locations')
    .select(SELECT)
    .eq('id', id)
    .eq('org_id', orgId)
    .single();

  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

/**
 * Lightweight location options for future stock receipt/transfer selectors
 * (active-org scoped). Active locations only by default. When editing a record
 * whose location has since been retired, pass { includeId } to fold that one
 * inactive location in so it still renders.
 * @param {{ includeInactive?: boolean, includeId?: string|null }} [options]
 * @returns {Promise<{ data: Array<{ id, locationCode, name, locationType, isActive }>|null, error: object|null }>}
 */
export async function getStockLocationOptions(options = {}) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: [], error: null };

  let query = supabase
    .from('stock_locations')
    .select('id, location_code, name, location_type, is_active')
    .eq('org_id', orgId);

  if (!options.includeInactive) query = query.eq('is_active', true);

  const { data, error } = await query
    .order('name', { ascending: true })
    .order('location_code', { ascending: true });

  if (error) return { data: null, error };

  const toOption = (l) => ({
    id: l.id,
    locationCode: l.location_code,
    name: l.name,
    locationType: l.location_type,
    isActive: l.is_active,
  });

  const list = (data || []).map(toOption);

  if (options.includeId && !list.some((o) => o.id === options.includeId)) {
    const { data: extra, error: extraError } = await supabase
      .from('stock_locations')
      .select('id, location_code, name, location_type, is_active')
      .eq('id', options.includeId)
      .eq('org_id', orgId)
      .single();
    if (!extraError && extra) list.push(toOption(extra));
  }

  return { data: list, error: null };
}

// ── Writes ───────────────────────────────────────────────────────────────────

const VALID_TYPES = new Set(STOCK_LOCATION_TYPES.map((t) => t.value));

/**
 * Create a stock location in the active organisation. Sets org_id = active org
 * and owner_id = the authenticated user (never from the payload). is_active
 * defaults to true. Code uniqueness (case-insensitive, per org) is DB-enforced.
 * @param {{ locationCode: string, name: string, locationType: string,
 *   notes?: string|null }} input
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function createStockLocation(input) {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) {
    return { data: null, error: userError || { message: 'Not authenticated' } };
  }
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  const locationCode = (input.locationCode || '').trim();
  const name = (input.name || '').trim();
  const locationType = (input.locationType || '').trim();

  if (!locationCode) return { data: null, error: { message: 'A location code is required.' } };
  if (!name) return { data: null, error: { message: 'A name is required.' } };
  if (!VALID_TYPES.has(locationType)) return { data: null, error: { message: 'Please choose a valid location type.' } };

  const row = {
    org_id: orgId,
    owner_id: userData.user.id,
    location_code: locationCode,
    name,
    location_type: locationType,
    notes: input.notes ? input.notes.trim() : null,
    // is_active intentionally omitted — DB default is TRUE.
  };

  const { data, error } = await supabase
    .from('stock_locations')
    .insert(row)
    .select(SELECT)
    .single();

  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

/**
 * Update a stock location's editable fields (active-org scoped). id, org_id and
 * owner_id are NEVER changed here (owner_id immutability is also DB-enforced).
 * is_active is NOT changed here — use deactivate/reactivate.
 * @param {string} id
 * @param {{ locationCode?: string, name?: string, locationType?: string,
 *   notes?: string|null }} input
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function updateStockLocation(id, input) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  const row = {};
  if (input.locationCode !== undefined) {
    const locationCode = (input.locationCode || '').trim();
    if (!locationCode) return { data: null, error: { message: 'A location code is required.' } };
    row.location_code = locationCode;
  }
  if (input.name !== undefined) {
    const name = (input.name || '').trim();
    if (!name) return { data: null, error: { message: 'A name is required.' } };
    row.name = name;
  }
  if (input.locationType !== undefined) {
    const locationType = (input.locationType || '').trim();
    if (!VALID_TYPES.has(locationType)) return { data: null, error: { message: 'Please choose a valid location type.' } };
    row.location_type = locationType;
  }
  if (input.notes !== undefined) row.notes = input.notes ? input.notes.trim() : null;
  // is_active / org_id / owner_id intentionally NOT writable here.

  const { data, error } = await supabase
    .from('stock_locations')
    .update(row)
    .eq('id', id)
    .eq('org_id', orgId)
    .select(SELECT)
    .single();

  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

/**
 * Retire a stock location (soft-delete). Sets is_active = false; never deletes.
 * Active-org scoped.
 * @param {string} id
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function deactivateStockLocation(id) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  const { data, error } = await supabase
    .from('stock_locations')
    .update({ is_active: false })
    .eq('id', id)
    .eq('org_id', orgId)
    .select(SELECT)
    .single();

  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

/**
 * Re-activate a previously retired stock location. Sets is_active = true.
 * Active-org scoped.
 * @param {string} id
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function reactivateStockLocation(id) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  const { data, error } = await supabase
    .from('stock_locations')
    .update({ is_active: true })
    .eq('id', id)
    .eq('org_id', orgId)
    .select(SELECT)
    .single();

  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

// NOTE: there is intentionally NO deleteStockLocation() — locations are retired
// via deactivateStockLocation (is_active = false), never hard-deleted.
