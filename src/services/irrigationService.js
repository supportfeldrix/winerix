import { supabase } from './supabase';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Irrigation Service
// Data access for irrigation records (watering activities across vineyards and
// blocks).
//
// All reads rely on Supabase Row Level Security: each row is scoped to the
// authenticated user via `auth.uid() = owner_id`, so these queries only ever
// return the current user's data. No manual user filtering is required and no
// second Supabase client is created.
// Schema: supabase/migrations/003_irrigation.sql
// ─────────────────────────────────────────────────────────────────────────────

// Allowed irrigation statuses (shared with the form/filters). The `status`
// column is free TEXT in the schema; these are the supported values the app
// writes.
export const IRRIGATION_STATUSES = [
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
export function friendlyIrrigationError(error) {
  if (!error) return 'Something went wrong. Please try again.';

  const code = error.code;
  const msg = (error.message || '').toLowerCase();

  if (code === '42P01' || code === 'PGRST205' || msg.includes('does not exist')) {
    return 'The irrigation database is not set up yet. Please run the latest migration.';
  }
  if (code === '23503' || msg.includes('foreign key')) {
    return 'The selected vineyard or block could not be found. Please choose valid options.';
  }
  if (code === '23505' || msg.includes('duplicate')) {
    return 'An irrigation record with these details already exists.';
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

// Normalise a raw Supabase irrigation row (with optional nested vineyard/block)
// into the app's camelCase shape.
function normaliseIrrigation(r) {
  if (!r) return null;
  const vineyard = r.vineyard || null;
  const block = r.block || null;
  return {
    id: r.id,
    vineyardId: r.vineyard_id,
    blockId: r.block_id,
    title: r.title,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    vineyardName: vineyard ? vineyard.name : null,
    blockName: block ? block.name : null,
  };
}

// Columns selected for an irrigation record, including related vineyard and
// block names via the irrigation.vineyard_id -> vineyards.id and
// irrigation.block_id -> blocks.id foreign keys.
const IRRIGATION_SELECT =
  'id, vineyard_id, block_id, title, status, created_at, updated_at, ' +
  'vineyard:vineyards(id, name), block:blocks(id, name)';

/**
 * Fetch the authenticated user's irrigation records, each with vineyard/block
 * names.
 * @returns {Promise<{ data: Array|null, error: object|null }>}
 */
export async function getIrrigationRecords() {
  const { data, error } = await supabase
    .from('irrigation')
    .select(IRRIGATION_SELECT)
    .order('created_at', { ascending: false });

  if (error) return { data: null, error };
  return { data: (data || []).map(normaliseIrrigation), error: null };
}

/**
 * Fetch the authenticated user's irrigation records for a single vineyard.
 * @param {string} vineyardId
 * @returns {Promise<{ data: Array|null, error: object|null }>}
 */
export async function getIrrigationByVineyard(vineyardId) {
  const { data, error } = await supabase
    .from('irrigation')
    .select(IRRIGATION_SELECT)
    .eq('vineyard_id', vineyardId)
    .order('created_at', { ascending: false });

  if (error) return { data: null, error };
  return { data: (data || []).map(normaliseIrrigation), error: null };
}

/**
 * Fetch the authenticated user's irrigation records for a single block.
 * @param {string} blockId
 * @returns {Promise<{ data: Array|null, error: object|null }>}
 */
export async function getIrrigationByBlock(blockId) {
  const { data, error } = await supabase
    .from('irrigation')
    .select(IRRIGATION_SELECT)
    .eq('block_id', blockId)
    .order('created_at', { ascending: false });

  if (error) return { data: null, error };
  return { data: (data || []).map(normaliseIrrigation), error: null };
}

/**
 * Fetch a single irrigation record by id (RLS-scoped) with vineyard/block names.
 * @param {string} id
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function getIrrigationRecord(id) {
  const { data, error } = await supabase
    .from('irrigation')
    .select(IRRIGATION_SELECT)
    .eq('id', id)
    .single();

  if (error) return { data: null, error };
  return { data: normaliseIrrigation(data), error: null };
}

/**
 * Create an irrigation record owned by the authenticated user.
 * Sets owner_id to the current user's id to satisfy the RLS WITH CHECK policy.
 * @param {{ title: string, vineyardId: string, blockId?: string|null, status?: string }} input
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function createIrrigationRecord(input) {
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
    .from('irrigation')
    .insert(row)
    .select(IRRIGATION_SELECT)
    .single();

  if (error) return { data: null, error };
  return { data: normaliseIrrigation(data), error: null };
}

/**
 * Update an existing irrigation record (RLS-scoped to the owner).
 * @param {string} id
 * @param {{ title?: string, vineyardId?: string, blockId?: string|null, status?: string }} input
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function updateIrrigationRecord(id, input) {
  const row = {
    vineyard_id: input.vineyardId,
    block_id: input.blockId || null,
    title: input.title,
    status: input.status,
  };

  const { data, error } = await supabase
    .from('irrigation')
    .update(row)
    .eq('id', id)
    .select(IRRIGATION_SELECT)
    .single();

  if (error) return { data: null, error };
  return { data: normaliseIrrigation(data), error: null };
}

/**
 * Delete an irrigation record by id (RLS-scoped to the owner).
 * @param {string} id
 * @returns {Promise<{ error: object|null }>}
 */
export async function deleteIrrigationRecord(id) {
  const { error } = await supabase.from('irrigation').delete().eq('id', id);
  return { error };
}

/**
 * Load the authenticated user's vineyards as options for selectors/filters.
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
