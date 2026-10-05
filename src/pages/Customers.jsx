import { useEffect, useMemo, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Typography, Button, TextField, InputAdornment, MenuItem, Paper,
  Skeleton, Alert, Snackbar, Stack,
} from '@mui/material';
import AddOutlinedIcon from '@mui/icons-material/AddOutlined';
import SearchOutlinedIcon from '@mui/icons-material/SearchOutlined';
import StorefrontOutlinedIcon from '@mui/icons-material/StorefrontOutlined';
import PageContainer from '../components/layout/PageContainer';
import { useOrganisation } from '../context/OrganisationContext';
import CustomerTable from '../components/customers/CustomerTable';
import CustomerForm from '../components/customers/CustomerForm';
import ConfirmDialog from '../components/common/ConfirmDialog';
import {
  getCustomers, createCustomer, updateCustomer,
  deactivateCustomer, reactivateCustomer, friendlyCustomerError, CUSTOMER_TYPES,
} from '../services/customerService';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Customers page (P2L-2)
//
// The commercial customer master used later by Sales Orders. Supports search,
// customer-type filter, Active/All filter, create, edit, deactivate and
// reactivate. All data access goes through customerService (never Supabase
// directly). Organisation scoping is handled inside the service; this page
// refetches whenever the active organisation OR the Active/All scope changes.
//
// Customer master ONLY — no contacts, addresses, orders or any later P2L phase.
// ─────────────────────────────────────────────────────────────────────────────

const ALL = 'all';
const SCOPE_ACTIVE = 'active';
const SCOPE_ALL = 'all';

function Customers() {
  const navigate = useNavigate();
  const { activeOrgId } = useOrganisation();

  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState(ALL);
  const [scope, setScope] = useState(SCOPE_ACTIVE);

  const [formOpen, setFormOpen] = useState(false);
  const [formMode, setFormMode] = useState('create');
  const [formTarget, setFormTarget] = useState(null);
  const [saving, setSaving] = useState(false);

  const [deactivateTarget, setDeactivateTarget] = useState(null);
  const [deactivating, setDeactivating] = useState(false);
  const [toast, setToast] = useState('');

  const load = useCallback(async (currentScope) => {
    setLoading(true); setError('');
    const { data, error: err } = await getCustomers({ includeInactive: currentScope === SCOPE_ALL });
    if (err) {
      const friendly = friendlyCustomerError(err);
      if (/not set up yet/i.test(friendly)) setCustomers([]); else setError(friendly);
    } else {
      setCustomers(data || []);
    }
    setLoading(false);
  }, []);

  // Refetch on active-organisation change AND scope change. Clear first so no
  // previous-organisation rows are shown mid-switch.
  useEffect(() => {
    if (!activeOrgId) { setCustomers([]); return; }
    setCustomers([]);
    load(scope);
  }, [activeOrgId, scope, load]);

  // Client-side search + type filter over the loaded rows.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return customers.filter((c) => {
      const matchType = typeFilter === ALL || c.customerType === typeFilter;
      const matchQuery = !q ||
        (c.legalName || '').toLowerCase().includes(q) ||
        (c.tradingName || '').toLowerCase().includes(q) ||
        (c.email || '').toLowerCase().includes(q) ||
        (c.phone || '').toLowerCase().includes(q);
      return matchType && matchQuery;
    });
  }, [customers, search, typeFilter]);

  const filtersActive = search.trim() !== '' || typeFilter !== ALL;
  const clearFilters = () => { setSearch(''); setTypeFilter(ALL); };

  const openCreate = () => { setFormMode('create'); setFormTarget(null); setFormOpen(true); };
  const openEdit = (c) => { setFormMode('edit'); setFormTarget(c); setFormOpen(true); };

  const handleSubmit = async (values) => {
    setSaving(true);
    const res = formMode === 'edit'
      ? await updateCustomer(formTarget.id, values)
      : await createCustomer(values);
    setSaving(false);
    if (res.error) { setError(friendlyCustomerError(res.error)); return; }
    setFormOpen(false); setFormTarget(null);
    setToast(formMode === 'edit' ? 'Customer updated.' : 'Customer created.');
    await load(scope);
  };

  const handleDeactivate = async () => {
    if (!deactivateTarget) return;
    setDeactivating(true);
    const { error: err } = await deactivateCustomer(deactivateTarget.id);
    setDeactivating(false); setDeactivateTarget(null);
    if (err) { setError(friendlyCustomerError(err)); return; }
    setToast('Customer deactivated.'); await load(scope);
  };

  const handleReactivate = async (c) => {
    const { error: err } = await reactivateCustomer(c.id);
    if (err) { setError(friendlyCustomerError(err)); return; }
    setToast('Customer reactivated.'); await load(scope);
  };

  const noneAtAll = !loading && customers.length === 0;
  const noMatches = !loading && customers.length > 0 && filtered.length === 0;

  return (
    <PageContainer maxWidth={1600} sx={{ px: { xs: 2, sm: 3, md: 4, lg: 5 } }}>
      <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, alignItems: { xs: 'stretch', sm: 'center' }, justifyContent: 'space-between', gap: 2, mb: 1 }}>
        <Box>
          <Typography variant="h2" component="h1" sx={{ mb: 0.5 }}>Customers</Typography>
          <Typography variant="body1" sx={{ color: 'text.secondary' }}>
            Your commercial customer master — the entities that place sales orders.
          </Typography>
        </Box>
        <Button variant="contained" color="primary" startIcon={<AddOutlinedIcon />} onClick={openCreate} sx={{ flexShrink: 0 }}>Add Customer</Button>
      </Box>

      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ my: 3 }} alignItems={{ md: 'center' }}>
        <TextField
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, email or phone"
          fullWidth
          sx={{ maxWidth: { md: 320 } }}
          InputProps={{ startAdornment: <InputAdornment position="start"><SearchOutlinedIcon fontSize="small" /></InputAdornment> }}
        />
        <TextField select label="Type" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} fullWidth sx={{ maxWidth: { md: 220 } }}>
          <MenuItem value={ALL}>All types</MenuItem>
          {CUSTOMER_TYPES.map((t) => <MenuItem key={t} value={t}>{t}</MenuItem>)}
        </TextField>
        <TextField select label="Status" value={scope} onChange={(e) => setScope(e.target.value)} fullWidth sx={{ maxWidth: { md: 160 } }}>
          <MenuItem value={SCOPE_ACTIVE}>Active</MenuItem>
          <MenuItem value={SCOPE_ALL}>All</MenuItem>
        </TextField>
        {filtersActive && <Button onClick={clearFilters} color="inherit" sx={{ flexShrink: 0 }}>Clear filters</Button>}
      </Stack>

      {error && <Alert severity="error" sx={{ mb: 2 }} action={<Button color="inherit" size="small" onClick={() => load(scope)}>Retry</Button>} onClose={() => setError('')}>{error}</Alert>}

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
        <EmptyCustomers onAdd={openCreate} scope={scope} />
      ) : noMatches ? (
        <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', p: 4, textAlign: 'center' }}>
          <Typography variant="body1" sx={{ color: 'text.secondary', mb: 2 }}>No customers match your filters.</Typography>
          <Button onClick={clearFilters} variant="outlined" color="primary">Clear filters</Button>
        </Paper>
      ) : (
        <CustomerTable
          customers={filtered}
          onOpen={(c) => navigate(`/customers/${c.id}`)}
          onEdit={openEdit}
          onDeactivate={setDeactivateTarget}
          onReactivate={handleReactivate}
        />
      )}

      <CustomerForm
        open={formOpen}
        mode={formMode}
        customer={formTarget}
        saving={saving}
        onSubmit={handleSubmit}
        onClose={() => { setFormOpen(false); setFormTarget(null); }}
      />
      <ConfirmDialog
        open={Boolean(deactivateTarget)}
        title="Deactivate Customer?"
        message="This customer will be retained for historical records but hidden from the active list. You can reactivate it later."
        confirmLabel="Deactivate"
        confirmColor="error"
        loading={deactivating}
        onConfirm={handleDeactivate}
        onClose={() => setDeactivateTarget(null)}
      />
      <Snackbar open={Boolean(toast)} autoHideDuration={4000} onClose={() => setToast('')} message={toast} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }} />
    </PageContainer>
  );
}

function EmptyCustomers({ onAdd, scope }) {
  const activeOnly = scope === SCOPE_ACTIVE;
  const heading = activeOnly ? 'No active customers' : 'No customers yet';
  const body = activeOnly
    ? 'There are no active customers. Switch the Status filter to “All” to view inactive customers, or add a new one.'
    : 'Add your first customer to begin building your commercial customer master.';
  return (
    <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', px: 3, py: { xs: 5, md: 7 }, textAlign: 'center' }}>
      <Box sx={{ width: 64, height: 64, borderRadius: '50%', bgcolor: 'background.paper', display: 'flex', alignItems: 'center', justifyContent: 'center', mx: 'auto', mb: 2, color: 'secondary.main' }}>
        <StorefrontOutlinedIcon sx={{ fontSize: '2rem' }} />
      </Box>
      <Typography variant="h4" component="p" sx={{ mb: 0.5 }}>{heading}</Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary', maxWidth: 460, mx: 'auto', mb: 3 }}>{body}</Typography>
      <Button variant="contained" color="primary" startIcon={<AddOutlinedIcon />} onClick={onAdd}>Add Customer</Button>
    </Paper>
  );
}

export default Customers;
