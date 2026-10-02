import { supabase } from './supabase';
import { getActiveOrgId } from './activeOrg';
import {
  evaluateLabMeasurement, EVALUATION_STATUS, RANGE_RESULT,
} from './labEvaluationService';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Lab Alert Service (P2J-13b)
//
// Persists and manages FACTUAL laboratory exceptions (out-of-range readings and
// unit-mismatch data-quality problems) as lab_alerts rows. An alert is NOT a
// quality / regulatory / release / SAWIS / SARS / export claim, and creating or
// transitioning one NEVER changes lab_samples.status.
//
// SINGLE SOURCE OF TRUTH: evaluation is computed by labEvaluationService
// (evaluateLabMeasurement). This service does NOT re-implement the comparison —
// it maps an already-computed evaluation to an alert type/class and calls the
// controlled SECURITY DEFINER RPCs (migration 033). Writes NEVER go directly to
// lab_alerts; org_id/owner_id/actor are derived server-side in the RPCs.
//
// Alert mapping (only these three; everything else = no alert):
//   below_minimum     -> range_exception
//   above_maximum     -> range_exception
//   incompatible_unit -> data_quality
// within_spec / target_match / no_specification / not_numeric / not_evaluable
// deliberately produce NO alert. (no_specification stays an operational
// indicator computed by the evaluation layer, not an alert.)
//
// Reads are org-scoped via getActiveOrgId() + RLS; lifecycle changes go through
// the RPCs. { data, error } convention, camelCase, friendly errors throughout.
// Schema: supabase/migrations/032_lab_alerts.sql + RPCs: 033_lab_alert_rpcs.sql
// ─────────────────────────────────────────────────────────────────────────────

export const LAB_ALERT_STATUSES = Object.freeze(['open', 'acknowledged', 'resolved', 'dismissed']);
export const LAB_ALERT_TYPES = Object.freeze(['below_minimum', 'above_maximum', 'incompatible_unit']);
export const LAB_ALERT_CLASSES = Object.freeze(['range_exception', 'data_quality']);

/**
 * PURE: decide whether an evaluation result warrants an alert, and which
 * type/class. Returns null when no alert is warranted. Side-effect free and
 * directly testable. The ONLY place the evaluation->alert mapping lives.
 * @param {{ evaluationStatus: string, rangeResult: string|null }} evaluation
 * @returns {{ alertType: string, alertClass: string }|null}
 */
export function alertFromEvaluation(evaluation) {
  if (!evaluation) return null;
  const { evaluationStatus, rangeResult } = evaluation;

  if (evaluationStatus === EVALUATION_STATUS.EVALUATED) {
    if (rangeResult === RANGE_RESULT.BELOW_MINIMUM) {
      return { alertType: 'below_minimum', alertClass: 'range_exception' };
    }
    if (rangeResult === RANGE_RESULT.ABOVE_MAXIMUM) {
      return { alertType: 'above_maximum', alertClass: 'range_exception' };
    }
    return null; // within_spec / target_match -> no alert
  }
  if (evaluationStatus === EVALUATION_STATUS.INCOMPATIBLE_UNIT) {
    return { alertType: 'incompatible_unit', alertClass: 'data_quality' };
  }
  // no_specification / not_numeric / not_evaluable -> no alert
  return null;
}

/**
 * Translate a Supabase/PostgREST/RPC error into a friendly, non-technical message.
 * @param {object|null} error
 * @returns {string}
 */
export function friendlyLabAlertError(error) {
  if (!error) return 'Something went wrong. Please try again.';
  const code = error.code;
  const msg = (error.message || '').toLowerCase();
  if (code === '42P01' || code === 'PGRST205' || msg.includes('does not exist')) {
    return 'The laboratory alerts database is not set up yet. Please run the latest migration.';
  }
  if (msg.includes('not authenticated')) return 'You must be signed in to perform this action.';
  if (msg.includes('requires an owner, admin or cellar role')) {
    return 'You do not have permission to manage laboratory alerts. This requires an Owner, Admin or Cellar role.';
  }
  if (msg.includes('not a member of')) return 'This alert belongs to a different organisation.';
  if (msg.includes('not found')) return 'The alert could not be found.';
  if (msg.includes('can be acknowledged') || msg.includes('can be resolved') || msg.includes('can be dismissed')) {
    return 'That action is not allowed from the alert''s current status.';
  }
  if (msg.includes('invalid alert type/class') || msg.includes('unsupported alert type')) {
    return 'That alert type is not supported.';
  }
  if (code === '42501' || msg.includes('row-level security') || msg.includes('permission')) {
    return 'You do not have permission to perform this action.';
  }
  if (msg.includes('network') || msg.includes('fetch')) {
    return 'Network error. Please check your connection and try again.';
  }
  return 'Something went wrong. Please try again.';
}

// Normalise a raw lab_alerts row (with optional joined context) into camelCase.
function normalise(a) {
  if (!a) return null;
  const measurement = a.lab_measurement || null;
  const analyte = measurement && measurement.lab_analyte ? measurement.lab_analyte : null;
  const sample = measurement && measurement.lab_sample ? measurement.lab_sample : null;
  return {
    id: a.id,
    labMeasurementId: a.lab_measurement_id,
    alertType: a.alert_type,
    alertClass: a.alert_class,
    status: a.status,
    triggeredAt: a.triggered_at,
    acknowledgedAt: a.acknowledged_at,
    acknowledgedBy: a.acknowledged_by,
    resolvedAt: a.resolved_at,
    resolvedBy: a.resolved_by,
    dismissedAt: a.dismissed_at,
    dismissedBy: a.dismissed_by,
    resolutionNotes: a.resolution_notes,
    // Frozen snapshot (authoritative basis; never re-derived from live spec).
    measurementValue: a.measurement_value,
    measurementUnit: a.measurement_unit,
    specificationId: a.specification_id,
    specificationName: a.specification_name,
    specificationMinValue: a.specification_min_value,
    specificationMaxValue: a.specification_max_value,
    specificationTargetValue: a.specification_target_value,
    specificationUnit: a.specification_unit,
    evaluationStatus: a.evaluation_status,
    rangeResult: a.range_result,
    ownerId: a.owner_id,
    createdAt: a.created_at,
    updatedAt: a.updated_at,
    // Derived context (read-only; existing relationships, nothing duplicated).
    measurementMeasuredAt: measurement ? measurement.measured_at : null,
    labSampleId: sample ? sample.id : null,
    sampleCode: sample ? sample.sample_code : null,
    analyteCode: analyte ? analyte.code : null,
    analyteDisplayName: analyte ? analyte.display_name : null,
  };
}

// Normalise a single lab_alerts row returned by an RPC (no joined context).
function normaliseBare(a) {
  if (!a) return null;
  return normalise(a);
}

const SELECT_WITH_CONTEXT =
  'id, lab_measurement_id, alert_type, alert_class, status, triggered_at, ' +
  'acknowledged_at, acknowledged_by, resolved_at, resolved_by, dismissed_at, dismissed_by, resolution_notes, ' +
  'measurement_value, measurement_unit, specification_id, specification_name, ' +
  'specification_min_value, specification_max_value, specification_target_value, specification_unit, ' +
  'evaluation_status, range_result, owner_id, created_at, updated_at, ' +
  'lab_measurement:lab_measurements(id, measured_at, ' +
  'lab_sample:lab_samples(id, sample_code), lab_analyte:lab_analytes(id, code, display_name))';

/**
 * Evaluate a measurement and, if the result warrants it, create (idempotently)
 * the corresponding alert via the controlled RPC. Never inserts directly.
 *
 * @param {string} measurementId
 * @returns {Promise<{ data: { created: boolean, alert: object|null, evaluation: object }|null, error: object|null }>}
 *   created=false with alert=null means "no alert required" (a successful outcome).
 */
export async function evaluateAndCreateLabAlert(measurementId) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };
  if (!measurementId) return { data: null, error: { message: 'A measurement is required.' } };

  // 1/2. Compute the evaluation (single source of truth).
  const { data: evaluation, error: evalErr } = await evaluateLabMeasurement(measurementId);
  if (evalErr) return { data: null, error: evalErr };
  if (!evaluation) return { data: null, error: { message: 'Measurement not found.' } };

  // 3/4. Does it warrant an alert?
  const mapped = alertFromEvaluation(evaluation);
  if (!mapped) {
    return { data: { created: false, alert: null, evaluation }, error: null };
  }

  // 5. Persist via the controlled RPC (idempotent; returns existing-or-new row).
  const { data: alertRow, error: rpcErr } = await supabase.rpc('create_lab_alert', {
    p_lab_measurement_id: measurementId,
    p_alert_type: mapped.alertType,
    p_alert_class: mapped.alertClass,
    p_measurement_value: evaluation.measurementValueNumeric ?? null,
    p_measurement_unit: evaluation.measurementUnit ?? null,
    p_specification_id: evaluation.specificationId ?? null,
    p_specification_name: evaluation.specificationName ?? null,
    p_specification_min_value: evaluation.specificationMinValue ?? null,
    p_specification_max_value: evaluation.specificationMaxValue ?? null,
    p_specification_target_value: evaluation.specificationTargetValue ?? null,
    p_specification_unit: evaluation.specificationUnit ?? null,
    p_evaluation_status: evaluation.evaluationStatus ?? null,
    p_range_result: evaluation.rangeResult ?? null,
  });
  if (rpcErr) return { data: null, error: rpcErr };

  const row = Array.isArray(alertRow) ? alertRow[0] : alertRow;
  return { data: { created: true, alert: normaliseBare(row), evaluation }, error: null };
}

/**
 * Fetch the active organisation's alerts (with measurement/sample/analyte
 * context), newest first. Options: status, alertType, alertClass, measurementId,
 * sampleId, limit.
 * @param {{ status?: string, alertType?: string, alertClass?: string,
 *   measurementId?: string, sampleId?: string, limit?: number }} [options]
 * @returns {Promise<{ data: Array|null, error: object|null }>}
 */
export async function getLaboratoryAlerts(options = {}) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: [], error: null };

  let query = supabase
    .from('lab_alerts')
    .select(SELECT_WITH_CONTEXT)
    .eq('org_id', orgId);

  if (options.status) query = query.eq('status', options.status);
  if (options.alertType) query = query.eq('alert_type', options.alertType);
  if (options.alertClass) query = query.eq('alert_class', options.alertClass);
  if (options.measurementId) query = query.eq('lab_measurement_id', options.measurementId);
  // sampleId filters through the measurement relationship.
  if (options.sampleId) query = query.eq('lab_measurement.lab_sample_id', options.sampleId);

  query = query.order('triggered_at', { ascending: false }).order('created_at', { ascending: false });
  if (options.limit) query = query.limit(options.limit);

  const { data, error } = await query;
  if (error) return { data: null, error };
  let rows = (data || []).map(normalise);
  // sampleId is applied client-side as a safeguard (the embedded filter above
  // only narrows the join, not the parent rows, in some PostgREST versions).
  if (options.sampleId) rows = rows.filter((r) => r.labSampleId === options.sampleId);
  return { data: rows, error: null };
}

/**
 * Convenience: active (open + acknowledged) alerts for the active organisation.
 * @param {{ limit?: number }} [options]
 * @returns {Promise<{ data: Array|null, error: object|null }>}
 */
export async function getOpenLaboratoryAlerts(options = {}) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: [], error: null };

  const { data, error } = await supabase
    .from('lab_alerts')
    .select(SELECT_WITH_CONTEXT)
    .eq('org_id', orgId)
    .in('status', ['open', 'acknowledged'])
    .order('triggered_at', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(options.limit || 500);

  if (error) return { data: null, error };
  return { data: (data || []).map(normalise), error: null };
}

/**
 * Fetch alerts for a single lab sample (active-org scoped), newest first.
 * @param {string} labSampleId
 * @returns {Promise<{ data: Array|null, error: object|null }>}
 */
export async function getAlertsForSample(labSampleId) {
  if (!labSampleId) return { data: [], error: null };
  return getLaboratoryAlerts({ sampleId: labSampleId });
}

/**
 * Fetch alerts for a single measurement (active-org scoped), newest first.
 * @param {string} measurementId
 * @returns {Promise<{ data: Array|null, error: object|null }>}
 */
export async function getAlertsForMeasurement(measurementId) {
  if (!measurementId) return { data: [], error: null };
  return getLaboratoryAlerts({ measurementId });
}

// Shared lifecycle caller: invoke a controlled RPC and normalise its row.
async function callLifecycleRpc(fn, args) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };
  const { data, error } = await supabase.rpc(fn, args);
  if (error) return { data: null, error };
  const row = Array.isArray(data) ? data[0] : data;
  return { data: normaliseBare(row), error: null };
}

/**
 * Acknowledge an alert (open -> acknowledged) via the controlled RPC.
 * @param {string} alertId
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function acknowledgeLaboratoryAlert(alertId) {
  if (!alertId) return { data: null, error: { message: 'An alert is required.' } };
  return callLifecycleRpc('acknowledge_lab_alert', { p_alert_id: alertId });
}

/**
 * Resolve an alert (open|acknowledged -> resolved) via the controlled RPC.
 * @param {string} alertId
 * @param {string|null} [notes]
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function resolveLaboratoryAlert(alertId, notes = null) {
  if (!alertId) return { data: null, error: { message: 'An alert is required.' } };
  return callLifecycleRpc('resolve_lab_alert', { p_alert_id: alertId, p_notes: notes || null });
}

/**
 * Dismiss an alert (open|acknowledged -> dismissed) via the controlled RPC.
 * @param {string} alertId
 * @param {string|null} [notes]
 * @returns {Promise<{ data: object|null, error: object|null }>}
 */
export async function dismissLaboratoryAlert(alertId, notes = null) {
  if (!alertId) return { data: null, error: { message: 'An alert is required.' } };
  return callLifecycleRpc('dismiss_lab_alert', { p_alert_id: alertId, p_notes: notes || null });
}

// ─────────────────────────────────────────────────────────────────────────────
// DETERMINISTIC SELF-TEST (pure mapping only; no I/O, no DB)
// Verifies the evaluation->alert decision for every evaluation outcome. The
// lifecycle/dedup/cross-org/actor cases are enforced in the DB RPCs (033) and
// are verified live, not here.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @returns {{ ok: boolean, passed: number, failed: number, results: Array }}
 */
export function runLabAlertMappingSelfTest() {
  const results = [];
  const check = (name, actual, expected) => {
    results.push({ name, pass: JSON.stringify(actual) === JSON.stringify(expected) });
  };
  const E = EVALUATION_STATUS;
  const R = RANGE_RESULT;

  check('1 within_spec -> no alert',
    alertFromEvaluation({ evaluationStatus: E.EVALUATED, rangeResult: R.WITHIN_SPEC }), null);
  check('2 below_minimum -> range_exception',
    alertFromEvaluation({ evaluationStatus: E.EVALUATED, rangeResult: R.BELOW_MINIMUM }),
    { alertType: 'below_minimum', alertClass: 'range_exception' });
  check('3 above_maximum -> range_exception',
    alertFromEvaluation({ evaluationStatus: E.EVALUATED, rangeResult: R.ABOVE_MAXIMUM }),
    { alertType: 'above_maximum', alertClass: 'range_exception' });
  check('4 incompatible_unit -> data_quality',
    alertFromEvaluation({ evaluationStatus: E.INCOMPATIBLE_UNIT, rangeResult: null }),
    { alertType: 'incompatible_unit', alertClass: 'data_quality' });
  check('5 no_specification -> no alert',
    alertFromEvaluation({ evaluationStatus: E.NO_SPECIFICATION, rangeResult: null }), null);
  check('6 not_numeric -> no alert',
    alertFromEvaluation({ evaluationStatus: E.NOT_NUMERIC, rangeResult: null }), null);
  check('7 not_evaluable -> no alert',
    alertFromEvaluation({ evaluationStatus: E.NOT_EVALUABLE, rangeResult: null }), null);
  check('8 target_match -> no alert',
    alertFromEvaluation({ evaluationStatus: E.EVALUATED, rangeResult: R.TARGET_MATCH }), null);
  check('9 null evaluation -> no alert', alertFromEvaluation(null), null);

  const failed = results.filter((r) => !r.pass).length;
  return { ok: failed === 0, passed: results.length - failed, failed, results };
}
