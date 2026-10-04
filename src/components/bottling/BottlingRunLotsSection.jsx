import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Paper, Typography, Button, Skeleton, Alert, Snackbar, Stack, Chip, Link,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, IconButton,
  Tooltip, Grid,
} from '@mui/material';
import AddOutlinedIcon from '@mui/icons-material/AddOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import ScienceOutlinedIcon from '@mui/icons-material/ScienceOutlined';
import OpenInNewOutlinedIcon from '@mui/icons-material/OpenInNewOutlined';
import { alpha } from '@mui/material/styles';
import BottlingRunLotForm from './BottlingRunLotForm';
import { isBottlingRunEditable } from './BottlingRunTable';
import { formatNumber } from '../common/formatters';
import { useOrganisation } from '../../context/OrganisationContext';
import {
  getBottlingRunLots, addBottlingRunLot, updateBottlingRunLot,
  getWineLotOptionsForBottling, friendlyBottlingError,
} from '../../services/bottlingService';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Bottling Run → Source Wine Lots section (P2J-B5-2)
//
// Lists, adds and edits the source Wine Lot allocations for a bottling run.
// PLANNING DATA ONLY — this never deducts Wine Lot volume, never creates
// production_events or lot_volume_movements, and never calls the completion RPC.
// All data access goes through bottlingService (never Supabase directly).
//
// Active-run rule: add/edit are available only while the run is planned or
// in_progress. Completed/cancelled runs render read-only (the DB 036 guards are
// the final authority).
//
// Removal: the B2 schema intentionally defines NO DELETE policy / grant for
// bottling_run_lots and the service has NO delete function. A Remove action is
// therefore NOT implemented here — see the task report. We do not add DELETE
// access, a delete RPC, or any RLS change.
//
// Duplicate protection: already-allocated lots are excluded from the Add
// selector; the DB unique (bottling_run_id, wine_lot_id) remains authoritative
// and a race is surfaced via the friendly error.
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

function BottlingRunLotsSection({ run }) {
  const navigate = useNavigate();
  const { activeOrgId } = useOrganisation();
  const runId = run?.id || null;
  const editable = isBottlingRunEditable(run?.status);

  const [allocations, setAllocations] = useState([]);
  const [lotOptions, setLotOptions] = useState([]);
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
    const [lotsRes, optionsRes] = await Promise.all([
      getBottlingRunLots(runId),
      getWineLotOptionsForBottling(),
    ]);

    if (lotsRes.error) {
      const friendly = friendlyBottlingError(lotsRes.error);
      if (/not set up yet/i.test(friendly)) setAllocations([]); else setError(friendly);
    } else {
      setAllocations(lotsRes.data || []);
    }

    if (optionsRes.error) setLotOptions([]);
    else setLotOptions(optionsRes.data || []);

    setLoading(false);
  }, [runId]);

  // Reload when the run OR the active organisation changes. Clear first so no
  // previous-org allocations are shown mid-switch.
  useEffect(() => {
    if (!activeOrgId || !runId) { setAllocations([]); setLotOptions([]); return; }
    setAllocations([]); setLotOptions([]);
    load();
  }, [activeOrgId, runId, load]);

  // Totals from the actual rows (no invented percentages/yields).
  const totals = allocations.reduce(
    (acc, a) => {
      acc.consumed += Number(a.consumedVolumeLitres) || 0;
      acc.bottled += Number(a.bottledLitres) || 0;
      acc.loss += Number(a.lossLitres) || 0;
      return acc;
    },
    { consumed: 0, bottled: 0, loss: 0 }
  );

  // Exclude already-allocated lots from the Add selector (duplicate avoidance).
  const allocatedLotIds = new Set(allocations.map((a) => a.wineLotId));
  const availableLotOptions = lotOptions.filter((l) => !allocatedLotIds.has(l.id));

  const openAdd = () => { setFormMode('add'); setFormTarget(null); setFormOpen(true); };
  const openEdit = (a) => { setFormMode('edit'); setFormTarget(a); setFormOpen(true); };

  const handleSubmit = async (payload) => {
    setSaving(true);
    let res;
    if (formMode === 'edit') {
      res = await updateBottlingRunLot(formTarget.id, payload);
    } else {
      res = await addBottlingRunLot({ ...payload, bottlingRunId: runId });
    }
    setSaving(false);
    if (res.error) { setError(friendlyBottlingError(res.error)); return; }
    setFormOpen(false); setFormTarget(null);
    setToast(formMode === 'edit' ? 'Source wine lot updated.' : 'Source wine lot added.');
    await load();
  };

  return (
    <Paper variant="outlined" sx={{ borderRadius: 3, p: { xs: 2.5, md: 3.5 }, mt: 3 }}>
      {/* Header */}
      <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, alignItems: { xs: 'flex-start', sm: 'center' }, justifyContent: 'space-between', gap: 2, mb: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
          <Box sx={{ width: 36, height: 36, borderRadius: 1.5, bgcolor: 'background.subtle', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'secondary.main' }}>
            <ScienceOutlinedIcon />
          </Box>
          <Box>
            <Typography variant="h5" component="h2">Source Wine Lots</Typography>
            {!editable && (
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                Read-only — this run is {run?.status === 'completed' ? 'completed' : 'cancelled'}.
              </Typography>
            )}
          </Box>
        </Box>
        {editable && (
          <Button variant="outlined" color="primary" startIcon={<AddOutlinedIcon />} onClick={openAdd} sx={{ flexShrink: 0 }}>
            Add Source Wine Lot
          </Button>
        )}
      </Box>

      {/* Totals */}
      {!loading && allocations.length > 0 && (
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ mb: 2.5 }}>
          <TotalStat label="Source Lots" value={formatNumber(allocations.length, { maximumFractionDigits: 0 })} />
          <TotalStat label="Total Consumed" value={formatNumber(totals.consumed)} suffix="L" />
          <TotalStat label="Total Bottled" value={formatNumber(totals.bottled)} suffix="L" />
          <TotalStat label="Total Loss" value={formatNumber(totals.loss)} suffix="L" />
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
      ) : allocations.length === 0 ? (
        <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', px: 3, py: { xs: 4, md: 5 }, textAlign: 'center' }}>
          <Typography variant="body2" sx={{ color: 'text.secondary', maxWidth: 520, mx: 'auto', mb: editable ? 2.5 : 0 }}>
            No source wine lots have been allocated to this run yet.
          </Typography>
          {editable && (
            <Button variant="contained" color="primary" startIcon={<AddOutlinedIcon />} onClick={openAdd}>Add Source Wine Lot</Button>
          )}
        </Paper>
      ) : (
        <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 2, overflowX: 'auto' }}>
          <Table sx={{ minWidth: 920 }} aria-label="Source wine lots">
            <TableHead>
              <TableRow>
                <TableCell>Wine Lot</TableCell>
                <TableCell>Batch</TableCell>
                <TableCell align="right">Available</TableCell>
                <TableCell align="right">Consumed</TableCell>
                <TableCell align="right">Bottled</TableCell>
                <TableCell align="right">Loss</TableCell>
                <TableCell>Notes</TableCell>
                {editable && <TableCell align="right">Actions</TableCell>}
              </TableRow>
            </TableHead>
            <TableBody>
              {allocations.map((a) => (
                <TableRow key={a.id} hover sx={{ '& .MuiTableCell-root': { py: 1.5 } }}>
                  <TableCell>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <Box
                        sx={{
                          width: 30, height: 30, borderRadius: 1.25, flexShrink: 0,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          color: 'secondary.main', bgcolor: (t) => alpha(t.palette.secondary.main, 0.12),
                        }}
                      >
                        <ScienceOutlinedIcon sx={{ fontSize: '1rem' }} />
                      </Box>
                      {a.wineLotId ? (
                        <Link
                          component="button"
                          type="button"
                          underline="hover"
                          onClick={() => navigate(`/wine-lots/${a.wineLotId}`)}
                          sx={{ fontWeight: 600, color: 'text.primary', textAlign: 'left' }}
                        >
                          {a.lotCode || '—'}
                        </Link>
                      ) : (
                        <Typography variant="body2" sx={{ fontWeight: 600 }}>{a.lotCode || '—'}</Typography>
                      )}
                      {a.lotStatus && <Chip label={a.lotStatus} size="small" variant="outlined" sx={{ height: 20, fontSize: '0.68rem' }} />}
                    </Box>
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                      {a.batchCode || '—'}{a.batchVintage ? ` · ${a.batchVintage}` : ''}
                    </Typography>
                  </TableCell>
                  <TableCell align="right">
                    <Typography variant="body2" sx={{ color: 'text.secondary' }}>{a.lotVolumeLitres != null ? `${formatNumber(a.lotVolumeLitres)} L` : '—'}</Typography>
                  </TableCell>
                  <TableCell align="right">
                    <Typography variant="body2" sx={{ color: 'text.primary', fontWeight: 600 }}>{formatNumber(a.consumedVolumeLitres)} L</Typography>
                  </TableCell>
                  <TableCell align="right">
                    <Typography variant="body2" sx={{ color: 'text.secondary' }}>{formatNumber(a.bottledLitres)} L</Typography>
                  </TableCell>
                  <TableCell align="right">
                    <Typography variant="body2" sx={{ color: 'text.secondary' }}>{formatNumber(a.lossLitres)} L</Typography>
                  </TableCell>
                  <TableCell sx={{ maxWidth: 220 }}>
                    <Typography
                      variant="body2"
                      sx={{ color: a.notes ? 'text.secondary' : 'text.disabled', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      title={a.notes || ''}
                    >
                      {a.notes || '—'}
                    </Typography>
                  </TableCell>
                  {editable && (
                    <TableCell align="right">
                      <Box sx={{ display: 'inline-flex' }}>
                        <Tooltip title="Open wine lot">
                          <IconButton size="small" color="primary" aria-label={`Open wine lot ${a.lotCode}`} onClick={() => a.wineLotId && navigate(`/wine-lots/${a.wineLotId}`)} disabled={!a.wineLotId}>
                            <OpenInNewOutlinedIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title="Edit allocation">
                          <IconButton size="small" aria-label={`Edit allocation ${a.lotCode}`} onClick={() => openEdit(a)}>
                            <EditOutlinedIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      </Box>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {/* Reconciliation note from the real totals (no invented figures). */}
      {!loading && allocations.length > 0 && (
        <Grid container sx={{ mt: 2 }}>
          <Grid item xs={12}>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              Total Consumed {formatNumber(totals.consumed)} L = Bottled {formatNumber(totals.bottled)} L + Loss {formatNumber(totals.loss)} L.
              {' '}Allocations are planned only — wine lot volumes are not reduced until the run is completed.
            </Typography>
          </Grid>
        </Grid>
      )}

      <BottlingRunLotForm
        open={formOpen}
        mode={formMode}
        allocation={formTarget}
        lotOptions={availableLotOptions}
        saving={saving}
        onSubmit={handleSubmit}
        onClose={() => { setFormOpen(false); setFormTarget(null); }}
      />
      <Snackbar open={Boolean(toast)} autoHideDuration={4000} onClose={() => setToast('')} message={toast} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }} />
    </Paper>
  );
}

export default BottlingRunLotsSection;
