import { supabase } from './supabase';
import { getActiveOrgId } from './activeOrg';
import { getLabMeasurement } from './labMeasurementService';
import { getLabSample } from './labSampleService';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Lab Measurement Evaluation Service (P2J-12a)
//
// Factual, READ-ONLY, computed-on-demand comparison of ONE lab measurement
// against the laboratory specification that was EFFECTIVE AT the measurement's
// measured_at timestamp (STRICT HISTORICAL selection — never the "current"
// spec by default). Nothing is persisted: there is no lab_evaluations table and
// lab_measurements is never modified.
//
// This is a NUMERICAL comparison only. It does NOT determine wine quality,
// regulatory/SAWIS/SARS/export compliance, release approval, or commercial
// suitability — and it NEVER changes a sample's review status.
//
// Approved decisions (P2J-12 review):
//   * Selection: STRICT HISTORICAL, half-open interval [effective_from, effective_to).
//       measured_at == effective_from  -> spec applies
//       measured_at == effective_to    -> spec does NOT apply
//     No fallback to the current specification.
//   * Unit: STRICT EXACT match (no trim/lowercase/convert). Mismatch -> incompatible_unit.
//   * Targets: INFORMATIONAL only. No tolerance. target-only -> not_evaluable.
//   * Inactive analyte: does NOT block evaluation if a historical spec applies.
//
// Result model (two orthogonal fields):
//   evaluationStatus: 'evaluated' | 'no_specification' | 'incompatible_unit'
//                     | 'not_numeric' | 'not_evaluable'
//   rangeResult:      'within_spec' | 'below_minimum' | 'above_maximum'
//                     | 'target_match' | null
//   (target_match is reserved but UNUSED in this phase — no tolerance defined.)
//
// Reads go through the existing org-scoped services / RLS. No RPC, no SECURITY
// DEFINER, no direct component queries.
// ─────────────────────────────────────────────────────────────────────────────

// Controlled evaluation vocabularies (exported for the future UI).
export const EVALUATION_STATUS = Object.freeze({
  EVALUATED: 'evaluated',
  NO_SPECIFICATION: 'no_specification',
  INCOMPATIBLE_UNIT: 'incompatible_unit',
  NOT_NUMERIC: 'not_numeric',
  NOT_EVALUABLE: 'not_evaluable',
});

export const RANGE_RESULT = Object.freeze({
  WITHIN_SPEC: 'within_spec',
  BELOW_MINIMUM: 'below_minimum',
  ABOVE_MAXIMUM: 'above_maximum',
  TARGET_MATCH: 'target_match', // reserved; unused until a tolerance model exists
});

/**
 * Translate a Supabase/PostgREST error into a friendly, non-technical message.
 * @param {object|null} error
 * @returns {string}
 */
export function friendlyLabEvaluationError(error) {
  if (!error) return 'Something went wrong. Please try again.';
  const code = error.code;
  const msg = (error.message || '').toLowerCase();
  if (code === '42P01' || code === 'PGRST205' || msg.includes('does not exist')) {
    return 'The laboratory database is not set up yet. Please run the latest migration.';
  }
  if (code === '42501' || msg.includes('row-level security') || msg.includes('permission')) {
    return 'You do not have permission to view this laboratory data.';
  }
  if (msg.includes('network') || msg.includes('fetch')) {
    return 'Network error. Please check your connection and try again.';
  }
  return 'Something went wrong. Please try again.';
}

// Is a stored measurement value genuinely numeric? value_numeric is the numeric
// column; a text-only measurement has value_numeric null/'' and only value_text.
function hasNumericValue(measurement) {
  const v = measurement ? measurement.valueNumeric : undefined;
  return v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v));
}

function hasNumber(v) {
  return v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v));
}

/**
 * PURE: select the specification applicable to `measuredAt` using the strict
 * half-open interval [effective_from, effective_to). Deterministic: when more
 * than one row's window contains the instant (should not happen given the
 * single-current invariant, but defended anyway) the one with the latest
 * effective_from wins, then the latest created_at.
 *
 * @param {Array<object>} specifications  normalised spec rows (any is_active)
 * @param {string} measuredAt  ISO timestamp
 * @returns {object|null} the applicable spec, or null if none applies
 */
export function selectApplicableSpecification(specifications, measuredAt) {
  if (!Array.isArray(specifications) || specifications.length === 0) return null;
  const t = new Date(measuredAt).getTime();
  if (Number.isNaN(t)) return null;

  const applicable = specifications.filter((s) => {
    const from = new Date(s.effectiveFrom).getTime();
    if (Number.isNaN(from)) return false;
    if (t < from) return false; // before window start -> not applicable
    if (s.effectiveTo === null || s.effectiveTo === undefined) return true; // open-ended
    const to = new Date(s.effectiveTo).getTime();
    if (Number.isNaN(to)) return true; // treat an unparseable end as open-ended
    return t < to; // half-open: measured_at == effective_to is NOT applicable
  });

  if (applicable.length === 0) return null;

  applicable.sort((a, b) => {
    const af = new Date(a.effectiveFrom).getTime();
    const bf = new Date(b.effectiveFrom).getTime();
    if (af !== bf) return bf - af; // latest effective_from first
    const ac = new Date(a.createdAt || 0).getTime();
    const bc = new Date(b.createdAt || 0).getTime();
    return bc - ac; // latest created_at first
  });

  return applicable[0];
}

/**
 * PURE: evaluate a measurement against a (possibly null) specification.
 * Does no I/O; safe to unit-test directly. Returns { evaluationStatus, rangeResult }.
 *
 * @param {object} measurement  normalised measurement ({ valueNumeric, unit, ... })
 * @param {object|null} specification  normalised spec, or null when none applies
 * @returns {{ evaluationStatus: string, rangeResult: string|null }}
 */
export function evaluateMeasurementAgainstSpecification(measurement, specification) {
  // No applicable specification at all.
  if (!specification) {
    return { evaluationStatus: EVALUATION_STATUS.NO_SPECIFICATION, rangeResult: null };
  }

  // Text / non-numeric measurement cannot be range-compared.
  if (!hasNumericValue(measurement)) {
    return { evaluationStatus: EVALUATION_STATUS.NOT_NUMERIC, rangeResult: null };
  }

  // STRICT EXACT unit match (no normalisation/conversion).
  if (measurement.unit !== specification.unit) {
    return { evaluationStatus: EVALUATION_STATUS.INCOMPATIBLE_UNIT, rangeResult: null };
  }

  const value = Number(measurement.valueNumeric);
  const hasMin = hasNumber(specification.minValue);
  const hasMax = hasNumber(specification.maxValue);

  // Target-only (no bounds): informational only, no tolerance -> not_evaluable.
  if (!hasMin && !hasMax) {
    return { evaluationStatus: EVALUATION_STATUS.NOT_EVALUABLE, rangeResult: null };
  }

  // Range evaluation (min-only / max-only / min+max). A present target is
  // informational and does NOT affect the range verdict.
  if (hasMin && value < Number(specification.minValue)) {
    return { evaluationStatus: EVALUATION_STATUS.EVALUATED, rangeResult: RANGE_RESULT.BELOW_MINIMUM };
  }
  if (hasMax && value > Number(specification.maxValue)) {
    return { evaluationStatus: EVALUATION_STATUS.EVALUATED, rangeResult: RANGE_RESULT.ABOVE_MAXIMUM };
  }
  return { evaluationStatus: EVALUATION_STATUS.EVALUATED, rangeResult: RANGE_RESULT.WITHIN_SPEC };
}

// Normalise a raw lab_specifications row (local — this service reads the spec
// table directly with a date-windowed query to apply strict historical
// selection). camelCase, mirroring labSpecificationService's normalise.
function normaliseSpec(s) {
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
    unit: s.unit,
    effectiveFrom: s.effective_from,
    effectiveTo: s.effective_to,
    isActive: s.is_active,
    supersedesId: s.supersedes_id,
    createdAt: s.created_at,
    analyteCode: analyte ? analyte.code : null,
    analyteDisplayName: analyte ? analyte.display_name : null,
  };
}

const SPEC_SELECT =
  'id, lab_analyte_id, sample_type, name, min_value, max_value, target_value, unit, ' +
  'effective_from, effective_to, is_active, supersedes_id, created_at, ' +
  'lab_analyte:lab_analytes(id, code, display_name)';

/**
 * Evaluate a single lab measurement against the historically applicable
 * specification (active-org scoped, computed on demand, NOT persisted).
 *
 * @param {string} measurementId
 * @returns {Promise<{ data: object|null, error: object|null }>}
 *   data (on success) includes measurement/analyte/sample context, the resolved
 *   specification (or null), and { evaluationStatus, rangeResult }.
 */
export async function evaluateLabMeasurement(measurementId) {
  const orgId = getActiveOrgId();
  if (!orgId) return { data: null, error: { message: 'No active organisation' } };
  if (!measurementId) return { data: null, error: { message: 'A measurement is required.' } };

  // 1/2. Load the measurement (org-scoped; includes analyte context).
  const { data: measurement, error: mErr } = await getLabMeasurement(measurementId);
  if (mErr) return { data: null, error: mErr };
  if (!measurement) return { data: null, error: { message: 'Measurement not found.' } };

  // 3/4. Resolve the parent sample for its sample_type (org-scoped).
  const { data: sample, error: sErr } = await getLabSample(measurement.labSampleId);
  if (sErr) return { data: null, error: sErr };
  if (!sample) return { data: null, error: { message: 'Parent lab sample not found.' } };

  // 5. Find the historically applicable specification: same org/analyte/
  // sample_type, with the half-open window containing measured_at. The DB does
  // the org/analyte/sample_type + lower-bound filter; the exact half-open
  // upper-bound (measured_at < effective_to, open-ended when NULL) is applied in
  // selectApplicableSpecification so the boundary semantics are explicit and tested.
  const { data: specRows, error: specErr } = await supabase
    .from('lab_specifications')
    .select(SPEC_SELECT)
    .eq('org_id', orgId)
    .eq('lab_analyte_id', measurement.labAnalyteId)
    .eq('sample_type', sample.sampleType)
    .lte('effective_from', measurement.measuredAt)
    .order('effective_from', { ascending: false })
    .order('created_at', { ascending: false });
  if (specErr) return { data: null, error: specErr };

  const specification = selectApplicableSpecification(
    (specRows || []).map(normaliseSpec),
    measurement.measuredAt
  );

  // 6. Factual evaluation (pure).
  const { evaluationStatus, rangeResult } = evaluateMeasurementAgainstSpecification(
    measurement,
    specification
  );

  // Structured result — enough for the future UI without a second spec lookup.
  return {
    data: {
      measurementId: measurement.id,
      labAnalyteId: measurement.labAnalyteId,
      analyteCode: measurement.analyteCode,
      analyteDisplayName: measurement.analyteDisplayName,
      labSampleId: sample.id,
      sampleCode: sample.sampleCode,
      sampleType: sample.sampleType,
      measurementValueNumeric: measurement.valueNumeric,
      measurementValueText: measurement.valueText,
      measurementUnit: measurement.unit,
      measuredAt: measurement.measuredAt,
      evaluationStatus,
      rangeResult,
      // Resolved specification context (null when no_specification).
      specificationId: specification ? specification.id : null,
      specificationName: specification ? specification.name : null,
      specificationEffectiveFrom: specification ? specification.effectiveFrom : null,
      specificationEffectiveTo: specification ? specification.effectiveTo : null,
      specificationIsActive: specification ? specification.isActive : null,
      specificationMinValue: specification ? specification.minValue : null,
      specificationMaxValue: specification ? specification.maxValue : null,
      specificationTargetValue: specification ? specification.targetValue : null,
      specificationUnit: specification ? specification.unit : null,
    },
    error: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// DETERMINISTIC SELF-TEST
// The project has no test runner installed (Vite only), so rather than add a
// framework we expose a pure, dependency-free self-test over the exported pure
// functions. It can be run from a console or wired into a future runner:
//     import { runLabEvaluationSelfTest } from './services/labEvaluationService';
//     const r = runLabEvaluationSelfTest(); console.log(r.ok, r.results);
// It performs NO I/O and does not touch the database.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the P2J-12a logic cases. Returns { ok, passed, failed, results }.
 * @returns {{ ok: boolean, passed: number, failed: number, results: Array }}
 */
export function runLabEvaluationSelfTest() {
  const results = [];
  const check = (name, actual, expected) => {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    results.push({ name, pass, actual, expected });
  };

  const u = 'g/L';
  const spec = (over = {}) => ({
    id: 's', unit: u, minValue: null, maxValue: null, targetValue: null,
    effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: null, createdAt: '2026-01-01T00:00:00Z',
    ...over,
  });
  const meas = (over = {}) => ({ valueNumeric: 5, valueText: null, unit: u, ...over });
  const ev = (m, s) => evaluateMeasurementAgainstSpecification(m, s);

  // 1. value inside min/max
  check('1 inside min/max',
    ev(meas({ valueNumeric: 5 }), spec({ minValue: 3, maxValue: 8 })),
    { evaluationStatus: 'evaluated', rangeResult: 'within_spec' });

  // 2. below minimum
  check('2 below minimum',
    ev(meas({ valueNumeric: 2 }), spec({ minValue: 3, maxValue: 8 })),
    { evaluationStatus: 'evaluated', rangeResult: 'below_minimum' });

  // 3. above maximum
  check('3 above maximum',
    ev(meas({ valueNumeric: 9 }), spec({ minValue: 3, maxValue: 8 })),
    { evaluationStatus: 'evaluated', rangeResult: 'above_maximum' });

  // 4. min-only (at/above ok, below fails)
  check('4a min-only within',
    ev(meas({ valueNumeric: 3 }), spec({ minValue: 3 })),
    { evaluationStatus: 'evaluated', rangeResult: 'within_spec' });
  check('4b min-only below',
    ev(meas({ valueNumeric: 2.9 }), spec({ minValue: 3 })),
    { evaluationStatus: 'evaluated', rangeResult: 'below_minimum' });

  // 5. max-only
  check('5a max-only within',
    ev(meas({ valueNumeric: 8 }), spec({ maxValue: 8 })),
    { evaluationStatus: 'evaluated', rangeResult: 'within_spec' });
  check('5b max-only above',
    ev(meas({ valueNumeric: 8.1 }), spec({ maxValue: 8 })),
    { evaluationStatus: 'evaluated', rangeResult: 'above_maximum' });

  // 6. target + range (target is informational; range decides)
  check('6a target+range within',
    ev(meas({ valueNumeric: 5 }), spec({ minValue: 3, maxValue: 8, targetValue: 5 })),
    { evaluationStatus: 'evaluated', rangeResult: 'within_spec' });
  check('6b target+range below',
    ev(meas({ valueNumeric: 1 }), spec({ minValue: 3, maxValue: 8, targetValue: 5 })),
    { evaluationStatus: 'evaluated', rangeResult: 'below_minimum' });

  // 7. target-only -> not_evaluable
  check('7 target-only',
    ev(meas({ valueNumeric: 5 }), spec({ targetValue: 5 })),
    { evaluationStatus: 'not_evaluable', rangeResult: null });

  // 8. incompatible unit
  check('8 incompatible unit',
    ev(meas({ valueNumeric: 5, unit: 'mg/L' }), spec({ minValue: 3, maxValue: 8 })),
    { evaluationStatus: 'incompatible_unit', rangeResult: null });

  // 9. non-numeric measurement
  check('9 non-numeric',
    ev(meas({ valueNumeric: null, valueText: 'clear' }), spec({ minValue: 3, maxValue: 8 })),
    { evaluationStatus: 'not_numeric', rangeResult: null });

  // 10. no specification
  check('10 no specification',
    ev(meas({ valueNumeric: 5 }), null),
    { evaluationStatus: 'no_specification', rangeResult: null });

  // Selection cases (11–15) use selectApplicableSpecification.
  const sel = (specs, at) => {
    const chosen = selectApplicableSpecification(specs, at);
    return chosen ? chosen.id : null;
  };
  const v1 = { id: 'v1', effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: '2026-06-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z' };
  const v2 = { id: 'v2', effectiveFrom: '2026-06-01T00:00:00Z', effectiveTo: null, createdAt: '2026-06-01T00:00:00Z' };
  const history = [v2, v1];

  // 11. historical selection (date inside v1's window picks v1, not current v2)
  check('11 historical selection', sel(history, '2026-03-01T00:00:00Z'), 'v1');

  // 12. measured_at == effective_from -> that spec applies (v2 at its start)
  check('12 at effective_from', sel(history, '2026-06-01T00:00:00Z'), 'v2');

  // 13. measured_at == effective_to -> that spec does NOT apply (v1 ends -> v2 begins)
  //     At exactly 2026-06-01, v1 (to=2026-06-01) is excluded; v2 (from=2026-06-01) applies.
  check('13 at effective_to (v1 excluded)', sel([v1], '2026-06-01T00:00:00Z'), null);

  // 14. measurement before first specification -> none applies
  check('14 before first spec', sel(history, '2025-12-31T23:59:59Z'), null);

  // 15. inactive analyte with an applicable historical spec: evaluation is NOT
  //     blocked by analyte inactivity — the pure evaluator never inspects
  //     analyte.is_active, and selection ignores it too. A retired (is_active
  //     false) spec whose window still covers measured_at remains applicable.
  const retiredButInWindow = spec({ id: 'r', isActive: false, minValue: 3, maxValue: 8,
    effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: '2026-06-01T00:00:00Z' });
  check('15 inactive-analyte/retired spec still evaluates',
    ev(meas({ valueNumeric: 5 }), retiredButInWindow),
    { evaluationStatus: 'evaluated', rangeResult: 'within_spec' });

  const failed = results.filter((r) => !r.pass).length;
  return { ok: failed === 0, passed: results.length - failed, failed, results };
}
