import { useEffect, useState, useCallback } from 'react';
import {
  Box, Typography, Button, Paper, Skeleton, Alert, Snackbar,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
} from '@mui/material';
import SwapHorizOutlinedIcon from '@mui/icons-material/SwapHorizOutlined';
import RefreshOutlinedIcon from '@mui/icons-material/RefreshOutlined';
import WarehouseOutlinedIcon from '@mui/icons-material/WarehouseOutlined';
import { alpha } from '@mui/material/styles';
import PageContainer from '../components/layout/PageContainer';
import { useOrganisation } from '../context/OrganisationContext';
import StockTransferDialog from '../components/stock/StockTransferDialog';
import { formatNumber } from '../components/common/formatters';
import { formatPackagingBreakdown } from '../utils/packaging';
import {
  getStockItems, getStockItemsWithStockForProduct, transferFinishedStock, friendlyStockError,
} from '../services/stockService';
import { getFinishedProductOptions } from '../services/finishedProductService';
import { getStockLocationOptions } from '../services/stockLocationService';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Stock Transfers page (P2K-6)
//
// Shows current finished-goods balances (per product/location) and lets an
// authorised user move stock between two active locations via the atomic
// transfer_finished_stock RPC. All data access through services (never Supabase
// directly). Org-scoped: clears + refetches on activeOrgId change. Creates no
// products or locations. Additive to P2K-5 — receiving is untouched.
// ─────────────────────────────────────────────────────────────────────────────

function StockTransfers() {
  const { activeOrgId } = useOrganisation();

  const [items, setItems] = useState([]);
  const [productOptions, setProductOptions] = useState([]);
  const [locationOptions, setLocationOptions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [dialogOpen, setDialogOpen] = useState(false);
  const [sourceItems, setSourceItems] = useState([]);
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

  const openTransfer = () => {
    setSourceItems([]);
    setResult(null);
    setDialogError('');
    setDialogOpen(true);
  };

  const closeDialog = async () => {
    const hadResult = Boolean(result);
    setDialogOpen(false); setSourceItems([]); setDialogError(''); setResult(null);
    if (hadResult) await load();
  };

  // When a product is chosen in the dialog, load its source stock items (the
  // locations that currently hold a positive balance of that product).
  const handleProductChange = async (productId) => {
    setSourceItems([]);
    if (!productId) return;
    const { data, error: err } = await getStockItemsWithStockForProduct(productId);
    if (!err) setSourceItems(data || []);
  };

  const handleConfirm = async (input) => {
    setSaving(true); setDialogError('');
    const { data, error: err } = await transferFinishedStock(input);
    setSaving(false);
    if (err) {
      setDialogError(friendlyStockError(err));
      // Stock may have changed since the dialog loaded — refresh source items.
      const refreshed = await getStockItemsWithStockForProduct(input.productId);
      if (!refreshed.error) setSourceItems(refreshed.data || []);
      return;
    }
    setResult(data);
    setToast('Stock transferred.');
  };

  const noneAtAll = !loading && items.length === 0;
  const canTransfer = productOptions.length > 0 && locationOptions.length > 0;

  return (
    <PageContainer maxWidth={1600} sx={{ px: { xs: 2, sm: 3, md: 4, lg: 5 } }}>
      <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, alignItems: { xs: 'stretch', sm: 'center' }, justifyContent: 'space-between', gap: 2, mb: 1 }}>
        <Box>
          <Typography variant="h2" component="h1" sx={{ mb: 0.5 }}>Stock Transfers</Typography>
          <Typography variant="body1" sx={{ color: 'text.secondary' }}>
            Move finished goods between stock locations.
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', gap: 1, flexShrink: 0 }}>
          <Button onClick={load} color="inherit" startIcon={<RefreshOutlinedIcon />} disabled={loading}>Refresh</Button>
          <Button variant="contained" color="primary" startIcon={<SwapHorizOutlinedIcon />} onClick={openTransfer} disabled={!canTransfer}>New Transfer</Button>
        </Box>
      </Box>

      {!loading && !canTransfer && (
        <Alert severity="info" sx={{ my: 2 }}>
          You need at least one active finished product and active stock locations with stock before you can transfer.
        </Alert>
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
                <TableCell>Cases</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {items.map((it) => {
                const breakdown = formatPackagingBreakdown(it.qtyBottles, it.productBottlesPerCase);
                return (
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
                  <TableCell>
                    <Typography variant="body2" sx={{ color: breakdown ? 'text.secondary' : 'text.disabled' }}>{breakdown || '—'}</Typography>
                  </TableCell>
                </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <StockTransferDialog
        open={dialogOpen}
        productOptions={productOptions}
        locationOptions={locationOptions}
        sourceItems={sourceItems}
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
        <SwapHorizOutlinedIcon sx={{ fontSize: '2rem' }} />
      </Box>
      <Typography variant="h4" component="p" sx={{ mb: 0.5 }}>No finished-goods stock yet</Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary', maxWidth: 460, mx: 'auto' }}>
        Receive finished goods from a completed bottling run first. Once stock exists you can transfer it between locations.
      </Typography>
    </Paper>
  );
}

export default StockTransfers;
