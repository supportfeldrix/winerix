import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  Box, Paper, Typography, Button, Skeleton, Alert, Snackbar, Chip, Divider,
  Tooltip, CircularProgress,
  Table, TableHead, TableBody, TableRow, TableCell, TableContainer,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import AddOutlinedIcon from '@mui/icons-material/AddOutlined';
import ScienceOutlinedIcon from '@mui/icons-material/ScienceOutlined';
import LabMeasurementForm from './LabMeasurementForm';
import { formatDate } from '../common/formatters';
import {
  getMeasurementsBySample, createLabMeasurement, friendlyLabMeasurementError,
} from '../../services/labMeasurementService';
import { getLabAnalyteOptions } from '../../services/labAnalyteService';
import {
  evaluateLabMeasurement, EVALUATION_STATUS, RANGE_RESULT,
} from '../../services/labEvaluationService';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Laboratory Measurements section (lives on the Lab Sample profile)
//
// Lists the append-only measurements recorded against ONE lab sample and lets
// authorised users add new ones. Reads go through labMeasurementService
// (getMeasurementsBySample) and analyte options through labAnalyteService
// (getLabAnalyteOptions, ACTIVE analytes only — inactive analytes cannot be
// chosen for NEW measurements). No Supabase access here.
//
// Display rules:
//   * value: the stored value_numeric OR value_text (whichever is present)
//   * unit: the measurement's OWN snapshot unit (never re-derived from the
//     analyte's current canonical unit), so history is immutable
//   * analyte: the joined analyte display name/code — a measurement whose
//     analyte was later DEACTIVATED still displays fully
//   * append-only: there are intentionally NO edit/delete/remove actions
// ─────────────────────────────────────────────────────────────────────────────

// Render a measurement's value from whichever column is populated.
function measurementValue(m) {
  if (m.valueNumeric !== null && m.valueNumeric !== undefined && m.valueNumeric !== '') {
    return String(m.valueNumeric);
  }
  if (m.valueText) return m.valueText;
  return '—';
}

// Prefer the analyte display name, fall back to its code, then to a dash. Uses
// the joined analyte context so deactivated analytes still show a name.
function analyteLabel(m) {
  return m.analyteDisplayName || m.analyteCode || '—';
}

// A stable key for grouping rows by analyte: the analyte id when present, else
// the display label (so a historical measurement whose analyte is missing still
// groups sensibly).
function analyteKey(m) {
  return m.labAnalyteId || `label:${analyteLabel(m)}`;
}

// Group the already-sorted (measured_at DESC, created_at DESC) measurements by
// analyte WITHOUT reordering within a group, so the service's chronology is
// preserved. Groups are ordered by their newest member (which, given the input
// order, is simply the order in which each analyte is first encountered). The
// first row in each group is therefore that analyte's latest measurement.
function groupByAnalyte(rows) {
  const groups = [];
  const index = new Map();
  rows.forEach((m) => {
    const key = analyteKey(m);
    let group = index.get(key);
    if (!group) {
      group = { key, label: analyteLabel(m), code: m.analyteCode || null, rows: [] };
      index.set(key, group);
      groups.push(group);
    }
    group.rows.push(m);
  });
  return groups;
}

function LabMeasurementsSection({ sampleId }) {
  const [measurements, setMeasurements] = useState([]);
  const [analyteOptions, setAnalyteOptions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Per-measurement evaluation state, keyed by measurement id. Each entry is
  // { status: 'loading' | 'ready' | 'error', result?, }. Computed on demand via
  // the evaluation service (never persisted); refreshed whenever measurements
  // reload (including after an organisation switch, since this runs inside load).
  const [evaluations, setEvaluations] = useState({});

  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState('');

  // Resolve one evaluation per measurement (once per load), in parallel. Each
  // failure is isolated to its own row — it never breaks the list. Uses the
  // existing evaluateLabMeasurement service; no direct spec queries here.
  const resolveEvaluations = useCallback(async (rows) => {
    if (!rows || rows.length === 0) { setEvaluations({}); return; }
    setEvaluations(Object.fromEntries(rows.map((m) => [m.id, { status: 'loading' }])));
    const settled = await Promise.all(
      rows.map(async (m) => {
        try {
          const { data, error: evalErr } = await evaluateLabMeasurement(m.id);
          if (evalErr || !data) return [m.id, { status: 'error' }];
          return [m.id, { status: 'ready', result: data }];
        } catch {
          return [m.id, { status: 'error' }];
        }
      })
    );
    setEvaluations(Object.fromEntries(settled));
  }, []);

  const load = useCallback(async () => {
    if (!sampleId) return;
    setLoading(true); setError('');
    const [measRes, analytesRes] = await Promise.all([
      getMeasurementsBySample(sampleId),
      getLabAnalyteOptions(), // ACTIVE analytes only (default) for new measurements
    ]);

    let rows = [];
    if (measRes.error) {
      const friendly = friendlyLabMeasurementError(measRes.error);
      if (/not set up yet/i.test(friendly)) setMeasurements([]); else setError(friendly);
    } else {
      rows = measRes.data || [];
      setMeasurements(rows);
    }

    // Analyte options are non-fatal: if they fail, the list still renders and
    // only the add dialog is affected.
    if (analytesRes.error) {
      setAnalyteOptions([]);
    } else {
      setAnalyteOptions(analytesRes.data || []);
    }

    setLoading(false);

    // Evaluate after the measurements are shown so the list is not blocked on
    // the per-row evaluation lookups (they fill in a moment later).
    resolveEvaluations(rows);
  }, [sampleId, resolveEvaluations]);

  // Reload whenever the sample id changes (the parent profile already keys its
  // own fetch on the active organisation and clears stale state on switch, so a
  // changed id here follows that lifecycle).
  useEffect(() => {
    setMeasurements([]); setAnalyteOptions([]); setEvaluations({});
    load();
  }, [load]);

  const handleCreate = async (values) => {
    setSaving(true);
    const { error: err } = await createLabMeasurement({ ...values, labSampleId: sampleId });
    setSaving(false);
    if (err) { setError(friendlyLabMeasurementError(err)); return; }
    setFormOpen(false);
    setToast('Measurement recorded.');
    await load();
  };

  const isEmpty = !loading && measurements.length === 0;

  // Factual summary + analyte grouping, computed purely in the UI from the
  // already-loaded measurement records (no extra service/database calls).
  const summary = useMemo(() => {
    const total = measurements.length;
    const distinctAnalytes = new Set(measurements.map(analyteKey)).size;
    // Rows arrive measured_at DESC, so the first row carries the latest date.
    const lastMeasuredAt = total > 0 ? measurements[0].measuredAt : null;
    return { total, distinctAnalytes, lastMeasuredAt };
  }, [measurements]);

  const groups = useMemo(() => groupByAnalyte(measurements), [measurements]);

  return (
    <Paper variant="outlined" sx={{ borderRadius: 3, p: { xs: 2.5, md: 3.5 }, mt: 3 }}>
      <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, alignItems: { xs: 'stretch', sm: 'center' }, justifyContent: 'space-between', gap: 2, mb: 2 }}>
        <Box>
          <Typography variant="h5" component="h2" sx={{ mb: 0.5 }}>Laboratory Measurements</Typography>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            Laboratory readings recorded against this sample. Measurements are kept as a permanent record.
          </Typography>
        </Box>
        <Button
          variant="contained"
          color="primary"
          startIcon={<AddOutlinedIcon />}
          onClick={() => setFormOpen(true)}
          sx={{ flexShrink: 0 }}
        >
          Add Measurement
        </Button>
      </Box>

      {error && (
        <Alert
          severity="error"
          sx={{ mb: 2 }}
          action={<Button color="inherit" size="small" onClick={load}>Retry</Button>}
          onClose={() => setError('')}
        >
          {error}
        </Alert>
      )}

      {loading ? (
        <Box>
          {[0, 1, 2].map((i) => (
            <Box key={i} sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 1 }}>
              <Skeleton width="30%" height={24} />
              <Skeleton width="15%" height={24} />
              <Skeleton width="20%" height={24} sx={{ ml: 'auto' }} />
            </Box>
          ))}
        </Box>
      ) : isEmpty ? (
        <EmptyMeasurements onAdd={() => setFormOpen(true)} />
      ) : (
        <>
          {/* Factual summary — counts and the latest date only. No judgement. */}
          <MeasurementSummary summary={summary} />

          {/* Full chronological history, grouped by analyte for readability.
              No older measurements are hidden. */}
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
            {groups.map((group) => (
              <AnalyteGroup key={group.key} group={group} evaluations={evaluations} />
            ))}
          </Box>
        </>
      )}

      <LabMeasurementForm
        open={formOpen}
        analyteOptions={analyteOptions}
        saving={saving}
        onSubmit={handleCreate}
        onClose={() => setFormOpen(false)}
      />
      <Snackbar open={Boolean(toast)} autoHideDuration={4000} onClose={() => setToast('')} message={toast} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }} />
    </Paper>
  );
}

// Factual summary row: Measurements / Analytes Tested / Last Measured.
// Purely counts and a date — no quality score, pass/fail, or trend language.
function MeasurementSummary({ summary }) {
  const items = [
    { label: summary.total === 1 ? 'Measurement' : 'Measurements', value: String(summary.total) },
    { label: summary.distinctAnalytes === 1 ? 'Analyte Tested' : 'Analytes Tested', value: String(summary.distinctAnalytes) },
    { label: 'Last Measured', value: summary.lastMeasuredAt ? formatDate(summary.lastMeasuredAt) : '—' },
  ];
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, 1fr)' },
        gap: 2,
        mb: 3,
      }}
    >
      {items.map((it) => (
        <Paper
          key={it.label}
          variant="outlined"
          sx={{ borderRadius: 2, p: 2, bgcolor: 'background.subtle' }}
        >
          <Typography variant="h4" component="p" sx={{ color: 'text.primary', mb: 0.25 }}>{it.value}</Typography>
          <Typography variant="overline" sx={{ color: 'text.disabled', letterSpacing: '0.08em' }}>{it.label}</Typography>
        </Paper>
      ))}
    </Box>
  );
}

// One analyte's measurements: a labelled header plus the full chronological
// history for that analyte (newest first). The first row is tagged "Latest"
// purely to indicate chronology — no interpretation of the value.
function AnalyteGroup({ group, evaluations }) {
  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, mb: 1 }}>
        <Box
          sx={{
            width: 28, height: 28, borderRadius: 1.25, flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'secondary.main', bgcolor: (t) => alpha(t.palette.secondary.main, 0.12),
          }}
        >
          <ScienceOutlinedIcon sx={{ fontSize: '0.95rem' }} />
        </Box>
        <Typography variant="subtitle1" sx={{ fontWeight: 700, color: 'text.primary' }}>{group.label}</Typography>
        {group.code && group.code !== group.label && (
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>{group.code}</Typography>
        )}
        <Box sx={{ flexGrow: 1 }} />
        <Typography variant="caption" sx={{ color: 'text.disabled' }}>
          {group.rows.length === 1 ? '1 reading' : `${group.rows.length} readings`}
        </Typography>
      </Box>
      <Divider sx={{ mb: 1 }} />
      <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 2, overflowX: 'auto' }}>
        <Table sx={{ minWidth: 720 }} aria-label={`${group.label} measurements`}>
          <TableHead>
            <TableRow>
              <TableCell>Value</TableCell>
              <TableCell>Unit</TableCell>
              <TableCell>Evaluation</TableCell>
              <TableCell>Measured At</TableCell>
              <TableCell>Notes</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {group.rows.map((m, idx) => (
              <TableRow key={m.id} hover sx={{ '& .MuiTableCell-root': { py: 1.5 } }}>
                <TableCell>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Typography variant="body2" sx={{ fontWeight: 600, color: 'text.primary' }}>{measurementValue(m)}</Typography>
                    {idx === 0 && (
                      <Chip label="Latest" size="small" variant="outlined" sx={{ height: 20, fontSize: '0.68rem', fontWeight: 600 }} />
                    )}
                  </Box>
                </TableCell>
                <TableCell>
                  {/* The measurement's OWN stored unit snapshot. */}
                  <Typography variant="body2" sx={{ color: 'text.secondary' }}>{m.unit || '—'}</Typography>
                </TableCell>
                <TableCell>
                  <MeasurementEvaluation entry={evaluations[m.id]} />
                </TableCell>
                <TableCell>
                  <Typography variant="body2" sx={{ color: 'text.secondary' }}>{formatDate(m.measuredAt)}</Typography>
                </TableCell>
                <TableCell sx={{ maxWidth: 260 }}>
                  {m.notes
                    ? <Typography variant="body2" sx={{ color: 'text.secondary' }}>{m.notes}</Typography>
                    : <Typography variant="body2" sx={{ color: 'text.disabled' }}>—</Typography>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
}

// Factual display label + MUI chip colour for a resolved evaluation. Colour is
// a supplement only — the readable text label always carries the meaning, so
// the indicator never relies on colour alone (accessibility).
function evaluationDisplay(result) {
  const { evaluationStatus, rangeResult } = result;
  if (evaluationStatus === EVALUATION_STATUS.EVALUATED) {
    if (rangeResult === RANGE_RESULT.WITHIN_SPEC) return { label: 'Within specification', color: 'success' };
    if (rangeResult === RANGE_RESULT.BELOW_MINIMUM) return { label: 'Below minimum', color: 'warning' };
    if (rangeResult === RANGE_RESULT.ABOVE_MAXIMUM) return { label: 'Above maximum', color: 'warning' };
    if (rangeResult === RANGE_RESULT.TARGET_MATCH) return { label: 'Target match', color: 'success' };
    return { label: 'Evaluated', color: 'default' };
  }
  if (evaluationStatus === EVALUATION_STATUS.NO_SPECIFICATION) return { label: 'No applicable specification', color: 'default' };
  if (evaluationStatus === EVALUATION_STATUS.INCOMPATIBLE_UNIT) return { label: 'Unit mismatch', color: 'default' };
  if (evaluationStatus === EVALUATION_STATUS.NOT_NUMERIC) return { label: 'Not numeric', color: 'default' };
  if (evaluationStatus === EVALUATION_STATUS.NOT_EVALUABLE) return { label: 'Not evaluable', color: 'default' };
  return { label: 'Evaluation unavailable', color: 'default' };
}

// Build the compact specification-context lines shown under the chip and in the
// tooltip. Uses the historically-applicable spec the service resolved — never
// the current spec. Returns an array of short strings (may be empty).
function specificationContextLines(result) {
  const lines = [];
  if (!result || result.specificationId == null) {
    if (result && result.evaluationStatus === EVALUATION_STATUS.NO_SPECIFICATION) {
      lines.push('No applicable specification for this measurement date.');
    }
    return lines;
  }
  const unit = result.specificationUnit || '';
  if (result.specificationName) lines.push(`Specification: ${result.specificationName}`);

  const hasMin = result.specificationMinValue !== null && result.specificationMinValue !== undefined;
  const hasMax = result.specificationMaxValue !== null && result.specificationMaxValue !== undefined;
  if (hasMin && hasMax) lines.push(`Range: ${result.specificationMinValue} – ${result.specificationMaxValue} ${unit}`.trim());
  else if (hasMin) lines.push(`Range: ≥ ${result.specificationMinValue} ${unit}`.trim());
  else if (hasMax) lines.push(`Range: ≤ ${result.specificationMaxValue} ${unit}`.trim());

  if (result.specificationTargetValue !== null && result.specificationTargetValue !== undefined) {
    lines.push(`Target: ${result.specificationTargetValue} ${unit}`.trim());
  }

  // Version window (make a historical specification explicit).
  const from = result.specificationEffectiveFrom ? formatDate(result.specificationEffectiveFrom) : null;
  const to = result.specificationEffectiveTo ? formatDate(result.specificationEffectiveTo) : null;
  if (from && to) lines.push(`Version effective ${from} – ${to}`);
  else if (from) lines.push(`Version effective from ${from}`);

  // For a unit mismatch, spell out both units so the user sees why.
  if (result.evaluationStatus === EVALUATION_STATUS.INCOMPATIBLE_UNIT) {
    lines.push(`Measurement unit: ${result.measurementUnit || '—'}`);
    lines.push(`Specification unit: ${result.specificationUnit || '—'}`);
  }
  return lines;
}

// Compact, accessible per-row evaluation cell. Loading -> spinner + text;
// per-row failure -> "Evaluation unavailable"; success -> labelled chip with a
// tooltip + a subtle secondary context line (spec name / range / target / version).
function MeasurementEvaluation({ entry }) {
  if (!entry || entry.status === 'loading') {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <CircularProgress size={14} />
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>Evaluating…</Typography>
      </Box>
    );
  }
  if (entry.status === 'error' || !entry.result) {
    return <Typography variant="body2" sx={{ color: 'text.secondary' }}>Evaluation unavailable</Typography>;
  }

  const { label, color } = evaluationDisplay(entry.result);
  const lines = specificationContextLines(entry.result);
  const tooltip = lines.length > 0 ? lines.join('\n') : '';

  const chip = (
    <Chip
      label={label}
      size="small"
      color={color}
      variant={color === 'default' ? 'outlined' : 'filled'}
      sx={{ fontWeight: 600, maxWidth: '100%' }}
    />
  );

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, alignItems: 'flex-start' }}>
      {tooltip
        ? <Tooltip title={<span style={{ whiteSpace: 'pre-line' }}>{tooltip}</span>}>{chip}</Tooltip>
        : chip}
      {lines.length > 0 && (
        <Typography variant="caption" sx={{ color: 'text.secondary', lineHeight: 1.35 }}>
          {lines[0]}
        </Typography>
      )}
    </Box>
  );
}

function EmptyMeasurements({ onAdd }) {
  return (
    <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', px: 3, py: { xs: 4, md: 5 }, textAlign: 'center' }}>
      <Box sx={{ width: 56, height: 56, borderRadius: '50%', bgcolor: 'background.paper', display: 'flex', alignItems: 'center', justifyContent: 'center', mx: 'auto', mb: 2, color: 'secondary.main' }}>
        <ScienceOutlinedIcon sx={{ fontSize: '1.75rem' }} />
      </Box>
      <Typography variant="h5" component="p" sx={{ mb: 0.5 }}>No measurements yet</Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary', maxWidth: 420, mx: 'auto', mb: 3 }}>
        Record the first laboratory measurement for this sample.
      </Typography>
      <Button variant="contained" color="primary" startIcon={<AddOutlinedIcon />} onClick={onAdd}>Add Measurement</Button>
    </Paper>
  );
}

export default LabMeasurementsSection;
