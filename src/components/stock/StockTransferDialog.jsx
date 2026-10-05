import { useEffect, useMemo, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, TextField, MenuItem,
  Button, Stack, CircularProgress, Alert, Divider, Box, Typography, InputAdornment,
} from '@mui/material';
import CheckCircleOutlineOutlinedIcon from '@mui/icons-material/CheckCircleOutlineOutlined';
import SwapHorizOutlinedIcon from '@mui/icons-material/SwapHorizOutlined';
import { formatNumber } from '../common/formatters';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Stock Transfer dialog (P2K-6)
//
// Moves finished goods between two active locations in the same organisation.
// Steps: (1) select product + from (sources with stock) + to (any active) +
// bottles, with live validation; (2) explicit confirmation; (3) result. The
// parent (StockTransfers) performs the write via stockService.transferFinishedStock
// (the atomic RPC) and owns `saving` + supplies the source stock items for the
// selected product. This dialog NEVER queries Supabase and creates no locations.
//
// Validation (UX only; the RPC is the final authority): bottles > 0; source !=
// destination; bottles <= available at source. On a server rejection the parent
// refreshes and shows the error — no automatic retry.
// ─────────────────────────────────────────────────────────────────────────────

function StockTransferDialog({
  open, productOptions = [], locationOptions = [], sourceItems = [], saving = false,
  result = null, errorText = '', onProductChange, onConfirm, onClose,
}) {
  const [productId, setProductId] = useState('');
  const [fromLocationId, setFromLocationId] = useState('');
  const [toLocationId, setToLocationId] = useState('');
  const [bottles, setBottles] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (!open) return;
    setProductId('');
    setFromLocationId('');
    setToLocationId('');
    setBottles('');
    setConfirming(false);
    setErrors({});
  }, [open]);

  const selectedProduct = useMemo(
    () => productOptions.find((p) => p.id === productId) || null,
    [productOptions, productId]
  );

  // Source options are the stock items (locations) that hold this product.
  const sourceOptions = useMemo(
    () => (sourceItems || []).map((si) => ({
      locationId: si.locationId,
      locationCode: si.locationCode,
      locationName: si.locationName,
      qtyBottles: si.qtyBottles,
    })),
    [sourceItems]
  );
  const selectedSource = useMemo(
    () => sourceOptions.find((s) => s.locationId === fromLocationId) || null,
    [sourceOptions, fromLocationId]
  );
  const available = selectedSource ? Number(selectedSource.qtyBottles) : null;

  // Destination = any active location except the chosen source.
  const destinationOptions = useMemo(
    () => locationOptions.filter((l) => l.id !== fromLocationId),
    [locationOptions, fromLocationId]
  );

  const selectedDestination = useMemo(
    () => locationOptions.find((l) => l.id === toLocationId) || null,
    [locationOptions, toLocationId]
  );

  const handleProductChange = (value) => {
    setProductId(value);
    setFromLocationId('');
    setToLocationId('');
    setBottles('');
    setErrors({});
    onProductChange?.(value);
  };

  const bottlesNum = Number(bottles);
  const validate = () => {
    const next = {};
    if (!productId) next.productId = 'Select a product.';
    if (!fromLocationId) next.fromLocationId = 'Select a source location.';
    if (!toLocationId) next.toLocationId = 'Select a destination location.';
    if (fromLocationId && toLocationId && fromLocationId === toLocationId) {
      next.toLocationId = 'Destination must differ from source.';
    }
    if (!Number.isInteger(bottlesNum) || bottlesNum <= 0) {
      next.bottles = 'Enter a positive whole number of bottles.';
    } else if (available !== null && bottlesNum > available) {
      next.bottles = `Only ${formatNumber(available, { maximumFractionDigits: 0 })} bottles available at source.`;
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const goToConfirm = () => { if (validate()) setConfirming(true); };
  const handleConfirm = () => {
    if (saving) return;
    onConfirm({ productId, fromLocationId, toLocationId, bottles: bottlesNum });
  };

  const done = Boolean(result);

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>Transfer Finished Goods</DialogTitle>

      <DialogContent>
        {errorText && <Alert severity="error" sx={{ mb: 2 }}>{errorText}</Alert>}

        {done ? (
          // ── Success state ──
          <Alert severity="success" icon={<CheckCircleOutlineOutlinedIcon />}>
            Transferred {formatNumber(result.bottles, { maximumFractionDigits: 0 })} bottles.
            {' '}Source ({selectedSource?.name || selectedSource?.locationName || 'from'}) is now{' '}
            <strong>{formatNumber(result.fromQtyBottles, { maximumFractionDigits: 0 })} bottles</strong>;
            {' '}destination ({selectedDestination?.name || 'to'}) is now{' '}
            <strong>{formatNumber(result.toQtyBottles, { maximumFractionDigits: 0 })} bottles</strong>.
          </Alert>
        ) : confirming ? (
          // ── Confirmation step ──
          <Box>
            <Alert severity="warning" sx={{ mb: 2 }}>
              This moves finished goods between locations. Total product stock is unchanged.
            </Alert>
            <Box sx={{ p: 2, borderRadius: 2, border: (t) => `1px solid ${t.palette.divider}` }}>
              <Row label="Product" value={`${selectedProduct?.name || '—'}${selectedProduct?.skuCode ? ` (${selectedProduct.skuCode})` : ''}`} />
              <Row label="From" value={`${selectedSource?.locationName || '—'}${selectedSource?.locationCode ? ` (${selectedSource.locationCode})` : ''}`} />
              <Row label="To" value={`${selectedDestination?.name || '—'}${selectedDestination?.locationCode ? ` (${selectedDestination.locationCode})` : ''}`} />
              <Divider sx={{ my: 1 }} />
              <Row label="Available at source" value={`${formatNumber(available ?? 0, { maximumFractionDigits: 0 })} bottles`} />
              <Row label="Bottles to transfer" value={formatNumber(bottlesNum, { maximumFractionDigits: 0 })} strong />
              <Divider sx={{ my: 1 }} />
              <Row label="Source after" value={`${formatNumber((available ?? 0) - bottlesNum, { maximumFractionDigits: 0 })} bottles`} />
            </Box>
          </Box>
        ) : (
          // ── Selection step ──
          <Stack spacing={2.5} sx={{ mt: 0.5 }}>
            <TextField
              label="Finished Product" value={productId} onChange={(e) => handleProductChange(e.target.value)}
              error={Boolean(errors.productId)} helperText={errors.productId || 'Select the product to move'}
              fullWidth select required disabled={saving}
            >
              {productOptions.length === 0 ? (
                <MenuItem value="" disabled><em>No active finished products</em></MenuItem>
              ) : (
                productOptions.map((p) => (
                  <MenuItem key={p.id} value={p.id}>
                    {p.name}{p.skuCode ? ` — ${p.skuCode}` : ''}
                  </MenuItem>
                ))
              )}
            </TextField>

            <TextField
              label="From (source)" value={fromLocationId}
              onChange={(e) => { setFromLocationId(e.target.value); setErrors((p) => ({ ...p, fromLocationId: undefined, bottles: undefined })); if (toLocationId === e.target.value) setToLocationId(''); }}
              error={Boolean(errors.fromLocationId)}
              helperText={errors.fromLocationId || (productId ? 'Only locations holding this product are shown' : 'Select a product first')}
              fullWidth select required disabled={saving || !productId}
            >
              {sourceOptions.length === 0 ? (
                <MenuItem value="" disabled><em>{productId ? 'No stock of this product anywhere' : 'Select a product first'}</em></MenuItem>
              ) : (
                sourceOptions.map((s) => (
                  <MenuItem key={s.locationId} value={s.locationId}>
                    {s.locationName}{s.locationCode ? ` — ${s.locationCode}` : ''} · {formatNumber(s.qtyBottles, { maximumFractionDigits: 0 })} bottles
                  </MenuItem>
                ))
              )}
            </TextField>

            {available !== null && (
              <Typography variant="caption" sx={{ color: 'text.secondary', mt: -1 }}>
                Available at source: <strong>{formatNumber(available, { maximumFractionDigits: 0 })} bottles</strong>
              </Typography>
            )}

            <TextField
              label="To (destination)" value={toLocationId}
              onChange={(e) => { setToLocationId(e.target.value); setErrors((p) => ({ ...p, toLocationId: undefined })); }}
              error={Boolean(errors.toLocationId)}
              helperText={errors.toLocationId || 'Any active location, different from the source'}
              fullWidth select required disabled={saving || !fromLocationId}
            >
              {destinationOptions.length === 0 ? (
                <MenuItem value="" disabled><em>No other active locations</em></MenuItem>
              ) : (
                destinationOptions.map((l) => (
                  <MenuItem key={l.id} value={l.id}>{l.name}{l.locationCode ? ` — ${l.locationCode}` : ''}</MenuItem>
                ))
              )}
            </TextField>

            <TextField
              label="Bottles to transfer" type="number" value={bottles}
              onChange={(e) => { setBottles(e.target.value); setErrors((p) => ({ ...p, bottles: undefined })); }}
              error={Boolean(errors.bottles)} helperText={errors.bottles || 'Partial transfers are allowed'}
              fullWidth required disabled={saving || !fromLocationId}
              inputProps={{ step: 1, min: 1, max: available ?? undefined }}
              InputProps={{ endAdornment: <InputAdornment position="end">bottles</InputAdornment> }}
            />
          </Stack>
        )}
      </DialogContent>

      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        {done ? (
          <Button onClick={onClose} variant="contained" color="primary">Done</Button>
        ) : confirming ? (
          <>
            <Button onClick={() => setConfirming(false)} color="inherit" disabled={saving}>Back</Button>
            <Button onClick={handleConfirm} variant="contained" color="primary" startIcon={!saving ? <SwapHorizOutlinedIcon /> : undefined} disabled={saving}>
              {saving ? <CircularProgress size={20} color="inherit" /> : 'Confirm Transfer'}
            </Button>
          </>
        ) : (
          <>
            <Button onClick={onClose} color="inherit" disabled={saving}>Cancel</Button>
            <Button
              onClick={goToConfirm}
              variant="contained"
              color="primary"
              disabled={saving || productOptions.length === 0}
            >
              Review
            </Button>
          </>
        )}
      </DialogActions>
    </Dialog>
  );
}

function Row({ label, value, strong }) {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', py: 0.5 }}>
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>{label}</Typography>
      <Typography variant="body2" sx={{ color: 'text.primary', fontWeight: strong ? 700 : 500 }}>{value}</Typography>
    </Box>
  );
}

export default StockTransferDialog;
