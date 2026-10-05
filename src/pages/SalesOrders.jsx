import { useEffect, useMemo, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Typography, Button, TextField, InputAdornment, MenuItem, Paper,
  Skeleton, Alert, Snackbar, Stack,
} from '@mui/material';
import AddOutlinedIcon from '@mui/icons-material/AddOutlined';
import SearchOutlinedIcon from '@mui/icons-material/SearchOutlined';
import ReceiptLongOutlinedIcon from '@mui/icons-material/ReceiptLongOutlined';
import PageContainer from '../components/layout/PageContainer';
import { useOrganisation } from '../context/OrganisationContext';
import SalesOrderTable from '../components/sales/SalesOrderTable';
import SalesOrderForm from '../components/sales/SalesOrderForm';
import {
  getSalesOrders, createDraftSalesOrder, friendlySalesOrderError, SALES_ORDER_STATUSES,
} from '../services/salesOrderService';
import { getCustomers } from '../services/customerService';
import { getAddressesByCustomer } from '../services/customerAddressService';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Sales Orders page (P2L-4, draft foundation)
//
// Lists the active organisation's sales orders and creates DRAFT orders. All
// data access through salesOrderService / customerService / customerAddressService
// (never Supabase directly). Org-scoped: clears + refetches on activeOrgId change.
// No order lines, pricing, tax, allocation or dispatch.
// ─────────────────────────────────────────────────────────────────────────────

const ALL = 'all';

function SalesOrders() {
  const navigate = useNavigate();
  const { activeOrgId } = useOrganisation();

  const [orders, setOrders] = useState([]);
  const [customerOptions, setCustomerOptions] = useState([]);
  const [addressOptions, setAddressOptions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState(ALL);
  const [customerFilter, setCustomerFilter] = useState(ALL);

  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    const [ordersRes, custRes] = await Promise.all([
      getSalesOrders(),
      getCustomers(), // active customers for the create form + customer filter
    ]);
    if (ordersRes.error) {
      const friendly = friendlySalesOrderError(ordersRes.error);
      if (/not set up yet/i.test(friendly)) setOrders([]); else setError(friendly);
    } else {
      setOrders(ordersRes.data || []);
    }
    setCustomerOptions(custRes.error ? [] : (custRes.data || []));
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!activeOrgId) { setOrders([]); setCustomerOptions([]); return; }
    setOrders([]); setCustomerOptions([]);
    load();
  }, [activeOrgId, load]);

  // When a customer is chosen in the form, load that customer's active addresses.
  const handleCustomerChange = async (customerId) => {
    setAddressOptions([]);
    if (!customerId) return;
    const { data, error: err } = await getAddressesByCustomer(customerId, { activeOnly: true });
    if (!err) setAddressOptions(data || []);
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return orders.filter((o) => {
      const matchStatus = statusFilter === ALL || o.status === statusFilter;
      const matchCustomer = customerFilter === ALL || o.customerId === customerFilter;
      const matchQuery = !q ||
        (o.orderNumber || '').toLowerCase().includes(q) ||
        (o.customerLegalName || '').toLowerCase().includes(q) ||
        (o.customerTradingName || '').toLowerCase().includes(q);
      return matchStatus && matchCustomer && matchQuery;
    });
  }, [orders, search, statusFilter, customerFilter]);

  const filtersActive = search.trim() !== '' || statusFilter !== ALL || customerFilter !== ALL;
  const clearFilters = () => { setSearch(''); setStatusFilter(ALL); setCustomerFilter(ALL); };

  const openCreate = () => { setAddressOptions([]); setFormOpen(true); };

  const handleCreate = async (values) => {
    setSaving(true);
    const { data, error: err } = await createDraftSalesOrder(values);
    setSaving(false);
    if (err) { setError(friendlySalesOrderError(err)); return; }
    setFormOpen(false);
    setToast('Draft sales order created.');
    await load();
    if (data?.id) navigate(`/sales-orders/${data.id}`);
  };

  const noneAtAll = !loading && orders.length === 0;
  const noMatches = !loading && orders.length > 0 && filtered.length === 0;

  return (
    <PageContainer maxWidth={1600} sx={{ px: { xs: 2, sm: 3, md: 4, lg: 5 } }}>
      <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, alignItems: { xs: 'stretch', sm: 'center' }, justifyContent: 'space-between', gap: 2, mb: 1 }}>
        <Box>
          <Typography variant="h2" component="h1" sx={{ mb: 0.5 }}>Sales Orders</Typography>
          <Typography variant="body1" sx={{ color: 'text.secondary' }}>
            Create and track commercial sales orders for your customers.
          </Typography>
        </Box>
        <Button variant="contained" color="primary" startIcon={<AddOutlinedIcon />} onClick={openCreate} sx={{ flexShrink: 0 }}>Add Sales Order</Button>
      </Box>

      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ my: 3 }} alignItems={{ md: 'center' }}>
        <TextField
          value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by order number or customer" fullWidth sx={{ maxWidth: { md: 300 } }}
          InputProps={{ startAdornment: <InputAdornment position="start"><SearchOutlinedIcon fontSize="small" /></InputAdornment> }}
        />
        <TextField select label="Status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} fullWidth sx={{ maxWidth: { md: 200 } }}>
          <MenuItem value={ALL}>All statuses</MenuItem>
          {SALES_ORDER_STATUSES.map((s) => <MenuItem key={s.value} value={s.value}>{s.label}</MenuItem>)}
        </TextField>
        <TextField select label="Customer" value={customerFilter} onChange={(e) => setCustomerFilter(e.target.value)} fullWidth sx={{ maxWidth: { md: 240 } }}>
          <MenuItem value={ALL}>All customers</MenuItem>
          {customerOptions.map((c) => <MenuItem key={c.id} value={c.id}>{c.legalName}</MenuItem>)}
        </TextField>
        {filtersActive && <Button onClick={clearFilters} color="inherit" sx={{ flexShrink: 0 }}>Clear filters</Button>}
      </Stack>

      {error && <Alert severity="error" sx={{ mb: 2 }} action={<Button color="inherit" size="small" onClick={load}>Retry</Button>} onClose={() => setError('')}>{error}</Alert>}

      {loading ? (
        <Paper variant="outlined" sx={{ borderRadius: 3, p: 2.5 }}>
          {[0, 1, 2].map((i) => (
            <Box key={i} sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 1 }}>
              <Skeleton variant="rounded" width={34} height={34} />
              <Skeleton width="35%" height={24} />
              <Skeleton width="15%" height={24} sx={{ ml: 'auto' }} />
            </Box>
          ))}
        </Paper>
      ) : noneAtAll ? (
        <EmptySalesOrders onAdd={openCreate} />
      ) : noMatches ? (
        <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', p: 4, textAlign: 'center' }}>
          <Typography variant="body1" sx={{ color: 'text.secondary', mb: 2 }}>No sales orders match your filters.</Typography>
          <Button onClick={clearFilters} variant="outlined" color="primary">Clear filters</Button>
        </Paper>
      ) : (
        <SalesOrderTable
          orders={filtered}
          onOpen={(o) => navigate(`/sales-orders/${o.id}`)}
          onEdit={(o) => navigate(`/sales-orders/${o.id}`)}
        />
      )}

      <SalesOrderForm
        open={formOpen}
        mode="create"
        customerOptions={customerOptions}
        addressOptions={addressOptions}
        saving={saving}
        onCustomerChange={handleCustomerChange}
        onSubmit={handleCreate}
        onClose={() => setFormOpen(false)}
      />
      <Snackbar open={Boolean(toast)} autoHideDuration={4000} onClose={() => setToast('')} message={toast} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }} />
    </PageContainer>
  );
}

function EmptySalesOrders({ onAdd }) {
  return (
    <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', px: 3, py: { xs: 5, md: 7 }, textAlign: 'center' }}>
      <Box sx={{ width: 64, height: 64, borderRadius: '50%', bgcolor: 'background.paper', display: 'flex', alignItems: 'center', justifyContent: 'center', mx: 'auto', mb: 2, color: 'secondary.main' }}>
        <ReceiptLongOutlinedIcon sx={{ fontSize: '2rem' }} />
      </Box>
      <Typography variant="h4" component="p" sx={{ mb: 0.5 }}>No sales orders yet</Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary', maxWidth: 460, mx: 'auto', mb: 3 }}>
        Create your first draft sales order. Order lines, pricing and allocation come in later steps.
      </Typography>
      <Button variant="contained" color="primary" startIcon={<AddOutlinedIcon />} onClick={onAdd}>Add Sales Order</Button>
    </Paper>
  );
}

export default SalesOrders;
