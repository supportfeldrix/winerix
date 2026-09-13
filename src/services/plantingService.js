import { supabase } from './supabase';
import { getActiveOrgId } from './activeOrg';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Planting Service
// Plantings represent the vineyard planting composition within a block
// (block -> planting -> cultivar). Multiple plantings per block are supported.
//
// Reads/writes are scoped to the active organisation (.eq('org_id', activeOrgId))
// on top of organisation-based RLS (is_org_member(org_id)) — RLS + the DB
// cross-org integrity trigger remain the authoritative boundary. Creates set
// org_id = active org and owner_id = the authenticated user; neither is taken
// from the UI. Schema: supabase/migrations/012_plantings.sql
// ─────────────────────────────────────────────────────────────────────────────

// Allowed planting statuses (shared with the form UI). P1C: exactly these.
export const PLANTING_STATUSES = [
  { value: 'active', label: 'Active' },
  { value: 'removed', label: 'Removed' },
  { value: 'replanted', label: 'Replanted' },
];

/**
 * Translate a Supabase/PostgREST error into a friendly, non-technical message.
 * Recognises the cross-organisation integrity trigger's messages.
 * @param {object|null} error
 * @returns {string}
 */
export function friendlyPlantingError(error) {
  if (!error) return 'Something went wrong. Please try again.';
  const code = error.code;
  const msg = (error.message || '').toLowerCase();
  if (code === '42P01' || code === 'PGRST205' || msg.includes('does not exist')) {
    return 'The planting database is not set up yet. Please run the latest migration.';
  }
  if (msg.includes('cross-organisation')) {
    return 'The selected block or cultivar belongs to a different organisation.';
  }
  if (msg.includes('invalid block')) return 'The selected block could not be found.';
  if (msg.includes('invalid cultivar')) return 'The selected cultivar could not be found.';
  if (code === '23503' || msg.includes('foreign key')) {
    return 'The selected block or cultivar could not be found.';
  }
  if (code === '23514' || msg.includes('check constraint')) {
    return 'Please provide a valid area and status.';
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

// Normalise a raw Supabase planting row (with optional nested cultivar) into
// the app's camelCase shape.
function normalise(p) {
  if (!p) return null;
  const cultivar = p.cultivar || null;
  return {
    id: p.id,
    blockId: p.block_id,
    cultivarId: p.cultivar_id,
    cultivarName: cultivar ? cultivar.name : null,
    cultivarColour: cultivar ? cultivar.colour : null,
    plantingYear: p.planting_year,
    areaHectares: p.area_hectares,
    rootstock: p.rootstock,
    clone: p.clone,
    status: p.status,
    notes: p.notes,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}

// Columns selected for a planting, including the related cultivar name/colour
// via plantings.cultivar_id -> cultivars.id. Historical plantings referencing
// an inactive cultivar still resolve the name/colour here.
const SELECT =
  'id, block_id, cultivar_id, planting_year, area_hectares, rootstock, clone, ' +
  'status, notes, created_at, updated_at, cultivar:cultivars(id, name, colour)';

/**
 * Fetch the active organisation's plantings for a single block, cultivar-joined.
 * Ordered by cultivar name.
 * @param {string} blockId
 * @returns {Promise<{ data: Array|null, error: object|null }>}
 */
export async function getPlantingsByBlock(blockId) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: [], error: null };

  const { data, error } = await supabase
    .from('plantings')
    .select(SELECT)
    .eq('org_id', orgId)
    .eq('block_id', blockId)
    .order('created_at', { ascending: true });

  if (error) return { data: null, error };
  return { data: (data || []).map(normalise), error: null };
}

/**
 * Fetch a single planting by id (active-org scoped), cultivar-joined.
 * @param {string} id
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function getPlanting(id) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  const { data, error } = await supabase
    .from('plantings')
    .select(SELECT)
    .eq('id', id)
    .eq('org_id', orgId)
    .single();

  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

// Friendly pre-check that a block belongs to the active organisation. The DB
// cross-org trigger remains authoritative; this only improves UX. Returns
// true when the block is visible in the active org (RLS-scoped read).
async function blockInActiveOrg(blockId, orgId) {
  const { data } = await supabase
    .from('blocks')
    .select('id')
    .eq('id', blockId)
    .eq('org_id', orgId)
    .maybeSingle();
  return Boolean(data);
}

// Friendly pre-check that a cultivar belongs to the active organisation.
async function cultivarInActiveOrg(cultivarId, orgId) {
  const { data } = await supabase
    .from('cultivars')
    .select('id')
    .eq('id', cultivarId)
    .eq('org_id', orgId)
    .maybeSingle();
  return Boolean(data);
}

/**
 * Create a planting in the active organisation.
 * Sets org_id = active org and owner_id = the authenticated user (never from
 * the payload). Performs friendly block/cultivar org pre-validation; the DB
 * trigger is the authoritative same-org guard.
 * @param {{ blockId: string, cultivarId: string, plantingYear?: number|null,
 *   areaHectares?: number|null, rootstock?: string|null, clone?: string|null,
 *   status?: string, notes?: string|null }} input
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function createPlanting(input) {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) {
    return { data: null, error: userError || { message: 'Not authenticated' } };
  }

  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  if (!input.blockId) return { data: null, error: { message: 'A block is required.' } };
  if (!input.cultivarId) return { data: null, error: { message: 'A cultivar is required.' } };

  // Friendly org pre-checks (DB trigger is authoritative).
  if (!(await blockInActiveOrg(input.blockId, orgId))) {
    return { data: null, error: { message: 'The selected block could not be found.' } };
  }
  if (!(await cultivarInActiveOrg(input.cultivarId, orgId))) {
    return { data: null, error: { message: 'The selected cultivar could not be found.' } };
  }

  const row = {
    org_id: orgId,
    owner_id: userData.user.id,
    block_id: input.blockId,
    cultivar_id: input.cultivarId,
    planting_year: input.plantingYear ?? null,
    area_hectares: input.areaHectares ?? null,
    rootstock: input.rootstock || null,
    clone: input.clone || null,
    status: input.status || 'active',
    notes: input.notes || null,
  };

  const { data, error } = await supabase
    .from('plantings')
    .insert(row)
    .select(SELECT)
    .single();

  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

/**
 * Update an existing planting (active-org scoped). org_id and owner_id are
 * never changed (owner_id immutability is also enforced by a DB trigger). If
 * cultivar_id is changed, the DB cross-org trigger enforces same-org integrity.
 * @param {string} id
 * @param {object} input
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function updatePlanting(id, input) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  // Friendly pre-check when reassigning the cultivar.
  if (input.cultivarId !== undefined && input.cultivarId) {
    if (!(await cultivarInActiveOrg(input.cultivarId, orgId))) {
      return { data: null, error: { message: 'The selected cultivar could not be found.' } };
    }
  }

  const row = {};
  if (input.cultivarId !== undefined) row.cultivar_id = input.cultivarId;
  if (input.plantingYear !== undefined) row.planting_year = input.plantingYear ?? null;
  if (input.areaHectares !== undefined) row.area_hectares = input.areaHectares ?? null;
  if (input.rootstock !== undefined) row.rootstock = input.rootstock || null;
  if (input.clone !== undefined) row.clone = input.clone || null;
  if (input.status !== undefined) row.status = input.status;
  if (input.notes !== undefined) row.notes = input.notes || null;

  const { data, error } = await supabase
    .from('plantings')
    .update(row)
    .eq('id', id)
    .eq('org_id', orgId)
    .select(SELECT)
    .single();

  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

/**
 * Deactivate a planting (status = 'removed'). Preferred over physical deletion.
 * @param {string} id
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function deactivatePlanting(id) {
  return updatePlanting(id, { status: 'removed' });
}

/**
 * Reactivate a removed planting (status = 'active').
 * @param {string} id
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function reactivatePlanting(id) {
  return updatePlanting(id, { status: 'active' });
}

/**
 * Compute per-cultivar area percentages for a block's plantings.
 *
 * Percentage is derived (never stored): planting.area_hectares / sum(area of
 * ACTIVE plantings with a known area) * 100. Returns a Map of planting id ->
 * percentage (number) ONLY when it can be computed reliably. If any active
 * planting has a NULL area, percentages are NOT invented — an empty Map is
 * returned so the UI shows areas without misleading percentages.
 *
 * @param {Array} plantings - normalised plantings for one block
 * @returns {{ percentages: Map<string, number>, reliable: boolean }}
 */
export function computeAreaPercentages(plantings) {
  const active = (plantings || []).filter((p) => p.status === 'active');
  const anyNullArea = active.some((p) => p.areaHectares == null);
  const total = active.reduce((s, p) => s + (Number(p.areaHectares) || 0), 0);

  const percentages = new Map();
  if (anyNullArea || total <= 0) {
    return { percentages, reliable: false };
  }
  active.forEach((p) => {
    percentages.set(p.id, (Number(p.areaHectares) / total) * 100);
  });
  return { percentages, reliable: true };
}
