import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  Box, Paper, Typography, Button, Skeleton, Alert, Snackbar, Chip, Divider,
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

  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState('');

  const load = useCallback(async () => {
    if (!sampleId) return;
    setLoading(true); setError('');
    const [measRes, analytesRes] = await Promise.all([
      getMeasurementsBySample(sampleId),
      getLabAnalyteOptions(), // ACTIVE analytes only (default) for new measurements
    ]);

    if (measRes.error) {
      const friendly = friendlyLabMeasurementError(measRes.error);
      if (/not set up yet/i.test(friendly)) setMeasurements([]); else setError(friendly);
    } else {
      setMeasurements(measRes.data || []);
    }

    // Analyte options are non-fatal: if they fail, the list still renders and
    // only the add dialog is affected.
    if (analytesRes.error) {
      setAnalyteOptions([]);
    } else {
      setAnalyteOptions(analytesRes.data || []);
    }

    setLoading(false);
  }, [sampleId]);

  // Reload whenever the sample id changes (the parent profile already keys its
  // own fetch on the active organisation and clears stale state on switch, so a
  // changed id here follows that lifecycle).
  useEffect(() => {
    setMeasurements([]); setAnalyteOptions([]);
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
              <AnalyteGroup key={group.key} group={group} />
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
function AnalyteGroup({ group }) {
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
        <Table sx={{ minWidth: 560 }} aria-label={`${group.label} measurements`}>
          <TableHead>
            <TableRow>
              <TableCell>Value</TableCell>
              <TableCell>Unit</TableCell>
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
