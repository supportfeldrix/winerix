import { useEffect, useMemo, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, TextField, MenuItem,
  Button, Stack, CircularProgress, Alert, Divider, Box, Typography, Chip,
} from '@mui/material';
import CheckCircleOutlineOutlinedIcon from '@mui/icons-material/CheckCircleOutlineOutlined';
import Inventory2OutlinedIcon from '@mui/icons-material/Inventory2Outlined';
import { formatNumber, formatDate } from '../common/formatters';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Receive Finished Goods dialog (P2K-5)
//
// Receives ONE completed bottling output into stock in FULL (its bottle_count).
// Two steps: (1) select the finished product + destination location and review;
// (2) explicit confirmation. The parent (ReceiveFinishedGoods) performs the
// write via stockService.receiveBottlingOutput (the atomic RPC) and owns `saving`.
// This dialog NEVER queries Supabase. It never creates products or locations.
//
// On success the parent refetches and the dialog shows the resulting stock
// quantity for the (product, location) pair.
// ─────────────────────────────────────────────────────────────────────────────

function ReceiveFinishedGoodsDialog({
  open, output, productOptions = [], locationOptions = [], saving = false,
  result = null, errorText = '', onConfirm, onClose,
}) {
  const [productId, setProductId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [touchErrors, setTouchErrors] = useState({});

  useEffect(() => {
    if (!open) return;
    setProductId('');
    setLocationId('');
    setConfirming(false);
    setTouchErrors({});
  }, [open, output]);

  const selectedProduct = useMemo(
    () => productOptions.find((p) => p.id === productId) || null,
    [productOptions, productId]
  );
  const selectedLocation = useMemo(
    () => locationOptions.find((l) => l.id === locationId) || null,
    [locationOptions, locationId]
  );

  const bottles = output?.bottleCount ?? 0;

  const validate = () => {
    const next = {};
    if (!productId) next.productId = 'Select a finished product.';
    if (!locationId) next.locationId = 'Select a destination location.';
    setTouchErrors(next);
    return Object.keys(next).length === 0;
  };

  const goToConfirm = () => { if (validate()) setConfirming(true); };
  const handleConfirm = () => {
    if (saving) return;
    onConfirm({ bottlingOutputId: output.id, productId, locationId });
  };

  const done = Boolean(result);

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>Receive Finished Goods</DialogTitle>

      <DialogContent>
        {errorText && <Alert severity="error" sx={{ mb: 2 }}>{errorText}</Alert>}

        {/* Bottling output summary (always shown). */}
        {output && (
          <Box sx={{ mb: 2.5, p: 2, borderRadius: 2, bgcolor: 'background.subtle' }}>
            <Typography variant="overline" sx={{ color: 'text.disabled', letterSpacing: '0.08em' }}>Bottling Output</Typography>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={{ xs: 1, sm: 3 }} sx={{ mt: 0.5 }}>
              <Box>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>Run</Typography>
                <Typography variant="body2" sx={{ color: 'text.primary' }}>{output.bottlingCode || '—'}</Typography>
              </Box>
              <Box>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>Bottle Volume</Typography>
                <Typography variant="body2" sx={{ color: 'text.primary' }}>{output.bottleVolumeMl != null ? `${formatNumber(output.bottleVolumeMl, { maximumFractionDigits: 0 })} ml` : '—'}</Typography>
              </Box>
              <Box>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>Bottle Count</Typography>
                <Typography variant="body2" sx={{ color: 'text.primary', fontWeight: 700 }}>{formatNumber(bottles, { maximumFractionDigits: 0 })}</Typography>
              </Box>
              <Box>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>Date</Typography>
                <Typography variant="body2" sx={{ color: 'text.primary' }}>{formatDate(output.bottlingDate)}</Typography>
              </Box>
            </Stack>
          </Box>
        )}

        {done ? (
          // ── Success state ──
          <Alert severity="success" icon={<CheckCircleOutlineOutlinedIcon />}>
            Received {formatNumber(bottles, { maximumFractionDigits: 0 })} bottles.
            {' '}Stock at {result.locationName || selectedLocation?.name || 'the location'} for{' '}
            {result.productName || selectedProduct?.name || 'the product'} is now{' '}
            <strong>{formatNumber(result.qtyBottles, { maximumFractionDigits: 0 })} bottles</strong>.
          </Alert>
        ) : confirming ? (
          // ── Confirmation step ──
          <Box>
            <Alert severity="warning" sx={{ mb: 2 }}>
              This will receive the full bottle count into stock. A bottling output can only be received once.
            </Alert>
            <Box sx={{ p: 2, borderRadius: 2, border: (t) => `1px solid ${t.palette.divider}` }}>
              <Row label="Product" value={`${selectedProduct?.name || '—'}${selectedProduct?.skuCode ? ` (${selectedProduct.skuCode})` : ''}`} />
              <Row label="Destination" value={`${selectedLocation?.name || '—'}${selectedLocation?.locationCode ? ` (${selectedLocation.locationCode})` : ''}`} />
              <Divider sx={{ my: 1 }} />
              <Row label="Bottles to receive" value={formatNumber(bottles, { maximumFractionDigits: 0 })} strong />
            </Box>
          </Box>
        ) : (
          // ── Selection step ──
          <Stack spacing={2.5} sx={{ mt: 0.5 }}>
            <TextField
              label="Finished Product" value={productId} onChange={(e) => { setProductId(e.target.value); setTouchErrors((p) => ({ ...p, productId: undefined })); }}
              error={Boolean(touchErrors.productId)} helperText={touchErrors.productId || 'Select the sellable product this output becomes'}
              fullWidth select required disabled={saving}
            >
              {productOptions.length === 0 ? (
                <MenuItem value="" disabled><em>No active finished products — create one first</em></MenuItem>
              ) : (
                productOptions.map((p) => (
                  <MenuItem key={p.id} value={p.id}>
                    {p.name}{p.skuCode ? ` — ${p.skuCode}` : ''}
                    {p.bottleVolumeMl ? ` · ${formatNumber(p.bottleVolumeMl, { maximumFractionDigits: 0 })} ml` : ''}
                  </MenuItem>
                ))
              )}
            </TextField>

            <TextField
              label="Destination Stock Location" value={locationId} onChange={(e) => { setLocationId(e.target.value); setTouchErrors((p) => ({ ...p, locationId: undefined })); }}
              error={Boolean(touchErrors.locationId)} helperText={touchErrors.locationId || 'Where the finished goods will be held'}
              fullWidth select required disabled={saving}
            >
              {locationOptions.length === 0 ? (
                <MenuItem value="" disabled><em>No active stock locations — create one first</em></MenuItem>
              ) : (
                locationOptions.map((l) => (
                  <MenuItem key={l.id} value={l.id}>
                    {l.name}{l.locationCode ? ` — ${l.locationCode}` : ''}
                  </MenuItem>
                ))
              )}
            </TextField>

            <Chip
              icon={<Inventory2OutlinedIcon />}
              label={`Receives ${formatNumber(bottles, { maximumFractionDigits: 0 })} bottles (full output)`}
              variant="outlined"
              sx={{ alignSelf: 'flex-start', fontWeight: 600 }}
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
            <Button onClick={handleConfirm} variant="contained" color="primary" disabled={saving}>
              {saving ? <CircularProgress size={20} color="inherit" /> : 'Confirm Receipt'}
            </Button>
          </>
        ) : (
          <>
            <Button onClick={onClose} color="inherit" disabled={saving}>Cancel</Button>
            <Button
              onClick={goToConfirm}
              variant="contained"
              color="primary"
              disabled={saving || productOptions.length === 0 || locationOptions.length === 0}
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

export default ReceiveFinishedGoodsDialog;
