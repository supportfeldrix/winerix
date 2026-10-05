import { useEffect, useMemo, useState, useCallback } from 'react';
import {
  Box, Typography, Button, TextField, InputAdornment, MenuItem, Paper,
  Skeleton, Alert, Snackbar, Stack,
} from '@mui/material';
import AddOutlinedIcon from '@mui/icons-material/AddOutlined';
import SearchOutlinedIcon from '@mui/icons-material/SearchOutlined';
import Inventory2OutlinedIcon from '@mui/icons-material/Inventory2Outlined';
import PageContainer from '../components/layout/PageContainer';
import { useOrganisation } from '../context/OrganisationContext';
import FinishedProductTable from '../components/finishedGoods/FinishedProductTable';
import FinishedProductForm from '../components/finishedGoods/FinishedProductForm';
import ConfirmDialog from '../components/common/ConfirmDialog';
import {
  getFinishedProducts, createFinishedProduct, updateFinishedProduct,
  deactivateFinishedProduct, reactivateFinishedProduct, friendlyFinishedProductError,
} from '../services/finishedProductService';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Finished Products catalogue page (P2K-2)
//
// Lists the active organisation's finished products (sellable SKUs) and supports
// search, Active/All filtering, create, edit, deactivate and reactivate. All data
// access goes through finishedProductService (never Supabase directly).
// Organisation scoping is handled inside the service; this page refetches
// whenever the active organisation OR the Active/All scope changes.
//
// Catalogue management ONLY — no stock, receipt, locations, transfers or any
// later P2K functionality.
// ─────────────────────────────────────────────────────────────────────────────

const SCOPE_ACTIVE = 'active';
const SCOPE_ALL = 'all';

function FinishedProducts() {
  const { activeOrgId } = useOrganisation();

  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [search, setSearch] = useState('');
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
    const { data, error: err } = await getFinishedProducts({ includeInactive: currentScope === SCOPE_ALL });
    if (err) {
      const friendly = friendlyFinishedProductError(err);
      if (/not set up yet/i.test(friendly)) setProducts([]); else setError(friendly);
    } else {
      setProducts(data || []);
    }
    setLoading(false);
  }, []);

  // Refetch on active-organisation change AND scope change. Clear first so no
  // previous-organisation rows are shown mid-switch.
  useEffect(() => {
    if (!activeOrgId) { setProducts([]); return; }
    setProducts([]);
    load(scope);
  }, [activeOrgId, scope, load]);

  // Client-side search over the loaded rows (SKU / name).
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return products;
    return products.filter((p) =>
      (p.skuCode || '').toLowerCase().includes(q) ||
      (p.name || '').toLowerCase().includes(q)
    );
  }, [products, search]);

  const filtersActive = search.trim() !== '';
  const clearFilters = () => setSearch('');

  const openCreate = () => { setFormMode('create'); setFormTarget(null); setFormOpen(true); };
  const openEdit = (p) => { setFormMode('edit'); setFormTarget(p); setFormOpen(true); };

  const handleSubmit = async (values) => {
    setSaving(true);
    const res = formMode === 'edit'
      ? await updateFinishedProduct(formTarget.id, values)
      : await createFinishedProduct(values);
    setSaving(false);
    if (res.error) { setError(friendlyFinishedProductError(res.error)); return; }
    setFormOpen(false); setFormTarget(null);
    setToast(formMode === 'edit' ? 'Product updated.' : 'Product created.');
    await load(scope);
  };

  const handleDeactivate = async () => {
    if (!deactivateTarget) return;
    setDeactivating(true);
    const { error: err } = await deactivateFinishedProduct(deactivateTarget.id);
    setDeactivating(false); setDeactivateTarget(null);
    if (err) { setError(friendlyFinishedProductError(err)); return; }
    setToast('Product deactivated.'); await load(scope);
  };

  const handleReactivate = async (p) => {
    const { error: err } = await reactivateFinishedProduct(p.id);
    if (err) { setError(friendlyFinishedProductError(err)); return; }
    setToast('Product reactivated.'); await load(scope);
  };

  const noneAtAll = !loading && products.length === 0;
  const noMatches = !loading && products.length > 0 && filtered.length === 0;

  return (
    <PageContainer maxWidth={1600} sx={{ px: { xs: 2, sm: 3, md: 4, lg: 5 } }}>
      <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, alignItems: { xs: 'stretch', sm: 'center' }, justifyContent: 'space-between', gap: 2, mb: 1 }}>
        <Box>
          <Typography variant="h2" component="h1" sx={{ mb: 0.5 }}>Finished Products</Typography>
          <Typography variant="body1" sx={{ color: 'text.secondary' }}>
            Manage your sellable finished-wine products (SKUs).
          </Typography>
        </Box>
        <Button variant="contained" color="primary" startIcon={<AddOutlinedIcon />} onClick={openCreate} sx={{ flexShrink: 0 }}>Create Product</Button>
      </Box>

      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ my: 3 }} alignItems={{ md: 'center' }}>
        <TextField
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by SKU or name"
          fullWidth
          sx={{ maxWidth: { md: 320 } }}
          InputProps={{ startAdornment: <InputAdornment position="start"><SearchOutlinedIcon fontSize="small" /></InputAdornment> }}
        />
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
        <EmptyFinishedProducts onAdd={openCreate} scope={scope} />
      ) : noMatches ? (
        <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', p: 4, textAlign: 'center' }}>
          <Typography variant="body1" sx={{ color: 'text.secondary', mb: 2 }}>No products match your search.</Typography>
          <Button onClick={clearFilters} variant="outlined" color="primary">Clear filters</Button>
        </Paper>
      ) : (
        <FinishedProductTable
          products={filtered}
          onEdit={openEdit}
          onDeactivate={setDeactivateTarget}
          onReactivate={handleReactivate}
        />
      )}

      <FinishedProductForm
        open={formOpen}
        mode={formMode}
        product={formTarget}
        saving={saving}
        onSubmit={handleSubmit}
        onClose={() => { setFormOpen(false); setFormTarget(null); }}
      />
      <ConfirmDialog
        open={Boolean(deactivateTarget)}
        title="Deactivate Product?"
        message="This product will be retained for historical records but hidden from the active catalogue. You can reactivate it later."
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

function EmptyFinishedProducts({ onAdd, scope }) {
  const activeOnly = scope === SCOPE_ACTIVE;
  const heading = activeOnly ? 'No active finished products' : 'No finished products yet';
  const body = activeOnly
    ? 'There are no active products. Switch the Status filter to “All” to view inactive products, or create a new one.'
    : 'Create your first finished product to define a sellable finished-wine identity (SKU).';
  return (
    <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', px: 3, py: { xs: 5, md: 7 }, textAlign: 'center' }}>
      <Box sx={{ width: 64, height: 64, borderRadius: '50%', bgcolor: 'background.paper', display: 'flex', alignItems: 'center', justifyContent: 'center', mx: 'auto', mb: 2, color: 'secondary.main' }}>
        <Inventory2OutlinedIcon sx={{ fontSize: '2rem' }} />
      </Box>
      <Typography variant="h4" component="p" sx={{ mb: 0.5 }}>{heading}</Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary', maxWidth: 460, mx: 'auto', mb: 3 }}>{body}</Typography>
      <Button variant="contained" color="primary" startIcon={<AddOutlinedIcon />} onClick={onAdd}>Create Product</Button>
    </Paper>
  );
}

export default FinishedProducts;
