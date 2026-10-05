import { useEffect, useState, useCallback } from 'react';
import {
  Box, Paper, Typography, Button, Skeleton, Alert, Snackbar, Stack, Chip, Grid,
  Divider, Dialog, DialogTitle, DialogContent, DialogContentText, DialogActions,
  CircularProgress, List, ListItem, ListItemIcon, ListItemText,
} from '@mui/material';
import TaskAltOutlinedIcon from '@mui/icons-material/TaskAltOutlined';
import CheckCircleOutlineOutlinedIcon from '@mui/icons-material/CheckCircleOutlineOutlined';
import ErrorOutlineOutlinedIcon from '@mui/icons-material/ErrorOutlineOutlined';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import WarningAmberOutlinedIcon from '@mui/icons-material/WarningAmberOutlined';
import { alpha } from '@mui/material/styles';
import { isBottlingRunEditable } from './BottlingRunTable';
import { bottlingRunStatusColor } from './BottlingRunTable';
import { formatNumber, formatDate } from '../common/formatters';
import { useOrganisation } from '../../context/OrganisationContext';
import {
  getBottlingRunLots, getBottlingOutputs, completeBottlingRun,
  friendlyBottlingError, bottlingRunStatusLabel,
} from '../../services/bottlingService';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Bottling Run → Completion section (P2J-B5-4)
//
// Final review + the real atomic completion. Loads source lots and outputs via
// bottlingService (never Supabase directly), shows a review and client-side
// gates, then — only after explicit confirmation — calls completeBottlingRun()
// which invokes the SECURITY DEFINER RPC public.complete_bottling_run(uuid). The
// RPC performs ALL state changes atomically; this component performs none.
//
// The gates here are UX only; the RPC is the final authority. On success the
// parent refetches everything (run + sources + outputs) so the UI reflects the
// real post-deduction database state — nothing is faked locally. On failure the
// run stays active and the friendly error is shown (the RPC is atomic, so a
// failure means no partial transaction occurred).
// ─────────────────────────────────────────────────────────────────────────────

const EPSILON = 1e-6;

function ReviewRow({ label, value, suffix, strong }) {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', py: 0.5 }}>
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>{label}</Typography>
      <Typography variant="body2" sx={{ color: 'text.primary', fontWeight: strong ? 700 : 500 }}>
        {value}{suffix ? <Typography component="span" variant="caption" sx={{ color: 'text.secondary', ml: 0.5 }}>{suffix}</Typography> : null}
      </Typography>
    </Box>
  );
}

function BottlingCompletionSection({ run, onCompleted }) {
  const { activeOrgId } = useOrganisation();
  const runId = run?.id || null;
  const runStatus = run?.status || null;
  const active = isBottlingRunEditable(run?.status); // planned / in_progress

  const [runLots, setRunLots] = useState([]);
  const [outputs, setOutputs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [toast, setToast] = useState('');

  const load = useCallback(async () => {
    if (!runId) return;
    setLoading(true); setError('');
    const [lotsRes, outputsRes] = await Promise.all([
      getBottlingRunLots(runId),
      getBottlingOutputs(runId),
    ]);
    if (lotsRes.error) {
      const friendly = friendlyBottlingError(lotsRes.error);
      if (/not set up yet/i.test(friendly)) setRunLots([]); else setError(friendly);
    } else {
      setRunLots(lotsRes.data || []);
    }
    if (outputsRes.error) setOutputs([]);
    else setOutputs(outputsRes.data || []);
    setLoading(false);
  }, [runId]);

  // Reload when the run OR the active organisation changes. Clear first so no
  // previous-org review data lingers mid-switch.
  useEffect(() => {
    if (!activeOrgId || !runId) { setRunLots([]); setOutputs([]); return; }
    setRunLots([]); setOutputs([]);
    load();
    // runStatus included so the review refetches when the run transitions
    // (e.g. after completion) and the section re-renders read-only.
  }, [activeOrgId, runId, runStatus, load]);

  // ── Review figures (from real rows only) ───────────────────────────────────
  const src = runLots.reduce(
    (acc, l) => {
      acc.consumed += Number(l.consumedVolumeLitres) || 0;
      acc.bottled += Number(l.bottledLitres) || 0;
      acc.loss += Number(l.lossLitres) || 0;
      return acc;
    },
    { consumed: 0, bottled: 0, loss: 0 }
  );
  const out = outputs.reduce(
    (acc, o) => {
      acc.bottled += Number(o.bottledLitres) || 0;
      acc.bottles += Number(o.bottleCount) || 0;
      return acc;
    },
    { bottled: 0, bottles: 0 }
  );

  const difference = out.bottled - src.bottled;
  const reconciled = Math.abs(difference) <= EPSILON;

  // ── Client-side gates (mirror the RPC; UX only) ────────────────────────────
  const perLotReconciles = runLots.every(
    (l) => Math.abs((Number(l.bottledLitres) || 0) + (Number(l.lossLitres) || 0) - (Number(l.consumedVolumeLitres) || 0)) <= EPSILON
  );
  const availabilityOk = runLots.every(
    (l) => l.lotVolumeLitres == null || (Number(l.consumedVolumeLitres) || 0) - Number(l.lotVolumeLitres) <= EPSILON
  );
  const outputsValid = outputs.every((o) => {
    const vol = Number(o.bottleVolumeMl);
    const count = Number(o.bottleCount);
    const bl = Number(o.bottledLitres);
    const vintageOk = o.vintage == null || (Number.isInteger(Number(o.vintage)) && o.vintage >= 1900 && o.vintage <= 2200);
    return Number.isFinite(vol) && vol > 0
      && Number.isInteger(count) && count >= 0
      && Number.isFinite(bl) && bl >= 0
      && String(o.packagingFormat || '').trim().length > 0
      && vintageOk;
  });

  const checks = [
    { key: 'status', ok: active, label: 'Run is planned or in progress' },
    { key: 'sources', ok: runLots.length > 0, label: 'At least one source wine lot' },
    { key: 'outputs', ok: outputs.length > 0, label: 'At least one bottling output' },
    { key: 'consumed', ok: src.consumed > 0, label: 'Total consumed volume is greater than zero' },
    { key: 'perlot', ok: perLotReconciles, label: 'Each source: bottled + loss = consumed' },
    { key: 'avail', ok: availabilityOk, label: 'No source exceeds its available wine lot volume' },
    { key: 'recon', ok: reconciled, label: 'Source bottled equals declared output bottled' },
    { key: 'outvalid', ok: outputsValid, label: 'All output fields are valid' },
  ];
  const canComplete = active && checks.every((c) => c.ok) && !loading;

  const handleConfirm = async () => {
    setCompleting(true);
    const { error: err } = await completeBottlingRun(runId);
    setCompleting(false);
    if (err) {
      // Atomic failure: no partial transaction. Keep run active, show error,
      // refresh review data, do not retry.
      setConfirmOpen(false);
      setError(friendlyBottlingError(err));
      await load();
      return;
    }
    setConfirmOpen(false);
    setToast('Bottling run completed.');
    // Refetch from the database (never fake the result). The parent owns the
    // run + sibling sections, so delegate the full refresh to it.
    if (onCompleted) await onCompleted();
    await load();
  };

  // ── Terminal (completed/cancelled): read-only summary ──────────────────────
  const terminal = !active;

  return (
    <Paper variant="outlined" sx={{ borderRadius: 3, p: { xs: 2.5, md: 3.5 }, mt: 3 }}>
      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, mb: 2 }}>
        <Box sx={{ width: 36, height: 36, borderRadius: 1.5, bgcolor: 'background.subtle', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'secondary.main' }}>
          <TaskAltOutlinedIcon />
        </Box>
        <Box>
          <Typography variant="h5" component="h2">Completion</Typography>
          {terminal && (
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              Read-only — this run is {run?.status === 'completed' ? 'completed' : 'cancelled'}.
            </Typography>
          )}
        </Box>
      </Box>

      {error && <Alert severity="error" sx={{ mb: 2 }} action={<Button color="inherit" size="small" onClick={load}>Retry</Button>} onClose={() => setError('')}>{error}</Alert>}

      {loading ? (
        <Box>
          {[0, 1, 2].map((i) => (
            <Box key={i} sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 1 }}>
              <Skeleton width="40%" height={22} />
              <Skeleton width="20%" height={22} sx={{ ml: 'auto' }} />
            </Box>
          ))}
        </Box>
      ) : (
        <>
          {run?.status === 'completed' && (
            <Alert severity="success" icon={<CheckCircleOutlineOutlinedIcon />} sx={{ mb: 2.5 }}>
              This bottling run is completed. Source volume deductions have been applied.
            </Alert>
          )}
          {run?.status === 'cancelled' && (
            <Alert severity="warning" icon={<LockOutlinedIcon />} sx={{ mb: 2.5 }}>
              This bottling run was cancelled and cannot be completed.
            </Alert>
          )}

          {/* Review grid */}
          <Paper variant="outlined" sx={{ borderRadius: 2, p: { xs: 2, md: 2.5 }, bgcolor: 'background.subtle' }}>
            <Typography variant="overline" sx={{ color: 'text.disabled', letterSpacing: '0.08em' }}>Bottling Review</Typography>
            <Grid container spacing={{ xs: 2, md: 4 }} sx={{ mt: 0 }}>
              <Grid item xs={12} md={4}>
                <Typography variant="subtitle2" sx={{ color: 'text.primary', mb: 0.5 }}>Source Wine</Typography>
                <ReviewRow label="Source Lots" value={formatNumber(runLots.length, { maximumFractionDigits: 0 })} />
                <ReviewRow label="Total Consumed" value={formatNumber(src.consumed)} suffix="L" />
                <ReviewRow label="Total Bottled" value={formatNumber(src.bottled)} suffix="L" />
                <ReviewRow label="Total Loss" value={formatNumber(src.loss)} suffix="L" />
              </Grid>
              <Grid item xs={12} md={4}>
                <Typography variant="subtitle2" sx={{ color: 'text.primary', mb: 0.5 }}>Outputs</Typography>
                <ReviewRow label="Output Lines" value={formatNumber(outputs.length, { maximumFractionDigits: 0 })} />
                <ReviewRow label="Total Bottles" value={formatNumber(out.bottles, { maximumFractionDigits: 0 })} />
                <ReviewRow label="Declared Bottled" value={formatNumber(out.bottled)} suffix="L" />
              </Grid>
              <Grid item xs={12} md={4}>
                <Typography variant="subtitle2" sx={{ color: 'text.primary', mb: 0.5 }}>Run</Typography>
                <ReviewRow label="Bottling Code" value={run?.bottlingCode || '—'} />
                <ReviewRow label="Bottling Date" value={formatDate(run?.bottlingDate)} />
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', py: 0.5 }}>
                  <Typography variant="body2" sx={{ color: 'text.secondary' }}>Status</Typography>
                  <Chip label={bottlingRunStatusLabel(run?.status)} size="small" color={bottlingRunStatusColor(run?.status)} sx={{ fontWeight: 600 }} />
                </Box>
              </Grid>
            </Grid>

            <Divider sx={{ my: 2 }} />

            {/* Reconciliation */}
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={{ xs: 1.5, sm: 3 }} alignItems={{ sm: 'center' }}>
              <Box>
                <Typography variant="overline" sx={{ color: 'text.disabled', letterSpacing: '0.08em' }}>Source Bottled</Typography>
                <Typography variant="body1" sx={{ color: 'text.primary' }}>{formatNumber(src.bottled)} L</Typography>
              </Box>
              <Box>
                <Typography variant="overline" sx={{ color: 'text.disabled', letterSpacing: '0.08em' }}>Declared Outputs</Typography>
                <Typography variant="body1" sx={{ color: 'text.primary' }}>{formatNumber(out.bottled)} L</Typography>
              </Box>
              <Box>
                <Typography variant="overline" sx={{ color: 'text.disabled', letterSpacing: '0.08em' }}>Difference</Typography>
                <Typography variant="body1" sx={{ color: 'text.primary' }}>{formatNumber(difference)} L</Typography>
              </Box>
              <Box sx={{ flexGrow: 1 }} />
              <Chip
                icon={reconciled ? <CheckCircleOutlineOutlinedIcon /> : <ErrorOutlineOutlinedIcon />}
                color={reconciled ? 'success' : 'warning'}
                variant={reconciled ? 'filled' : 'outlined'}
                label={reconciled ? 'Balanced' : 'Not Balanced'}
                sx={{ fontWeight: 600 }}
              />
            </Stack>
          </Paper>

          {/* Gate checklist + Complete action (active runs only) */}
          {active && (
            <Box sx={{ mt: 2.5 }}>
              {!canComplete && (
                <List dense sx={{ mb: 1 }}>
                  {checks.map((c) => (
                    <ListItem key={c.key} disableGutters sx={{ py: 0.25 }}>
                      <ListItemIcon sx={{ minWidth: 32 }}>
                        {c.ok
                          ? <CheckCircleOutlineOutlinedIcon fontSize="small" color="success" />
                          : <WarningAmberOutlinedIcon fontSize="small" color="warning" />}
                      </ListItemIcon>
                      <ListItemText
                        primary={c.label}
                        primaryTypographyProps={{ variant: 'body2', color: c.ok ? 'text.secondary' : 'text.primary' }}
                      />
                    </ListItem>
                  ))}
                </List>
              )}
              <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Button
                  variant="contained"
                  color="primary"
                  startIcon={<TaskAltOutlinedIcon />}
                  disabled={!canComplete}
                  onClick={() => setConfirmOpen(true)}
                >
                  Complete Bottling Run
                </Button>
              </Box>
              {!canComplete && (
                <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', textAlign: 'right', mt: 1 }}>
                  Resolve the items above to enable completion. The database remains the final authority.
                </Typography>
              )}
            </Box>
          )}
        </>
      )}

      {/* Explicit confirmation dialog */}
      <Dialog open={confirmOpen} onClose={completing ? undefined : () => setConfirmOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Complete Bottling Run?</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ color: 'text.secondary', mb: 2 }}>
            This will permanently complete this bottling run and apply the recorded source volume deductions.
            This cannot be undone.
          </DialogContentText>
          <Paper variant="outlined" sx={{ borderRadius: 2, p: 2, bgcolor: 'background.subtle' }}>
            <ReviewRow label="Consumed" value={formatNumber(src.consumed)} suffix="L" strong />
            <ReviewRow label="Bottled" value={formatNumber(src.bottled)} suffix="L" />
            <ReviewRow label="Loss" value={formatNumber(src.loss)} suffix="L" />
            <ReviewRow label="Outputs" value={formatNumber(out.bottled)} suffix="L" />
            <Divider sx={{ my: 1 }} />
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <CheckCircleOutlineOutlinedIcon fontSize="small" color={(Math.abs(src.bottled + src.loss - src.consumed) <= EPSILON) ? 'success' : 'disabled'} />
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                Bottled + Loss = Consumed ({formatNumber(src.bottled + src.loss)} L = {formatNumber(src.consumed)} L)
              </Typography>
            </Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 0.5 }}>
              <CheckCircleOutlineOutlinedIcon fontSize="small" color={reconciled ? 'success' : 'disabled'} />
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                Outputs = Bottled ({formatNumber(out.bottled)} L = {formatNumber(src.bottled)} L)
              </Typography>
            </Box>
          </Paper>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2.5 }}>
          <Button onClick={() => setConfirmOpen(false)} color="inherit" disabled={completing}>Cancel</Button>
          <Button onClick={handleConfirm} variant="contained" color="primary" disabled={completing || !canComplete}>
            {completing ? <CircularProgress size={20} color="inherit" /> : 'Complete Bottling Run'}
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar open={Boolean(toast)} autoHideDuration={4000} onClose={() => setToast('')} message={toast} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }} />
    </Paper>
  );
}

export default BottlingCompletionSection;
