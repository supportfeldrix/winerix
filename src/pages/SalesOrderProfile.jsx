import { useEffect, useState, useCallback, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Box, Paper, Typography, Chip, Button, Divider, Grid, Skeleton, Alert, Snackbar, Link,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, IconButton, Tooltip,
  Dialog, DialogTitle, DialogContent, DialogContentText, DialogActions, CircularProgress,
} from '@mui/material';
import ArrowBackOutlinedIcon from '@mui/icons-material/ArrowBackOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined';
import AddOutlinedIcon from '@mui/icons-material/AddOutlined';
import TaskAltOutlinedIcon from '@mui/icons-material/TaskAltOutlined';
import CheckCircleOutlineOutlinedIcon from '@mui/icons-material/CheckCircleOutlineOutlined';
import ReceiptLongOutlinedIcon from '@mui/icons-material/ReceiptLongOutlined';
import ListAltOutlinedIcon from '@mui/icons-material/ListAltOutlined';
import PageContainer from '../components/layout/PageContainer';
import { useOrganisation } from '../context/OrganisationContext';
import SalesOrderForm from '../components/sales/SalesOrderForm';
import SalesOrderLineForm from '../components/sales/SalesOrderLineForm';
import StockAllocationPanel from '../components/sales/StockAllocationPanel';
import { salesOrderStatusColor } from '../components/sales/SalesOrderTable';
import ConfirmDialog from '../components/common/ConfirmDialog';
import { formatDate, formatNumber } from '../components/common/formatters';
import {
  getSalesOrder, updateDraftSalesOrder, salesOrderStatusLabel, friendlySalesOrderError,
} from '../services/salesOrderService';
import {
  getSalesOrderLines, addSalesOrderLine, updateSalesOrderLine, deleteSalesOrderLine,
  confirmSalesOrder, friendlySalesOrderLineError,
} from '../services/salesOrderLineService';
import { getCustomers } from '../services/customerService';
import { getAddressesByCustomer } from '../services/customerAddressService';
import { getFinishedProductOptions } from '../services/finishedProductService';
import { getStockLocationOptions } from '../services/stockLocationService';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Sales Order profile (P2L-5 + P2L-6)
//
// Draft orders: editable header, order-line CRUD, server-recalculated totals and
// a Confirm action. Confirmed orders: read-only lines/totals and the historical
// JSONB address snapshots (live-address edits never rewrite a confirmed order).
//
// Once an order is in the allocation flow (confirmed / partially_allocated /
// ready_to_dispatch) a Stock Allocation panel (P2L-6) lets OWNER/ADMIN/SALES
// users reserve available stock per line/location. Allocation never reduces
// physical stock; the order status is recomputed server-side. All data access
// goes through services.
// ─────────────────────────────────────────────────────────────────────────────

function Field({ label, children }) {
  return (
    <Box>
      <Typography variant="overline" sx={{ color: 'text.disabled', letterSpacing: '0.08em' }}>{label}</Typography>
      <Typography variant="body1" sx={{ color: 'text.primary' }}>{children}</Typography>
    </Box>
  );
}

function liveAddressText(a) {
  if (!a) return null;
  return [a.addressLine1, a.addressLine2, a.city, a.province, a.postalCode, a.country].filter(Boolean).join(', ');
}

function snapshotAddressText(s) {
  if (!s) return null;
  return [s.address_line_1, s.address_line_2, s.city, s.province, s.postal_code, s.country].filter(Boolean).join(', ');
}

function SalesOrderProfile() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { activeOrgId, activeRole } = useOrganisation();

  const [order, setOrder] = useState(null);
  const [lines, setLines] = useState([]);
  const [addresses, setAddresses] = useState([]);
  const [customerOptions, setCustomerOptions] = useState([]);
  const [productOptions, setProductOptions] = useState([]);
  const [locationOptions, setLocationOptions] = useState([]);
  const [formAddressOptions, setFormAddressOptions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [editOpen, setEditOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState('');

  // Line dialog
  const [lineOpen, setLineOpen] = useState(false);
  const [lineMode, setLineMode] = useState('add');
  const [lineTarget, setLineTarget] = useState(null);
  const [lineSaving, setLineSaving] = useState(false);
  const [lineDelete, setLineDelete] = useState(null);
  const [lineDeleting, setLineDeleting] = useState(false);

  // Confirm dialog
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    const { data, error: err } = await getSalesOrder(id);
    if (err) { setError(friendlySalesOrderError(err)); setLoading(false); return; }
    if (!data) { setError('Sales order not found.'); setLoading(false); return; }
    setOrder(data);

    const [linesRes, addrRes, custRes, prodRes, locRes] = await Promise.all([
      getSalesOrderLines(id),
      data.customerId ? getAddressesByCustomer(data.customerId) : Promise.resolve({ data: [] }),
      getCustomers(),
      getFinishedProductOptions(),
      getStockLocationOptions(),
    ]);
    if (!linesRes.error) setLines(linesRes.data || []);
    if (!addrRes.error) setAddresses(addrRes.data || []);
    if (!custRes.error) setCustomerOptions(custRes.data || []);
    if (!prodRes.error) setProductOptions(prodRes.data || []);
    if (!locRes.error) setLocationOptions(locRes.data || []);
    setLoading(false);
  }, [id]);

  useEffect(() => {
    if (!activeOrgId) { setOrder(null); setLines([]); setAddresses([]); setCustomerOptions([]); setProductOptions([]); setLocationOptions([]); return; }
    setOrder(null); setLines([]); setAddresses([]); setCustomerOptions([]); setProductOptions([]); setLocationOptions([]);
    load();
  }, [activeOrgId, load]);

  const isDraft = order?.status === 'draft';
  const canAllocate = ['OWNER', 'ADMIN', 'SALES'].includes(activeRole);
  const inAllocationFlow = ['confirmed', 'partially_allocated', 'ready_to_dispatch'].includes(order?.status);
  const cur = order?.currency || 'ZAR';

  // Address display: prefer the confirmed JSONB snapshot; else the live address.
  const billingText = useMemo(() => {
    if (!order) return '—';
    if (order.billingAddressSnapshot) return snapshotAddressText(order.billingAddressSnapshot) || '—';
    const live = addresses.find((a) => a.id === order.billingAddressId);
    return liveAddressText(live) || '—';
  }, [order, addresses]);
  const shippingText = useMemo(() => {
    if (!order) return '—';
    if (order.shippingAddressSnapshot) return snapshotAddressText(order.shippingAddressSnapshot) || '—';
    const live = addresses.find((a) => a.id === order.shippingAddressId);
    return liveAddressText(live) || '—';
  }, [order, addresses]);

  const handleCustomerChange = async (customerId) => {
    setFormAddressOptions([]);
    if (!customerId) return;
    const { data, error: err } = await getAddressesByCustomer(customerId, { activeOnly: true });
    if (!err) setFormAddressOptions(data || []);
  };

  const handleEdit = async (values) => {
    setSaving(true);
    const { error: err } = await updateDraftSalesOrder(id, values);
    setSaving(false);
    if (err) { setError(friendlySalesOrderError(err)); return; }
    setEditOpen(false); setToast('Sales order updated.');
    await load();
  };

  // ── Lines ──
  const openLineAdd = () => { setLineMode('add'); setLineTarget(null); setLineOpen(true); };
  const openLineEdit = (l) => { setLineMode('edit'); setLineTarget(l); setLineOpen(true); };
  const handleLineSubmit = async (values) => {
    setLineSaving(true);
    const res = lineMode === 'edit'
      ? await updateSalesOrderLine(lineTarget.id, values)
      : await addSalesOrderLine(id, values);
    setLineSaving(false);
    if (res.error) { setError(friendlySalesOrderLineError(res.error)); return; }
    setLineOpen(false); setLineTarget(null);
    setToast(lineMode === 'edit' ? 'Order line updated.' : 'Order line added.');
    await load();
  };
  const handleLineDelete = async () => {
    if (!lineDelete) return;
    setLineDeleting(true);
    const { error: err } = await deleteSalesOrderLine(lineDelete.id);
    setLineDeleting(false); setLineDelete(null);
    if (err) { setError(friendlySalesOrderLineError(err)); return; }
    setToast('Order line removed.'); await load();
  };

  // ── Confirm ──
  const handleConfirm = async () => {
    setConfirming(true);
    const { error: err } = await confirmSalesOrder(id);
    setConfirming(false); setConfirmOpen(false);
    if (err) { setError(friendlySalesOrderLineError(err)); return; }
    setToast('Sales order confirmed.'); await load();
  };

  if (loading) {
    return (
      <PageContainer maxWidth={1100} sx={{ px: { xs: 2, sm: 3, md: 4 } }}>
        <Skeleton width={160} height={32} sx={{ mb: 2 }} />
        <Paper variant="outlined" sx={{ borderRadius: 3, p: 3 }}>
          <Skeleton width="40%" height={36} sx={{ mb: 2 }} />
          <Grid container spacing={3}>
            {[0, 1, 2, 3, 4, 5].map((i) => <Grid item xs={12} sm={6} md={4} key={i}><Skeleton width="80%" height={48} /></Grid>)}
          </Grid>
        </Paper>
      </PageContainer>
    );
  }

  if (error && !order) {
    return (
      <PageContainer maxWidth={1100} sx={{ px: { xs: 2, sm: 3, md: 4 } }}>
        <Button startIcon={<ArrowBackOutlinedIcon />} onClick={() => navigate('/sales-orders')} color="inherit" sx={{ mb: 2 }}>Back to Sales Orders</Button>
        <Alert severity="error" action={<Button color="inherit" size="small" onClick={load}>Retry</Button>}>{error}</Alert>
      </PageContainer>
    );
  }

  if (!order) return null;

  return (
    <PageContainer maxWidth={1100} sx={{ px: { xs: 2, sm: 3, md: 4 } }}>
      <Button startIcon={<ArrowBackOutlinedIcon />} onClick={() => navigate('/sales-orders')} color="inherit" sx={{ mb: 2 }}>Back to Sales Orders</Button>

      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}

      <Paper variant="outlined" sx={{ borderRadius: 3, p: { xs: 2.5, md: 3.5 } }}>
        <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, alignItems: { xs: 'flex-start', sm: 'center' }, justifyContent: 'space-between', gap: 2, mb: 2 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <Box sx={{ width: 44, height: 44, borderRadius: 2, bgcolor: 'background.subtle', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'secondary.main' }}>
              <ReceiptLongOutlinedIcon />
            </Box>
            <Box>
              <Typography variant="h3" component="h1">{order.orderNumber}</Typography>
              <Chip label={salesOrderStatusLabel(order.status)} size="small" color={salesOrderStatusColor(order.status)} sx={{ fontWeight: 600, mt: 0.5 }} />
            </Box>
          </Box>
          {isDraft && (
            <Button variant="outlined" color="primary" startIcon={<EditOutlinedIcon />} onClick={() => setEditOpen(true)} sx={{ flexShrink: 0 }}>Edit Draft</Button>
          )}
        </Box>

        {inAllocationFlow && (
          <Alert severity="success" icon={<CheckCircleOutlineOutlinedIcon />} sx={{ mb: 2 }}>
            This order is confirmed. Lines, totals and addresses are locked as a historical record.
            Reserve stock in the allocation panel below — physical stock is not reduced until dispatch.
          </Alert>
        )}

        <Divider sx={{ mb: 3 }} />

        <Grid container spacing={3}>
          <Grid item xs={12} sm={6} md={4}>
            <Field label="Customer">
              {order.customerId ? (
                <Link component="button" type="button" underline="hover" onClick={() => navigate(`/customers/${order.customerId}`)}>
                  {order.customerLegalName || '—'}
                </Link>
              ) : '—'}
            </Field>
          </Grid>
          <Grid item xs={12} sm={6} md={4}><Field label="Status">{salesOrderStatusLabel(order.status)}</Field></Grid>
          <Grid item xs={12} sm={6} md={4}><Field label="Currency">{order.currency || '—'}</Field></Grid>
          <Grid item xs={12} sm={6} md={4}><Field label="Order Date">{formatDate(order.orderDate)}</Field></Grid>
          <Grid item xs={12} sm={6} md={4}><Field label="Requested Delivery">{order.requestedDeliveryDate ? formatDate(order.requestedDeliveryDate) : '—'}</Field></Grid>
          <Grid item xs={12} sm={6} md={4}><Field label="Created">{formatDate(order.createdAt)}</Field></Grid>
          <Grid item xs={12} sm={6}><Field label="Billing Address">{billingText}</Field></Grid>
          <Grid item xs={12} sm={6}><Field label="Shipping Address">{shippingText}</Field></Grid>
          <Grid item xs={12}><Field label="Notes">{order.notes || '—'}</Field></Grid>
        </Grid>

        <Divider sx={{ my: 3 }} />

        <Grid container spacing={3}>
          <Grid item xs={6} sm={3}><Field label="Subtotal">{cur} {formatNumber(order.subtotal, { maximumFractionDigits: 2 })}</Field></Grid>
          <Grid item xs={6} sm={3}><Field label="Discount">{cur} {formatNumber(order.discountTotal, { maximumFractionDigits: 2 })}</Field></Grid>
          <Grid item xs={6} sm={3}><Field label="Tax">{cur} {formatNumber(order.taxTotal, { maximumFractionDigits: 2 })}</Field></Grid>
          <Grid item xs={6} sm={3}><Field label="Total">{cur} {formatNumber(order.total, { maximumFractionDigits: 2 })}</Field></Grid>
        </Grid>
      </Paper>

      {/* Order lines */}
      <Paper variant="outlined" sx={{ borderRadius: 3, p: { xs: 2.5, md: 3.5 }, mt: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, mb: 2 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
            <Box sx={{ width: 36, height: 36, borderRadius: 1.5, bgcolor: 'background.subtle', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'secondary.main' }}><ListAltOutlinedIcon /></Box>
            <Typography variant="h5" component="h2">Order Lines</Typography>
          </Box>
          {isDraft && (
            <Button variant="outlined" color="primary" startIcon={<AddOutlinedIcon />} onClick={openLineAdd} sx={{ flexShrink: 0 }}>Add Line</Button>
          )}
        </Box>

        {lines.length === 0 ? (
          <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', px: 3, py: { xs: 4, md: 5 }, textAlign: 'center' }}>
            <Typography variant="body2" sx={{ color: 'text.secondary', mb: isDraft ? 2 : 0 }}>No order lines yet.</Typography>
            {isDraft && <Button variant="contained" color="primary" startIcon={<AddOutlinedIcon />} onClick={openLineAdd}>Add Line</Button>}
          </Paper>
        ) : (
          <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 2, overflowX: 'auto' }}>
            <Table sx={{ minWidth: 1000 }} aria-label="Sales order lines">
              <TableHead>
                <TableRow>
                  <TableCell>#</TableCell>
                  <TableCell>Product / SKU</TableCell>
                  <TableCell align="right">Bottle Size</TableCell>
                  <TableCell align="right">Qty</TableCell>
                  <TableCell align="right">Unit Price</TableCell>
                  <TableCell align="right">Discount</TableCell>
                  <TableCell align="right">Tax Rate</TableCell>
                  <TableCell align="right">Tax</TableCell>
                  <TableCell align="right">Line Total</TableCell>
                  {isDraft && <TableCell align="right">Actions</TableCell>}
                </TableRow>
              </TableHead>
              <TableBody>
                {lines.map((l) => (
                  <TableRow key={l.id} hover sx={{ '& .MuiTableCell-root': { py: 1.5 } }}>
                    <TableCell><Typography variant="body2" sx={{ color: 'text.secondary' }}>{l.lineNumber}</Typography></TableCell>
                    <TableCell>
                      <Typography variant="body2" sx={{ fontWeight: 600, color: 'text.primary' }}>{l.productNameSnapshot}</Typography>
                      <Typography variant="caption" sx={{ color: 'text.secondary' }}>{l.skuCodeSnapshot}</Typography>
                    </TableCell>
                    <TableCell align="right"><Typography variant="body2" sx={{ color: 'text.secondary' }}>{formatNumber(l.bottleVolumeMlSnapshot, { maximumFractionDigits: 0 })} ml</Typography></TableCell>
                    <TableCell align="right"><Typography variant="body2" sx={{ color: 'text.primary' }}>{formatNumber(l.quantityBottles, { maximumFractionDigits: 0 })}</Typography></TableCell>
                    <TableCell align="right"><Typography variant="body2" sx={{ color: 'text.secondary' }}>{cur} {formatNumber(l.unitPrice, { maximumFractionDigits: 2 })}</Typography></TableCell>
                    <TableCell align="right"><Typography variant="body2" sx={{ color: 'text.secondary' }}>{cur} {formatNumber(l.lineDiscount, { maximumFractionDigits: 2 })}</Typography></TableCell>
                    <TableCell align="right"><Typography variant="body2" sx={{ color: 'text.secondary' }}>{formatNumber(l.taxRate, { maximumFractionDigits: 4 })}%</Typography></TableCell>
                    <TableCell align="right"><Typography variant="body2" sx={{ color: 'text.secondary' }}>{cur} {formatNumber(l.taxAmount, { maximumFractionDigits: 2 })}</Typography></TableCell>
                    <TableCell align="right"><Typography variant="body2" sx={{ color: 'text.primary', fontWeight: 600 }}>{cur} {formatNumber(l.lineTotal, { maximumFractionDigits: 2 })}</Typography></TableCell>
                    {isDraft && (
                      <TableCell align="right">
                        <Box sx={{ display: 'inline-flex' }}>
                          <Tooltip title="Edit line">
                            <IconButton size="small" aria-label={`Edit line ${l.lineNumber}`} onClick={() => openLineEdit(l)}>
                              <EditOutlinedIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                          <Tooltip title="Remove line">
                            <IconButton size="small" color="error" aria-label={`Remove line ${l.lineNumber}`} onClick={() => setLineDelete(l)}>
                              <DeleteOutlineOutlinedIcon fontSize="small" />
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

        {/* Confirm action (draft + at least one line). */}
        {isDraft && lines.length > 0 && (
          <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 2.5 }}>
            <Button variant="contained" color="primary" startIcon={<TaskAltOutlinedIcon />} onClick={() => setConfirmOpen(true)}>
              Confirm Order
            </Button>
          </Box>
        )}
      </Paper>

      {/* Stock allocation (P2L-6) — only in the allocation flow. */}
      {inAllocationFlow && lines.length > 0 && (
        <StockAllocationPanel
          orderId={id}
          lines={lines}
          currency={cur}
          locationOptions={locationOptions}
          canWrite={canAllocate}
          onChanged={load}
        />
      )}

      {/* Header edit dialog */}
      <SalesOrderForm
        open={editOpen}
        mode="edit"
        order={order}
        customerOptions={customerOptions}
        addressOptions={formAddressOptions}
        saving={saving}
        onCustomerChange={handleCustomerChange}
        onSubmit={handleEdit}
        onClose={() => setEditOpen(false)}
      />

      {/* Line add/edit dialog */}
      <SalesOrderLineForm
        open={lineOpen}
        mode={lineMode}
        line={lineTarget}
        currency={cur}
        productOptions={productOptions}
        saving={lineSaving}
        onSubmit={handleLineSubmit}
        onClose={() => { setLineOpen(false); setLineTarget(null); }}
      />

      {/* Remove line confirmation */}
      <ConfirmDialog
        open={Boolean(lineDelete)}
        title="Remove Order Line?"
        message="This line will be removed from the draft order and the totals recalculated."
        confirmLabel="Remove"
        confirmColor="error"
        loading={lineDeleting}
        onConfirm={handleLineDelete}
        onClose={() => setLineDelete(null)}
      />

      {/* Confirm order dialog */}
      <Dialog open={confirmOpen} onClose={confirming ? undefined : () => setConfirmOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Confirm Sales Order?</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ color: 'text.secondary', mb: 2 }}>
            Confirming locks this order for further editing. Lines, totals and the billing/shipping
            addresses are captured as a historical record. Stock is not allocated at this step.
          </DialogContentText>
          <Paper variant="outlined" sx={{ borderRadius: 2, p: 2, bgcolor: 'background.subtle' }}>
            <ConfRow label="Order Number" value={order.orderNumber} />
            <ConfRow label="Customer" value={order.customerLegalName || '—'} />
            <ConfRow label="Lines" value={String(lines.length)} />
            <Divider sx={{ my: 1 }} />
            <ConfRow label="Subtotal" value={`${cur} ${formatNumber(order.subtotal, { maximumFractionDigits: 2 })}`} />
            <ConfRow label="Discount" value={`${cur} ${formatNumber(order.discountTotal, { maximumFractionDigits: 2 })}`} />
            <ConfRow label="Tax" value={`${cur} ${formatNumber(order.taxTotal, { maximumFractionDigits: 2 })}`} />
            <ConfRow label="Total" value={`${cur} ${formatNumber(order.total, { maximumFractionDigits: 2 })}`} strong />
          </Paper>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2.5 }}>
          <Button onClick={() => setConfirmOpen(false)} color="inherit" disabled={confirming}>Cancel</Button>
          <Button onClick={handleConfirm} variant="contained" color="primary" disabled={confirming}>
            {confirming ? <CircularProgress size={20} color="inherit" /> : 'Confirm Order'}
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar open={Boolean(toast)} autoHideDuration={4000} onClose={() => setToast('')} message={toast} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }} />
    </PageContainer>
  );
}

function ConfRow({ label, value, strong }) {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', py: 0.5 }}>
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>{label}</Typography>
      <Typography variant="body2" sx={{ color: 'text.primary', fontWeight: strong ? 700 : 500 }}>{value}</Typography>
    </Box>
  );
}

export default SalesOrderProfile;
