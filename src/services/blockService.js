import { supabase } from './supabase';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Block Service
// Data access for blocks (sub-divisions of a vineyard).
//
// All reads rely on Supabase Row Level Security: each row is scoped to the
// authenticated user via `auth.uid() = owner_id`, so these queries only ever
// return the current user's data. No manual user filtering is required and no
// second Supabase client is created.
// Schema: supabase/migrations/002_vineyards.sql
// ─────────────────────────────────────────────────────────────────────────────

// Allowed block statuses (shared with the form UI). The `status` column is
// free TEXT in the schema; these are the supported values the app writes.
export const BLOCK_STATUSES = [
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
export function friendlyBlockError(error) {
  if (!error) return 'Something went wrong. Please try again.';

  const code = error.code;
  const msg = (error.message || '').toLowerCase();

  if (code === '42P01' || code === 'PGRST205' || msg.includes('does not exist')) {
    return 'The block database is not set up yet. Please run the latest migration.';
  }
  if (code === '23503' || msg.includes('foreign key')) {
    return 'The selected vineyard could not be found. Please choose a valid vineyard.';
  }
  if (code === '23505' || msg.includes('duplicate')) {
    return 'A block with these details already exists.';
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

// Normalise a raw Supabase block row (with optional nested vineyard) into the
// app's camelCase shape.
function normaliseBlock(b) {
  if (!b) return null;
  const vineyard = b.vineyard || null;
  return {
    id: b.id,
    vineyardId: b.vineyard_id,
    name: b.name,
    areaHectares: b.area_hectares,
    status: b.status,
    createdAt: b.created_at,
    updatedAt: b.updated_at,
    vineyardName: vineyard ? vineyard.name : null,
  };
}

// Columns selected for a block, including the related vineyard name via the
// blocks.vineyard_id -> vineyards.id foreign key.
const BLOCK_SELECT =
  'id, vineyard_id, name, area_hectares, status, created_at, updated_at, vineyard:vineyards(id, name)';

/**
 * Fetch the authenticated user's blocks, each with its parent vineyard name.
 * @returns {Promise<{ data: Array|null, error: object|null }>}
 */
export async function getBlocks() {
  const { data, error } = await supabase
    .from('blocks')
    .select(BLOCK_SELECT)
    .order('created_at', { ascending: true });

  if (error) return { data: null, error };
  return { data: (data || []).map(normaliseBlock), error: null };
}

/**
 * Fetch the authenticated user's blocks for a single vineyard.
 * RLS still applies; the vineyard_id filter narrows to one vineyard.
 * @param {string} vineyardId
 * @returns {Promise<{ data: Array|null, error: object|null }>}
 */
export async function getBlocksByVineyard(vineyardId) {
  const { data, error } = await supabase
    .from('blocks')
    .select(BLOCK_SELECT)
    .eq('vineyard_id', vineyardId)
    .order('created_at', { ascending: true });

  if (error) return { data: null, error };
  return { data: (data || []).map(normaliseBlock), error: null };
}

/**
 * Fetch a single block by id (RLS-scoped) with its parent vineyard name.
 * @param {string} id
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function getBlock(id) {
  const { data, error } = await supabase
    .from('blocks')
    .select(BLOCK_SELECT)
    .eq('id', id)
    .single();

  if (error) return { data: null, error };
  return { data: normaliseBlock(data), error: null };
}

/**
 * Create a block owned by the authenticated user.
 * Sets owner_id to the current user's id to satisfy the RLS WITH CHECK policy.
 * @param {{ name: string, vineyardId: string, areaHectares?: number|null, status?: string }} input
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function createBlock(input) {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) {
    return { data: null, error: userError || { message: 'Not authenticated' } };
  }

  const row = {
    owner_id: userData.user.id,
    vineyard_id: input.vineyardId,
    name: input.name,
    area_hectares: input.areaHectares ?? null,
    status: input.status || 'active',
  };

  const { data, error } = await supabase
    .from('blocks')
    .insert(row)
    .select(BLOCK_SELECT)
    .single();

  if (error) return { data: null, error };
  return { data: normaliseBlock(data), error: null };
}

/**
 * Update an existing block (RLS-scoped to the owner).
 * @param {string} id
 * @param {{ name?: string, vineyardId?: string, areaHectares?: number|null, status?: string }} input
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function updateBlock(id, input) {
  const row = {
    vineyard_id: input.vineyardId,
    name: input.name,
    area_hectares: input.areaHectares ?? null,
    status: input.status,
  };

  const { data, error } = await supabase
    .from('blocks')
    .update(row)
    .eq('id', id)
    .select(BLOCK_SELECT)
    .single();

  if (error) return { data: null, error };
  return { data: normaliseBlock(data), error: null };
}

/**
 * Delete a block by id (RLS-scoped to the owner).
 * @param {string} id
 * @returns {Promise<{ error: object|null }>}
 */
export async function deleteBlock(id) {
  const { error } = await supabase.from('blocks').delete().eq('id', id);
  return { error };
}

/**
 * Load the authenticated user's vineyards as options for the block form's
 * vineyard selector. RLS guarantees only the user's own vineyards are returned,
 * so a user can never assign a block to another user's vineyard.
 * @returns {Promise<{ data: Array<{ id: string, name: string }>|null, error: object|null }>}
 */
export async function getVineyardOptions() {
  const { data, error } = await supabase
    .from('vineyards')
    .select('id, name')
    .order('name', { ascending: true });

  if (error) return { data: null, error };
  return { data: data || [], error: null };
}
