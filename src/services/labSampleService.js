import { supabase } from './supabase';
import { getActiveOrgId } from './activeOrg';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Lab Sample Service (P2J)
// A lab sample is a sample drawn from exactly one wine lot at a point in time:
// Wine Lot -> Lab Sample. sample_type is the PURPOSE / PROCESS STAGE of the
// sample; status is its QUALITY / REVIEW STATE. Lineage (batch / intake /
// harvest / planting / cultivar / block / vineyard / vessel) is DERIVED via the
// wine lot and is NEVER duplicated here. Samples are NOT deleted (history is
// preserved; measurements RESTRICT a hard delete anyway) — there is no delete path.
//
// Reads/writes are scoped to the active organisation (.eq('org_id', activeOrgId))
// on top of organisation-based RLS (is_org_member + OWNER/ADMIN/CELLAR writes).
// Creates set org_id = active org and owner_id = the authenticated user; neither
// is taken from the UI. wine_lot_id is the sample's origin: set on create, never
// changed on update.
// Schema: supabase/migrations/027_lab_foundation.sql
// ─────────────────────────────────────────────────────────────────────────────

// Controlled sample-type vocabulary (purpose / process stage). DB-approved set.
export const LAB_SAMPLE_TYPES = [
  { value: 'fermentation', label: 'Fermentation' },
  { value: 'maturation', label: 'Maturation' },
  { value: 'pre_filtration', label: 'Pre-filtration' },
  { value: 'pre_bottling', label: 'Pre-bottling' },
  { value: 'release', label: 'Release' },
  { value: 'other', label: 'Other' },
];

// Controlled sample-status vocabulary (quality / review state). DB-approved set.
export const LAB_SAMPLE_STATUSES = [
  { value: 'pending', label: 'Pending' },
  { value: 'within_spec', label: 'Within Spec' },
  { value: 'attention', label: 'Attention' },
  { value: 'hold', label: 'Hold' },
  { value: 'released', label: 'Released' },
];

// Human labels for display.
export function labSampleTypeLabel(type) {
  const found = LAB_SAMPLE_TYPES.find((t) => t.value === type);
  return found ? found.label : type || '—';
}
export function labSampleStatusLabel(status) {
  const found = LAB_SAMPLE_STATUSES.find((s) => s.value === status);
  return found ? found.label : status || '—';
}

/**
 * Translate a Supabase/PostgREST error into a friendly, non-technical message.
 * @param {object|null} error
 * @returns {string}
 */
export function friendlyLabSampleError(error) {
  if (!error) return 'Something went wrong. Please try again.';
  const code = error.code;
  const msg = (error.message || '').toLowerCase();
  if (code === '42P01' || code === 'PGRST205' || msg.includes('does not exist')) {
    return 'The laboratory database is not set up yet. Please run the latest migration.';
  }
  if (code === '23505' || msg.includes('duplicate') || msg.includes('unique')) {
    return 'A sample with this code already exists in this organisation.';
  }
  if (msg.includes('cross-organisation')) {
    return 'The selected wine lot belongs to a different organisation.';
  }
  if (msg.includes('invalid wine lot')) return 'The wine lot could not be found.';
  if (code === '23514' || msg.includes('check constraint')) {
    return 'Please choose a valid sample type and status.';
  }
  if (code === '23503' || msg.includes('foreign key')) {
    return 'The wine lot could not be found.';
  }
  if (code === '23502') return 'Please fill in all required fields.';
  if (code === '42501' || msg.includes('row-level security') || msg.includes('permission')) {
    return 'You do not have permission to manage lab samples. This requires an Owner, Admin or Cellar role.';
  }
  if (msg.includes('network') || msg.includes('fetch')) {
    return 'Network error. Please check your connection and try again.';
  }
  return 'Something went wrong. Please try again.';
}

// Normalise a raw lab_samples row (with optional joined wine-lot context) into camelCase.
function normalise(s) {
  if (!s) return null;
  const lot = s.wine_lot || null;
  return {
    id: s.id,
    wineLotId: s.wine_lot_id,
    sampleCode: s.sample_code,
    sampleType: s.sample_type,
    status: s.status,
    sampledAt: s.sampled_at,
    reviewedBy: s.reviewed_by,
    reviewedAt: s.reviewed_at,
    notes: s.notes,
    ownerId: s.owner_id,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
    // Derived wine-lot context (read-only). No deeper lineage is duplicated here.
    lotCode: lot ? lot.lot_code : null,
    lotStatus: lot ? lot.status : null,
  };
}

const SELECT_BASE =
  'id, wine_lot_id, sample_code, sample_type, status, sampled_at, reviewed_by, reviewed_at, notes, owner_id, created_at, updated_at';

// With the related wine-lot reference needed for display/traceability (the lot
// is the entry point to the existing traceability chain — nothing is duplicated).
const SELECT_WITH_LOT =
  SELECT_BASE + ', wine_lot:wine_lots(id, lot_code, status)';

/**
 * Fetch the active organisation's lab samples, newest sampled_at first.
 * Supports optional filters: wineLotId, sampleType, status, and a sampled_at
 * date range (dateFrom / dateTo, inclusive, ISO timestamps).
 * @param {{ wineLotId?: string, sampleType?: string, status?: string,
 *   dateFrom?: string, dateTo?: string }} [options]
 * @returns {Promise<{ data: Array|null, error: object|null }>}
 */
export async function getLabSamples(options = {}) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: [], error: null };

  let query = supabase
    .from('lab_samples')
    .select(SELECT_WITH_LOT)
    .eq('org_id', orgId);

  if (options.wineLotId) query = query.eq('wine_lot_id', options.wineLotId);
  if (options.sampleType) query = query.eq('sample_type', options.sampleType);
  if (options.status) query = query.eq('status', options.status);
  if (options.dateFrom) query = query.gte('sampled_at', options.dateFrom);
  if (options.dateTo) query = query.lte('sampled_at', options.dateTo);

  const { data, error } = await query
    .order('sampled_at', { ascending: false })
    .order('created_at', { ascending: false });

  if (error) return { data: null, error };
  return { data: (data || []).map(normalise), error: null };
}

/**
 * Fetch a single lab sample by id (active-org scoped), including the related
 * wine-lot reference needed for display/traceability.
 * @param {string} id
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function getLabSample(id) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  const { data, error } = await supabase
    .from('lab_samples')
    .select(SELECT_WITH_LOT)
    .eq('id', id)
    .eq('org_id', orgId)
    .single();

  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

/**
 * Fetch the active organisation's lab samples for a single wine lot, newest first.
 * @param {string} wineLotId
 * @returns {Promise<{ data: Array|null, error: object|null }>}
 */
export async function getLabSamplesByWineLot(wineLotId) {
  const orgId = getActiveOrgId();
  if (!orgId || !wineLotId) return { data: [], error: null };

  const { data, error } = await supabase
    .from('lab_samples')
    .select(SELECT_WITH_LOT)
    .eq('org_id', orgId)
    .eq('wine_lot_id', wineLotId)
    .order('sampled_at', { ascending: false })
    .order('created_at', { ascending: false });

  if (error) return { data: null, error };
  return { data: (data || []).map(normalise), error: null };
}

/**
 * Create a lab sample in the active organisation. Sets org_id = active org and
 * owner_id = the authenticated user (never from the payload). status defaults to
 * 'pending'. wine_lot_id is the sample's origin; the DB cross-org trigger is the
 * authoritative same-org guard.
 * @param {{ wineLotId: string, sampleCode: string, sampleType: string,
 *   sampledAt: string, status?: string, notes?: string|null }} input
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function createLabSample(input) {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) {
    return { data: null, error: userError || { message: 'Not authenticated' } };
  }

  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };
  if (!input.wineLotId) return { data: null, error: { message: 'A wine lot is required.' } };
  if (!input.sampleType) return { data: null, error: { message: 'A sample type is required.' } };
  if (!input.sampledAt) return { data: null, error: { message: 'A sampled-at date is required.' } };

  const row = {
    org_id: orgId,
    owner_id: userData.user.id,
    wine_lot_id: input.wineLotId,
    sample_code: input.sampleCode ?? null,
    sample_type: input.sampleType,
    status: input.status || 'pending',
    sampled_at: input.sampledAt,
    notes: input.notes || null,
  };

  const { data, error } = await supabase
    .from('lab_samples')
    .insert(row)
    .select(SELECT_WITH_LOT)
    .single();

  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

/**
 * Update a lab sample's editable fields (active-org scoped). id, org_id,
 * owner_id and wine_lot_id are NEVER changed here (owner_id immutability is also
 * enforced by a DB trigger; wine_lot_id is the sample's origin).
 * @param {string} id
 * @param {{ sampleCode?: string|null, sampleType?: string, status?: string,
 *   sampledAt?: string, notes?: string|null, reviewedBy?: string|null,
 *   reviewedAt?: string|null }} input
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function updateLabSample(id, input) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  const row = {};
  if (input.sampleCode !== undefined) row.sample_code = input.sampleCode || null;
  if (input.sampleType !== undefined) row.sample_type = input.sampleType;
  if (input.status !== undefined) row.status = input.status;
  if (input.sampledAt !== undefined) row.sampled_at = input.sampledAt;
  if (input.notes !== undefined) row.notes = input.notes || null;
  if (input.reviewedBy !== undefined) row.reviewed_by = input.reviewedBy || null;
  if (input.reviewedAt !== undefined) row.reviewed_at = input.reviewedAt || null;

  const { data, error } = await supabase
    .from('lab_samples')
    .update(row)
    .eq('id', id)
    .eq('org_id', orgId)
    .select(SELECT_WITH_LOT)
    .single();

  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

/**
 * Lifecycle helper: set a sample's quality/review status (active-org scoped).
 * @param {string} id
 * @param {string} status  one of LAB_SAMPLE_STATUSES
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function updateLabSampleStatus(id, status) {
  if (!status) return { data: null, error: { message: 'A status is required.' } };
  return updateLabSample(id, { status });
}

/**
 * Lifecycle helper: record a review on a sample — who reviewed it, when, and the
 * resulting status — in a single update (active-org scoped). reviewedAt defaults
 * to now when omitted.
 * @param {string} id
 * @param {string} reviewedBy  reviewing user's id
 * @param {string|null} [reviewedAt]  ISO timestamp; defaults to now
 * @param {string} status  resulting status (one of LAB_SAMPLE_STATUSES)
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function reviewLabSample(id, reviewedBy, reviewedAt, status) {
  if (!status) return { data: null, error: { message: 'A resulting status is required.' } };
  return updateLabSample(id, {
    reviewedBy: reviewedBy || null,
    reviewedAt: reviewedAt || new Date().toISOString(),
    status,
  });
}

// NOTE: there is intentionally NO deleteLabSample() — samples carry quality /
// review history and are never hard-deleted.
