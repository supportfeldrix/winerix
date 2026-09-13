import { supabase } from './supabase';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Organisation Service
// Read access to the current user's organisation memberships.
//
// Relies on the RLS-safe self-membership access path defined in
// 006_tenancy_foundation.sql: the organisation_members SELECT policy allows a
// user to read their own rows (user_id = auth.uid()), joined to the related
// organisation. No service-role access, no second Supabase client, no RLS
// bypass. Preserves the existing { data, error } service contract.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Translate a Supabase/PostgREST error into a friendly, non-technical message.
 * @param {object|null} error
 * @returns {string}
 */
export function friendlyOrganisationError(error) {
  if (!error) return 'Something went wrong. Please try again.';
  const code = error.code;
  const msg = (error.message || '').toLowerCase();
  if (code === '42P01' || code === 'PGRST205' || msg.includes('does not exist')) {
    return 'The organisation database is not set up yet. Please run the latest migration.';
  }
  if (code === '42501' || msg.includes('row-level security') || msg.includes('permission')) {
    return 'You do not have permission to view organisations.';
  }
  if (msg.includes('network') || msg.includes('fetch')) {
    return 'Network error. Please check your connection and try again.';
  }
  return 'Something went wrong. Please try again.';
}

// Normalise a raw organisations row into the app's camelCase shape.
function normaliseOrganisation(o) {
  if (!o) return null;
  return {
    id: o.id,
    name: o.name,
    slug: o.slug,
    type: o.type,
    isPersonal: o.is_personal,
    createdBy: o.created_by,
    createdAt: o.created_at,
    updatedAt: o.updated_at,
  };
}

// Nested select: the membership row plus its related organisation.
const SELECT =
  'role, status, org_id, ' +
  'organisation:organisations(id, name, slug, type, is_personal, created_by, created_at, updated_at)';

/**
 * Fetch the current authenticated user's ACTIVE organisation memberships,
 * each with its related organisation.
 *
 * Reads are scoped by RLS to the current user's own membership rows. Only
 * active memberships are returned.
 *
 * @returns {Promise<{ data: Array|null, error: object|null }>}
 *   data shape:
 *     [{ organisation: {...}, role: 'OWNER', status: 'active' }, ...]
 */
export async function getMyOrganisations() {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) {
    return { data: null, error: userError || { message: 'Not authenticated' } };
  }

  const { data, error } = await supabase
    .from('organisation_members')
    .select(SELECT)
    .eq('user_id', userData.user.id)
    .eq('status', 'active')
    .order('created_at', { ascending: true });

  if (error) return { data: null, error };

  const memberships = (data || [])
    // Guard against any row whose joined organisation is not visible.
    .filter((m) => m.organisation)
    .map((m) => ({
      organisation: normaliseOrganisation(m.organisation),
      role: m.role,
      status: m.status,
    }));

  return { data: memberships, error: null };
}
