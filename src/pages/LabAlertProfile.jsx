import { useEffect, useState, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Box, Paper, Typography, Chip, Button, Divider, Grid, Skeleton, Alert, Link,
  Snackbar, Stack, Dialog, DialogTitle, DialogContent, DialogActions, TextField,
  CircularProgress,
} from '@mui/material';
import ArrowBackOutlinedIcon from '@mui/icons-material/ArrowBackOutlined';
import ReportProblemOutlinedIcon from '@mui/icons-material/ReportProblemOutlined';
import FactCheckOutlinedIcon from '@mui/icons-material/FactCheckOutlined';
import DoneAllOutlinedIcon from '@mui/icons-material/DoneAllOutlined';
import CancelOutlinedIcon from '@mui/icons-material/CancelOutlined';
import PageContainer from '../components/layout/PageContainer';
import ConfirmDialog from '../components/common/ConfirmDialog';
import { formatDate } from '../components/common/formatters';
import { useOrganisation } from '../context/OrganisationContext';
import {
  getLaboratoryAlerts, acknowledgeLaboratoryAlert, resolveLaboratoryAlert,
  dismissLaboratoryAlert, friendlyLabAlertError,
} from '../services/labAlertService';
import { getLabSample, labSampleTypeLabel } from '../services/labSampleService';
import { getWineLotWithBatch } from '../services/wineLotService';
import { alertStatusDisplay, alertTypeLabel, alertClassLabel } from '../components/lab/labAlertDisplay';

function Field({ label, children }) {
  return (
    <Box>
      <Typography variant="overline" sx={{ color: 'text.disabled', letterSpacing: '0.08em' }}>{label}</Typography>
      <Typography variant="body1" sx={{ color: 'text.primary' }}>{children}</Typography>
    </Box>
  );
}

// Format the FROZEN specification range from the alert snapshot (never re-read
// from the live specification).
function snapshotRange(alert) {
  const hasMin = alert.specificationMinValue !== null && alert.specificationMinValue !== undefined;
  const hasMax = alert.specificationMaxValue !== null && alert.specificationMaxValue !== undefined;
  const u = alert.specificationUnit ? ` ${alert.specificationUnit}` : '';
  if (hasMin && hasMax) return `${alert.specificationMinValue} – ${alert.specificationMaxValue}${u}`;
  if (hasMin) return `≥ ${alert.specificationMinValue}${u}`;
  if (hasMax) return `≤ ${alert.specificationMaxValue}${u}`;
  return '—';
}

function LabAlertProfile() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { activeOrgId } = useOrganisation();

  const [alert, setAlert] = useState(null);
  const [wineContext, setWineContext] = useState(null); // { lotCode, batchCode, batchVintage, sampleType }
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [acknowledging, setAcknowledging] = useState(false);
  const [resolveOpen, setResolveOpen] = useState(false);
  const [dismissOpen, setDismissOpen] = useState(false);
  const [ackConfirm, setAckConfirm] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [toast, setToast] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    // The service has no getById; fetch via the org-scoped list and pick the id.
    const { data, error: err } = await getLaboratoryAlerts({});
    if (err) { setError(friendlyLabAlertError(err)); setLoading(false); return; }
    const found = (data || []).find((a) => a.id === id) || null;
    if (!found) { setError('Alert not found.'); setAlert(null); setLoading(false); return; }
    setAlert(found);

    // Wine context (display only) derived through existing services — NOT a
    // direct Supabase query, and NOT re-reading the live specification.
    let ctx = { lotCode: null, batchCode: null, batchVintage: null, sampleType: null };
    if (found.labSampleId) {
      const sampleRes = await getLabSample(found.labSampleId);
      if (!sampleRes.error && sampleRes.data) {
        ctx.sampleType = sampleRes.data.sampleType;
        ctx.lotCode = sampleRes.data.lotCode;
        if (sampleRes.data.wineLotId) {
          const lotRes = await getWineLotWithBatch(sampleRes.data.wineLotId);
          if (!lotRes.error && lotRes.data && lotRes.data.lot) {
            ctx.lotCode = lotRes.data.lot.lotCode;
            ctx.batchCode = lotRes.data.lot.batchCode;
            ctx.batchVintage = lotRes.data.lot.batchVintage;
          }
        }
      }
    }
    setWineContext(ctx);
    setLoading(false);
  }, [id]);

  // Reload on alert id OR active organisation change; clear stale data first.
  useEffect(() => {
    if (!activeOrgId) { setAlert(null); setWineContext(null); return; }
    setAlert(null); setWineContext(null);
    load();
  }, [activeOrgId, load]);

  const doAcknowledge = async () => {
    setAckConfirm(false); setAcknowledging(true);
    const { error: err } = await acknowledgeLaboratoryAlert(id);
    setAcknowledging(false);
    if (err) { setError(friendlyLabAlertError(err)); return; }
    setToast('Alert acknowledged.'); await load();
  };

  const doResolve = async (notes) => {
    setActionBusy(true);
    const { error: err } = await resolveLaboratoryAlert(id, notes);
    setActionBusy(false);
    if (err) { setError(friendlyLabAlertError(err)); return; }
    setResolveOpen(false); setToast('Alert resolved.'); await load();
  };

  const doDismiss = async (notes) => {
    setActionBusy(true);
    const { error: err } = await dismissLaboratoryAlert(id, notes);
    setActionBusy(false);
    if (err) { setError(friendlyLabAlertError(err)); return; }
    setDismissOpen(false); setToast('Alert dismissed.'); await load();
  };

  if (loading) {
    return (
      <PageContainer maxWidth={1100} sx={{ px: { xs: 2, sm: 3, md: 4 } }}>
        <Skeleton width={140} height={32} sx={{ mb: 2 }} />
        <Paper variant="outlined" sx={{ borderRadius: 3, p: 3 }}>
          <Skeleton width="40%" height={36} sx={{ mb: 2 }} />
          <Grid container spacing={3}>
            {[0, 1, 2, 3, 4, 5].map((i) => <Grid item xs={12} sm={6} md={4} key={i}><Skeleton width="80%" height={48} /></Grid>)}
          </Grid>
        </Paper>
      </PageContainer>
    );
  }

  if (error && !alert) {
    return (
      <PageContainer maxWidth={1100} sx={{ px: { xs: 2, sm: 3, md: 4 } }}>
        <Button startIcon={<ArrowBackOutlinedIcon />} onClick={() => navigate('/lab/alerts')} color="inherit" sx={{ mb: 2 }}>Back to Lab Alerts</Button>
        <Alert severity="error" action={<Button color="inherit" size="small" onClick={load}>Retry</Button>}>{error}</Alert>
      </PageContainer>
    );
  }
  if (!alert) return null;

  const status = alertStatusDisplay(alert.status);
  const canAck = alert.status === 'open';
  const canResolveOrDismiss = alert.status === 'open' || alert.status === 'acknowledged';
  const measured = alert.measurementValue !== null && alert.measurementValue !== undefined
    ? `${alert.measurementValue}${alert.measurementUnit ? ` ${alert.measurementUnit}` : ''}` : '—';

  return (
    <PageContainer maxWidth={1100} sx={{ px: { xs: 2, sm: 3, md: 4 } }}>
      <Button startIcon={<ArrowBackOutlinedIcon />} onClick={() => navigate('/lab/alerts')} color="inherit" sx={{ mb: 2 }}>Back to Lab Alerts</Button>

      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}

      <Paper variant="outlined" sx={{ borderRadius: 3, p: { xs: 2.5, md: 3.5 } }}>
        <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, alignItems: { xs: 'flex-start', sm: 'center' }, justifyContent: 'space-between', gap: 2, mb: 2 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <Box sx={{ width: 44, height: 44, borderRadius: 2, bgcolor: 'background.subtle', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'secondary.main' }}>
              <ReportProblemOutlinedIcon />
            </Box>
            <Box>
              <Typography variant="h3" component="h1">{alertTypeLabel(alert.alertType)}</Typography>
              <Chip label={status.label} size="small" color={status.color} sx={{ fontWeight: 600, mt: 0.5 }} />
            </Box>
          </Box>
          {/* Lifecycle actions, gated by current status. */}
          <Stack direction="row" spacing={1} sx={{ flexShrink: 0, flexWrap: 'wrap', gap: 1 }}>
            {canAck && (
              <Button variant="outlined" color="primary" startIcon={acknowledging ? <CircularProgress size={16} /> : <FactCheckOutlinedIcon />} onClick={() => setAckConfirm(true)} disabled={acknowledging}>Acknowledge</Button>
            )}
            {canResolveOrDismiss && (
              <Button variant="contained" color="primary" startIcon={<DoneAllOutlinedIcon />} onClick={() => setResolveOpen(true)}>Resolve</Button>
            )}
            {canResolveOrDismiss && (
              <Button variant="outlined" color="inherit" startIcon={<CancelOutlinedIcon />} onClick={() => setDismissOpen(true)}>Dismiss</Button>
            )}
          </Stack>
        </Box>

        <Divider sx={{ mb: 3 }} />

        {/* Alert information */}
        <Typography variant="overline" sx={{ color: 'text.disabled', letterSpacing: '0.08em' }}>Alert</Typography>
        <Grid container spacing={3} sx={{ mt: 0, mb: 1 }}>
          <Grid item xs={12} sm={6} md={4}><Field label="Alert Type">{alertTypeLabel(alert.alertType)}</Field></Grid>
          <Grid item xs={12} sm={6} md={4}><Field label="Alert Class">{alertClassLabel(alert.alertClass)}</Field></Grid>
          <Grid item xs={12} sm={6} md={4}><Field label="Status">{status.label}</Field></Grid>
          <Grid item xs={12} sm={6} md={4}><Field label="Triggered">{formatDate(alert.triggeredAt)}</Field></Grid>
          {alert.acknowledgedAt && <Grid item xs={12} sm={6} md={4}><Field label="Acknowledged">{formatDate(alert.acknowledgedAt)}</Field></Grid>}
          {alert.resolvedAt && <Grid item xs={12} sm={6} md={4}><Field label="Resolved">{formatDate(alert.resolvedAt)}</Field></Grid>}
          {alert.dismissedAt && <Grid item xs={12} sm={6} md={4}><Field label="Dismissed">{formatDate(alert.dismissedAt)}</Field></Grid>}
          {alert.resolutionNotes && <Grid item xs={12}><Field label="Notes">{alert.resolutionNotes}</Field></Grid>}
        </Grid>

        <Divider sx={{ my: 3 }} />

        {/* Measurement */}
        <Typography variant="overline" sx={{ color: 'text.disabled', letterSpacing: '0.08em' }}>Measurement</Typography>
        <Grid container spacing={3} sx={{ mt: 0, mb: 1 }}>
          <Grid item xs={12} sm={6} md={4}><Field label="Value">{measured}</Field></Grid>
          <Grid item xs={12} sm={6} md={4}><Field label="Unit">{alert.measurementUnit || '—'}</Field></Grid>
          <Grid item xs={12} sm={6} md={4}><Field label="Measured At">{alert.measurementMeasuredAt ? formatDate(alert.measurementMeasuredAt) : '—'}</Field></Grid>
          <Grid item xs={12} sm={6} md={4}><Field label="Analyte">{alert.analyteDisplayName || alert.analyteCode || '—'}</Field></Grid>
        </Grid>

        <Divider sx={{ my: 3 }} />

        {/* Wine context (derived via existing services, display only) */}
        <Typography variant="overline" sx={{ color: 'text.disabled', letterSpacing: '0.08em' }}>Wine Context</Typography>
        <Grid container spacing={3} sx={{ mt: 0, mb: 1 }}>
          <Grid item xs={12} sm={6} md={4}><Field label="Wine Lot">{wineContext?.lotCode || '—'}</Field></Grid>
          <Grid item xs={12} sm={6} md={4}><Field label="Batch">{wineContext?.batchCode || '—'}</Field></Grid>
          <Grid item xs={12} sm={6} md={4}><Field label="Vintage">{wineContext?.batchVintage || '—'}</Field></Grid>
          <Grid item xs={12} sm={6} md={4}>
            <Field label="Sample">
              {alert.labSampleId
                ? <Link component="button" type="button" onClick={() => navigate(`/lab/samples/${alert.labSampleId}`)} underline="hover">{alert.sampleCode || 'View sample'}</Link>
                : (alert.sampleCode || '—')}
            </Field>
          </Grid>
          <Grid item xs={12} sm={6} md={4}><Field label="Sample Type">{wineContext?.sampleType ? labSampleTypeLabel(wineContext.sampleType) : '—'}</Field></Grid>
        </Grid>

        <Divider sx={{ my: 3 }} />

        {/* Specification snapshot (FROZEN — never re-read from the live spec) */}
        <Typography variant="overline" sx={{ color: 'text.disabled', letterSpacing: '0.08em' }}>Specification Snapshot</Typography>
        <Grid container spacing={3} sx={{ mt: 0, mb: 1 }}>
          <Grid item xs={12} sm={6} md={4}><Field label="Specification">{alert.specificationName || '—'}</Field></Grid>
          <Grid item xs={12} sm={6} md={4}><Field label="Range">{snapshotRange(alert)}</Field></Grid>
          <Grid item xs={12} sm={6} md={4}><Field label="Minimum">{alert.specificationMinValue ?? '—'}</Field></Grid>
          <Grid item xs={12} sm={6} md={4}><Field label="Maximum">{alert.specificationMaxValue ?? '—'}</Field></Grid>
          <Grid item xs={12} sm={6} md={4}><Field label="Target">{alert.specificationTargetValue ?? '—'}</Field></Grid>
          <Grid item xs={12} sm={6} md={4}><Field label="Unit">{alert.specificationUnit || '—'}</Field></Grid>
        </Grid>

        <Divider sx={{ my: 3 }} />

        {/* Evaluation (frozen) */}
        <Typography variant="overline" sx={{ color: 'text.disabled', letterSpacing: '0.08em' }}>Evaluation</Typography>
        <Grid container spacing={3} sx={{ mt: 0 }}>
          <Grid item xs={12} sm={6} md={4}><Field label="Evaluation Status">{alert.evaluationStatus || '—'}</Field></Grid>
          <Grid item xs={12} sm={6} md={4}><Field label="Range Result">{alert.rangeResult || '—'}</Field></Grid>
        </Grid>
      </Paper>

      <ConfirmDialog
        open={ackConfirm}
        title="Acknowledge Alert?"
        message="This marks the alert as being handled. You can resolve or dismiss it afterwards."
        confirmLabel="Acknowledge"
        confirmColor="primary"
        loading={acknowledging}
        onConfirm={doAcknowledge}
        onClose={() => setAckConfirm(false)}
      />
      <NotesDialog
        open={resolveOpen}
        title="Resolve Alert"
        description="Mark this laboratory alert as resolved. Resolution notes are optional."
        confirmLabel="Resolve"
        confirmColor="primary"
        busy={actionBusy}
        onConfirm={doResolve}
        onClose={() => setResolveOpen(false)}
      />
      <NotesDialog
        open={dismissOpen}
        title="Dismiss Alert"
        description="Dismiss this laboratory alert (closed without resolution). Notes are optional."
        confirmLabel="Dismiss"
        confirmColor="inherit"
        busy={actionBusy}
        onConfirm={doDismiss}
        onClose={() => setDismissOpen(false)}
      />
      <Snackbar open={Boolean(toast)} autoHideDuration={4000} onClose={() => setToast('')} message={toast} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }} />
    </PageContainer>
  );
}

// Reusable optional-notes confirmation dialog for resolve / dismiss.
function NotesDialog({ open, title, description, confirmLabel, confirmColor, busy, onConfirm, onClose }) {
  const [notes, setNotes] = useState('');
  useEffect(() => { if (open) setNotes(''); }, [open]);
  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>{description}</Typography>
        <TextField
          label="Notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          helperText="Optional"
          fullWidth multiline minRows={2} disabled={busy} autoFocus
        />
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        <Button onClick={onClose} color="inherit" disabled={busy}>Cancel</Button>
        <Button
          onClick={() => onConfirm(notes.trim() === '' ? null : notes.trim())}
          variant="contained"
          color={confirmColor}
          disabled={busy}
        >
          {busy ? <CircularProgress size={20} color="inherit" /> : confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default LabAlertProfile;
