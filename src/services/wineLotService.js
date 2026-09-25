import { supabase } from './supabase';
import { getActiveOrgId } from './activeOrg';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Wine Lot Service (P2E)
// A wine lot is the physical/movable quantity of wine (in litres) originating
// from exactly one wine batch: Wine Batch -> Wine Lot. Grape-intake / harvest /
// planting / cultivar / block / vineyard remain DERIVED via the batch and are
// never duplicated here.
//
// Reads/writes are scoped to the active organisation (.eq('org_id', activeOrgId))
// on top of organisation-based RLS (is_org_member(org_id)) — RLS + the DB
// cross-org integrity trigger remain authoritative. Creates set org_id = active
// org and owner_id = the authenticated user; neither is taken from the UI.
// wine_batch_id is the lot's origin: set on create, never changed on update.
// volume_litres is a current-state quantity (no deltas/losses/splits in P2E).
// Schema: supabase/migrations/018_wine_lots.sql
// ─────────────────────────────────────────────────────────────────────────────

// Allowed wine-lot statuses (shared with the form UI). P2E: exactly these.
export const WINE_LOT_STATUSES = [
  { value: 'active', label: 'Active' },
  { value: 'in_production', label: 'In Production' },
  { value: 'bottled', label: 'Bottled' },
  { value: 'depleted', label: 'Depleted' },
  { value: 'archived', label: 'Archived' },
];

/**
 * Translate a Supabase/PostgREST error into a friendly, non-technical message.
 * @param {object|null} error
 * @returns {string}
 */
export function friendlyWineLotError(error) {
  if (!error) return 'Something went wrong. Please try again.';
  const code = error.code;
  const msg = (error.message || '').toLowerCase();
  if (code === '42P01' || code === 'PGRST205' || msg.includes('does not exist')) {
    return 'The wine lot database is not set up yet. Please run the latest migration.';
  }
  if (code === '23505' || msg.includes('duplicate') || msg.includes('unique')) {
    return 'A lot with this code already exists in this organisation.';
  }
  if (msg.includes('cross-organisation')) {
    return 'The selected batch belongs to a different organisation.';
  }
  if (msg.includes('invalid wine batch')) return 'The wine batch could not be found.';
  if (code === '23514' || msg.includes('check constraint')) {
    return 'Please provide a valid lot code, volume and status.';
  }
  if (code === '23503' || msg.includes('foreign key')) {
    return 'The wine batch could not be found.';
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

// Normalise a raw wine_lots row (with joined batch context) into camelCase.
function normalise(l) {
  if (!l) return null;
  const batch = l.wine_batch || null;
  return {
    id: l.id,
    wineBatchId: l.wine_batch_id,
    lotCode: l.lot_code,
    volumeLitres: l.volume_litres,
    status: l.status,
    notes: l.notes,
    ownerId: l.owner_id,
    createdAt: l.created_at,
    updatedAt: l.updated_at,
    // Derived batch context (read-only).
    batchCode: batch ? batch.batch_code : null,
    batchName: batch ? batch.name : null,
    batchVintage: batch ? batch.vintage : null,
    batchStatus: batch ? batch.status : null,
  };
}

const SELECT =
  'id, wine_batch_id, lot_code, volume_litres, status, notes, owner_id, created_at, updated_at, ' +
  'wine_batch:wine_batches(id, batch_code, name, vintage, status)';

/**
 * Fetch the active organisation's wine lots (with batch context), newest first.
 * @returns {Promise<{ data: Array|null, error: object|null }>}
 */
export async function getWineLots() {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: [], error: null };

  const { data, error } = await supabase
    .from('wine_lots')
    .select(SELECT)
    .eq('org_id', orgId)
    .order('created_at', { ascending: false });

  if (error) return { data: null, error };
  return { data: (data || []).map(normalise), error: null };
}

/**
 * Fetch the active organisation's wine lots for a single batch, newest first.
 * @param {string} batchId
 * @returns {Promise<{ data: Array|null, error: object|null }>}
 */
export async function getWineLotsByBatch(batchId) {
  const orgId = getActiveOrgId();
  if (!orgId || !batchId) return { data: [], error: null };

  const { data, error } = await supabase
    .from('wine_lots')
    .select(SELECT)
    .eq('org_id', orgId)
    .eq('wine_batch_id', batchId)
    .order('created_at', { ascending: false });

  if (error) return { data: null, error };
  return { data: (data || []).map(normalise), error: null };
}

/**
 * Fetch a single wine lot by id (active-org scoped), with batch context.
 * @param {string} id
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function getWineLot(id) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  const { data, error } = await supabase
    .from('wine_lots')
    .select(SELECT)
    .eq('id', id)
    .eq('org_id', orgId)
    .single();

  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

/**
 * Fetch a wine lot together with its batch and the batch's contributing grape
 * intakes (with derived harvest/cultivar context) for the traceability panel.
 * @param {string} id
 * @returns {Promise<{ data: { lot, intakes }|null, error: object|null }>}
 */
export async function getWineLotWithBatch(id) {
  const { data: lot, error: lotError } = await getWineLot(id);
  if (lotError) return { data: null, error: lotError };
  if (!lot) return { data: null, error: { message: 'Wine lot not found' } };

  const orgId = getActiveOrgId();
  const { data: links, error: linksError } = await supabase
    .from('batch_grape_intakes')
    .select(
      'id, contributed_kg, ' +
        'grape_intake:grape_intakes(id, intake_date, received_kg, status, ' +
        'harvest:harvest(id, title, vineyard:vineyards(id, name), block:blocks(id, name), ' +
        'planting:plantings(id, cultivar:cultivars(id, name))))'
    )
    .eq('org_id', orgId)
    .eq('wine_batch_id', lot.wineBatchId)
    .order('created_at', { ascending: true });

  if (linksError) return { data: null, error: linksError };

  const intakes = (links || []).map((l) => {
    const gi = l.grape_intake || null;
    const harvest = gi && gi.harvest ? gi.harvest : null;
    const planting = harvest && harvest.planting ? harvest.planting : null;
    const cultivar = planting && planting.cultivar ? planting.cultivar : null;
    return {
      id: l.id,
      contributedKg: l.contributed_kg,
      grapeIntakeId: gi ? gi.id : null,
      intakeDate: gi ? gi.intake_date : null,
      intakeReceivedKg: gi ? gi.received_kg : null,
      intakeStatus: gi ? gi.status : null,
      harvestId: harvest ? harvest.id : null,
      harvestTitle: harvest ? harvest.title : null,
      vineyardName: harvest && harvest.vineyard ? harvest.vineyard.name : null,
      blockName: harvest && harvest.block ? harvest.block.name : null,
      cultivarName: cultivar ? cultivar.name : null,
    };
  });

  return { data: { lot, intakes }, error: null };
}

/**
 * Create a wine lot in the active organisation. Sets org_id = active org and
 * owner_id = the authenticated user (never from the payload). wine_batch_id is
 * the lot's origin; the DB cross-org trigger is the authoritative same-org guard.
 * @param {{ wineBatchId: string, lotCode: string, volumeLitres: number,
 *   status?: string, notes?: string|null }} input
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function createWineLot(input) {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) {
    return { data: null, error: userError || { message: 'Not authenticated' } };
  }

  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };
  if (!input.wineBatchId) return { data: null, error: { message: 'A wine batch is required.' } };

  const row = {
    org_id: orgId,
    owner_id: userData.user.id,
    wine_batch_id: input.wineBatchId,
    lot_code: input.lotCode,
    volume_litres: input.volumeLitres ?? 0,
    status: input.status || 'active',
    notes: input.notes || null,
  };

  const { data, error } = await supabase
    .from('wine_lots')
    .insert(row)
    .select(SELECT)
    .single();

  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

/**
 * Update a wine lot (active-org scoped). org_id, owner_id and wine_batch_id are
 * NEVER changed here: owner_id immutability is also enforced by a DB trigger,
 * and wine_batch_id is the lot's origin (future split/merge/lineage will handle
 * relationships between lots — not a casual batch reassignment).
 * @param {string} id
 * @param {{ lotCode?: string, volumeLitres?: number, status?: string,
 *   notes?: string|null }} input
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function updateWineLot(id, input) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  const row = {};
  if (input.lotCode !== undefined) row.lot_code = input.lotCode;
  if (input.volumeLitres !== undefined) row.volume_litres = input.volumeLitres ?? 0;
  if (input.status !== undefined) row.status = input.status;
  if (input.notes !== undefined) row.notes = input.notes || null;

  const { data, error } = await supabase
    .from('wine_lots')
    .update(row)
    .eq('id', id)
    .eq('org_id', orgId)
    .select(SELECT)
    .single();

  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

/**
 * Delete a wine lot (active-org scoped). No downstream dependents in P2E.
 * @param {string} id
 * @returns {Promise<{ error: object|null }>}
 */
export async function deleteWineLot(id) {
  const orgId = getActiveOrgId();
  if (!orgId) return { error: { message: 'No active organisation' } };
  const { error } = await supabase
    .from('wine_lots')
    .delete()
    .eq('id', id)
    .eq('org_id', orgId);
  return { error };
}

/**
 * Fetch the active organisation's wine batches as options for the lot form's
 * batch selector. Only batches from the active organisation are returned.
 * @returns {Promise<{ data: Array<{ id, batchCode, name, vintage }>|null, error: object|null }>}
 */
export async function getBatchOptions() {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: [], error: null };

  const { data, error } = await supabase
    .from('wine_batches')
    .select('id, batch_code, name, vintage')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false });

  if (error) return { data: null, error };
  return {
    data: (data || []).map((b) => ({
      id: b.id,
      batchCode: b.batch_code,
      name: b.name,
      vintage: b.vintage,
    })),
    error: null,
  };
}
