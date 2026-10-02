import { supabase } from './supabase';
import { getActiveOrgId } from './activeOrg';
import { LAB_SAMPLE_TYPES, labSampleTypeLabel } from './labSampleService';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Lab Specification Service (P2J-10)
// A lab specification is an organisation's INTERNAL laboratory/quality rule
// stating the expected range/target for ONE analyte at ONE process stage
// (sample_type), valid over a period of time:
//     lab_analyte + sample_type -> lab_specification (expected range)
//
// Single-table, time-sliced versioning: a replacement is a NEW row whose
// supersedes_id points at the retired row; the retired row is set is_active =
// false (+ effective_to). The DB partial unique index guarantees at most ONE
// "current" spec (is_active = true AND effective_to IS NULL) per
// (org, analyte, sample_type) — that constraint, not the client, is the final
// guard against two current specifications.
//
// Reads/writes are scoped to the active organisation (.eq('org_id', activeOrgId))
// on top of organisation-based RLS (is_org_member + OWNER/ADMIN/CELLAR writes).
// Creates set org_id = active org and owner_id = the authenticated user; neither
// is taken from the caller. unit is a SNAPSHOT of the analyte's canonical unit —
// never converted, never silently overwritten. There is intentionally NO delete.
// Schema: supabase/migrations/029_lab_specifications.sql
// ─────────────────────────────────────────────────────────────────────────────

// Re-export the shared sample-type vocabulary so callers don't duplicate it.
export { LAB_SAMPLE_TYPES, labSampleTypeLabel };

/**
 * Translate a Supabase/PostgREST error into a friendly, non-technical message.
 * @param {object|null} error
 * @returns {string}
 */
export function labSpecificationError(error) {
  if (!error) return 'Something went wrong. Please try again.';
  const code = error.code;
  const msg = (error.message || '').toLowerCase();
  const details = (error.details || '').toLowerCase();
  if (code === '42P01' || code === 'PGRST205' || msg.includes('does not exist')) {
    return 'The laboratory specifications database is not set up yet. Please run the latest migration.';
  }
  // Unique current-specification conflict (partial unique index).
  if (
    code === '23505' || msg.includes('duplicate') || msg.includes('unique') ||
    msg.includes('uq_lab_specifications_current') || details.includes('uq_lab_specifications_current')
  ) {
    return 'There is already a current specification for this analyte and sample type. Retire or supersede it first.';
  }
  if (msg.includes('cross-organisation')) {
    return 'The selected analyte or specification belongs to a different organisation.';
  }
  if (msg.includes('invalid lab analyte')) return 'The analyte could not be found.';
  if (msg.includes('invalid superseded specification')) return 'The specification being superseded could not be found.';
  // CHECK constraints: name/unit blank, sample_type, has_value, min<=max, self-supersede.
  if (code === '23514' || msg.includes('check constraint') ||
      msg.includes('lab_specifications_min_le_max') || details.includes('lab_specifications_min_le_max')) {
    if (msg.includes('min_le_max') || details.includes('min_le_max')) {
      return 'The minimum value cannot be greater than the maximum value.';
    }
    if (msg.includes('has_value') || details.includes('has_value')) {
      return 'Provide at least one of minimum, maximum or target value.';
    }
    if (msg.includes('sample_type') || details.includes('sample_type')) {
      return 'Please choose a valid sample type.';
    }
    return 'Please provide a valid name, unit and value range.';
  }
  if (code === '23503' || msg.includes('foreign key')) {
    return 'The selected analyte or superseded specification could not be found.';
  }
  if (code === '23502') return 'Please fill in all required fields.';
  if (code === '42501' || msg.includes('row-level security') || msg.includes('permission')) {
    return 'You do not have permission to manage specifications. This requires an Owner, Admin or Cellar role.';
  }
  if (msg.includes('network') || msg.includes('fetch')) {
    return 'Network error. Please check your connection and try again.';
  }
  return 'Something went wrong. Please try again.';
}

// Normalise a raw lab_specifications row (with optional joined analyte context).
function normalise(s) {
  if (!s) return null;
  const analyte = s.lab_analyte || null;
  return {
    id: s.id,
    labAnalyteId: s.lab_analyte_id,
    sampleType: s.sample_type,
    name: s.name,
    minValue: s.min_value,
    maxValue: s.max_value,
    targetValue: s.target_value,
    // The specification's OWN stored unit snapshot (not re-derived from analyte).
    unit: s.unit,
    effectiveFrom: s.effective_from,
    effectiveTo: s.effective_to,
    isActive: s.is_active,
    supersedesId: s.supersedes_id,
    notes: s.notes,
    ownerId: s.owner_id,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
    // Derived analyte context (read-only). analyteCanonicalUnit is the analyte's
    // CURRENT unit and is distinct from the spec's snapshot `unit`.
    analyteCode: analyte ? analyte.code : null,
    analyteDisplayName: analyte ? analyte.display_name : null,
    analyteCanonicalUnit: analyte ? analyte.canonical_unit : null,
    analyteIsActive: analyte ? analyte.is_active : null,
  };
}

const SELECT_BASE =
  'id, org_id, owner_id, lab_analyte_id, sample_type, name, min_value, max_value, target_value, ' +
  'unit, effective_from, effective_to, is_active, supersedes_id, notes, created_at, updated_at';

// With analyte context for display. The join resolves the analyte even when it
// has since been deactivated (historical specs still display their analyte).
const SELECT_WITH_ANALYTE =
  SELECT_BASE + ', lab_analyte:lab_analytes(id, code, display_name, canonical_unit, is_active)';

/**
 * Fetch the active organisation's specifications (with analyte context).
 * Options:
 *   analyteId      — filter to one analyte
 *   sampleType     — filter to one sample type
 *   activeOnly     — only is_active = true
 *   includeExpired — when false (default), exclude rows with effective_to set
 *                    (i.e. only open-ended rows); when true, include them
 *   search         — client-side substring match on name / analyte code / display name
 * Ordered by analyte display name, sample type, then newest effective_from.
 * @param {{ analyteId?: string, sampleType?: string, activeOnly?: boolean,
 *   includeExpired?: boolean, search?: string }} [options]
 * @returns {Promise<{ data: Array|null, error: object|null }>}
 */
export async function getLabSpecifications(options = {}) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: [], error: null };

  let query = supabase
    .from('lab_specifications')
    .select(SELECT_WITH_ANALYTE)
    .eq('org_id', orgId);

  if (options.analyteId) query = query.eq('lab_analyte_id', options.analyteId);
  if (options.sampleType) query = query.eq('sample_type', options.sampleType);
  if (options.activeOnly) query = query.eq('is_active', true);
  if (!options.includeExpired) query = query.is('effective_to', null);

  const { data, error } = await query
    .order('effective_from', { ascending: false })
    .order('created_at', { ascending: false });

  if (error) return { data: null, error };

  let rows = (data || []).map(normalise);

  // Client-side search (simple substring over name / analyte code / display name),
  // mirroring the lightweight filtering style used by the other lab UIs.
  const q = (options.search || '').trim().toLowerCase();
  if (q) {
    rows = rows.filter((r) =>
      (r.name || '').toLowerCase().includes(q) ||
      (r.analyteCode || '').toLowerCase().includes(q) ||
      (r.analyteDisplayName || '').toLowerCase().includes(q)
    );
  }

  // Stable, readable ordering: analyte name, then sample type, then newest first
  // (the DB already ordered by effective_from DESC within the result set).
  rows.sort((a, b) => {
    const an = (a.analyteDisplayName || a.analyteCode || '').toLowerCase();
    const bn = (b.analyteDisplayName || b.analyteCode || '').toLowerCase();
    if (an !== bn) return an < bn ? -1 : 1;
    if (a.sampleType !== b.sampleType) return a.sampleType < b.sampleType ? -1 : 1;
    return 0; // preserve the DB effective_from DESC order within the same group
  });

  return { data: rows, error: null };
}

/**
 * Fetch a single specification by id (active-org scoped), with analyte context.
 * @param {string} id
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function getLabSpecification(id) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  const { data, error } = await supabase
    .from('lab_specifications')
    .select(SELECT_WITH_ANALYTE)
    .eq('id', id)
    .eq('org_id', orgId)
    .single();

  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

/**
 * Fetch the CURRENT active specification for an analyte + sample type
 * (active-org scoped). "Current" is defined by state, NOT by date arithmetic:
 * is_active = true AND effective_to IS NULL. The DB partial unique index means
 * at most one such row exists, so this uses maybeSingle semantics (0 or 1).
 * @param {string} labAnalyteId
 * @param {string} sampleType
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function getCurrentLabSpecification(labAnalyteId, sampleType) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };
  if (!labAnalyteId) return { data: null, error: { message: 'An analyte is required.' } };
  if (!sampleType) return { data: null, error: { message: 'A sample type is required.' } };

  const { data, error } = await supabase
    .from('lab_specifications')
    .select(SELECT_WITH_ANALYTE)
    .eq('org_id', orgId)
    .eq('lab_analyte_id', labAnalyteId)
    .eq('sample_type', sampleType)
    .eq('is_active', true)
    .is('effective_to', null)
    .maybeSingle();

  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

/**
 * Fetch lightweight specification options for future UI selectors (active-org
 * scoped). Current (active, open-ended) specs only by default — pass
 * includeExpired/activeOnly via the same semantics as getLabSpecifications.
 * @param {{ analyteId?: string, sampleType?: string, activeOnly?: boolean,
 *   includeExpired?: boolean }} [options]
 * @returns {Promise<{ data: Array<{ id, name, sampleType, unit, analyteId, analyteCode, analyteDisplayName }>|null, error: object|null }>}
 */
export async function getLabSpecificationOptions(options = {}) {
  // Default options to the "current" set unless the caller widens it.
  const { data, error } = await getLabSpecifications({
    analyteId: options.analyteId,
    sampleType: options.sampleType,
    activeOnly: options.activeOnly ?? true,
    includeExpired: options.includeExpired ?? false,
  });
  if (error) return { data: null, error };
  return {
    data: (data || []).map((s) => ({
      id: s.id,
      name: s.name,
      sampleType: s.sampleType,
      unit: s.unit,
      analyteId: s.labAnalyteId,
      analyteCode: s.analyteCode,
      analyteDisplayName: s.analyteDisplayName,
    })),
    error: null,
  };
}

// Shared value-rule validation: at least one of min/max/target, and min <= max.
// Mirrors the DB CHECKs so the UI gets a friendly message before the round-trip.
function validateValues({ minValue, maxValue, targetValue }) {
  const hasMin = minValue !== undefined && minValue !== null && minValue !== '';
  const hasMax = maxValue !== undefined && maxValue !== null && maxValue !== '';
  const hasTarget = targetValue !== undefined && targetValue !== null && targetValue !== '';
  if (!hasMin && !hasMax && !hasTarget) {
    return 'Provide at least one of minimum, maximum or target value.';
  }
  if (hasMin && hasMax && Number(minValue) > Number(maxValue)) {
    return 'The minimum value cannot be greater than the maximum value.';
  }
  return null;
}

// Coerce an optional numeric field to a number or null (never '' or undefined).
function numOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  return Number(v);
}

// Resolve an analyte in the active org and confirm the supplied unit matches its
// canonical unit (the DB stores unit as a snapshot; we never convert/overwrite).
// Returns { unit, error }. On any resolution/mismatch problem returns a friendly
// error message string instead of throwing.
async function resolveAnalyteUnit(orgId, labAnalyteId, suppliedUnit) {
  const { data, error } = await supabase
    .from('lab_analytes')
    .select('id, canonical_unit')
    .eq('id', labAnalyteId)
    .eq('org_id', orgId)
    .maybeSingle();
  if (error) return { unit: null, error: labSpecificationError(error) };
  if (!data) return { unit: null, error: 'The analyte could not be found in this organisation.' };

  const canonical = (data.canonical_unit || '').trim();
  const supplied = (suppliedUnit || '').trim();
  if (!supplied) return { unit: null, error: 'A unit is required.' };
  // Validate the snapshot matches the analyte's canonical unit; do NOT silently
  // convert or overwrite the supplied value.
  if (supplied !== canonical) {
    return {
      unit: null,
      error: `The unit must match the analyte's canonical unit ("${canonical}").`,
    };
  }
  return { unit: supplied, error: null };
}

/**
 * Create a specification in the active organisation. Sets org_id = active org
 * and owner_id = the authenticated user (never from input). unit is validated
 * against the analyte's canonical unit (snapshot; no conversion). The DB
 * cross-org trigger + partial unique index remain the authoritative guards.
 * @param {{ labAnalyteId: string, sampleType: string, name: string, unit: string,
 *   effectiveFrom: string, minValue?: number|null, maxValue?: number|null,
 *   targetValue?: number|null, effectiveTo?: string|null, supersedesId?: string|null,
 *   notes?: string|null, isActive?: boolean }} input
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function createLabSpecification(input) {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) {
    return { data: null, error: userError || { message: 'Not authenticated' } };
  }

  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  if (!input.labAnalyteId) return { data: null, error: { message: 'An analyte is required.' } };
  if (!input.sampleType) return { data: null, error: { message: 'A sample type is required.' } };
  if (!LAB_SAMPLE_TYPES.some((t) => t.value === input.sampleType)) {
    return { data: null, error: { message: 'Please choose a valid sample type.' } };
  }
  const name = (input.name || '').trim();
  if (!name) return { data: null, error: { message: 'A name is required.' } };
  if (!input.effectiveFrom) return { data: null, error: { message: 'An effective-from date is required.' } };

  const valueError = validateValues(input);
  if (valueError) return { data: null, error: { message: valueError } };

  // Snapshot/validate the unit against the analyte's canonical unit.
  const { unit, error: unitError } = await resolveAnalyteUnit(orgId, input.labAnalyteId, input.unit);
  if (unitError) return { data: null, error: { message: unitError } };

  const row = {
    org_id: orgId,
    owner_id: userData.user.id,
    lab_analyte_id: input.labAnalyteId,
    sample_type: input.sampleType,
    name,
    min_value: numOrNull(input.minValue),
    max_value: numOrNull(input.maxValue),
    target_value: numOrNull(input.targetValue),
    unit,
    effective_from: input.effectiveFrom,
    effective_to: input.effectiveTo || null,
    is_active: input.isActive ?? true,
    supersedes_id: input.supersedesId || null,
    notes: input.notes || null,
  };

  const { data, error } = await supabase
    .from('lab_specifications')
    .insert(row)
    .select(SELECT_WITH_ANALYTE)
    .single();

  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

/**
 * Update a specification's editable fields (active-org scoped). id, org_id,
 * owner_id, lab_analyte_id and supersedes_id are NEVER changed here (owner_id
 * immutability is also enforced by a DB trigger). The unit is NOT changed here
 * either — it is a snapshot tied to the analyte and must not drift from history.
 * Does not touch any measurement/sample row.
 * @param {string} id
 * @param {{ name?: string, minValue?: number|null, maxValue?: number|null,
 *   targetValue?: number|null, effectiveFrom?: string, effectiveTo?: string|null,
 *   notes?: string|null, isActive?: boolean }} input
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function updateLabSpecification(id, input) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  // Validate the resulting value-rule if any value field is being changed.
  if (input.minValue !== undefined || input.maxValue !== undefined || input.targetValue !== undefined) {
    // Load the current row so we validate against the merged final state.
    const current = await getLabSpecification(id);
    if (current.error) return { data: null, error: current.error };
    if (!current.data) return { data: null, error: { message: 'Specification not found.' } };
    const merged = {
      minValue: input.minValue !== undefined ? input.minValue : current.data.minValue,
      maxValue: input.maxValue !== undefined ? input.maxValue : current.data.maxValue,
      targetValue: input.targetValue !== undefined ? input.targetValue : current.data.targetValue,
    };
    const valueError = validateValues(merged);
    if (valueError) return { data: null, error: { message: valueError } };
  }

  const row = {};
  if (input.name !== undefined) {
    const name = (input.name || '').trim();
    if (!name) return { data: null, error: { message: 'A name is required.' } };
    row.name = name;
  }
  if (input.minValue !== undefined) row.min_value = numOrNull(input.minValue);
  if (input.maxValue !== undefined) row.max_value = numOrNull(input.maxValue);
  if (input.targetValue !== undefined) row.target_value = numOrNull(input.targetValue);
  if (input.effectiveFrom !== undefined) row.effective_from = input.effectiveFrom;
  if (input.effectiveTo !== undefined) row.effective_to = input.effectiveTo || null;
  if (input.notes !== undefined) row.notes = input.notes || null;
  if (input.isActive !== undefined) row.is_active = input.isActive;
  // unit / lab_analyte_id / supersedes_id / org_id / owner_id intentionally NOT writable here.

  const { data, error } = await supabase
    .from('lab_specifications')
    .update(row)
    .eq('id', id)
    .eq('org_id', orgId)
    .select(SELECT_WITH_ANALYTE)
    .single();

  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

/**
 * Retire a specification (active-org scoped): set is_active = false and stamp
 * effective_to (if not already set). The row is preserved — never deleted — so
 * audit history and version traceability remain intact.
 * @param {string} id
 * @param {{ effectiveTo?: string }} [options]  effective_to to stamp; defaults to now
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function retireLabSpecification(id, options = {}) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  // Only stamp effective_to if it isn't already set (preserve a real retirement time).
  const current = await getLabSpecification(id);
  if (current.error) return { data: null, error: current.error };
  if (!current.data) return { data: null, error: { message: 'Specification not found.' } };

  const row = { is_active: false };
  row.effective_to = current.data.effectiveTo || options.effectiveTo || new Date().toISOString();

  const { data, error } = await supabase
    .from('lab_specifications')
    .update(row)
    .eq('id', id)
    .eq('org_id', orgId)
    .select(SELECT_WITH_ANALYTE)
    .single();

  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

/**
 * Reactivate a retired specification (active-org scoped): set is_active = true
 * and clear effective_to so it becomes "current" again. This can conflict with
 * the DB partial unique current-spec index if another current spec exists for
 * the same analyte + sample type — in that case the DB raises and we return a
 * clear friendly error. We also pre-check to give a cleaner message, but the DB
 * constraint remains the authoritative guard; we NEVER silently retire another
 * spec to make room.
 * @param {string} id
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function reactivateLabSpecification(id) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  const current = await getLabSpecification(id);
  if (current.error) return { data: null, error: current.error };
  if (!current.data) return { data: null, error: { message: 'Specification not found.' } };

  // Pre-check for an existing current spec (friendlier message than the raw
  // unique-violation). The DB index is still the final guard.
  const existing = await getCurrentLabSpecification(current.data.labAnalyteId, current.data.sampleType);
  if (existing.error) return { data: null, error: existing.error };
  if (existing.data && existing.data.id !== id) {
    return {
      data: null,
      error: {
        message:
          'Cannot reactivate: there is already a current specification for this analyte and sample type. Retire it first.',
      },
    };
  }

  const { data, error } = await supabase
    .from('lab_specifications')
    .update({ is_active: true, effective_to: null })
    .eq('id', id)
    .eq('org_id', orgId)
    .select(SELECT_WITH_ANALYTE)
    .single();

  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

/**
 * Preferred versioning workflow: atomically retire the current specification and
 * create its replacement in ONE server-side transaction, via the SECURITY
 * DEFINER RPC public.supersede_lab_specification (migration 031). The new row
 * keeps the same analyte, sample type, org and unit snapshot (the DB enforces
 * this); the caller may change name/range/target/effectiveFrom/notes.
 *
 * ATOMIC — NO CLIENT-SIDE TWO-STEP: this makes exactly ONE Supabase RPC call.
 * It does NOT call retireLabSpecification() or createLabSpecification(), and it
 * never issues a second mutation or a retry. The RPC performs the retire-UPDATE
 * and the replacement-INSERT in a single PostgreSQL transaction, so either both
 * commit or neither does — there is no partial-write window. The RPC also
 * derives org_id from the source spec and owner_id from auth.uid(), and verifies
 * membership/role itself, so neither is passed from the client.
 *
 * @param {string} id  the specification being superseded
 * @param {{ name?: string, minValue?: number|null, maxValue?: number|null,
 *   targetValue?: number|null, effectiveFrom?: string, notes?: string|null }} input
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function createSupersedingLabSpecification(id, input = {}) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };
  if (!id) return { data: null, error: { message: 'A specification to supersede is required.' } };

  // Validate the SUPPLIED values as the new version's final state (the RPC sends
  // these verbatim; the DB CHECKs are the authoritative guard). Mirrors the
  // immediate feedback used elsewhere in this service.
  const valueError = validateValues(input);
  if (valueError) return { data: null, error: { message: valueError } };

  // Exactly ONE atomic RPC call. org_id/owner_id are NOT passed — the RPC
  // resolves them server-side. unit / analyte / sample type are preserved by the
  // RPC from the source specification and cannot be set by the client.
  const { data, error } = await supabase.rpc('supersede_lab_specification', {
    p_spec_id: id,
    p_name: input.name ?? null,
    p_min_value: numOrNull(input.minValue),
    p_max_value: numOrNull(input.maxValue),
    p_target_value: numOrNull(input.targetValue),
    p_effective_from: input.effectiveFrom ?? null,
    p_notes: input.notes ?? null,
  });

  // On failure: surface the friendly error and do NOT attempt any second
  // mutation (no retire/create fallback, no retry).
  if (error) return { data: null, error };

  // The RPC returns the new specification row. Re-fetch via getLabSpecification
  // so the response is normalised WITH analyte context, consistent with the
  // other service reads. (data may be the row object or a single-row array
  // depending on PostgREST shaping of a scalar-composite return.)
  const newId = Array.isArray(data) ? data[0]?.id : data?.id;
  if (newId) return getLabSpecification(newId);

  // Fallback: no id resolvable from the RPC payload — normalise what we got
  // rather than silently losing the result.
  const row = Array.isArray(data) ? data[0] : data;
  return { data: row ? normalise(row) : null, error: null };
}

// NOTE: there is intentionally NO deleteLabSpecification() — specifications are
// retired via retireLabSpecification (is_active = false + effective_to), never
// hard-deleted. The DB grants no DELETE to the application.
