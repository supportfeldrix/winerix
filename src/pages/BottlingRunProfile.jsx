import { useEffect, useState, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Box, Paper, Typography, Chip, Button, Divider, Grid, Skeleton, Alert, Snackbar,
} from '@mui/material';
import ArrowBackOutlinedIcon from '@mui/icons-material/ArrowBackOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import LiquorOutlinedIcon from '@mui/icons-material/LiquorOutlined';
import TaskAltOutlinedIcon from '@mui/icons-material/TaskAltOutlined';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import PageContainer from '../components/layout/PageContainer';
import BottlingRunForm from '../components/bottling/BottlingRunForm';
import BottlingRunLotsSection from '../components/bottling/BottlingRunLotsSection';
import BottlingOutputsSection from '../components/bottling/BottlingOutputsSection';
import { bottlingRunStatusColor, isBottlingRunEditable } from '../components/bottling/BottlingRunTable';
import { formatDate } from '../components/common/formatters';
import { useOrganisation } from '../context/OrganisationContext';
import {
  getBottlingRun, updateBottlingRun, getReleaseLabSampleOptions,
  friendlyBottlingError, bottlingRunStatusLabel,
} from '../services/bottlingService';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Bottling Run profile (P2J-B5-1)
//
// Shows a single run's header and offers Edit for ACTIVE runs (planned /
// in_progress). Completed/cancelled runs are terminal — the UI disables Edit and
// the DB (036) also rejects updates. The three workflow sections below (Source
// Wine Lots, Bottling Outputs, Completion) are intentionally placeholders for
// future B5 tasks: no source-lot, output or completion logic is implemented here.
// All data access is through bottlingService (never Supabase directly).
// ─────────────────────────────────────────────────────────────────────────────

// A compact labelled field used throughout the detail grid.
function Field({ label, children }) {
  return (
    <Box>
      <Typography variant="overline" sx={{ color: 'text.disabled', letterSpacing: '0.08em' }}>{label}</Typography>
      <Typography variant="body1" sx={{ color: 'text.primary' }}>{children}</Typography>
    </Box>
  );
}

// A clearly-marked placeholder for a future B5 workflow section.
function PlaceholderSection({ icon, title, description }) {
  return (
    <Paper variant="outlined" sx={{ borderRadius: 3, p: { xs: 2.5, md: 3.5 }, mt: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, mb: 2 }}>
        <Box sx={{ width: 36, height: 36, borderRadius: 1.5, bgcolor: 'background.subtle', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'secondary.main' }}>
          {icon}
        </Box>
        <Typography variant="h5" component="h2">{title}</Typography>
      </Box>
      <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', px: 3, py: { xs: 4, md: 5 }, textAlign: 'center' }}>
        <Typography variant="body2" sx={{ color: 'text.secondary', maxWidth: 520, mx: 'auto' }}>{description}</Typography>
        <Chip label="Coming soon" size="small" sx={{ mt: 2, fontWeight: 600 }} />
      </Paper>
    </Paper>
  );
}

function BottlingRunProfile() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { activeOrgId } = useOrganisation();

  const [run, setRun] = useState(null);
  const [labSampleOptions, setLabSampleOptions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [editOpen, setEditOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    const { data, error: err } = await getBottlingRun(id);
    if (err) { setError(friendlyBottlingError(err)); setLoading(false); return; }
    if (!data) { setError('Bottling run not found.'); setLoading(false); return; }
    setRun(data);

    // Lab-sample options for the edit dialog (optional context; non-blocking).
    const sampleRes = await getReleaseLabSampleOptions();
    if (!sampleRes.error) setLabSampleOptions(sampleRes.data || []);

    setLoading(false);
  }, [id]);

  // Reload when the run id OR the active organisation changes. Clearing first
  // prevents showing a previous-organisation run after a switch.
  useEffect(() => {
    if (!activeOrgId) { setRun(null); setLabSampleOptions([]); return; }
    setRun(null); setLabSampleOptions([]);
    load();
  }, [activeOrgId, load]);

  const handleEdit = async (values) => {
    setSaving(true);
    const { error: err } = await updateBottlingRun(id, values);
    setSaving(false);
    if (err) { setError(friendlyBottlingError(err)); return; }
    setEditOpen(false);
    setToast('Bottling run updated.');
    await load();
  };

  if (loading) {
    return (
      <PageContainer maxWidth={1100} sx={{ px: { xs: 2, sm: 3, md: 4 } }}>
        <Skeleton width={160} height={32} sx={{ mb: 2 }} />
        <Paper variant="outlined" sx={{ borderRadius: 3, p: 3 }}>
          <Skeleton width="40%" height={36} sx={{ mb: 2 }} />
          <Grid container spacing={3}>
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <Grid item xs={12} sm={6} md={4} key={i}><Skeleton width="80%" height={48} /></Grid>
            ))}
          </Grid>
        </Paper>
      </PageContainer>
    );
  }

  if (error && !run) {
    return (
      <PageContainer maxWidth={1100} sx={{ px: { xs: 2, sm: 3, md: 4 } }}>
        <Button startIcon={<ArrowBackOutlinedIcon />} onClick={() => navigate('/bottling-runs')} color="inherit" sx={{ mb: 2 }}>Back to Bottling Runs</Button>
        <Alert severity="error" action={<Button color="inherit" size="small" onClick={load}>Retry</Button>}>{error}</Alert>
      </PageContainer>
    );
  }

  if (!run) return null;

  const editable = isBottlingRunEditable(run.status);

  return (
    <PageContainer maxWidth={1100} sx={{ px: { xs: 2, sm: 3, md: 4 } }}>
      <Button startIcon={<ArrowBackOutlinedIcon />} onClick={() => navigate('/bottling-runs')} color="inherit" sx={{ mb: 2 }}>Back to Bottling Runs</Button>

      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}

      <Paper variant="outlined" sx={{ borderRadius: 3, p: { xs: 2.5, md: 3.5 } }}>
        {/* Header */}
        <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, alignItems: { xs: 'flex-start', sm: 'center' }, justifyContent: 'space-between', gap: 2, mb: 2 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <Box sx={{ width: 44, height: 44, borderRadius: 2, bgcolor: 'background.subtle', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'secondary.main' }}>
              <LiquorOutlinedIcon />
            </Box>
            <Box>
              <Typography variant="h3" component="h1">{run.bottlingCode || 'Bottling Run'}</Typography>
              <Chip label={bottlingRunStatusLabel(run.status)} size="small" color={bottlingRunStatusColor(run.status)} sx={{ fontWeight: 600, mt: 0.5 }} />
            </Box>
          </Box>
          {editable ? (
            <Button variant="outlined" color="primary" startIcon={<EditOutlinedIcon />} onClick={() => setEditOpen(true)} sx={{ flexShrink: 0 }}>Edit</Button>
          ) : (
            <Chip icon={<LockOutlinedIcon />} label="Locked (terminal run)" variant="outlined" sx={{ flexShrink: 0, fontWeight: 600 }} />
          )}
        </Box>

        <Divider sx={{ mb: 3 }} />

        {/* Core run detail */}
        <Grid container spacing={3}>
          <Grid item xs={12} sm={6} md={4}>
            <Field label="Bottling Code">{run.bottlingCode || '—'}</Field>
          </Grid>
          <Grid item xs={12} sm={6} md={4}>
            <Field label="Status">{bottlingRunStatusLabel(run.status)}</Field>
          </Grid>
          <Grid item xs={12} sm={6} md={4}>
            <Field label="Bottling Date">{formatDate(run.bottlingDate)}</Field>
          </Grid>
          <Grid item xs={12} sm={6} md={4}>
            <Field label="Release Lab Sample">{run.releaseLabSampleCode || '—'}</Field>
          </Grid>
          <Grid item xs={12} sm={6} md={4}>
            <Field label="Created">{formatDate(run.createdAt)}</Field>
          </Grid>
          <Grid item xs={12} sm={6} md={4}>
            <Field label="Updated">{formatDate(run.updatedAt)}</Field>
          </Grid>
          <Grid item xs={12}>
            <Field label="Notes">{run.notes || '—'}</Field>
          </Grid>
        </Grid>
      </Paper>

      {/* ── B5 workflow sections ───────────────────────────────────────────── */}

      {/* A. Source Wine Lots (P2J-B5-2 — real workflow) */}
      <BottlingRunLotsSection run={run} />

      {/* B. Bottling Outputs (P2J-B5-3 — real workflow) */}
      <BottlingOutputsSection run={run} />

      {/* C. Completion (placeholder — future B5 task) */}
      <PlaceholderSection
        icon={<TaskAltOutlinedIcon />}
        title="Completion"
        description="This run has not been completed. Completing a bottling run — which deducts source volumes and reconciles outputs — will be available in a later step."
      />

      <BottlingRunForm
        open={editOpen}
        mode="edit"
        run={run}
        labSampleOptions={labSampleOptions}
        saving={saving}
        onSubmit={handleEdit}
        onClose={() => setEditOpen(false)}
      />
      <Snackbar open={Boolean(toast)} autoHideDuration={4000} onClose={() => setToast('')} message={toast} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }} />
    </PageContainer>
  );
}

export default BottlingRunProfile;
