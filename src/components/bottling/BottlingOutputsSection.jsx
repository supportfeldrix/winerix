import { useEffect, useState, useCallback } from 'react';
import {
  Box, Paper, Typography, Button, Skeleton, Alert, Snackbar, Stack, Chip,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, IconButton,
  Tooltip,
} from '@mui/material';
import AddOutlinedIcon from '@mui/icons-material/AddOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import Inventory2OutlinedIcon from '@mui/icons-material/Inventory2Outlined';
import CheckCircleOutlineOutlinedIcon from '@mui/icons-material/CheckCircleOutlineOutlined';
import BalanceOutlinedIcon from '@mui/icons-material/BalanceOutlined';
import { alpha } from '@mui/material/styles';
import BottlingOutputForm from './BottlingOutputForm';
import { isBottlingRunEditable } from './BottlingRunTable';
import { formatNumber } from '../common/formatters';
import { useOrganisation } from '../../context/OrganisationContext';
import {
  getBottlingOutputs, createBottlingOutput, updateBottlingOutput,
  getBottlingRunLots, friendlyBottlingError,
} from '../../services/bottlingService';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Bottling Run → Bottling Outputs section (P2J-B5-3)
//
// Lists, adds and edits the declared output lines for a bottling run
// (bottling_outputs). DECLARED RECORDS ONLY — this never creates products, SKUs,
// stock, cases/pallets, production_events or lot_volume_movements, and never
// calls the completion RPC. All data access is through bottlingService.
//
// Active-run rule: add/edit only while planned/in_progress; completed/cancelled
// render read-only (DB 036 guards remain the final authority).
//
// Reconciliation: shows Source Bottled (SUM bottling_run_lots.bottled_litres) vs
// Declared Outputs (SUM bottling_outputs.bottled_litres). A mismatch is surfaced
// clearly but NEVER blocks add/edit — the B4 completion RPC is the final gate.
//
// No DELETE: 034 defines no DELETE policy/grant for bottling_outputs and the
// service has no delete function — there is intentionally no Delete action.
// ─────────────────────────────────────────────────────────────────────────────

function TotalStat({ label, value, suffix }) {
  return (
    <Paper
      variant="outlined"
      sx={{ borderRadius: 2, px: 2, py: 1.5, flex: 1, minWidth: 140, bgcolor: 'background.subtle' }}
    >
      <Typography variant="overline" sx={{ color: 'text.disabled', letterSpacing: '0.08em' }}>{label}</Typography>
      <Typography variant="h6" sx={{ color: 'text.primary' }}>
        {value}{suffix ? <Typography component="span" variant="body2" sx={{ color: 'text.secondary', ml: 0.5 }}>{suffix}</Typography> : null}
      </Typography>
    </Paper>
  );
}

const EPSILON = 1e-6;

function BottlingOutputsSection({ run }) {
  const { activeOrgId } = useOrganisation();
  const runId = run?.id || null;
  const editable = isBottlingRunEditable(run?.status);

  const [outputs, setOutputs] = useState([]);
  const [runLots, setRunLots] = useState([]); // for source-vs-output reconciliation
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [formOpen, setFormOpen] = useState(false);
  const [formMode, setFormMode] = useState('add');
  const [formTarget, setFormTarget] = useState(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState('');

  const load = useCallback(async () => {
    if (!runId) return;
    setLoading(true); setError('');
    const [outputsRes, lotsRes] = await Promise.all([
      getBottlingOutputs(runId),
      getBottlingRunLots(runId),
    ]);

    if (outputsRes.error) {
      const friendly = friendlyBottlingError(outputsRes.error);
      if (/not set up yet/i.test(friendly)) setOutputs([]); else setError(friendly);
    } else {
      setOutputs(outputsRes.data || []);
    }

    // Run lots are used only for the reconciliation indicator; a failure here
    // must not block the outputs list.
    if (lotsRes.error) setRunLots([]);
    else setRunLots(lotsRes.data || []);

    setLoading(false);
  }, [runId]);

  // Reload when the run OR the active organisation changes. Clear first so no
  // previous-org outputs are shown mid-switch.
  useEffect(() => {
    if (!activeOrgId || !runId) { setOutputs([]); setRunLots([]); return; }
    setOutputs([]); setRunLots([]);
    load();
  }, [activeOrgId, runId, load]);

  // Totals from the actual output rows (no invented yields / cases / pallets).
  const totals = outputs.reduce(
    (acc, o) => {
      acc.bottledLitres += Number(o.bottledLitres) || 0;
      acc.bottles += Number(o.bottleCount) || 0;
      return acc;
    },
    { bottledLitres: 0, bottles: 0 }
  );

  // Reconciliation figures.
  const sourceBottled = runLots.reduce((sum, l) => sum + (Number(l.bottledLitres) || 0), 0);
  const declaredOutputs = totals.bottledLitres;
  const difference = declaredOutputs - sourceBottled;
  const hasSource = runLots.length > 0;
  const balanced = Math.abs(difference) <= EPSILON;

  const openAdd = () => { setFormMode('add'); setFormTarget(null); setFormOpen(true); };
  const openEdit = (o) => { setFormMode('edit'); setFormTarget(o); setFormOpen(true); };

  const handleSubmit = async (payload) => {
    setSaving(true);
    let res;
    if (formMode === 'edit') {
      res = await updateBottlingOutput(formTarget.id, payload);
    } else {
      res = await createBottlingOutput({ ...payload, bottlingRunId: runId });
    }
    setSaving(false);
    if (res.error) { setError(friendlyBottlingError(res.error)); return; }
    setFormOpen(false); setFormTarget(null);
    setToast(formMode === 'edit' ? 'Bottling output updated.' : 'Bottling output added.');
    await load();
  };

  return (
    <Paper variant="outlined" sx={{ borderRadius: 3, p: { xs: 2.5, md: 3.5 }, mt: 3 }}>
      {/* Header */}
      <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, alignItems: { xs: 'flex-start', sm: 'center' }, justifyContent: 'space-between', gap: 2, mb: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
          <Box sx={{ width: 36, height: 36, borderRadius: 1.5, bgcolor: 'background.subtle', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'secondary.main' }}>
            <Inventory2OutlinedIcon />
          </Box>
          <Box>
            <Typography variant="h5" component="h2">Bottling Outputs</Typography>
            {!editable && (
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                Read-only — this run is {run?.status === 'completed' ? 'completed' : 'cancelled'}.
              </Typography>
            )}
          </Box>
        </Box>
        {editable && (
          <Button variant="outlined" color="primary" startIcon={<AddOutlinedIcon />} onClick={openAdd} sx={{ flexShrink: 0 }}>
            Add Bottling Output
          </Button>
        )}
      </Box>

      {/* Totals */}
      {!loading && outputs.length > 0 && (
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ mb: 2.5 }}>
          <TotalStat label="Output Lines" value={formatNumber(outputs.length, { maximumFractionDigits: 0 })} />
          <TotalStat label="Total Bottles" value={formatNumber(totals.bottles, { maximumFractionDigits: 0 })} />
          <TotalStat label="Total Bottled Litres" value={formatNumber(totals.bottledLitres)} suffix="L" />
        </Stack>
      )}

      {error && <Alert severity="error" sx={{ mb: 2 }} action={<Button color="inherit" size="small" onClick={load}>Retry</Button>} onClose={() => setError('')}>{error}</Alert>}

      {loading ? (
        <Box>
          {[0, 1].map((i) => (
            <Box key={i} sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 1 }}>
              <Skeleton variant="rounded" width={30} height={30} />
              <Skeleton width="30%" height={22} />
              <Skeleton width="15%" height={22} sx={{ ml: 'auto' }} />
            </Box>
          ))}
        </Box>
      ) : outputs.length === 0 ? (
        <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', px: 3, py: { xs: 4, md: 5 }, textAlign: 'center' }}>
          <Typography variant="body2" sx={{ color: 'text.secondary', maxWidth: 520, mx: 'auto', mb: editable ? 2.5 : 0 }}>
            No bottling outputs have been recorded for this run yet.
          </Typography>
          {editable && (
            <Button variant="contained" color="primary" startIcon={<AddOutlinedIcon />} onClick={openAdd}>Add Bottling Output</Button>
          )}
        </Paper>
      ) : (
        <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 2, overflowX: 'auto' }}>
          <Table sx={{ minWidth: 920 }} aria-label="Bottling outputs">
            <TableHead>
              <TableRow>
                <TableCell>Bottle Size</TableCell>
                <TableCell align="right">Bottle Count</TableCell>
                <TableCell align="right">Bottled Litres</TableCell>
                <TableCell>Packaging</TableCell>
                <TableCell>Product</TableCell>
                <TableCell align="right">Vintage</TableCell>
                <TableCell>Notes</TableCell>
                {editable && <TableCell align="right">Actions</TableCell>}
              </TableRow>
            </TableHead>
            <TableBody>
              {outputs.map((o) => (
                <TableRow key={o.id} hover sx={{ '& .MuiTableCell-root': { py: 1.5 } }}>
                  <TableCell>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <Box
                        sx={{
                          width: 30, height: 30, borderRadius: 1.25, flexShrink: 0,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          color: 'secondary.main', bgcolor: (t) => alpha(t.palette.secondary.main, 0.12),
                        }}
                      >
                        <Inventory2OutlinedIcon sx={{ fontSize: '1rem' }} />
                      </Box>
                      <Typography variant="body2" sx={{ fontWeight: 600, color: 'text.primary' }}>
                        {o.bottleVolumeMl != null ? `${formatNumber(o.bottleVolumeMl, { maximumFractionDigits: 0 })} ml` : '—'}
                      </Typography>
                    </Box>
                  </TableCell>
                  <TableCell align="right">
                    <Typography variant="body2" sx={{ color: 'text.secondary' }}>{formatNumber(o.bottleCount, { maximumFractionDigits: 0 })}</Typography>
                  </TableCell>
                  <TableCell align="right">
                    <Typography variant="body2" sx={{ color: 'text.primary', fontWeight: 600 }}>{formatNumber(o.bottledLitres)} L</Typography>
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" sx={{ color: 'text.secondary' }}>{o.packagingFormat || '—'}</Typography>
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" sx={{ color: o.productName ? 'text.secondary' : 'text.disabled' }}>{o.productName || '—'}</Typography>
                  </TableCell>
                  <TableCell align="right">
                    <Typography variant="body2" sx={{ color: o.vintage ? 'text.secondary' : 'text.disabled' }}>{o.vintage || '—'}</Typography>
                  </TableCell>
                  <TableCell sx={{ maxWidth: 200 }}>
                    <Typography
                      variant="body2"
                      sx={{ color: o.notes ? 'text.secondary' : 'text.disabled', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      title={o.notes || ''}
                    >
                      {o.notes || '—'}
                    </Typography>
                  </TableCell>
                  {editable && (
                    <TableCell align="right">
                      <Tooltip title="Edit output">
                        <IconButton size="small" aria-label={`Edit output ${o.bottleVolumeMl} ml`} onClick={() => openEdit(o)}>
                          <EditOutlinedIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {/* Source ↔ Output reconciliation (only once there are source allocations). */}
      {!loading && hasSource && (
        <Paper
          variant="outlined"
          sx={{
            mt: 2.5, borderRadius: 2, p: 2,
            borderColor: (t) => (balanced ? alpha(t.palette.success.main, 0.4) : alpha(t.palette.warning.main, 0.5)),
            bgcolor: (t) => alpha(balanced ? t.palette.success.main : t.palette.warning.main, 0.06),
          }}
        >
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={{ xs: 1.5, sm: 3 }} alignItems={{ sm: 'center' }}>
            <Box>
              <Typography variant="overline" sx={{ color: 'text.disabled', letterSpacing: '0.08em' }}>Source Bottled</Typography>
              <Typography variant="body1" sx={{ color: 'text.primary' }}>{formatNumber(sourceBottled)} L</Typography>
            </Box>
            <Box>
              <Typography variant="overline" sx={{ color: 'text.disabled', letterSpacing: '0.08em' }}>Declared Outputs</Typography>
              <Typography variant="body1" sx={{ color: 'text.primary' }}>{formatNumber(declaredOutputs)} L</Typography>
            </Box>
            <Box sx={{ flexGrow: 1 }} />
            <Chip
              icon={balanced ? <CheckCircleOutlineOutlinedIcon /> : <BalanceOutlinedIcon />}
              color={balanced ? 'success' : 'warning'}
              variant={balanced ? 'filled' : 'outlined'}
              label={
                balanced
                  ? 'Output reconciliation: Balanced'
                  : `Output reconciliation: Difference of ${formatNumber(Math.abs(difference))} L`
              }
              sx={{ fontWeight: 600 }}
            />
          </Stack>
          {!balanced && (
            <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 1 }}>
              Declared outputs {difference > 0 ? 'exceed' : 'are below'} the source bottled volume. You can continue building output
              lines — completion will require these totals to reconcile.
            </Typography>
          )}
        </Paper>
      )}

      <BottlingOutputForm
        open={formOpen}
        mode={formMode}
        output={formTarget}
        saving={saving}
        onSubmit={handleSubmit}
        onClose={() => { setFormOpen(false); setFormTarget(null); }}
      />
      <Snackbar open={Boolean(toast)} autoHideDuration={4000} onClose={() => setToast('')} message={toast} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }} />
    </Paper>
  );
}

export default BottlingOutputsSection;
