import { supabase } from './supabase';
import { getActiveOrgId } from './activeOrg';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Grape Intake Service (first cellar increment)
// A grape intake is one received delivery/load of grapes at the cellar,
// originating from a harvest: Harvest -> Grape Intake. Vineyard/block/planting/
// cultivar are DERIVED via the harvest and are never duplicated here.
//
// Reads/writes are scoped to the active organisation (.eq('org_id', activeOrgId))
// on top of organisation-based RLS (is_org_member(org_id)) — RLS + the DB
// cross-org integrity trigger remain authoritative. Creates set org_id = active
// org and owner_id = the authenticated user; neither is taken from the UI.
// Schema: supabase/migrations/014_grape_intakes.sql
// ─────────────────────────────────────────────────────────────────────────────

// Allowed grape-intake statuses (shared with the form UI). P2B: exactly these.
export const INTAKE_STATUSES = [
  { value: 'received', label: 'Received' },
  { value: 'processed', label: 'Processed' },
  { value: 'rejected', label: 'Rejected' },
];

/**
 * Translate a Supabase/PostgREST error into a friendly, non-technical message.
 * Recognises the cross-organisation integrity trigger's messages.
 * @param {object|null} error
 * @returns {string}
 */
export function friendlyIntakeError(error) {
  if (!error) return 'Something went wrong. Please try again.';
  const code = error.code;
  const msg = (error.message || '').toLowerCase();
  if (code === '42P01' || code === 'PGRST205' || msg.includes('does not exist')) {
    return 'The grape intake database is not set up yet. Please run the latest migration.';
  }
  if (msg.includes('cross-organisation')) {
    return 'This harvest belongs to a different organisation.';
  }
  if (msg.includes('invalid harvest')) return 'The harvest could not be found.';
  if (code === '23514' || msg.includes('check constraint')) {
    return 'Please provide a valid received weight and status.';
  }
  if (code === '23503' || msg.includes('foreign key')) {
    return 'The harvest could not be found.';
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

// Normalise a raw Supabase grape_intake row into the app's camelCase shape.
function normalise(i) {
  if (!i) return null;
  return {
    id: i.id,
    harvestId: i.harvest_id,
    intakeDate: i.intake_date,
    receivedKg: i.received_kg,
    status: i.status,
    notes: i.notes,
    createdAt: i.created_at,
    updatedAt: i.updated_at,
  };
}

const SELECT =
  'id, harvest_id, intake_date, received_kg, status, notes, created_at, updated_at';

/**
 * Fetch the active organisation's grape intakes for a single harvest.
 * Ordered by intake date (then creation).
 * @param {string} harvestId
 * @returns {Promise<{ data: Array|null, error: object|null }>}
 */
export async function getIntakesByHarvest(harvestId) {
  const orgId = getActiveOrgId();
  if (!orgId || !harvestId) return { data: [], error: null };

  const { data, error } = await supabase
    .from('grape_intakes')
    .select(SELECT)
    .eq('org_id', orgId)
    .eq('harvest_id', harvestId)
    .order('intake_date', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: true });

  if (error) return { data: null, error };
  return { data: (data || []).map(normalise), error: null };
}

/**
 * Fetch a single grape intake by id (active-org scoped).
 * @param {string} id
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function getIntake(id) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  const { data, error } = await supabase
    .from('grape_intakes')
    .select(SELECT)
    .eq('id', id)
    .eq('org_id', orgId)
    .single();

  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

/**
 * Create a grape intake against a harvest in the active organisation.
 * Sets org_id = active org and owner_id = the authenticated user (never from
 * the payload). The DB cross-org trigger is the authoritative same-org guard.
 * @param {{ harvestId: string, intakeDate?: string|null, receivedKg?: number|null,
 *   status?: string, notes?: string|null }} input
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function createIntake(input) {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) {
    return { data: null, error: userError || { message: 'Not authenticated' } };
  }

  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  if (!input.harvestId) return { data: null, error: { message: 'A harvest is required.' } };

  const row = {
    org_id: orgId,
    owner_id: userData.user.id,
    harvest_id: input.harvestId,
    intake_date: input.intakeDate || null,
    received_kg: input.receivedKg ?? null,
    status: input.status || 'received',
    notes: input.notes || null,
  };

  const { data, error } = await supabase
    .from('grape_intakes')
    .insert(row)
    .select(SELECT)
    .single();

  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

/**
 * Update an existing grape intake (active-org scoped). org_id, owner_id and
 * harvest_id are never changed here (owner_id immutability is also enforced by
 * a DB trigger; the harvest link is fixed once created).
 * @param {string} id
 * @param {{ intakeDate?: string|null, receivedKg?: number|null, status?: string,
 *   notes?: string|null }} input
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function updateIntake(id, input) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  const row = {};
  if (input.intakeDate !== undefined) row.intake_date = input.intakeDate || null;
  if (input.receivedKg !== undefined) row.received_kg = input.receivedKg ?? null;
  if (input.status !== undefined) row.status = input.status;
  if (input.notes !== undefined) row.notes = input.notes || null;

  const { data, error } = await supabase
    .from('grape_intakes')
    .update(row)
    .eq('id', id)
    .eq('org_id', orgId)
    .select(SELECT)
    .single();

  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

/**
 * Convenience status transitions (active-org scoped, via updateIntake).
 */
export async function markIntakeProcessed(id) {
  return updateIntake(id, { status: 'processed' });
}

export async function markIntakeRejected(id) {
  return updateIntake(id, { status: 'rejected' });
}

/**
 * Physically delete a grape intake (active-org scoped). Restricted to
 * correcting just-created mistakes — the UI does not surface this as a normal
 * action. Status changes (received/processed/rejected) are the lifecycle path.
 * @param {string} id
 * @returns {Promise<{ error: object|null }>}
 */
export async function deleteIntake(id) {
  const orgId = getActiveOrgId();
  if (!orgId) return { error: { message: 'No active organisation' } };
  const { error } = await supabase
    .from('grape_intakes')
    .delete()
    .eq('id', id)
    .eq('org_id', orgId);
  return { error };
}

/**
 * Sum received_kg across a set of normalised intakes (ignoring NULLs).
 * @param {Array} intakes
 * @returns {number}
 */
export function totalReceivedKg(intakes) {
  return (intakes || []).reduce((s, i) => s + (Number(i.receivedKg) || 0), 0);
}
