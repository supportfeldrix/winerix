import { useEffect, useState, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Box, Paper, Typography, Chip, Button, Divider, Grid, Skeleton, Alert, Snackbar, Link,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, MenuItem,
  Dialog, DialogTitle, DialogContent, DialogActions, Stack, CircularProgress,
} from '@mui/material';
import ArrowBackOutlinedIcon from '@mui/icons-material/ArrowBackOutlined';
import AssignmentReturnOutlinedIcon from '@mui/icons-material/AssignmentReturnOutlined';
import ListAltOutlinedIcon from '@mui/icons-material/ListAltOutlined';
import PageContainer from '../components/layout/PageContainer';
import { useOrganisation } from '../context/OrganisationContext';
import { formatDate, formatNumber } from '../components/common/formatters';
import { getStockLocationOptions } from '../services/stockLocationService';
import {
  getReturn, getReturnLines, receiveReturn, inspectReturnLine, restockReturnLine,
  writeoffReturnLine, closeReturn, cancelReturn,
  friendlyReturnError, returnStatusLabel, returnStatusColor,
  dispositionLabel, dispositionColor, reasonCodeLabel, conditionCodeLabel,
  RETURN_CONDITION_CODES, canPhysicalReturn, canCancelReturn,
} from '../services/returnService';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Return profile (P2M-6)
// Header + lines (returned qty, reason, condition, disposition) with lifecycle
// actions gated by role + status: Receive (pending→received), per-line Inspect /
// Restock / Write-off (received + awaiting_inspection), Close (received + all
// lines disposed), Cancel (pending only, admin). All writes via returnService
// RPCs; re-fetches after each success. Returns never mutate delivery/dispatch/
// allocation/order history.
// ─────────────────────────────────────────────────────────────────────────────

function Field({ label, children }) {
  return (
    <Box>
      <Typography variant="overline" sx={{ color: 'text.disabled', letterSpacing: '0.08em' }}>{label}</Typography>
      <Typography variant="body1" sx={{ color: 'text.primary' }}>{children}</Typography>
    </Box>
  );
}

function ReturnProfile() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { activeOrgId, activeRole } = useOrganisation();

  const [ret, setRet] = useState(null);
  const [lines, setLines] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(false);
  const [locations, setLocations] = useState([]);

  // dialogs
  const [restockLine, setRestockLine] = useState(null); // the line being restocked
  const [restockLocationId, setRestockLocationId] = useState('');
  const [writeoffLine, setWriteoffLine] = useState(null);
  const [writeoffReason, setWriteoffReason] = useState('');
  const [inspectLine, setInspectLine] = useState(null);
  const [inspectCondition, setInspectCondition] = useState('');
  const [inspectNotes, setInspectNotes] = useState('');
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReasonText, setCancelReasonText] = useState('');

  const canPhysical = canPhysicalReturn(activeRole);
  const canCancel = canCancelReturn(activeRole);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    const { data, error: err } = await getReturn(id);
    if (err) { setError(friendlyReturnError(err)); setLoading(false); return; }
    if (!data) { setError('Return not found.'); setLoading(false); return; }
    setRet(data);
    const { data: lineData, error: lineErr } = await getReturnLines(id);
    if (lineErr) { setError(friendlyReturnError(lineErr)); setLoading(false); return; }
    setLines(lineData || []);
    setLoading(false);
  }, [id]);

  useEffect(() => { if (activeOrgId) load(); }, [activeOrgId, load]);

  // Active locations for the restock picker (loaded lazily on first need).
  const ensureLocations = useCallback(async () => {
    if (locations.length > 0) return;
    const { data } = await getStockLocationOptions();
    setLocations(data || []);
  }, [locations.length]);

  const isPending = ret?.status === 'pending';
  const isReceived = ret?.status === 'received';
  const lineCount = lines.length;
  const disposedCount = lines.filter((l) => l.disposition !== 'awaiting_inspection').length;
  const allDisposed = lineCount > 0 && disposedCount === lineCount;
  const totalReturned = lines.reduce((s, l) => s + (Number(l.returnedQty) || 0), 0);

  async function handleReceive() {
    setBusy(true); setError('');
    const { error: err } = await receiveReturn(id);
    setBusy(false);
    if (err) { setError(friendlyReturnError(err)); return; }
    setToast('Return received into quarantine.'); await load();
  }

  async function handleClose() {
    setBusy(true); setError('');
    const { error: err } = await closeReturn(id);
    setBusy(false);
    if (err) { setError(friendlyReturnError(err)); return; }
    setToast('Return closed.'); await load();
  }

  async function handleCancel() {
    setBusy(true); setError('');
    const { error: err } = await cancelReturn(id, cancelReasonText);
    setBusy(false);
    if (err) { setError(friendlyReturnError(err)); return; }
    setCancelOpen(false); setCancelReasonText(''); setToast('Return cancelled.'); await load();
  }

  async function openRestock(line) {
    setRestockLine(line); setRestockLocationId('');
    await ensureLocations();
  }

  async function handleRestock() {
    setBusy(true); setError('');
    const { error: err } = await restockReturnLine(restockLine.id, restockLocationId);
    setBusy(false);
    if (err) { setError(friendlyReturnError(err)); return; }
    setRestockLine(null); setRestockLocationId(''); setToast('Line restocked.'); await load();
  }

  async function handleWriteoff() {
    setBusy(true); setError('');
    const { error: err } = await writeoffReturnLine(writeoffLine.id, writeoffReason.trim() || null);
    setBusy(false);
    if (err) { setError(friendlyReturnError(err)); return; }
    setWriteoffLine(null); setWriteoffReason(''); setToast('Line written off.'); await load();
  }

  function openInspect(line) {
    setInspectLine(line);
    setInspectCondition(line.conditionCode || '');
    setInspectNotes(line.notes || '');
  }

  async function handleInspect() {
    setBusy(true); setError('');
    const { error: err } = await inspectReturnLine(inspectLine.id, inspectCondition || null, inspectNotes.trim() || null);
    setBusy(false);
    if (err) { setError(friendlyReturnError(err)); return; }
    setInspectLine(null); setToast('Inspection saved.'); await load();
  }

  // Restock destination options exclude the quarantine location (server enforces this too).
  const restockOptions = locations.filter((l) => l.id !== ret?.quarantineLocationId);

  return (
    <PageContainer maxWidth={1600} sx={{ px: { xs: 2, sm: 3, md: 4, lg: 5 } }}>
      <Button startIcon={<ArrowBackOutlinedIcon />} onClick={() => navigate('/returns')} color="inherit" sx={{ mb: 2 }}>
        Back to Returns
      </Button>

      {error && <Alert severity="error" sx={{ mb: 2 }} action={<Button color="inherit" size="small" onClick={load}>Retry</Button>} onClose={() => setError('')}>{error}</Alert>}

      {loading ? (
        <Paper variant="outlined" sx={{ borderRadius: 3, p: { xs: 2.5, md: 3.5 } }}>
          <Skeleton width="30%" height={40} sx={{ mb: 2 }} />
          <Grid container spacing={3}>{[0,1,2,3,4,5].map((i) => <Grid item xs={12} sm={6} md={4} key={i}><Skeleton width="80%" height={48} /></Grid>)}</Grid>
        </Paper>
      ) : !ret ? null : (
        <>
          <Paper variant="outlined" sx={{ borderRadius: 3, p: { xs: 2.5, md: 3.5 } }}>
            <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, alignItems: { sm: 'center' }, justifyContent: 'space-between', gap: 2, mb: 1 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                <Box sx={{ width: 44, height: 44, borderRadius: 2, bgcolor: 'background.subtle', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'primary.main' }}>
                  <AssignmentReturnOutlinedIcon />
                </Box>
                <Box>
                  <Typography variant="h3" component="h1">{ret.returnNumber}</Typography>
                  <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                    {ret.deliveryNumber ? `For delivery ${ret.deliveryNumber}` : ''}
                  </Typography>
                </Box>
              </Box>
              <Chip label={returnStatusLabel(ret.status)} color={returnStatusColor(ret.status)} sx={{ fontWeight: 600 }} />
            </Box>

            <Divider sx={{ my: 3 }} />

            <Grid container spacing={3}>
              <Grid item xs={12} sm={6} md={4}>
                <Field label="Delivery">
                  {ret.deliveryConfirmationId ? (
                    <Link component="button" type="button" underline="hover" onClick={() => navigate(`/deliveries/${ret.deliveryConfirmationId}`)}>{ret.deliveryNumber || '—'}</Link>
                  ) : (ret.deliveryNumber || '—')}
                </Field>
              </Grid>
              <Grid item xs={12} sm={6} md={4}>
                <Field label="Dispatch">
                  {ret.dispatchId ? (
                    <Link component="button" type="button" underline="hover" onClick={() => navigate(`/dispatches/${ret.dispatchId}`)}>{ret.dispatchNumber || '—'}</Link>
                  ) : (ret.dispatchNumber || '—')}
                </Field>
              </Grid>
              <Grid item xs={12} sm={6} md={4}>
                <Field label="Sales Order">
                  {ret.salesOrderId ? (
                    <Link component="button" type="button" underline="hover" onClick={() => navigate(`/sales-orders/${ret.salesOrderId}`)}>{ret.orderNumber || '—'}</Link>
                  ) : (ret.orderNumber || '—')}
                </Field>
              </Grid>
              <Grid item xs={12} sm={6} md={4}>
                <Field label="Customer">
                  {ret.customerId ? (
                    <Link component="button" type="button" underline="hover" onClick={() => navigate(`/customers/${ret.customerId}`)}>{ret.customerLegalName || '—'}</Link>
                  ) : (ret.customerLegalName || '—')}
                </Field>
              </Grid>
              <Grid item xs={12} sm={6} md={4}><Field label="Quarantine Location">{ret.quarantineLocationName ? `${ret.quarantineLocationName} (${ret.quarantineLocationCode})` : '—'}</Field></Grid>
              <Grid item xs={12} sm={6} md={4}><Field label="Bottles returned">{formatNumber(totalReturned, { maximumFractionDigits: 0 })}</Field></Grid>
              <Grid item xs={12} sm={6} md={4}><Field label="Created">{ret.createdAt ? formatDate(ret.createdAt) : '—'}</Field></Grid>
              <Grid item xs={12} sm={6} md={4}><Field label="Received">{ret.receivedAt ? formatDate(ret.receivedAt) : '—'}</Field></Grid>
              <Grid item xs={12} sm={6} md={4}><Field label="Closed">{ret.closedAt ? formatDate(ret.closedAt) : '—'}</Field></Grid>
              <Grid item xs={12} sm={6}><Field label="Reason summary">{ret.reasonSummary || '—'}</Field></Grid>
              <Grid item xs={12} sm={6}><Field label="Cancellation reason">{ret.cancelReason || '—'}</Field></Grid>
            </Grid>

            {/* Header actions */}
            {(isPending || isReceived) && (canPhysical || canCancel) && (
              <>
                <Divider sx={{ my: 3 }} />
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                  {isPending && canPhysical && (
                    <Button variant="contained" color="primary" onClick={handleReceive} disabled={busy}>
                      Receive into quarantine
                    </Button>
                  )}
                  {isReceived && canPhysical && (
                    <Button variant="contained" color="primary" onClick={handleClose} disabled={busy || !allDisposed}>
                      Close return
                    </Button>
                  )}
                  {isPending && canCancel && (
                    <Button variant="text" color="inherit" onClick={() => setCancelOpen(true)} disabled={busy}>Cancel return</Button>
                  )}
                </Stack>
                <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 1 }}>
                  {isPending && 'Receiving adds the returned bottles into the quarantine location.'}
                  {isReceived && (allDisposed
                    ? 'All lines are disposed — the return can be closed.'
                    : `Dispose every line (restock or write off) before closing. ${disposedCount}/${lineCount} done.`)}
                </Typography>
              </>
            )}
          </Paper>

          {/* Lines */}
          <Paper variant="outlined" sx={{ borderRadius: 3, p: { xs: 2.5, md: 3.5 }, mt: 3 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, mb: 2 }}>
              <Box sx={{ width: 36, height: 36, borderRadius: 1.5, bgcolor: 'background.subtle', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'secondary.main' }}><ListAltOutlinedIcon /></Box>
              <Typography variant="h5" component="h2">Return Lines</Typography>
            </Box>

            <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 2, overflowX: 'auto' }}>
              <Table sx={{ minWidth: 1000 }} aria-label="Return lines">
                <TableHead>
                  <TableRow>
                    <TableCell>Product / SKU</TableCell>
                    <TableCell align="right">Returned</TableCell>
                    <TableCell>Reason</TableCell>
                    <TableCell>Condition</TableCell>
                    <TableCell>Disposition</TableCell>
                    <TableCell>Restock location</TableCell>
                    <TableCell align="right">Actions</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {lines.map((l) => {
                    const awaiting = l.disposition === 'awaiting_inspection';
                    const canAct = isReceived && canPhysical && awaiting;
                    return (
                      <TableRow key={l.id} hover sx={{ '& .MuiTableCell-root': { py: 1.5 } }}>
                        <TableCell>
                          <Typography variant="body2" sx={{ fontWeight: 600, color: 'text.primary' }}>{l.productName || '—'}</Typography>
                          <Typography variant="caption" sx={{ color: 'text.secondary' }}>{l.productSku || '—'}</Typography>
                        </TableCell>
                        <TableCell align="right"><Typography variant="body2" sx={{ fontWeight: 600 }}>{formatNumber(l.returnedQty, { maximumFractionDigits: 0 })}</Typography></TableCell>
                        <TableCell><Typography variant="body2" sx={{ color: 'text.secondary' }}>{reasonCodeLabel(l.reasonCode)}</Typography></TableCell>
                        <TableCell><Typography variant="body2" sx={{ color: 'text.secondary' }}>{conditionCodeLabel(l.conditionCode)}</Typography></TableCell>
                        <TableCell><Chip size="small" label={dispositionLabel(l.disposition)} color={dispositionColor(l.disposition)} sx={{ fontWeight: 600 }} /></TableCell>
                        <TableCell><Typography variant="body2" sx={{ color: 'text.secondary' }}>{l.restockLocationName ? `${l.restockLocationName} (${l.restockLocationCode})` : '—'}</Typography></TableCell>
                        <TableCell align="right">
                          {canAct ? (
                            <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                              <Button size="small" variant="text" onClick={() => openInspect(l)} disabled={busy}>Inspect</Button>
                              <Button size="small" variant="outlined" onClick={() => openRestock(l)} disabled={busy}>Restock</Button>
                              <Button size="small" variant="outlined" color="error" onClick={() => { setWriteoffLine(l); setWriteoffReason(''); }} disabled={busy}>Write off</Button>
                            </Stack>
                          ) : (
                            <Typography variant="caption" sx={{ color: 'text.disabled' }}>—</Typography>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableContainer>
          </Paper>
        </>
      )}

      {/* Restock dialog */}
      <Dialog open={Boolean(restockLine)} onClose={() => !busy && setRestockLine(null)} maxWidth="sm" fullWidth>
        <DialogTitle>Restock line</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>
            Moves {restockLine ? formatNumber(restockLine.returnedQty, { maximumFractionDigits: 0 }) : ''} bottle(s) of {restockLine?.productName || ''} out of quarantine into a sellable location.
          </Typography>
          <TextField select label="Restock location" value={restockLocationId} onChange={(e) => setRestockLocationId(e.target.value)} fullWidth required>
            {restockOptions.length === 0 && <MenuItem value="" disabled>No other active location available</MenuItem>}
            {restockOptions.map((l) => <MenuItem key={l.id} value={l.id}>{l.name} ({l.locationCode})</MenuItem>)}
          </TextField>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRestockLine(null)} color="inherit" disabled={busy}>Cancel</Button>
          <Button onClick={handleRestock} variant="contained" disabled={busy || !restockLocationId} startIcon={busy ? <CircularProgress size={16} /> : null}>Restock</Button>
        </DialogActions>
      </Dialog>

      {/* Write-off dialog */}
      <Dialog open={Boolean(writeoffLine)} onClose={() => !busy && setWriteoffLine(null)} maxWidth="sm" fullWidth>
        <DialogTitle>Write off line</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>
            Removes {writeoffLine ? formatNumber(writeoffLine.returnedQty, { maximumFractionDigits: 0 }) : ''} bottle(s) of {writeoffLine?.productName || ''} from physical inventory. This cannot be undone.
          </Typography>
          <TextField label="Reason (optional)" value={writeoffReason} onChange={(e) => setWriteoffReason(e.target.value)} fullWidth multiline minRows={2} />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setWriteoffLine(null)} color="inherit" disabled={busy}>Cancel</Button>
          <Button onClick={handleWriteoff} variant="contained" color="error" disabled={busy} startIcon={busy ? <CircularProgress size={16} /> : null}>Write off</Button>
        </DialogActions>
      </Dialog>

      {/* Inspect dialog */}
      <Dialog open={Boolean(inspectLine)} onClose={() => !busy && setInspectLine(null)} maxWidth="sm" fullWidth>
        <DialogTitle>Inspect line</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField select label="Condition" value={inspectCondition} onChange={(e) => setInspectCondition(e.target.value)} fullWidth>
              {RETURN_CONDITION_CODES.map((c) => <MenuItem key={c.value} value={c.value}>{c.label}</MenuItem>)}
            </TextField>
            <TextField label="Notes (optional)" value={inspectNotes} onChange={(e) => setInspectNotes(e.target.value)} fullWidth multiline minRows={2} />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setInspectLine(null)} color="inherit" disabled={busy}>Cancel</Button>
          <Button onClick={handleInspect} variant="contained" disabled={busy} startIcon={busy ? <CircularProgress size={16} /> : null}>Save inspection</Button>
        </DialogActions>
      </Dialog>

      {/* Cancel dialog */}
      <Dialog open={cancelOpen} onClose={() => !busy && setCancelOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Cancel pending return</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>
            This cancels the pending return. It frees the delivery for a new return and does not change stock. A received return cannot be cancelled — it must be processed to closure.
          </Typography>
          <TextField label="Reason" value={cancelReasonText} onChange={(e) => setCancelReasonText(e.target.value)} fullWidth required multiline minRows={2} />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCancelOpen(false)} color="inherit" disabled={busy}>Back</Button>
          <Button onClick={handleCancel} variant="contained" color="warning" disabled={busy || !cancelReasonText.trim()} startIcon={busy ? <CircularProgress size={16} /> : null}>Cancel return</Button>
        </DialogActions>
      </Dialog>

      <Snackbar open={Boolean(toast)} autoHideDuration={4000} onClose={() => setToast('')} message={toast} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }} />
    </PageContainer>
  );
}

export default ReturnProfile;
