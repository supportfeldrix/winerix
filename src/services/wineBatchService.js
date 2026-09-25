import { supabase } from './supabase';
import { getActiveOrgId } from './activeOrg';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Wine Batch Service (P2D — first cellar-production increment)
// A wine batch is a production/origin grouping (vintage). Grape intakes are
// linked to a batch via the batch_grape_intakes junction, which records HOW
// MANY kg of each intake contributed. The traceability chain
//   Wine Batch -> Grape Intake -> Harvest -> Planting -> Cultivar -> Block -> Vineyard
// is DERIVED via the grape intake and is never duplicated here.
//
// Reads/writes are scoped to the active organisation (.eq('org_id', activeOrgId))
// on top of organisation-based RLS (is_org_member(org_id)) — RLS + the DB
// cross-org integrity trigger remain authoritative. Creates set org_id = active
// org and owner_id = the authenticated user; neither is taken from the UI.
// Schema: supabase/migrations/017_wine_batches.sql
// ─────────────────────────────────────────────────────────────────────────────

// Allowed wine-batch statuses (shared with the form UI). P2D: exactly these.
export const WINE_BATCH_STATUSES = [
  { value: 'planned', label: 'Planned' },
  { value: 'active', label: 'Active' },
  { value: 'closed', label: 'Closed' },
  { value: 'discarded', label: 'Discarded' },
];

/**
 * Translate a Supabase/PostgREST error into a friendly, non-technical message.
 * @param {object|null} error
 * @returns {string}
 */
export function friendlyWineBatchError(error) {
  if (!error) return 'Something went wrong. Please try again.';
  const code = error.code;
  const msg = (error.message || '').toLowerCase();
  if (code === '42P01' || code === 'PGRST205' || msg.includes('does not exist')) {
    return 'The wine batch database is not set up yet. Please run the latest migration.';
  }
  if (code === '23505' || msg.includes('duplicate') || msg.includes('unique')) {
    // The unique constraint covers both (org, batch_code) and (batch, intake).
    if (msg.includes('batch_intake') || msg.includes('grape_intake')) {
      return 'That grape intake is already linked to this batch.';
    }
    return 'A batch with this code already exists in this organisation.';
  }
  if (msg.includes('cross-organisation')) {
    return 'The selected batch or grape intake belongs to a different organisation.';
  }
  if (msg.includes('invalid wine batch')) return 'The wine batch could not be found.';
  if (msg.includes('invalid grape intake')) return 'The grape intake could not be found.';
  if (code === '23514' || msg.includes('check constraint')) {
    return 'Please provide a valid batch code, vintage, status and contributed weight.';
  }
  if (code === '23503' || msg.includes('foreign key')) {
    return 'The batch or grape intake could not be found.';
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

// Normalise a raw wine_batches row into the app's camelCase shape.
function normaliseBatch(b) {
  if (!b) return null;
  return {
    id: b.id,
    batchCode: b.batch_code,
    name: b.name,
    vintage: b.vintage,
    status: b.status,
    notes: b.notes,
    ownerId: b.owner_id,
    createdAt: b.created_at,
    updatedAt: b.updated_at,
  };
}

// Normalise a batch_grape_intakes row (with its joined intake + harvest/cultivar
// context) into the app's camelCase shape. The upstream context is derived via
// the grape intake -> harvest -> planting -> cultivar joins; nothing is stored
// redundantly on the junction.
function normaliseLink(l) {
  if (!l) return null;
  const gi = l.grape_intake || null;
  const harvest = gi && gi.harvest ? gi.harvest : null;
  const planting = harvest && harvest.planting ? harvest.planting : null;
  const cultivar = planting && planting.cultivar ? planting.cultivar : null;
  return {
    id: l.id,
    wineBatchId: l.wine_batch_id,
    grapeIntakeId: l.grape_intake_id,
    contributedKg: l.contributed_kg,
    createdAt: l.created_at,
    updatedAt: l.updated_at,
    // Derived grape-intake context (read-only).
    intakeDate: gi ? gi.intake_date : null,
    intakeReceivedKg: gi ? gi.received_kg : null,
    intakeStatus: gi ? gi.status : null,
    harvestId: harvest ? harvest.id : null,
    harvestTitle: harvest ? harvest.title : null,
    vineyardName: harvest && harvest.vineyard ? harvest.vineyard.name : null,
    blockName: harvest && harvest.block ? harvest.block.name : null,
    cultivarName: cultivar ? cultivar.name : null,
  };
}

const BATCH_SELECT =
  'id, batch_code, name, vintage, status, notes, owner_id, created_at, updated_at';

// Junction select including derived harvest/planting/cultivar context.
const LINK_SELECT =
  'id, wine_batch_id, grape_intake_id, contributed_kg, created_at, updated_at, ' +
  'grape_intake:grape_intakes(id, intake_date, received_kg, status, ' +
  'harvest:harvest(id, title, vineyard:vineyards(id, name), block:blocks(id, name), ' +
  'planting:plantings(id, cultivar:cultivars(id, name))))';

// ── Wine batches ─────────────────────────────────────────────────────────────

/**
 * Fetch the active organisation's wine batches (all statuses), newest first.
 * @returns {Promise<{ data: Array|null, error: object|null }>}
 */
export async function getWineBatches() {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: [], error: null };

  const { data, error } = await supabase
    .from('wine_batches')
    .select(BATCH_SELECT)
    .eq('org_id', orgId)
    .order('created_at', { ascending: false });

  if (error) return { data: null, error };
  return { data: (data || []).map(normaliseBatch), error: null };
}

/**
 * Fetch a single wine batch by id (active-org scoped).
 * @param {string} id
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function getWineBatch(id) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  const { data, error } = await supabase
    .from('wine_batches')
    .select(BATCH_SELECT)
    .eq('id', id)
    .eq('org_id', orgId)
    .single();

  if (error) return { data: null, error };
  return { data: normaliseBatch(data), error: null };
}

/**
 * Fetch a wine batch together with its linked grape intakes (with context).
 * @param {string} id
 * @returns {Promise<{ data: { batch, intakes, totalKg }|null, error: object|null }>}
 */
export async function getWineBatchWithIntakes(id) {
  const { data: batch, error: batchError } = await getWineBatch(id);
  if (batchError) return { data: null, error: batchError };

  const { data: intakes, error: intakesError } = await getBatchIntakes(id);
  if (intakesError) return { data: null, error: intakesError };

  return {
    data: { batch, intakes: intakes || [], totalKg: sumContributedKg(intakes) },
    error: null,
  };
}

/**
 * Create a wine batch in the active organisation. Sets org_id = active org and
 * owner_id = the authenticated user (never from the payload).
 * @param {{ batchCode: string, name?: string|null, vintage?: number|null,
 *   status?: string, notes?: string|null }} input
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function createWineBatch(input) {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) {
    return { data: null, error: userError || { message: 'Not authenticated' } };
  }

  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  const row = {
    org_id: orgId,
    owner_id: userData.user.id,
    batch_code: input.batchCode,
    name: input.name || null,
    vintage: input.vintage ?? null,
    status: input.status || 'planned',
    notes: input.notes || null,
  };

  const { data, error } = await supabase
    .from('wine_batches')
    .insert(row)
    .select(BATCH_SELECT)
    .single();

  if (error) return { data: null, error };
  return { data: normaliseBatch(data), error: null };
}

/**
 * Update a wine batch (active-org scoped). org_id and owner_id are never
 * changed (owner_id immutability is also enforced by a DB trigger).
 * @param {string} id
 * @param {{ batchCode?: string, name?: string|null, vintage?: number|null,
 *   status?: string, notes?: string|null }} input
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function updateWineBatch(id, input) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  const row = {};
  if (input.batchCode !== undefined) row.batch_code = input.batchCode;
  if (input.name !== undefined) row.name = input.name || null;
  if (input.vintage !== undefined) row.vintage = input.vintage ?? null;
  if (input.status !== undefined) row.status = input.status;
  if (input.notes !== undefined) row.notes = input.notes || null;

  const { data, error } = await supabase
    .from('wine_batches')
    .update(row)
    .eq('id', id)
    .eq('org_id', orgId)
    .select(BATCH_SELECT)
    .single();

  if (error) return { data: null, error };
  return { data: normaliseBatch(data), error: null };
}

/**
 * Delete a wine batch (active-org scoped). Its batch_grape_intakes links are
 * removed by ON DELETE CASCADE; the grape intakes themselves are untouched.
 * @param {string} id
 * @returns {Promise<{ error: object|null }>}
 */
export async function deleteWineBatch(id) {
  const orgId = getActiveOrgId();
  if (!orgId) return { error: { message: 'No active organisation' } };
  const { error } = await supabase
    .from('wine_batches')
    .delete()
    .eq('id', id)
    .eq('org_id', orgId);
  return { error };
}

// ── Batch ↔ grape-intake links ───────────────────────────────────────────────

/**
 * Fetch the grape intakes linked to a batch (with derived harvest/cultivar
 * context), oldest link first. Active-org scoped.
 * @param {string} batchId
 * @returns {Promise<{ data: Array|null, error: object|null }>}
 */
export async function getBatchIntakes(batchId) {
  const orgId = getActiveOrgId();
  if (!orgId || !batchId) return { data: [], error: null };

  const { data, error } = await supabase
    .from('batch_grape_intakes')
    .select(LINK_SELECT)
    .eq('org_id', orgId)
    .eq('wine_batch_id', batchId)
    .order('created_at', { ascending: true });

  if (error) return { data: null, error };
  return { data: (data || []).map(normaliseLink), error: null };
}

/**
 * Link an existing grape intake to a batch with a contributed weight. Sets
 * org_id = active org and owner_id = the authenticated user. The DB cross-org
 * trigger is the authoritative same-org guard for both the batch and intake.
 * @param {string} batchId
 * @param {string} intakeId
 * @param {number} contributedKg
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function addIntakeToBatch(batchId, intakeId, contributedKg) {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) {
    return { data: null, error: userError || { message: 'Not authenticated' } };
  }

  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };
  if (!batchId) return { data: null, error: { message: 'A batch is required.' } };
  if (!intakeId) return { data: null, error: { message: 'A grape intake is required.' } };

  const row = {
    org_id: orgId,
    owner_id: userData.user.id,
    wine_batch_id: batchId,
    grape_intake_id: intakeId,
    contributed_kg: contributedKg ?? 0,
  };

  const { data, error } = await supabase
    .from('batch_grape_intakes')
    .insert(row)
    .select(LINK_SELECT)
    .single();

  if (error) return { data: null, error };
  return { data: normaliseLink(data), error: null };
}

/**
 * Update a batch↔intake link's contributed weight (active-org scoped). The
 * batch and intake references are fixed once linked; only contributed_kg
 * changes here.
 * @param {string} id - batch_grape_intakes row id
 * @param {number} contributedKg
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function updateBatchIntake(id, contributedKg) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  const { data, error } = await supabase
    .from('batch_grape_intakes')
    .update({ contributed_kg: contributedKg ?? 0 })
    .eq('id', id)
    .eq('org_id', orgId)
    .select(LINK_SELECT)
    .single();

  if (error) return { data: null, error };
  return { data: normaliseLink(data), error: null };
}

/**
 * Remove a batch↔intake link (active-org scoped). The grape intake itself is
 * not affected.
 * @param {string} id - batch_grape_intakes row id
 * @returns {Promise<{ error: object|null }>}
 */
export async function removeIntakeFromBatch(id) {
  const orgId = getActiveOrgId();
  if (!orgId) return { error: { message: 'No active organisation' } };
  const { error } = await supabase
    .from('batch_grape_intakes')
    .delete()
    .eq('id', id)
    .eq('org_id', orgId);
  return { error };
}

/**
 * Total contributed grape weight for a batch, summed server-side-equivalent
 * from the batch's links. Active-org scoped.
 * @param {string} batchId
 * @returns {Promise<{ data: number|null, error: object|null }>}
 */
export async function getBatchTotalKg(batchId) {
  const { data, error } = await getBatchIntakes(batchId);
  if (error) return { data: null, error };
  return { data: sumContributedKg(data), error: null };
}

// ── Selection helpers ─────────────────────────────────────────────────────────

/**
 * Fetch the active organisation's grape intakes as options for linking to a
 * batch, each with derived harvest/cultivar context for identification. Only
 * intakes from the active organisation are returned (RLS + org filter).
 * @returns {Promise<{ data: Array|null, error: object|null }>}
 */
export async function getIntakeOptions() {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: [], error: null };

  const { data, error } = await supabase
    .from('grape_intakes')
    .select(
      'id, intake_date, received_kg, status, ' +
        'harvest:harvest(id, title, vineyard:vineyards(id, name), block:blocks(id, name), ' +
        'planting:plantings(id, cultivar:cultivars(id, name)))'
    )
    .eq('org_id', orgId)
    .order('intake_date', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false });

  if (error) return { data: null, error };
  return {
    data: (data || []).map((gi) => {
      const harvest = gi.harvest || null;
      const planting = harvest && harvest.planting ? harvest.planting : null;
      const cultivar = planting && planting.cultivar ? planting.cultivar : null;
      return {
        id: gi.id,
        intakeDate: gi.intake_date,
        receivedKg: gi.received_kg,
        status: gi.status,
        harvestTitle: harvest ? harvest.title : null,
        vineyardName: harvest && harvest.vineyard ? harvest.vineyard.name : null,
        blockName: harvest && harvest.block ? harvest.block.name : null,
        cultivarName: cultivar ? cultivar.name : null,
      };
    }),
    error: null,
  };
}

/**
 * Sum contributed_kg across a set of normalised links (ignoring NULLs).
 * @param {Array} links
 * @returns {number}
 */
export function sumContributedKg(links) {
  return (links || []).reduce((s, l) => s + (Number(l.contributedKg) || 0), 0);
}
