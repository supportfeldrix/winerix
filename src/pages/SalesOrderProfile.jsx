import { useEffect, useState, useCallback, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Box, Paper, Typography, Chip, Button, Divider, Grid, Skeleton, Alert, Snackbar, Link,
} from '@mui/material';
import ArrowBackOutlinedIcon from '@mui/icons-material/ArrowBackOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import ReceiptLongOutlinedIcon from '@mui/icons-material/ReceiptLongOutlined';
import ListAltOutlinedIcon from '@mui/icons-material/ListAltOutlined';
import PageContainer from '../components/layout/PageContainer';
import { useOrganisation } from '../context/OrganisationContext';
import SalesOrderForm from '../components/sales/SalesOrderForm';
import { salesOrderStatusColor } from '../components/sales/SalesOrderTable';
import { formatDate, formatNumber } from '../components/common/formatters';
import {
  getSalesOrder, updateDraftSalesOrder, salesOrderStatusLabel, friendlySalesOrderError,
} from '../services/salesOrderService';
import { getCustomers } from '../services/customerService';
import { getAddressesByCustomer } from '../services/customerAddressService';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Sales Order profile (P2L-4, draft foundation)
//
// Shows a single order's header + totals and offers Edit for DRAFT orders. Order
// lines are a clearly-marked placeholder ("No order lines yet") — not implemented
// here. All data access through services (never Supabase directly). Org-scoped.
// ─────────────────────────────────────────────────────────────────────────────

function Field({ label, children }) {
  return (
    <Box>
      <Typography variant="overline" sx={{ color: 'text.disabled', letterSpacing: '0.08em' }}>{label}</Typography>
      <Typography variant="body1" sx={{ color: 'text.primary' }}>{children}</Typography>
    </Box>
  );
}

function addressText(a) {
  if (!a) return '—';
  return [a.addressLine1, a.addressLine2, a.city, a.province, a.postalCode, a.country].filter(Boolean).join(', ');
}

function SalesOrderProfile() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { activeOrgId } = useOrganisation();

  const [order, setOrder] = useState(null);
  const [addresses, setAddresses] = useState([]);
  const [customerOptions, setCustomerOptions] = useState([]);
  const [formAddressOptions, setFormAddressOptions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [editOpen, setEditOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    const { data, error: err } = await getSalesOrder(id);
    if (err) { setError(friendlySalesOrderError(err)); setLoading(false); return; }
    if (!data) { setError('Sales order not found.'); setLoading(false); return; }
    setOrder(data);

    // Resolve addresses for display (billing/shipping) + customers for the edit form.
    const [addrRes, custRes] = await Promise.all([
      data.customerId ? getAddressesByCustomer(data.customerId) : Promise.resolve({ data: [] }),
      getCustomers(),
    ]);
    if (!addrRes.error) setAddresses(addrRes.data || []);
    if (!custRes.error) setCustomerOptions(custRes.data || []);
    setLoading(false);
  }, [id]);

  useEffect(() => {
    if (!activeOrgId) { setOrder(null); setAddresses([]); setCustomerOptions([]); return; }
    setOrder(null); setAddresses([]); setCustomerOptions([]);
    load();
  }, [activeOrgId, load]);

  const billing = useMemo(
    () => addresses.find((a) => a.id === order?.billingAddressId) || null,
    [addresses, order]
  );
  const shipping = useMemo(
    () => addresses.find((a) => a.id === order?.shippingAddressId) || null,
    [addresses, order]
  );

  // For the edit form, load the order customer's active addresses on demand.
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

  const isDraft = order.status === 'draft';
  const cur = order.currency || 'ZAR';

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
          <Grid item xs={12} sm={6}><Field label="Billing Address">{billing ? addressText(billing) : '—'}</Field></Grid>
          <Grid item xs={12} sm={6}><Field label="Shipping Address">{shipping ? addressText(shipping) : '—'}</Field></Grid>
          <Grid item xs={12}><Field label="Notes">{order.notes || '—'}</Field></Grid>
        </Grid>

        <Divider sx={{ my: 3 }} />

        {/* Totals (0.00 at P2L-4; lines determine these later). */}
        <Grid container spacing={3}>
          <Grid item xs={6} sm={3}><Field label="Subtotal">{cur} {formatNumber(order.subtotal, { maximumFractionDigits: 2 })}</Field></Grid>
          <Grid item xs={6} sm={3}><Field label="Discount">{cur} {formatNumber(order.discountTotal, { maximumFractionDigits: 2 })}</Field></Grid>
          <Grid item xs={6} sm={3}><Field label="Tax">{cur} {formatNumber(order.taxTotal, { maximumFractionDigits: 2 })}</Field></Grid>
          <Grid item xs={6} sm={3}><Field label="Total">{cur} {formatNumber(order.total, { maximumFractionDigits: 2 })}</Field></Grid>
        </Grid>
      </Paper>

      {/* Order lines — placeholder for P2L-5 */}
      <Paper variant="outlined" sx={{ borderRadius: 3, p: { xs: 2.5, md: 3.5 }, mt: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, mb: 2 }}>
          <Box sx={{ width: 36, height: 36, borderRadius: 1.5, bgcolor: 'background.subtle', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'secondary.main' }}><ListAltOutlinedIcon /></Box>
          <Typography variant="h5" component="h2">Order Lines</Typography>
        </Box>
        <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', px: 3, py: { xs: 4, md: 5 }, textAlign: 'center' }}>
          <Typography variant="body2" sx={{ color: 'text.secondary', maxWidth: 520, mx: 'auto' }}>
            No order lines yet. Adding products, quantities and pricing will be available in a later step.
          </Typography>
          <Chip label="Coming soon" size="small" sx={{ mt: 2, fontWeight: 600 }} />
        </Paper>
      </Paper>

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
      <Snackbar open={Boolean(toast)} autoHideDuration={4000} onClose={() => setToast('')} message={toast} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }} />
    </PageContainer>
  );
}

export default SalesOrderProfile;
