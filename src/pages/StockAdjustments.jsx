import { useEffect, useState, useCallback } from 'react';
import {
  Box, Typography, Button, Paper, Skeleton, Alert, Snackbar,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
} from '@mui/material';
import TuneOutlinedIcon from '@mui/icons-material/TuneOutlined';
import ReportProblemOutlinedIcon from '@mui/icons-material/ReportProblemOutlined';
import RefreshOutlinedIcon from '@mui/icons-material/RefreshOutlined';
import WarehouseOutlinedIcon from '@mui/icons-material/WarehouseOutlined';
import { alpha } from '@mui/material/styles';
import PageContainer from '../components/layout/PageContainer';
import { useOrganisation } from '../context/OrganisationContext';
import StockAdjustmentDialog from '../components/stock/StockAdjustmentDialog';
import { formatNumber } from '../components/common/formatters';
import {
  getStockItems, getStockItemsWithStockForProduct,
  adjustFinishedStock, recordFinishedStockDamage, friendlyStockError,
} from '../services/stockService';
import { getFinishedProductOptions } from '../services/finishedProductService';
import { getStockLocationOptions } from '../services/stockLocationService';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Stock Adjustments & Damage page (P2K-7)
//
// Shows current finished-goods balances (per product/location) and lets an
// OWNER/ADMIN record a manual adjustment (signed) or damage (decrease) via the
// atomic RPCs. All data access through services (never Supabase directly).
// Org-scoped: clears + refetches on activeOrgId change. Creates no products or
// locations. Additive to P2K-5/P2K-6 — receiving and transfers are untouched.
// ─────────────────────────────────────────────────────────────────────────────

function StockAdjustments() {
  const { activeOrgId } = useOrganisation();

  const [items, setItems] = useState([]);
  const [productOptions, setProductOptions] = useState([]);
  const [locationOptions, setLocationOptions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [dialogOpen, setDialogOpen] = useState(false);
  const [mode, setMode] = useState('adjustment'); // 'adjustment' | 'damage'
  const [dialogStockItems, setDialogStockItems] = useState([]);
  const [saving, setSaving] = useState(false);
  const [dialogError, setDialogError] = useState('');
  const [result, setResult] = useState(null);
  const [toast, setToast] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    const [itemsRes, prodRes, locRes] = await Promise.all([
      getStockItems(),
      getFinishedProductOptions(),
      getStockLocationOptions(),
    ]);
    if (itemsRes.error) {
      const friendly = friendlyStockError(itemsRes.error);
      if (/not set up yet/i.test(friendly)) setItems([]); else setError(friendly);
    } else {
      setItems(itemsRes.data || []);
    }
    setProductOptions(prodRes.error ? [] : (prodRes.data || []));
    setLocationOptions(locRes.error ? [] : (locRes.data || []));
    setLoading(false);
  }, []);

  // Refetch on active-organisation change. Clear first so no previous-org rows
  // are shown mid-switch.
  useEffect(() => {
    if (!activeOrgId) { setItems([]); setProductOptions([]); setLocationOptions([]); return; }
    setItems([]); setProductOptions([]); setLocationOptions([]);
    load();
  }, [activeOrgId, load]);

  const openDialog = (nextMode) => {
    setMode(nextMode);
    setDialogStockItems([]);
    setResult(null);
    setDialogError('');
    setDialogOpen(true);
  };

  const closeDialog = async () => {
    const hadResult = Boolean(result);
    setDialogOpen(false); setDialogStockItems([]); setDialogError(''); setResult(null);
    if (hadResult) await load();
  };

  // On product change in the dialog, load that product's stock items (for the
  // location dropdown + current-balance preview).
  const handleProductChange = async (productId) => {
    setDialogStockItems([]);
    if (!productId) return;
    const { data, error: err } = await getStockItemsWithStockForProduct(productId);
    if (!err) setDialogStockItems(data || []);
  };

  const handleConfirm = async (input) => {
    setSaving(true); setDialogError('');
    const res = mode === 'damage'
      ? await recordFinishedStockDamage(input)
      : await adjustFinishedStock(input);
    setSaving(false);
    if (res.error) {
      setDialogError(friendlyStockError(res.error));
      // Stock may have changed since the dialog loaded — refresh the preview set.
      const refreshed = await getStockItemsWithStockForProduct(input.productId);
      if (!refreshed.error) setDialogStockItems(refreshed.data || []);
      return;
    }
    setResult(res.data);
    setToast(mode === 'damage' ? 'Damage recorded.' : 'Adjustment applied.');
  };

  const noneAtAll = !loading && items.length === 0;
  const hasProducts = productOptions.length > 0;

  return (
    <PageContainer maxWidth={1600} sx={{ px: { xs: 2, sm: 3, md: 4, lg: 5 } }}>
      <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, alignItems: { xs: 'stretch', sm: 'center' }, justifyContent: 'space-between', gap: 2, mb: 1 }}>
        <Box>
          <Typography variant="h2" component="h1" sx={{ mb: 0.5 }}>Stock Adjustments &amp; Damage</Typography>
          <Typography variant="body1" sx={{ color: 'text.secondary' }}>
            Record manual stock corrections and damage write-offs.
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', gap: 1, flexShrink: 0 }}>
          <Button onClick={load} color="inherit" startIcon={<RefreshOutlinedIcon />} disabled={loading}>Refresh</Button>
          <Button variant="outlined" color="error" startIcon={<ReportProblemOutlinedIcon />} onClick={() => openDialog('damage')} disabled={!hasProducts}>New Damage</Button>
          <Button variant="contained" color="primary" startIcon={<TuneOutlinedIcon />} onClick={() => openDialog('adjustment')} disabled={!hasProducts}>New Adjustment</Button>
        </Box>
      </Box>

      {!loading && !hasProducts && (
        <Alert severity="info" sx={{ my: 2 }}>You need at least one active finished product before you can adjust or record damage.</Alert>
      )}

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
        <EmptyStock />
      ) : (
        <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 3, overflowX: 'auto' }}>
          <Table sx={{ minWidth: 760 }} aria-label="Finished goods stock by location">
            <TableHead>
              <TableRow>
                <TableCell>Product</TableCell>
                <TableCell>Location</TableCell>
                <TableCell align="right">Bottles</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {items.map((it) => (
                <TableRow key={it.id} hover sx={{ '& .MuiTableCell-root': { py: 1.75 } }}>
                  <TableCell>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
                      <Box
                        sx={{
                          width: 34, height: 34, borderRadius: 1.5, flexShrink: 0,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          color: 'secondary.main', bgcolor: (t) => alpha(t.palette.secondary.main, 0.12),
                        }}
                      >
                        <WarehouseOutlinedIcon sx={{ fontSize: '1.1rem' }} />
                      </Box>
                      <Box>
                        <Typography variant="body2" sx={{ fontWeight: 600, color: 'text.primary' }}>{it.productName || '—'}</Typography>
                        {it.productSkuCode && <Typography variant="caption" sx={{ color: 'text.secondary' }}>{it.productSkuCode}</Typography>}
                      </Box>
                    </Box>
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" sx={{ color: 'text.primary' }}>{it.locationName || '—'}</Typography>
                    {it.locationCode && <Typography variant="caption" sx={{ color: 'text.secondary' }}>{it.locationCode}</Typography>}
                  </TableCell>
                  <TableCell align="right">
                    <Typography variant="body2" sx={{ color: 'text.primary', fontWeight: 700 }}>{formatNumber(it.qtyBottles, { maximumFractionDigits: 0 })}</Typography>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <StockAdjustmentDialog
        open={dialogOpen}
        mode={mode}
        productOptions={productOptions}
        locationOptions={locationOptions}
        stockItems={dialogStockItems}
        saving={saving}
        result={result}
        errorText={dialogError}
        onProductChange={handleProductChange}
        onConfirm={handleConfirm}
        onClose={closeDialog}
      />
      <Snackbar open={Boolean(toast)} autoHideDuration={4000} onClose={() => setToast('')} message={toast} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }} />
    </PageContainer>
  );
}

function EmptyStock() {
  return (
    <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', px: 3, py: { xs: 5, md: 7 }, textAlign: 'center' }}>
      <Box sx={{ width: 64, height: 64, borderRadius: '50%', bgcolor: 'background.paper', display: 'flex', alignItems: 'center', justifyContent: 'center', mx: 'auto', mb: 2, color: 'secondary.main' }}>
        <TuneOutlinedIcon sx={{ fontSize: '2rem' }} />
      </Box>
      <Typography variant="h4" component="p" sx={{ mb: 0.5 }}>No finished-goods stock yet</Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary', maxWidth: 460, mx: 'auto' }}>
        Receive finished goods from a completed bottling run first. You can also record an increase adjustment to establish an opening balance.
      </Typography>
    </Paper>
  );
}

export default StockAdjustments;
