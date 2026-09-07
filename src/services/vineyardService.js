import { supabase } from './supabase';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Vineyard Service
// Data access for vineyards, blocks and operations.
//
// All reads rely on Supabase Row Level Security: each row is scoped to the
// authenticated user via `auth.uid() = owner_id`, so these queries only ever
// return the current user's data. No manual user filtering is required and no
// second Supabase client is created.
// Schema: supabase/migrations/002_vineyards.sql
// ─────────────────────────────────────────────────────────────────────────────

// Operation statuses considered "active" (not yet finished / cancelled).
const INACTIVE_OPERATION_STATUSES = ['completed', 'cancelled', 'done', 'closed'];

// Allowed vineyard statuses (shared with the form UI). The `status` column is
// free TEXT in the schema; these are the supported values the app writes.
export const VINEYARD_STATUSES = [
  { value: 'active', label: 'Active' },
  { value: 'dormant', label: 'Dormant' },
  { value: 'planned', label: 'Planned' },
  { value: 'archived', label: 'Archived' },
];

/**
 * Translate a Supabase/PostgREST error into a friendly, non-technical message.
 * Never surfaces raw SQL / driver text to the user.
 * @param {object|null} error
 * @returns {string}
 */
export function friendlyVineyardError(error) {
  if (!error) return 'Something went wrong. Please try again.';

  const code = error.code;
  const msg = (error.message || '').toLowerCase();

  if (code === '42P01' || code === 'PGRST205' || msg.includes('does not exist')) {
    return 'The vineyard database is not set up yet. Please run the latest migration.';
  }
  if (code === '23505' || msg.includes('duplicate')) {
    return 'A vineyard with these details already exists.';
  }
  if (code === '23502') {
    return 'Please fill in all required fields.';
  }
  if (code === '42501' || msg.includes('row-level security') || msg.includes('permission')) {
    return 'You do not have permission to perform this action.';
  }
  if (msg.includes('network') || msg.includes('fetch')) {
    return 'Network error. Please check your connection and try again.';
  }
  return 'Something went wrong. Please try again.';
}

// Normalise a raw Supabase vineyard row into the app's camelCase shape.
function normaliseVineyard(v) {
  if (!v) return null;
  return {
    id: v.id,
    name: v.name,
    location: v.location,
    areaHectares: v.area_hectares,
    status: v.status,
    createdAt: v.created_at,
    updatedAt: v.updated_at,
    blockCount:
      Array.isArray(v.blocks) && v.blocks.length > 0 ? v.blocks[0].count : undefined,
  };
}

/**
 * Fetch the authenticated user's vineyards, each with its block count.
 *
 * Uses a nested aggregate select so block counts come back with the vineyards
 * in a single request. Returns the raw list plus a normalised shape.
 *
 * @returns {Promise<{ data: Array|null, error: object|null }>}
 */
export async function getVineyards() {
  const { data, error } = await supabase
    .from('vineyards')
    .select('id, name, location, area_hectares, status, created_at, blocks(count)')
    .order('created_at', { ascending: true });

  if (error) {
    return { data: null, error };
  }

  const vineyards = (data || []).map((v) => ({
    ...normaliseVineyard(v),
    // Nested aggregate always present here; default to 0 for the list view.
    blockCount:
      Array.isArray(v.blocks) && v.blocks.length > 0 ? v.blocks[0].count : 0,
  }));

  return { data: vineyards, error: null };
}

/**
 * Fetch a single vineyard by id (RLS-scoped to the owner) with block count.
 * @param {string} id
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function getVineyard(id) {
  const { data, error } = await supabase
    .from('vineyards')
    .select('id, name, location, area_hectares, status, created_at, updated_at, blocks(count)')
    .eq('id', id)
    .single();

  if (error) return { data: null, error };
  return { data: normaliseVineyard(data), error: null };
}

/**
 * Create a vineyard owned by the authenticated user.
 * Sets owner_id to the current user's id to satisfy the RLS WITH CHECK policy.
 * @param {{ name: string, location?: string, areaHectares?: number|null, status?: string }} input
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function createVineyard(input) {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) {
    return { data: null, error: userError || { message: 'Not authenticated' } };
  }

  const row = {
    owner_id: userData.user.id,
    name: input.name,
    location: input.location || null,
    area_hectares: input.areaHectares ?? null,
    status: input.status || 'active',
  };

  const { data, error } = await supabase
    .from('vineyards')
    .insert(row)
    .select('id, name, location, area_hectares, status, created_at, updated_at')
    .single();

  if (error) return { data: null, error };
  return { data: normaliseVineyard(data), error: null };
}

/**
 * Update an existing vineyard (RLS-scoped to the owner).
 * @param {string} id
 * @param {{ name?: string, location?: string, areaHectares?: number|null, status?: string }} input
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function updateVineyard(id, input) {
  const row = {
    name: input.name,
    location: input.location || null,
    area_hectares: input.areaHectares ?? null,
    status: input.status,
  };

  const { data, error } = await supabase
    .from('vineyards')
    .update(row)
    .eq('id', id)
    .select('id, name, location, area_hectares, status, created_at, updated_at')
    .single();

  if (error) return { data: null, error };
  return { data: normaliseVineyard(data), error: null };
}

/**
 * Delete a vineyard by id (RLS-scoped to the owner).
 * @param {string} id
 * @returns {Promise<{ error: object|null }>}
 */
export async function deleteVineyard(id) {
  const { error } = await supabase.from('vineyards').delete().eq('id', id);
  return { error };
}

/**
 * Compute summary metrics for the dashboard overview cards:
 *   - total vineyards
 *   - total blocks
 *   - total hectares (sum of vineyard area_hectares)
 *   - active operations (status not in a terminal set)
 *
 * Runs the count/aggregate queries in parallel. If any query errors, the whole
 * call returns that error so the caller can surface a single error state.
 *
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function getDashboardSummary() {
  const [vineyardsRes, blocksRes, hectaresRes, activeOpsRes] = await Promise.all([
    // Total vineyards (count only)
    supabase.from('vineyards').select('id', { count: 'exact', head: true }),

    // Total blocks (count only)
    supabase.from('blocks').select('id', { count: 'exact', head: true }),

    // Hectares — fetch area values and sum client-side (RLS-scoped rows only)
    supabase.from('vineyards').select('area_hectares'),

    // Active operations (count only), excluding terminal statuses
    supabase
      .from('operations')
      .select('id', { count: 'exact', head: true })
      .not('status', 'in', `(${INACTIVE_OPERATION_STATUSES.join(',')})`),
  ]);

  const firstError =
    vineyardsRes.error || blocksRes.error || hectaresRes.error || activeOpsRes.error;
  if (firstError) {
    return { data: null, error: firstError };
  }

  const totalHectares = (hectaresRes.data || []).reduce(
    (sum, row) => sum + (Number(row.area_hectares) || 0),
    0
  );

  return {
    data: {
      totalVineyards: vineyardsRes.count ?? 0,
      totalBlocks: blocksRes.count ?? 0,
      totalHectares,
      activeOperations: activeOpsRes.count ?? 0,
    },
    error: null,
  };
}
