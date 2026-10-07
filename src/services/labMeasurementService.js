import { supabase } from './supabase';
import { getActiveOrgId } from './activeOrg';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Lab Measurement Service (P2J)
// A lab measurement is one analyte reading on a lab sample:
// Lab Sample -> Lab Measurement -> Lab Analyte. Measurements are APPEND-ONLY —
// the table grants only SELECT + INSERT; there is no update or delete path (and
// this service exposes none). A correction is a NEW measurement row.
//
// The DB allows EITHER a numeric value OR a text value, but at least one must be
// populated (CHECK). unit is a HISTORICAL SNAPSHOT explicitly stored on the
// measurement; it is NOT auto-copied from the analyte's current canonical_unit,
// so a later change to the analyte's unit never rewrites past readings.
//
// Reads/writes are scoped to the active organisation (.eq('org_id', activeOrgId))
// on top of organisation-based RLS (is_org_member + OWNER/ADMIN/CELLAR writes).
// Creates set org_id = active org and owner_id = the authenticated user; neither
// is taken from the UI. The DB cross-org trigger guarantees the referenced
// sample and analyte are same-org.
// Schema: supabase/migrations/027_lab_foundation.sql
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Translate a Supabase/PostgREST error into a friendly, non-technical message.
 * @param {object|null} error
 * @returns {string}
 */
export function friendlyLabMeasurementError(error) {
  if (!error) return 'Something went wrong. Please try again.';
  const code = error.code;
  const msg = (error.message || '').toLowerCase();
  if (code === '42P01' || code === 'PGRST205' || msg.includes('does not exist')) {
    return 'The laboratory database is not set up yet. Please run the latest migration.';
  }
  if (msg.includes('cross-organisation')) {
    return 'The selected sample or analyte belongs to a different organisation.';
  }
  if (msg.includes('invalid lab sample')) return 'The lab sample could not be found.';
  if (msg.includes('invalid lab analyte')) return 'The analyte could not be found.';
  if (code === '23514' || msg.includes('check constraint')) {
    return 'A measurement needs a unit and at least one value (numeric or text).';
  }
  if (code === '23503' || msg.includes('foreign key')) {
    return 'The sample or analyte could not be found.';
  }
  if (code === '23502') return 'Please fill in all required fields.';
  if (code === '42501' || msg.includes('row-level security') || msg.includes('permission')) {
    return 'You do not have permission to record measurements. This requires an Owner, Admin or Cellar role.';
  }
  if (msg.includes('network') || msg.includes('fetch')) {
    return 'Network error. Please check your connection and try again.';
  }
  return 'Something went wrong. Please try again.';
}

// Normalise a raw lab_measurements row (with optional joined analyte context) into camelCase.
function normalise(m) {
  if (!m) return null;
  const analyte = m.lab_analyte || null;
  return {
    id: m.id,
    labSampleId: m.lab_sample_id,
    labAnalyteId: m.lab_analyte_id,
    valueNumeric: m.value_numeric,
    valueText: m.value_text,
    // The measurement's own unit snapshot — preserved as-stored, never
    // overwritten from the analyte.
    unit: m.unit,
    measuredAt: m.measured_at,
    notes: m.notes,
    ownerId: m.owner_id,
    createdAt: m.created_at,
    // Derived analyte context (read-only). analyteUnit is the analyte's CURRENT
    // canonical unit and is distinct from the measurement's snapshot `unit`.
    analyteCode: analyte ? analyte.code : null,
    analyteDisplayName: analyte ? analyte.display_name : null,
    analyteCanonicalUnit: analyte ? analyte.canonical_unit : null,
  };
}

const SELECT_BASE =
  'id, lab_sample_id, lab_analyte_id, value_numeric, value_text, unit, measured_at, notes, owner_id, created_at';

// With analyte context needed for display (code / display name / canonical unit).
const SELECT_WITH_ANALYTE =
  SELECT_BASE + ', lab_analyte:lab_analytes(id, code, display_name, canonical_unit)';

/**
 * Fetch the active organisation's measurements, newest measured_at first.
 * Supports optional filters: labSampleId, labAnalyteId.
 * @param {{ labSampleId?: string, labAnalyteId?: string }} [options]
 * @returns {Promise<{ data: Array|null, error: object|null }>}
 */
export async function getLabMeasurements(options = {}) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: [], error: null };

  let query = supabase
    .from('lab_measurements')
    .select(SELECT_WITH_ANALYTE)
    .eq('org_id', orgId);

  if (options.labSampleId) query = query.eq('lab_sample_id', options.labSampleId);
  if (options.labAnalyteId) query = query.eq('lab_analyte_id', options.labAnalyteId);

  const { data, error } = await query
    .order('measured_at', { ascending: false })
    .order('created_at', { ascending: false });

  if (error) return { data: null, error };
  return { data: (data || []).map(normalise), error: null };
}

/**
 * Fetch a single measurement by id (active-org scoped), with analyte context.
 * @param {string} id
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function getLabMeasurement(id) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  const { data, error } = await supabase
    .from('lab_measurements')
    .select(SELECT_WITH_ANALYTE)
    .eq('id', id)
    .eq('org_id', orgId)
    .single();

  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

/**
 * Fetch all measurements for a single sample (active-org scoped), newest first,
 * each including the analyte's code / display name / canonical unit for display.
 * The measurement's own snapshot `unit` is preserved separately from the
 * analyte's current canonical unit.
 * @param {string} labSampleId
 * @returns {Promise<{ data: Array|null, error: object|null }>}
 */
export async function getMeasurementsBySample(labSampleId) {
  const orgId = getActiveOrgId();
  if (!orgId || !labSampleId) return { data: [], error: null };

  const { data, error } = await supabase
    .from('lab_measurements')
    .select(SELECT_WITH_ANALYTE)
    .eq('org_id', orgId)
    .eq('lab_sample_id', labSampleId)
    .order('measured_at', { ascending: false })
    .order('created_at', { ascending: false });

  if (error) return { data: null, error };
  return { data: (data || []).map(normalise), error: null };
}

// Build a validated insert row from an input object, or return an error message.
// Shared by createLabMeasurement and createMeasurementsForSample so validation
// is identical. unit is stored exactly as supplied (snapshot) — never derived.
function buildMeasurementRow(orgId, ownerId, input) {
  if (!input || !input.labSampleId) return { row: null, message: 'A lab sample is required.' };
  if (!input.labAnalyteId) return { row: null, message: 'An analyte is required.' };
  const unit = (input.unit || '').trim();
  if (!unit) return { row: null, message: 'A unit is required.' };
  if (!input.measuredAt) return { row: null, message: 'A measured-at date is required.' };

  const hasNumeric = input.valueNumeric !== undefined && input.valueNumeric !== null && input.valueNumeric !== '';
  const hasText = input.valueText !== undefined && input.valueText !== null && String(input.valueText).trim() !== '';
  if (!hasNumeric && !hasText) {
    return { row: null, message: 'Enter a value — either numeric or text.' };
  }

  return {
    row: {
      org_id: orgId,
      owner_id: ownerId,
      lab_sample_id: input.labSampleId,
      lab_analyte_id: input.labAnalyteId,
      value_numeric: hasNumeric ? input.valueNumeric : null,
      value_text: hasText ? input.valueText : null,
      unit,
      measured_at: input.measuredAt,
      notes: input.notes || null,
    },
    message: null,
  };
}

/**
 * Create a measurement (append-only). Sets org_id = active org and owner_id =
 * the authenticated user (never from the payload). Either valueNumeric or
 * valueText must be provided. unit is stored exactly as supplied (historical
 * snapshot) and is NOT auto-filled from the analyte.
 * @param {{ labSampleId: string, labAnalyteId: string, unit: string,
 *   measuredAt: string, valueNumeric?: number|null, valueText?: string|null,
 *   notes?: string|null }} input
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function createLabMeasurement(input) {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) {
    return { data: null, error: userError || { message: 'Not authenticated' } };
  }

  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };

  const { row, message } = buildMeasurementRow(orgId, userData.user.id, input);
  if (!row) return { data: null, error: { message } };

  const { data, error } = await supabase
    .from('lab_measurements')
    .insert(row)
    .select(SELECT_WITH_ANALYTE)
    .single();

  if (error) return { data: null, error };
  return { data: normalise(data), error: null };
}

/**
 * Convenience helper: create several measurements for one sample.
 *
 * APPEND-ONLY and NO FAKE TRANSACTION: this does not wrap the inserts in a
 * database transaction (the frontend has no such mechanism) and does NOT
 * silently swallow failures. Inserts run sequentially; on the FIRST error it
 * STOPS and returns that error together with the measurements already created,
 * so the caller can see exactly what succeeded and what did not. All rows share
 * the same labSampleId; each measurement is validated the same way as
 * createLabMeasurement, and each carries its own explicit unit snapshot.
 *
 * @param {string} labSampleId
 * @param {Array<{ labAnalyteId: string, unit: string, measuredAt: string,
 *   valueNumeric?: number|null, valueText?: string|null, notes?: string|null }>} measurements
 * @returns {Promise<{ data: Array|null, error: object|null, created: Array, failedIndex: number|null }>}
 *   data: all created rows (same as `created`) when every insert succeeded, else null.
 *   created: the rows that were successfully inserted before any failure.
 *   failedIndex: the index in `measurements` that failed, or null on full success.
 */
export async function createMeasurementsForSample(labSampleId, measurements) {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) {
    return { data: null, error: userError || { message: 'Not authenticated' }, created: [], failedIndex: null };
  }

  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' }, created: [], failedIndex: null };
  if (!labSampleId) return { data: null, error: { message: 'A lab sample is required.' }, created: [], failedIndex: null };
  if (!Array.isArray(measurements) || measurements.length === 0) {
    return { data: null, error: { message: 'At least one measurement is required.' }, created: [], failedIndex: null };
  }

  // Validate ALL rows up-front so an invalid payload fails BEFORE any insert
  // (reduces, though cannot eliminate, partial writes caused by validation).
  const rows = [];
  for (let i = 0; i < measurements.length; i += 1) {
    const { row, message } = buildMeasurementRow(orgId, userData.user.id, {
      ...measurements[i],
      labSampleId,
    });
    if (!row) {
      return {
        data: null,
        error: { message: `Measurement ${i + 1}: ${message}` },
        created: [],
        failedIndex: i,
      };
    }
    rows.push(row);
  }

  // Insert sequentially; stop on the first DB error and report it explicitly.
  const created = [];
  for (let i = 0; i < rows.length; i += 1) {
    const { data, error } = await supabase
      .from('lab_measurements')
      .insert(rows[i])
      .select(SELECT_WITH_ANALYTE)
      .single();
    if (error) {
      return { data: null, error, created, failedIndex: i };
    }
    created.push(normalise(data));
  }

  return { data: created, error: null, created, failedIndex: null };
}

// NOTE: there is intentionally NO updateLabMeasurement() and NO
// deleteLabMeasurement() — measurements are APPEND-ONLY. A correction is a new
// measurement row.
