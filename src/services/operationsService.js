import { supabase } from './supabase';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Operations Service
// Data access for operations (tasks performed across vineyards and blocks).
//
// All reads rely on Supabase Row Level Security: each row is scoped to the
// authenticated user via `auth.uid() = owner_id`, so these queries only ever
// return the current user's data. No manual user filtering is required and no
// second Supabase client is created.
// Schema: supabase/migrations/002_vineyards.sql
// ─────────────────────────────────────────────────────────────────────────────

// Allowed operation statuses (shared with the form/filters). The `status`
// column is free TEXT in the schema; these are the supported values the app
// writes. Note: 'active' and 'planned' count as "active operations" on the
// dashboard; 'completed' and 'cancelled' are terminal.
export const OPERATION_STATUSES = [
  { value: 'active', label: 'Active' },
  { value: 'planned', label: 'Planned' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
];

/**
 * Translate a Supabase/PostgREST error into a friendly, non-technical message.
 * Never surfaces raw SQL / driver text to the user.
 * @param {object|null} error
 * @returns {string}
 */
export function friendlyOperationError(error) {
  if (!error) return 'Something went wrong. Please try again.';

  const code = error.code;
  const msg = (error.message || '').toLowerCase();

  if (code === '42P01' || code === 'PGRST205' || msg.includes('does not exist')) {
    return 'The operations database is not set up yet. Please run the latest migration.';
  }
  if (code === '23503' || msg.includes('foreign key')) {
    return 'The selected vineyard or block could not be found. Please choose valid options.';
  }
  if (code === '23505' || msg.includes('duplicate')) {
    return 'An operation with these details already exists.';
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

// Normalise a raw Supabase operation row (with optional nested vineyard/block)
// into the app's camelCase shape.
function normaliseOperation(o) {
  if (!o) return null;
  const vineyard = o.vineyard || null;
  const block = o.block || null;
  return {
    id: o.id,
    vineyardId: o.vineyard_id,
    blockId: o.block_id,
    title: o.title,
    status: o.status,
    createdAt: o.created_at,
    updatedAt: o.updated_at,
    vineyardName: vineyard ? vineyard.name : null,
    blockName: block ? block.name : null,
  };
}

// Columns selected for an operation, including related vineyard and block names
// via the operations.vineyard_id -> vineyards.id and
// operations.block_id -> blocks.id foreign keys.
const OPERATION_SELECT =
  'id, vineyard_id, block_id, title, status, created_at, updated_at, ' +
  'vineyard:vineyards(id, name), block:blocks(id, name)';

/**
 * Fetch the authenticated user's operations, each with vineyard/block names.
 * @returns {Promise<{ data: Array|null, error: object|null }>}
 */
export async function getOperations() {
  const { data, error } = await supabase
    .from('operations')
    .select(OPERATION_SELECT)
    .order('created_at', { ascending: false });

  if (error) return { data: null, error };
  return { data: (data || []).map(normaliseOperation), error: null };
}

/**
 * Fetch the authenticated user's operations for a single vineyard.
 * @param {string} vineyardId
 * @returns {Promise<{ data: Array|null, error: object|null }>}
 */
export async function getOperationsByVineyard(vineyardId) {
  const { data, error } = await supabase
    .from('operations')
    .select(OPERATION_SELECT)
    .eq('vineyard_id', vineyardId)
    .order('created_at', { ascending: false });

  if (error) return { data: null, error };
  return { data: (data || []).map(normaliseOperation), error: null };
}

/**
 * Fetch the authenticated user's operations for a single block.
 * @param {string} blockId
 * @returns {Promise<{ data: Array|null, error: object|null }>}
 */
export async function getOperationsByBlock(blockId) {
  const { data, error } = await supabase
    .from('operations')
    .select(OPERATION_SELECT)
    .eq('block_id', blockId)
    .order('created_at', { ascending: false });

  if (error) return { data: null, error };
  return { data: (data || []).map(normaliseOperation), error: null };
}

/**
 * Fetch a single operation by id (RLS-scoped) with vineyard/block names.
 * @param {string} id
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function getOperation(id) {
  const { data, error } = await supabase
    .from('operations')
    .select(OPERATION_SELECT)
    .eq('id', id)
    .single();

  if (error) return { data: null, error };
  return { data: normaliseOperation(data), error: null };
}

/**
 * Create an operation owned by the authenticated user.
 * Sets owner_id to the current user's id to satisfy the RLS WITH CHECK policy.
 * @param {{ title: string, vineyardId: string, blockId?: string|null, status?: string }} input
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function createOperation(input) {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) {
    return { data: null, error: userError || { message: 'Not authenticated' } };
  }

  const row = {
    owner_id: userData.user.id,
    vineyard_id: input.vineyardId,
    block_id: input.blockId || null,
    title: input.title,
    status: input.status || 'planned',
  };

  const { data, error } = await supabase
    .from('operations')
    .insert(row)
    .select(OPERATION_SELECT)
    .single();

  if (error) return { data: null, error };
  return { data: normaliseOperation(data), error: null };
}

/**
 * Update an existing operation (RLS-scoped to the owner).
 * @param {string} id
 * @param {{ title?: string, vineyardId?: string, blockId?: string|null, status?: string }} input
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function updateOperation(id, input) {
  const row = {
    vineyard_id: input.vineyardId,
    block_id: input.blockId || null,
    title: input.title,
    status: input.status,
  };

  const { data, error } = await supabase
    .from('operations')
    .update(row)
    .eq('id', id)
    .select(OPERATION_SELECT)
    .single();

  if (error) return { data: null, error };
  return { data: normaliseOperation(data), error: null };
}

/**
 * Delete an operation by id (RLS-scoped to the owner).
 * @param {string} id
 * @returns {Promise<{ error: object|null }>}
 */
export async function deleteOperation(id) {
  const { error } = await supabase.from('operations').delete().eq('id', id);
  return { error };
}

/**
 * Load the authenticated user's vineyards as options for selectors/filters.
 * RLS guarantees only the user's own vineyards are returned.
 * @returns {Promise<{ data: Array<{ id, name }>|null, error: object|null }>}
 */
export async function getVineyardOptions() {
  const { data, error } = await supabase
    .from('vineyards')
    .select('id, name')
    .order('name', { ascending: true });

  if (error) return { data: null, error };
  return { data: data || [], error: null };
}

/**
 * Load the authenticated user's blocks as options for selectors/filters.
 * Each option includes vineyardId so the UI can filter blocks by vineyard.
 * @returns {Promise<{ data: Array<{ id, name, vineyardId }>|null, error: object|null }>}
 */
export async function getBlockOptions() {
  const { data, error } = await supabase
    .from('blocks')
    .select('id, name, vineyard_id')
    .order('name', { ascending: true });

  if (error) return { data: null, error };
  return {
    data: (data || []).map((b) => ({
      id: b.id,
      name: b.name,
      vineyardId: b.vineyard_id,
    })),
    error: null,
  };
}
