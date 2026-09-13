import { supabase } from './supabase';
import { getActiveOrgId } from './activeOrg';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Cultivar Service
// Organisation-owned master/reference data (grape varieties).
//
// Reads are scoped to the active organisation (.eq('org_id', activeOrgId)) on
// top of organisation-based RLS (is_org_member(org_id)) — RLS remains the
// authoritative boundary. Creates set org_id = active org and created_by =
// the authenticated user; org_id/created_by are never taken from the UI.
// Cultivars are reference data: the UI prefers DEACTIVATION (is_active=false)
// over physical deletion. Schema: supabase/migrations/011_cultivars.sql
// ─────────────────────────────────────────────────────────────────────────────

// Allowed cultivar colours (shared with the form UI). The `colour` column is
// nullable TEXT with a CHECK; these are the supported values.
export const CULTIVAR_COLOURS = [
  { value: 'red', label: 'Red' },
  { value: 'white', label: 'White' },
  { value: 'rosé', label: 'Rosé' },
  { value: 'other', label: 'Other' },
];

/**
 * Translate a Supabase/PostgREST error into a friendly, non-technical message.
 * @param {object|null} error
 * @returns {string}
 */
export function friendlyCultivarError(error) {
  if (!error) return 'Something went wrong. Please try again.';
  const code = error.code;
  const msg = (error.message || '').toLowerCase();
  if (code === '42P01' || code === 'PGRST205' || msg.includes('does not exist')) {
    return 'The cultivar database is not set up yet. Please run the latest migration.';
  }
  if (code === '23505' || msg.includes('duplicate') || msg.includes('unique')) {
    return 'A cultivar with this name already exists in this organisation.';
  }
  if (code === '23514' || msg.includes('check constraint')) {
    return 'Please provide a valid cultivar name and colour.';
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

// Normalise a raw Supabase cultivar row into the app's camelCase shape.
function normalise(c) {
  if (!c) return null;
  return {
    id: c.id,
    name: c.name,
    colour: c.colour,
    isActive: c.is_active,
    createdBy: c.created_by,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
  };
}

const SELECT = 'id, name, colour, is_active, created_by, created_at, updated_at';

/**
 * Fetch the active organisation's cultivars (all statuses), name-ordered.
 * @returns {Promise<{ data: Array|null, error: object|null }>}
 */
export async function getCultivars() {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: [], error: null };

  const { data, error } = await supabase
    .from('cultivars')
    .select(SELECT)
    .eq('org_id', orgId)
    .order('name', { ascending: true });

  if (error) return { data: null, error };
  return { data: (data || []).map(normalise), error: null };
}

/**
 * Fetch a single cultivar by id (active-org scoped).
 * @param {string} id
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function getCultivar(id) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  const { data, error } = await supabase
    .from('cultivars')
    .select(SELECT)
    .eq('id', id)
    .eq('org_id', orgId)
    .single();

  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

/**
 * Fetch active cultivars as options for selectors (e.g. the future planting
 * form). Only active cultivars are returned. Active-org scoped.
 * @returns {Promise<{ data: Array<{ id, name, colour }>|null, error: object|null }>}
 */
export async function getCultivarOptions() {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: [], error: null };

  const { data, error } = await supabase
    .from('cultivars')
    .select('id, name, colour')
    .eq('org_id', orgId)
    .eq('is_active', true)
    .order('name', { ascending: true });

  if (error) return { data: null, error };
  return { data: data || [], error: null };
}

/**
 * Create a cultivar in the active organisation.
 * Sets org_id = active org and created_by = the authenticated user to satisfy
 * RLS; never trusts org_id/created_by from the payload.
 * @param {{ name: string, colour?: string|null, isActive?: boolean }} input
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function createCultivar(input) {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) {
    return { data: null, error: userError || { message: 'Not authenticated' } };
  }

  const orgId = getActiveOrgId();
  if (!orgId) {
    return { data: null, error: { message: 'No active organisation' } };
  }

  const row = {
    org_id: orgId,
    created_by: userData.user.id,
    name: input.name,
    colour: input.colour || null,
    is_active: input.isActive ?? true,
  };

  const { data, error } = await supabase
    .from('cultivars')
    .insert(row)
    .select(SELECT)
    .single();

  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

/**
 * Update an existing cultivar (active-org scoped). org_id and created_by are
 * never changed (created_by immutability is also enforced by a DB trigger).
 * @param {string} id
 * @param {{ name?: string, colour?: string|null, isActive?: boolean }} input
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function updateCultivar(id, input) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  const row = {};
  if (input.name !== undefined) row.name = input.name;
  if (input.colour !== undefined) row.colour = input.colour || null;
  if (input.isActive !== undefined) row.is_active = input.isActive;

  const { data, error } = await supabase
    .from('cultivars')
    .update(row)
    .eq('id', id)
    .eq('org_id', orgId)
    .select(SELECT)
    .single();

  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

/**
 * Deactivate a cultivar (soft-remove: is_active = false). Preferred over
 * physical deletion for reference data. Active-org scoped.
 * @param {string} id
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function deactivateCultivar(id) {
  return updateCultivar(id, { isActive: false });
}

/**
 * Reactivate a previously deactivated cultivar. Active-org scoped.
 * @param {string} id
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function reactivateCultivar(id) {
  return updateCultivar(id, { isActive: true });
}
