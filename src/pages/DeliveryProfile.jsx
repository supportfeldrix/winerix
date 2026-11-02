import { useEffect, useState, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Box, Paper, Typography, Chip, Button, Divider, Grid, Skeleton, Alert, Snackbar, Link,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, MenuItem,
  Dialog, DialogTitle, DialogContent, DialogActions, Stack, CircularProgress,
} from '@mui/material';
import ArrowBackOutlinedIcon from '@mui/icons-material/ArrowBackOutlined';
import AssignmentTurnedInOutlinedIcon from '@mui/icons-material/AssignmentTurnedInOutlined';
import ListAltOutlinedIcon from '@mui/icons-material/ListAltOutlined';
import PageContainer from '../components/layout/PageContainer';
import { useOrganisation } from '../context/OrganisationContext';
import { formatDate, formatNumber } from '../components/common/formatters';
import {
  getDelivery, getDeliveryLines, updateDeliveryPending, confirmDelivery, failDelivery, cancelDelivery,
  friendlyDeliveryError, deliveryStatusLabel, deliveryStatusColor,
  varianceReasonLabel, failureReasonLabel, VARIANCE_REASONS, FAILURE_REASONS,
} from '../services/deliveryService';
import { canCreateReturn } from '../services/returnService';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Delivery profile (P2M-5)
// Header + POD metadata + lines (dispatched/delivered/variance). Actions for a
// PENDING delivery (set delivered quantities, confirm, mark failed, cancel) are
// role-gated and go through deliveryService RPCs. Delivery changes NEVER move
// stock. Confirmed/failed/cancelled deliveries are historical (read-only).
// ─────────────────────────────────────────────────────────────────────────────

function Field({ label, children }) {
  return (
    <Box>
      <Typography variant="overline" sx={{ color: 'text.disabled', letterSpacing: '0.08em' }}>{label}</Typography>
      <Typography variant="body1" sx={{ color: 'text.primary' }}>{children}</Typography>
    </Box>
  );
}

function snapshotAddressText(s) {
  if (!s || typeof s !== 'object') return null;
  const parts = [s.address_line_1 || s.addressLine1, s.address_line_2 || s.addressLine2, s.city, s.province, s.postal_code || s.postalCode, s.country].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

const CAN_WRITE = ['OWNER', 'ADMIN', 'SALES', 'CELLAR'];
const CAN_ADMIN = ['OWNER', 'ADMIN'];

function DeliveryProfile() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { activeOrgId, activeRole } = useOrganisation();

  const [delivery, setDelivery] = useState(null);
  const [lines, setLines] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(false);

  // edit-pending line quantities (local draft)
  const [qtyDraft, setQtyDraft] = useState({});

  // dialogs
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [varianceReason, setVarianceReason] = useState('');
  const [recipientName, setRecipientName] = useState('');
  const [failOpen, setFailOpen] = useState(false);
  const [failureReason, setFailureReason] = useState('');
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');

  const canWrite = CAN_WRITE.includes(activeRole);
  const canAdmin = CAN_ADMIN.includes(activeRole);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    const { data, error: err } = await getDelivery(id);
    if (err) { setError(friendlyDeliveryError(err)); setLoading(false); return; }
    if (!data) { setError('Delivery not found.'); setLoading(false); return; }
    setDelivery(data);
    const { data: lineData, error: lineErr } = await getDeliveryLines(id);
    if (lineErr) { setError(friendlyDeliveryError(lineErr)); setLoading(false); return; }
    setLines(lineData || []);
    const draft = {};
    (lineData || []).forEach((l) => { draft[l.id] = l.deliveredQty ?? 0; });
    setQtyDraft(draft);
    setLoading(false);
  }, [id]);

  useEffect(() => { if (activeOrgId) load(); }, [activeOrgId, load]);

  const isPending = delivery?.status === 'pending';
  const hasShortfall = lines.some((l) => (qtyDraft[l.id] ?? 0) < (l.dispatchedQty ?? 0));
  const shippedTotal = lines.reduce((s, l) => s + (Number(l.dispatchedQty) || 0), 0);
  const deliveredTotal = lines.reduce((s, l) => s + (Number(l.deliveredQty) || 0), 0);
  const shippingText = snapshotAddressText(delivery?.addressSnapshot);

  async function handleSaveQuantities() {
    setBusy(true); setError('');
    const payload = lines.map((l) => ({
      delivery_confirmation_line_id: l.id,
      delivered_qty: Number(qtyDraft[l.id] ?? 0),
    }));
    const { error: err } = await updateDeliveryPending(id, payload, { recipientName: recipientName || undefined });
    setBusy(false);
    if (err) { setError(friendlyDeliveryError(err)); return; }
    setToast('Delivered quantities saved.');
    await load();
  }

  async function handleConfirm() {
    setBusy(true); setError('');
    // Save the current draft quantities first, then confirm.
    const payload = lines.map((l) => ({ delivery_confirmation_line_id: l.id, delivered_qty: Number(qtyDraft[l.id] ?? 0) }));
    const { error: upErr } = await updateDeliveryPending(id, payload, { recipientName: recipientName || undefined });
    if (upErr) { setBusy(false); setError(friendlyDeliveryError(upErr)); return; }
    const { error: err } = await confirmDelivery(id, {
      varianceReason: hasShortfall ? (varianceReason || undefined) : undefined,
      recipientName: recipientName || undefined,
    });
    setBusy(false);
    if (err) { setError(friendlyDeliveryError(err)); return; }
    setConfirmOpen(false); setToast('Delivery confirmed.'); await load();
  }

  async function handleFail() {
    setBusy(true); setError('');
    const { error: err } = await failDelivery(id, failureReason);
    setBusy(false);
    if (err) { setError(friendlyDeliveryError(err)); return; }
    setFailOpen(false); setToast('Delivery marked as failed.'); await load();
  }

  async function handleCancel() {
    setBusy(true); setError('');
    const { error: err } = await cancelDelivery(id, cancelReason || null);
    setBusy(false);
    if (err) { setError(friendlyDeliveryError(err)); return; }
    setCancelOpen(false); setToast('Delivery cancelled.'); await load();
  }

  return (
    <PageContainer maxWidth={1600} sx={{ px: { xs: 2, sm: 3, md: 4, lg: 5 } }}>
      <Button startIcon={<ArrowBackOutlinedIcon />} onClick={() => navigate('/deliveries')} color="inherit" sx={{ mb: 2 }}>
        Back to Deliveries
      </Button>

      {error && <Alert severity="error" sx={{ mb: 2 }} action={<Button color="inherit" size="small" onClick={load}>Retry</Button>} onClose={() => setError('')}>{error}</Alert>}

      {loading ? (
        <Paper variant="outlined" sx={{ borderRadius: 3, p: { xs: 2.5, md: 3.5 } }}>
          <Skeleton width="30%" height={40} sx={{ mb: 2 }} />
          <Grid container spacing={3}>{[0,1,2,3,4,5].map((i) => <Grid item xs={12} sm={6} md={4} key={i}><Skeleton width="80%" height={48} /></Grid>)}</Grid>
        </Paper>
      ) : !delivery ? null : (
        <>
          <Paper variant="outlined" sx={{ borderRadius: 3, p: { xs: 2.5, md: 3.5 } }}>
            <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, alignItems: { sm: 'center' }, justifyContent: 'space-between', gap: 2, mb: 1 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                <Box sx={{ width: 44, height: 44, borderRadius: 2, bgcolor: 'background.subtle', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'primary.main' }}>
                  <AssignmentTurnedInOutlinedIcon />
                </Box>
                <Box>
                  <Typography variant="h3" component="h1">{delivery.deliveryNumber}</Typography>
                  <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                    {delivery.dispatchNumber ? `For dispatch ${delivery.dispatchNumber}` : ''}
                  </Typography>
                </Box>
              </Box>
              <Stack direction={{ xs: 'row' }} spacing={1.5} alignItems="center">
                {['delivered', 'delivered_with_variance'].includes(delivery.status)
                  && delivery.dispatchStatus === 'recorded'
                  && canCreateReturn(activeRole) && (
                  <Button
                    variant="outlined" size="small"
                    onClick={() => navigate(`/returns?createForDelivery=${delivery.id}`)}
                  >
                    Create return
                  </Button>
                )}
                <Chip label={deliveryStatusLabel(delivery.status)} color={deliveryStatusColor(delivery.status)} sx={{ fontWeight: 600 }} />
              </Stack>
            </Box>

            <Divider sx={{ my: 3 }} />

            <Grid container spacing={3}>
              <Grid item xs={12} sm={6} md={4}>
                <Field label="Dispatch">
                  {delivery.dispatchId ? (
                    <Link component="button" type="button" underline="hover" onClick={() => navigate(`/dispatches/${delivery.dispatchId}`)}>{delivery.dispatchNumber || '—'}</Link>
                  ) : (delivery.dispatchNumber || '—')}
                </Field>
              </Grid>
              <Grid item xs={12} sm={6} md={4}>
                <Field label="Sales Order">
                  {delivery.salesOrderId ? (
                    <Link component="button" type="button" underline="hover" onClick={() => navigate(`/sales-orders/${delivery.salesOrderId}`)}>{delivery.orderNumber || '—'}</Link>
                  ) : (delivery.orderNumber || '—')}
                </Field>
              </Grid>
              <Grid item xs={12} sm={6} md={4}>
                <Field label="Customer">
                  {delivery.customerId ? (
                    <Link component="button" type="button" underline="hover" onClick={() => navigate(`/customers/${delivery.customerId}`)}>{delivery.customerLegalName || '—'}</Link>
                  ) : (delivery.customerLegalName || '—')}
                </Field>
              </Grid>
              <Grid item xs={12} sm={6} md={4}><Field label="Status">{deliveryStatusLabel(delivery.status)}</Field></Grid>
              <Grid item xs={12} sm={6} md={4}><Field label="Delivered At">{delivery.deliveredAt ? formatDate(delivery.deliveredAt) : '—'}</Field></Grid>
              <Grid item xs={12} sm={6} md={4}><Field label="Bottles (delivered / dispatched)">{formatNumber(deliveredTotal, { maximumFractionDigits: 0 })} / {formatNumber(shippedTotal, { maximumFractionDigits: 0 })}</Field></Grid>
              <Grid item xs={12} sm={6} md={4}><Field label="Recipient">{delivery.recipientName || '—'}</Field></Grid>
              <Grid item xs={12} sm={6} md={4}><Field label="Recipient Role">{delivery.recipientRole || '—'}</Field></Grid>
              <Grid item xs={12} sm={6} md={4}>
                <Field label="Variance / Failure">
                  {delivery.varianceReason ? varianceReasonLabel(delivery.varianceReason)
                    : delivery.failureReason ? failureReasonLabel(delivery.failureReason) : '—'}
                </Field>
              </Grid>
              <Grid item xs={12} sm={6}><Field label="Shipping Address Snapshot">{shippingText || '—'}</Field></Grid>
              <Grid item xs={12} sm={6}><Field label="Notes">{delivery.deliveryNotes || '—'}</Field></Grid>
            </Grid>

            {/* Actions (pending only, role-gated) */}
            {isPending && (canWrite || canAdmin) && (
              <>
                <Divider sx={{ my: 3 }} />
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                  {canWrite && <Button variant="outlined" onClick={handleSaveQuantities} disabled={busy}>Save quantities</Button>}
                  {canWrite && <Button variant="contained" color="primary" onClick={() => setConfirmOpen(true)} disabled={busy}>Confirm delivery</Button>}
                  {canWrite && <Button variant="outlined" color="error" onClick={() => setFailOpen(true)} disabled={busy}>Mark failed</Button>}
                  {canAdmin && <Button variant="text" color="inherit" onClick={() => setCancelOpen(true)} disabled={busy}>Cancel</Button>}
                </Stack>
                <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 1 }}>
                  Confirming a delivery records receipt and does not change physical stock.
                </Typography>
              </>
            )}
          </Paper>

          {/* Lines */}
          <Paper variant="outlined" sx={{ borderRadius: 3, p: { xs: 2.5, md: 3.5 }, mt: 3 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, mb: 2 }}>
              <Box sx={{ width: 36, height: 36, borderRadius: 1.5, bgcolor: 'background.subtle', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'secondary.main' }}><ListAltOutlinedIcon /></Box>
              <Typography variant="h5" component="h2">Delivery Lines</Typography>
            </Box>

            <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 2, overflowX: 'auto' }}>
              <Table sx={{ minWidth: 900 }} aria-label="Delivery lines">
                <TableHead>
                  <TableRow>
                    <TableCell>Product / SKU</TableCell>
                    <TableCell>Location</TableCell>
                    <TableCell align="right">Dispatched</TableCell>
                    <TableCell align="right">Delivered</TableCell>
                    <TableCell align="right">Variance</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {lines.map((l) => {
                    const delivered = isPending ? (qtyDraft[l.id] ?? 0) : (l.deliveredQty ?? 0);
                    const variance = (l.dispatchedQty ?? 0) - Number(delivered || 0);
                    return (
                      <TableRow key={l.id} hover sx={{ '& .MuiTableCell-root': { py: 1.5 } }}>
                        <TableCell>
                          <Typography variant="body2" sx={{ fontWeight: 600, color: 'text.primary' }}>{l.productName || '—'}</Typography>
                          <Typography variant="caption" sx={{ color: 'text.secondary' }}>{l.productSku || '—'}</Typography>
                        </TableCell>
                        <TableCell><Typography variant="body2" sx={{ color: 'text.secondary' }}>{l.locationCode || l.locationName || '—'}</Typography></TableCell>
                        <TableCell align="right"><Typography variant="body2" sx={{ color: 'text.primary' }}>{formatNumber(l.dispatchedQty, { maximumFractionDigits: 0 })}</Typography></TableCell>
                        <TableCell align="right">
                          {isPending && canWrite ? (
                            <TextField
                              type="number" size="small" value={qtyDraft[l.id] ?? 0}
                              onChange={(e) => {
                                const v = e.target.value === '' ? 0 : Math.max(0, Math.min(Number(e.target.value), l.dispatchedQty ?? 0));
                                setQtyDraft((d) => ({ ...d, [l.id]: v }));
                              }}
                              inputProps={{ min: 0, max: l.dispatchedQty ?? 0, style: { textAlign: 'right', width: 80 } }}
                            />
                          ) : (
                            <Typography variant="body2" sx={{ color: 'text.primary', fontWeight: 600 }}>{formatNumber(l.deliveredQty, { maximumFractionDigits: 0 })}</Typography>
                          )}
                        </TableCell>
                        <TableCell align="right"><Typography variant="body2" sx={{ color: variance > 0 ? 'error.main' : 'text.secondary' }}>{formatNumber(variance, { maximumFractionDigits: 0 })}</Typography></TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableContainer>
          </Paper>
        </>
      )}

      {/* Confirm dialog */}
      <Dialog open={confirmOpen} onClose={() => !busy && setConfirmOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Confirm delivery</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>
            {hasShortfall
              ? 'This delivery is short of the dispatched quantity. A variance reason is required.'
              : 'All dispatched bottles were received in full.'}
          </Typography>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField label="Recipient name" value={recipientName} onChange={(e) => setRecipientName(e.target.value)} fullWidth />
            {hasShortfall && (
              <TextField select label="Variance reason" value={varianceReason} onChange={(e) => setVarianceReason(e.target.value)} fullWidth required>
                {VARIANCE_REASONS.map((r) => <MenuItem key={r.value} value={r.value}>{r.label}</MenuItem>)}
              </TextField>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)} color="inherit" disabled={busy}>Cancel</Button>
          <Button onClick={handleConfirm} variant="contained" disabled={busy || (hasShortfall && !varianceReason)} startIcon={busy ? <CircularProgress size={16} /> : null}>Confirm</Button>
        </DialogActions>
      </Dialog>

      {/* Fail dialog */}
      <Dialog open={failOpen} onClose={() => !busy && setFailOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Mark delivery failed</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField select label="Failure reason" value={failureReason} onChange={(e) => setFailureReason(e.target.value)} fullWidth required>
              {FAILURE_REASONS.map((r) => <MenuItem key={r.value} value={r.value}>{r.label}</MenuItem>)}
            </TextField>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setFailOpen(false)} color="inherit" disabled={busy}>Back</Button>
          <Button onClick={handleFail} variant="contained" color="error" disabled={busy || !failureReason} startIcon={busy ? <CircularProgress size={16} /> : null}>Mark failed</Button>
        </DialogActions>
      </Dialog>

      {/* Cancel dialog */}
      <Dialog open={cancelOpen} onClose={() => !busy && setCancelOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Cancel pending delivery</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>This cancels the pending delivery confirmation. It does not change stock or the dispatch.</Typography>
          <TextField label="Reason (optional)" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} fullWidth multiline minRows={2} />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCancelOpen(false)} color="inherit" disabled={busy}>Back</Button>
          <Button onClick={handleCancel} variant="contained" color="warning" disabled={busy} startIcon={busy ? <CircularProgress size={16} /> : null}>Cancel delivery</Button>
        </DialogActions>
      </Dialog>

      <Snackbar open={Boolean(toast)} autoHideDuration={4000} onClose={() => setToast('')} message={toast} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }} />
    </PageContainer>
  );
}

export default DeliveryProfile;
