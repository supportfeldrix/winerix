import { useEffect, useMemo, useState, useCallback } from 'react';
import {
  Box, Typography, Button, TextField, InputAdornment, MenuItem, Paper,
  Skeleton, Alert, Snackbar, Stack,
} from '@mui/material';
import AddOutlinedIcon from '@mui/icons-material/AddOutlined';
import SearchOutlinedIcon from '@mui/icons-material/SearchOutlined';
import WarehouseOutlinedIcon from '@mui/icons-material/WarehouseOutlined';
import PageContainer from '../components/layout/PageContainer';
import { useOrganisation } from '../context/OrganisationContext';
import StockLocationTable from '../components/stock/StockLocationTable';
import StockLocationForm from '../components/stock/StockLocationForm';
import ConfirmDialog from '../components/common/ConfirmDialog';
import {
  getStockLocations, createStockLocation, updateStockLocation,
  deactivateStockLocation, reactivateStockLocation, friendlyStockLocationError,
  STOCK_LOCATION_TYPES,
} from '../services/stockLocationService';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Stock Locations page (P2K-3)
//
// Lists the active organisation's finished-goods stock locations and supports
// search, Active/All filtering, location-type filtering, create, edit,
// deactivate and reactivate. All data access goes through stockLocationService
// (never Supabase directly). Organisation scoping is handled inside the service;
// this page refetches whenever the active organisation OR the Active/All scope
// changes. No stock quantities are shown — a location only describes WHERE goods
// are held. The actual inventory relationship comes later (P2K-4/P2K-5).
// ─────────────────────────────────────────────────────────────────────────────

const ALL = 'all';
const SCOPE_ACTIVE = 'active';
const SCOPE_ALL = 'all';

function StockLocations() {
  const { activeOrgId } = useOrganisation();

  const [locations, setLocations] = useState([]);
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
    const { data, error: err } = await getStockLocations({ includeInactive: currentScope === SCOPE_ALL });
    if (err) {
      const friendly = friendlyStockLocationError(err);
      if (/not set up yet/i.test(friendly)) setLocations([]); else setError(friendly);
    } else {
      setLocations(data || []);
    }
    setLoading(false);
  }, []);

  // Refetch on active-organisation change AND scope change. Clear first so no
  // previous-organisation rows are shown mid-switch.
  useEffect(() => {
    if (!activeOrgId) { setLocations([]); return; }
    setLocations([]);
    load(scope);
  }, [activeOrgId, scope, load]);

  // Client-side search + type filter over the loaded rows.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return locations.filter((l) => {
      const matchType = typeFilter === ALL || l.locationType === typeFilter;
      const matchQuery = !q ||
        (l.locationCode || '').toLowerCase().includes(q) ||
        (l.name || '').toLowerCase().includes(q);
      return matchType && matchQuery;
    });
  }, [locations, search, typeFilter]);

  const filtersActive = search.trim() !== '' || typeFilter !== ALL;
  const clearFilters = () => { setSearch(''); setTypeFilter(ALL); };

  const openCreate = () => { setFormMode('create'); setFormTarget(null); setFormOpen(true); };
  const openEdit = (l) => { setFormMode('edit'); setFormTarget(l); setFormOpen(true); };

  const handleSubmit = async (values) => {
    setSaving(true);
    const res = formMode === 'edit'
      ? await updateStockLocation(formTarget.id, values)
      : await createStockLocation(values);
    setSaving(false);
    if (res.error) { setError(friendlyStockLocationError(res.error)); return; }
    setFormOpen(false); setFormTarget(null);
    setToast(formMode === 'edit' ? 'Location updated.' : 'Location created.');
    await load(scope);
  };

  const handleDeactivate = async () => {
    if (!deactivateTarget) return;
    setDeactivating(true);
    const { error: err } = await deactivateStockLocation(deactivateTarget.id);
    setDeactivating(false); setDeactivateTarget(null);
    if (err) { setError(friendlyStockLocationError(err)); return; }
    setToast('Location deactivated.'); await load(scope);
  };

  const handleReactivate = async (l) => {
    const { error: err } = await reactivateStockLocation(l.id);
    if (err) { setError(friendlyStockLocationError(err)); return; }
    setToast('Location reactivated.'); await load(scope);
  };

  const noneAtAll = !loading && locations.length === 0;
  const noMatches = !loading && locations.length > 0 && filtered.length === 0;

  return (
    <PageContainer maxWidth={1600} sx={{ px: { xs: 2, sm: 3, md: 4, lg: 5 } }}>
      <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, alignItems: { xs: 'stretch', sm: 'center' }, justifyContent: 'space-between', gap: 2, mb: 1 }}>
        <Box>
          <Typography variant="h2" component="h1" sx={{ mb: 0.5 }}>Stock Locations</Typography>
          <Typography variant="body1" sx={{ color: 'text.secondary' }}>
            Define where finished-goods inventory is stored.
          </Typography>
        </Box>
        <Button variant="contained" color="primary" startIcon={<AddOutlinedIcon />} onClick={openCreate} sx={{ flexShrink: 0 }}>Create Location</Button>
      </Box>

      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ my: 3 }} alignItems={{ md: 'center' }}>
        <TextField
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by code or name"
          fullWidth
          sx={{ maxWidth: { md: 320 } }}
          InputProps={{ startAdornment: <InputAdornment position="start"><SearchOutlinedIcon fontSize="small" /></InputAdornment> }}
        />
        <TextField select label="Type" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} fullWidth sx={{ maxWidth: { md: 220 } }}>
          <MenuItem value={ALL}>All types</MenuItem>
          {STOCK_LOCATION_TYPES.map((t) => <MenuItem key={t.value} value={t.value}>{t.label}</MenuItem>)}
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
        <EmptyStockLocations onAdd={openCreate} scope={scope} />
      ) : noMatches ? (
        <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', p: 4, textAlign: 'center' }}>
          <Typography variant="body1" sx={{ color: 'text.secondary', mb: 2 }}>No locations match your filters.</Typography>
          <Button onClick={clearFilters} variant="outlined" color="primary">Clear filters</Button>
        </Paper>
      ) : (
        <StockLocationTable
          locations={filtered}
          onEdit={openEdit}
          onDeactivate={setDeactivateTarget}
          onReactivate={handleReactivate}
        />
      )}

      <StockLocationForm
        open={formOpen}
        mode={formMode}
        location={formTarget}
        saving={saving}
        onSubmit={handleSubmit}
        onClose={() => { setFormOpen(false); setFormTarget(null); }}
      />
      <ConfirmDialog
        open={Boolean(deactivateTarget)}
        title="Deactivate Location?"
        message="This location will be retained for historical records but hidden from the active list. You can reactivate it later."
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

function EmptyStockLocations({ onAdd, scope }) {
  const activeOnly = scope === SCOPE_ACTIVE;
  const heading = activeOnly ? 'No active stock locations' : 'No stock locations yet';
  const body = activeOnly
    ? 'There are no active locations. Switch the Status filter to “All” to view inactive locations, or create a new one.'
    : 'Create your first stock location to define where finished goods are held.';
  return (
    <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', px: 3, py: { xs: 5, md: 7 }, textAlign: 'center' }}>
      <Box sx={{ width: 64, height: 64, borderRadius: '50%', bgcolor: 'background.paper', display: 'flex', alignItems: 'center', justifyContent: 'center', mx: 'auto', mb: 2, color: 'secondary.main' }}>
        <WarehouseOutlinedIcon sx={{ fontSize: '2rem' }} />
      </Box>
      <Typography variant="h4" component="p" sx={{ mb: 0.5 }}>{heading}</Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary', maxWidth: 460, mx: 'auto', mb: 3 }}>{body}</Typography>
      <Button variant="contained" color="primary" startIcon={<AddOutlinedIcon />} onClick={onAdd}>Create Location</Button>
    </Paper>
  );
}

export default StockLocations;
