import { supabase } from './supabase';
import { getActiveOrgId } from './activeOrg';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Lab Analyte Service (P2J)
// A lab analyte is an org-scoped, extensible catalog entry describing a
// measurable quantity (pH, TA, VA, free SO2, ...). Analytes are added on demand
// (no seed catalog) and RETIRED via is_active = false — there is NO delete path
// (RESTRICT FKs from measurements would block a hard delete anyway, and history
// must be preserved). code is unique per organisation CASE-INSENSITIVELY.
//
// Reads/writes are scoped to the active organisation (.eq('org_id', activeOrgId))
// on top of organisation-based RLS (is_org_member + OWNER/ADMIN/CELLAR writes) —
// RLS remains authoritative. Creates set org_id = active org and owner_id = the
// authenticated user; neither is taken from the UI.
// Schema: supabase/migrations/027_lab_foundation.sql
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Translate a Supabase/PostgREST error into a friendly, non-technical message.
 * @param {object|null} error
 * @returns {string}
 */
export function friendlyLabAnalyteError(error) {
  if (!error) return 'Something went wrong. Please try again.';
  const code = error.code;
  const msg = (error.message || '').toLowerCase();
  if (code === '42P01' || code === 'PGRST205' || msg.includes('does not exist')) {
    return 'The laboratory database is not set up yet. Please run the latest migration.';
  }
  if (code === '23505' || msg.includes('duplicate') || msg.includes('unique')) {
    return 'An analyte with this code already exists in this organisation.';
  }
  if (code === '23514' || msg.includes('check constraint')) {
    return 'Please provide a code, display name and canonical unit.';
  }
  if (code === '23502') return 'Please fill in all required fields.';
  if (code === '42501' || msg.includes('row-level security') || msg.includes('permission')) {
    return 'You do not have permission to manage analytes. This requires an Owner, Admin or Cellar role.';
  }
  if (msg.includes('network') || msg.includes('fetch')) {
    return 'Network error. Please check your connection and try again.';
  }
  return 'Something went wrong. Please try again.';
}

// Normalise a raw lab_analytes row into camelCase.
function normalise(a) {
  if (!a) return null;
  return {
    id: a.id,
    code: a.code,
    displayName: a.display_name,
    canonicalUnit: a.canonical_unit,
    isActive: a.is_active,
    notes: a.notes,
    ownerId: a.owner_id,
    createdAt: a.created_at,
    updatedAt: a.updated_at,
  };
}

const SELECT =
  'id, code, display_name, canonical_unit, is_active, notes, owner_id, created_at, updated_at';

/**
 * Fetch the active organisation's analytes. Active analytes only by default;
 * pass { includeInactive: true } to include retired analytes. Ordered by
 * display_name then code.
 * @param {{ includeInactive?: boolean }} [options]
 * @returns {Promise<{ data: Array|null, error: object|null }>}
 */
export async function getLabAnalytes(options = {}) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: [], error: null };

  let query = supabase
    .from('lab_analytes')
    .select(SELECT)
    .eq('org_id', orgId);

  if (!options.includeInactive) query = query.eq('is_active', true);

  const { data, error } = await query
    .order('display_name', { ascending: true })
    .order('code', { ascending: true });

  if (error) return { data: null, error };
  return { data: (data || []).map(normalise), error: null };
}

/**
 * Fetch a single analyte by id (active-org scoped).
 * @param {string} id
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function getLabAnalyte(id) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  const { data, error } = await supabase
    .from('lab_analytes')
    .select(SELECT)
    .eq('id', id)
    .eq('org_id', orgId)
    .single();

  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

/**
 * Fetch lightweight analyte options for future dropdowns (active-org scoped).
 * Active analytes only by default. When editing a historical record whose
 * analyte has since been retired, pass { includeId } to additionally include
 * that one inactive analyte so it still renders in the selector.
 * @param {{ includeInactive?: boolean, includeId?: string|null }} [options]
 * @returns {Promise<{ data: Array<{ id, code, displayName, canonicalUnit, isActive }>|null, error: object|null }>}
 */
export async function getLabAnalyteOptions(options = {}) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: [], error: null };

  // Base set: active analytes (or all if includeInactive).
  let query = supabase
    .from('lab_analytes')
    .select('id, code, display_name, canonical_unit, is_active')
    .eq('org_id', orgId);

  if (!options.includeInactive) query = query.eq('is_active', true);

  const { data, error } = await query
    .order('display_name', { ascending: true })
    .order('code', { ascending: true });

  if (error) return { data: null, error };

  const toOption = (a) => ({
    id: a.id,
    code: a.code,
    displayName: a.display_name,
    canonicalUnit: a.canonical_unit,
    isActive: a.is_active,
  });

  const list = (data || []).map(toOption);

  // Optionally fold in a single explicitly-requested analyte (e.g. a retired
  // one referenced by a historical measurement being edited) if not already present.
  if (options.includeId && !list.some((o) => o.id === options.includeId)) {
    const { data: extra, error: extraError } = await supabase
      .from('lab_analytes')
      .select('id, code, display_name, canonical_unit, is_active')
      .eq('id', options.includeId)
      .eq('org_id', orgId)
      .single();
    if (!extraError && extra) list.push(toOption(extra));
  }

  return { data: list, error: null };
}

/**
 * Create an analyte in the active organisation. Sets org_id = active org and
 * owner_id = the authenticated user (never from the payload). is_active defaults
 * to true. Uniqueness of code is enforced case-insensitively by the DB.
 * @param {{ code: string, displayName: string, canonicalUnit: string,
 *   notes?: string|null }} input
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function createLabAnalyte(input) {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) {
    return { data: null, error: userError || { message: 'Not authenticated' } };
  }

  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  const code = (input.code || '').trim();
  const displayName = (input.displayName || '').trim();
  const canonicalUnit = (input.canonicalUnit || '').trim();
  if (!code) return { data: null, error: { message: 'A code is required.' } };
  if (!displayName) return { data: null, error: { message: 'A display name is required.' } };
  if (!canonicalUnit) return { data: null, error: { message: 'A canonical unit is required.' } };

  const row = {
    org_id: orgId,
    owner_id: userData.user.id,
    code,
    display_name: displayName,
    canonical_unit: canonicalUnit,
    notes: input.notes || null,
    // is_active intentionally omitted — DB default is TRUE.
  };

  const { data, error } = await supabase
    .from('lab_analytes')
    .insert(row)
    .select(SELECT)
    .single();

  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

/**
 * Update an analyte's editable metadata (active-org scoped). id, org_id and
 * owner_id are NEVER changed here (owner_id immutability is also enforced by a
 * DB trigger). is_active is NOT changed here — use deactivate/reactivate.
 * @param {string} id
 * @param {{ code?: string, displayName?: string, canonicalUnit?: string,
 *   notes?: string|null }} input
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function updateLabAnalyte(id, input) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  const row = {};
  if (input.code !== undefined) {
    const code = (input.code || '').trim();
    if (!code) return { data: null, error: { message: 'A code is required.' } };
    row.code = code;
  }
  if (input.displayName !== undefined) {
    const displayName = (input.displayName || '').trim();
    if (!displayName) return { data: null, error: { message: 'A display name is required.' } };
    row.display_name = displayName;
  }
  if (input.canonicalUnit !== undefined) {
    const canonicalUnit = (input.canonicalUnit || '').trim();
    if (!canonicalUnit) return { data: null, error: { message: 'A canonical unit is required.' } };
    row.canonical_unit = canonicalUnit;
  }
  if (input.notes !== undefined) row.notes = input.notes || null;
  // is_active intentionally NOT writable here (see deactivate/reactivate).

  const { data, error } = await supabase
    .from('lab_analytes')
    .update(row)
    .eq('id', id)
    .eq('org_id', orgId)
    .select(SELECT)
    .single();

  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

/**
 * Retire an analyte (soft-delete). Sets is_active = false; never deletes.
 * Active-org scoped.
 * @param {string} id
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function deactivateLabAnalyte(id) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  const { data, error } = await supabase
    .from('lab_analytes')
    .update({ is_active: false })
    .eq('id', id)
    .eq('org_id', orgId)
    .select(SELECT)
    .single();

  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

/**
 * Re-activate a previously retired analyte. Sets is_active = true. Active-org scoped.
 * @param {string} id
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function reactivateLabAnalyte(id) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  const { data, error } = await supabase
    .from('lab_analytes')
    .update({ is_active: true })
    .eq('id', id)
    .eq('org_id', orgId)
    .select(SELECT)
    .single();

  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

// NOTE: there is intentionally NO deleteLabAnalyte() — analytes are retired via
// deactivateLabAnalyte (is_active = false), never hard-deleted.
