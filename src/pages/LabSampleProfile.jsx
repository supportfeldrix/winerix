import { useEffect, useState, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Box, Paper, Typography, Chip, Button, Divider, Grid, Skeleton, Alert, Link,
  Snackbar, TextField, MenuItem, Stack, CircularProgress,
} from '@mui/material';
import ArrowBackOutlinedIcon from '@mui/icons-material/ArrowBackOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import FactCheckOutlinedIcon from '@mui/icons-material/FactCheckOutlined';
import BiotechOutlinedIcon from '@mui/icons-material/BiotechOutlined';
import PageContainer from '../components/layout/PageContainer';
import LabSampleForm from '../components/lab/LabSampleForm';
import LabMeasurementsSection from '../components/lab/LabMeasurementsSection';
import { sampleStatusColor } from '../components/lab/LabSampleTable';
import { formatDate } from '../components/common/formatters';
import { useOrganisation } from '../context/OrganisationContext';
import {
  getLabSample, updateLabSample, updateLabSampleStatus, reviewLabSample,
  friendlyLabSampleError, labSampleTypeLabel, labSampleStatusLabel,
  LAB_SAMPLE_STATUSES,
} from '../services/labSampleService';
import { getWineLots, getWineLotWithBatch } from '../services/wineLotService';
import { getCurrentUser } from '../services/authService';

// A compact labelled field used throughout the detail grid.
function Field({ label, children }) {
  return (
    <Box>
      <Typography variant="overline" sx={{ color: 'text.disabled', letterSpacing: '0.08em' }}>{label}</Typography>
      <Typography variant="body1" sx={{ color: 'text.primary' }}>{children}</Typography>
    </Box>
  );
}

function LabSampleProfile() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { activeOrgId } = useOrganisation();

  const [sample, setSample] = useState(null);
  const [trace, setTrace] = useState(null); // { lot, intakes } for traceability context
  const [lotOptions, setLotOptions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [editOpen, setEditOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [statusValue, setStatusValue] = useState('');
  const [statusSaving, setStatusSaving] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [toast, setToast] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    const { data, error: err } = await getLabSample(id);
    if (err) { setError(friendlyLabSampleError(err)); setLoading(false); return; }
    if (!data) { setError('Sample not found.'); setLoading(false); return; }
    setSample(data);
    setStatusValue(data.status);

    // Traceability context (display only) + lot options for the edit dialog.
    const [traceRes, lotsRes] = await Promise.all([
      getWineLotWithBatch(data.wineLotId),
      getWineLots(),
    ]);
    if (!traceRes.error) setTrace(traceRes.data);
    if (!lotsRes.error) setLotOptions(lotsRes.data || []);

    setLoading(false);
  }, [id]);

  // Reload when the sample id OR the active organisation changes. Clearing first
  // prevents showing a previous-organisation sample after a switch.
  useEffect(() => {
    if (!activeOrgId) { setSample(null); setTrace(null); setLotOptions([]); return; }
    setSample(null); setTrace(null); setLotOptions([]);
    load();
  }, [activeOrgId, load]);

  const handleEdit = async (values) => {
    setSaving(true);
    const { error: err } = await updateLabSample(id, values);
    setSaving(false);
    if (err) { setError(friendlyLabSampleError(err)); return; }
    setEditOpen(false);
    setToast('Sample updated.');
    await load();
  };

  const handleStatusChange = async (newStatus) => {
    setStatusValue(newStatus);
    if (!newStatus || newStatus === sample.status) return;
    setStatusSaving(true);
    const { error: err } = await updateLabSampleStatus(id, newStatus);
    setStatusSaving(false);
    if (err) { setError(friendlyLabSampleError(err)); setStatusValue(sample.status); return; }
    setToast('Status updated.');
    await load();
  };

  // Record a review using the authenticated user as reviewer. The sample's
  // CURRENT status is retained as the review's resulting status (changing the
  // status is done via the status control above). reviewedAt defaults to now.
  const handleReview = async () => {
    setReviewing(true);
    const { data: userData, error: userErr } = await getCurrentUser();
    if (userErr || !userData?.user) {
      setReviewing(false);
      setError('You must be signed in to review a sample.');
      return;
    }
    const { error: err } = await reviewLabSample(id, userData.user.id, null, sample.status);
    setReviewing(false);
    if (err) { setError(friendlyLabSampleError(err)); return; }
    setToast('Sample reviewed.');
    await load();
  };

  if (loading) {
    return (
      <PageContainer maxWidth={1100} sx={{ px: { xs: 2, sm: 3, md: 4 } }}>
        <Skeleton width={120} height={32} sx={{ mb: 2 }} />
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

  if (error && !sample) {
    return (
      <PageContainer maxWidth={1100} sx={{ px: { xs: 2, sm: 3, md: 4 } }}>
        <Button startIcon={<ArrowBackOutlinedIcon />} onClick={() => navigate('/lab/samples')} color="inherit" sx={{ mb: 2 }}>Back to Lab Samples</Button>
        <Alert severity="error" action={<Button color="inherit" size="small" onClick={load}>Retry</Button>}>{error}</Alert>
      </PageContainer>
    );
  }

  if (!sample) return null;

  const lot = trace?.lot || null;

  return (
    <PageContainer maxWidth={1100} sx={{ px: { xs: 2, sm: 3, md: 4 } }}>
      <Button startIcon={<ArrowBackOutlinedIcon />} onClick={() => navigate('/lab/samples')} color="inherit" sx={{ mb: 2 }}>Back to Lab Samples</Button>

      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}

      <Paper variant="outlined" sx={{ borderRadius: 3, p: { xs: 2.5, md: 3.5 } }}>
        {/* Header */}
        <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, alignItems: { xs: 'flex-start', sm: 'center' }, justifyContent: 'space-between', gap: 2, mb: 2 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <Box sx={{ width: 44, height: 44, borderRadius: 2, bgcolor: 'background.subtle', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'secondary.main' }}>
              <BiotechOutlinedIcon />
            </Box>
            <Box>
              <Typography variant="h3" component="h1">{sample.sampleCode || 'Lab Sample'}</Typography>
              <Chip label={labSampleStatusLabel(sample.status)} size="small" color={sampleStatusColor(sample.status)} sx={{ fontWeight: 600, mt: 0.5 }} />
            </Box>
          </Box>
          <Button variant="outlined" color="primary" startIcon={<EditOutlinedIcon />} onClick={() => setEditOpen(true)} sx={{ flexShrink: 0 }}>Edit</Button>
        </Box>

        <Divider sx={{ mb: 3 }} />

        {/* Core sample detail */}
        <Grid container spacing={3}>
          <Grid item xs={12} sm={6} md={4}>
            <Field label="Sample Code">{sample.sampleCode || '—'}</Field>
          </Grid>
          <Grid item xs={12} sm={6} md={4}>
            <Field label="Wine Lot">
              {lot ? (
                <Link component="button" type="button" onClick={() => navigate(`/wine-lots/${lot.id}`)} underline="hover">
                  {lot.lotCode}
                </Link>
              ) : (sample.lotCode || '—')}
            </Field>
          </Grid>
          <Grid item xs={12} sm={6} md={4}>
            <Field label="Sample Type">{labSampleTypeLabel(sample.sampleType)}</Field>
          </Grid>
          <Grid item xs={12} sm={6} md={4}>
            <Field label="Sampled At">{formatDate(sample.sampledAt)}</Field>
          </Grid>
          <Grid item xs={12} sm={6} md={4}>
            <Field label="Reviewed At">{sample.reviewedAt ? formatDate(sample.reviewedAt) : 'Not reviewed'}</Field>
          </Grid>
          <Grid item xs={12} sm={6} md={4}>
            <Field label="Reviewed By">{sample.reviewedBy || '—'}</Field>
          </Grid>
          <Grid item xs={12}>
            <Field label="Notes">{sample.notes || '—'}</Field>
          </Grid>
        </Grid>

        {/* Traceability context (display only — derived from the wine lot). */}
        {lot && (
          <>
            <Divider sx={{ my: 3 }} />
            <Typography variant="overline" sx={{ color: 'text.disabled', letterSpacing: '0.08em' }}>Traceability</Typography>
            <Grid container spacing={3} sx={{ mt: 0 }}>
              <Grid item xs={12} sm={6} md={4}><Field label="Wine Lot">{lot.lotCode}</Field></Grid>
              <Grid item xs={12} sm={6} md={4}><Field label="Batch">{lot.batchCode || lot.batchName || '—'}</Field></Grid>
              <Grid item xs={12} sm={6} md={4}><Field label="Vintage">{lot.batchVintage || '—'}</Field></Grid>
            </Grid>
          </>
        )}
      </Paper>

      {/* Status & review controls */}
      <Paper variant="outlined" sx={{ borderRadius: 3, p: { xs: 2.5, md: 3.5 }, mt: 3 }}>
        <Typography variant="h5" component="h2" sx={{ mb: 0.5 }}>Status &amp; Review</Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2.5 }}>
          Set the sample’s quality/review status and record a review. “Within Spec” is a review decision — it is not calculated from measurements.
        </Typography>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }}>
          <TextField
            select
            label="Status"
            value={statusValue}
            onChange={(e) => handleStatusChange(e.target.value)}
            disabled={statusSaving}
            sx={{ minWidth: { sm: 220 } }}
            fullWidth
          >
            {LAB_SAMPLE_STATUSES.map((s) => <MenuItem key={s.value} value={s.value}>{s.label}</MenuItem>)}
          </TextField>
          {statusSaving && <CircularProgress size={20} />}
          <Box sx={{ flexGrow: 1 }} />
          <Button
            variant="contained"
            color="primary"
            startIcon={reviewing ? <CircularProgress size={18} color="inherit" /> : <FactCheckOutlinedIcon />}
            onClick={handleReview}
            disabled={reviewing}
            sx={{ flexShrink: 0 }}
          >
            {sample.reviewedAt ? 'Re-review Sample' : 'Mark as Reviewed'}
          </Button>
        </Stack>
      </Paper>

      {/* Laboratory Measurements — append-only readings for this sample. */}
      <LabMeasurementsSection sampleId={sample.id} />

      <LabSampleForm
        open={editOpen}
        sample={sample}
        lotOptions={lotOptions}
        saving={saving}
        onSubmit={handleEdit}
        onClose={() => setEditOpen(false)}
      />
      <Snackbar open={Boolean(toast)} autoHideDuration={4000} onClose={() => setToast('')} message={toast} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }} />
    </PageContainer>
  );
}

export default LabSampleProfile;
