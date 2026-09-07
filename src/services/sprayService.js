import { supabase } from './supabase';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Spray Programme Service
// Data access for spray programme records (spraying activities across vineyards
// and blocks).
//
// All reads rely on Supabase Row Level Security: each row is scoped to the
// authenticated user via `auth.uid() = owner_id`, so these queries only ever
// return the current user's data. No manual user filtering is required and no
// second Supabase client is created.
// Schema: supabase/migrations/004_spray_programme.sql
// ─────────────────────────────────────────────────────────────────────────────

// Allowed spray programme statuses (shared with the form/filters). The `status`
// column is free TEXT in the schema; these are the supported values the app
// writes.
export const SPRAY_PROGRAMME_STATUSES = [
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
export function friendlySprayProgrammeError(error) {
  if (!error) return 'Something went wrong. Please try again.';

  const code = error.code;
  const msg = (error.message || '').toLowerCase();

  if (code === '42P01' || code === 'PGRST205' || msg.includes('does not exist')) {
    return 'The spray programme database is not set up yet. Please run the latest migration.';
  }
  if (code === '23503' || msg.includes('foreign key')) {
    return 'The selected vineyard or block could not be found. Please choose valid options.';
  }
  if (code === '23505' || msg.includes('duplicate')) {
    return 'A spray programme with these details already exists.';
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

// Normalise a raw Supabase spray programme row (with optional nested
// vineyard/block) into the app's camelCase shape.
function normaliseSprayProgramme(r) {
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

// Columns selected for a spray programme record, including related vineyard and
// block names via the spray_programme.vineyard_id -> vineyards.id and
// spray_programme.block_id -> blocks.id foreign keys.
const SPRAY_SELECT =
  'id, vineyard_id, block_id, title, status, created_at, updated_at, ' +
  'vineyard:vineyards(id, name), block:blocks(id, name)';

/**
 * Fetch the authenticated user's spray programmes, each with vineyard/block
 * names.
 * @returns {Promise<{ data: Array|null, error: object|null }>}
 */
export async function getSprayProgrammes() {
  const { data, error } = await supabase
    .from('spray_programme')
    .select(SPRAY_SELECT)
    .order('created_at', { ascending: false });

  if (error) return { data: null, error };
  return { data: (data || []).map(normaliseSprayProgramme), error: null };
}

/**
 * Fetch the authenticated user's spray programmes for a single vineyard.
 * @param {string} vineyardId
 * @returns {Promise<{ data: Array|null, error: object|null }>}
 */
export async function getSprayProgrammesByVineyard(vineyardId) {
  const { data, error } = await supabase
    .from('spray_programme')
    .select(SPRAY_SELECT)
    .eq('vineyard_id', vineyardId)
    .order('created_at', { ascending: false });

  if (error) return { data: null, error };
  return { data: (data || []).map(normaliseSprayProgramme), error: null };
}

/**
 * Fetch the authenticated user's spray programmes for a single block.
 * @param {string} blockId
 * @returns {Promise<{ data: Array|null, error: object|null }>}
 */
export async function getSprayProgrammesByBlock(blockId) {
  const { data, error } = await supabase
    .from('spray_programme')
    .select(SPRAY_SELECT)
    .eq('block_id', blockId)
    .order('created_at', { ascending: false });

  if (error) return { data: null, error };
  return { data: (data || []).map(normaliseSprayProgramme), error: null };
}

/**
 * Fetch a single spray programme by id (RLS-scoped) with vineyard/block names.
 * @param {string} id
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function getSprayProgramme(id) {
  const { data, error } = await supabase
    .from('spray_programme')
    .select(SPRAY_SELECT)
    .eq('id', id)
    .single();

  if (error) return { data: null, error };
  return { data: normaliseSprayProgramme(data), error: null };
}

/**
 * Create a spray programme owned by the authenticated user.
 * Sets owner_id to the current user's id to satisfy the RLS WITH CHECK policy.
 * @param {{ title: string, vineyardId: string, blockId?: string|null, status?: string }} input
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function createSprayProgramme(input) {
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
    .from('spray_programme')
    .insert(row)
    .select(SPRAY_SELECT)
    .single();

  if (error) return { data: null, error };
  return { data: normaliseSprayProgramme(data), error: null };
}

/**
 * Update an existing spray programme (RLS-scoped to the owner).
 * @param {string} id
 * @param {{ title?: string, vineyardId?: string, blockId?: string|null, status?: string }} input
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function updateSprayProgramme(id, input) {
  const row = {
    vineyard_id: input.vineyardId,
    block_id: input.blockId || null,
    title: input.title,
    status: input.status,
  };

  const { data, error } = await supabase
    .from('spray_programme')
    .update(row)
    .eq('id', id)
    .select(SPRAY_SELECT)
    .single();

  if (error) return { data: null, error };
  return { data: normaliseSprayProgramme(data), error: null };
}

/**
 * Delete a spray programme by id (RLS-scoped to the owner).
 * @param {string} id
 * @returns {Promise<{ error: object|null }>}
 */
export async function deleteSprayProgramme(id) {
  const { error } = await supabase.from('spray_programme').delete().eq('id', id);
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
