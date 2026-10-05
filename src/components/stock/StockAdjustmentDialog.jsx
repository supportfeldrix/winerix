import { useEffect, useMemo, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, TextField, MenuItem,
  Button, Stack, CircularProgress, Alert, Divider, Box, Typography, InputAdornment,
  ToggleButton, ToggleButtonGroup,
} from '@mui/material';
import CheckCircleOutlineOutlinedIcon from '@mui/icons-material/CheckCircleOutlineOutlined';
import { formatNumber } from '../common/formatters';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Stock Adjustment / Damage dialog (P2K-7)
//
// mode = 'adjustment' | 'damage'. Steps: (1) select product + location + qty
// (+ direction for adjustments) + reason + notes, with live validation and a
// Current → Change → Result preview; (2) explicit confirmation; (3) result. The
// parent (StockAdjustments) performs the write via stockService
// (adjustFinishedStock / recordFinishedStockDamage) and owns `saving` + supplies
// the source stock items for the selected product. This dialog NEVER queries
// Supabase and creates no products or locations. OWNER/ADMIN only (RPC-enforced).
//
// Validation (UX only; the RPC is the final authority): reason required;
// quantity > 0; a decrease (adjustment down, or damage) cannot exceed the stock
// available at the chosen location.
// ─────────────────────────────────────────────────────────────────────────────

function StockAdjustmentDialog({
  open, mode = 'adjustment', productOptions = [], locationOptions = [], stockItems = [],
  saving = false, result = null, errorText = '', onProductChange, onConfirm, onClose,
}) {
  const isDamage = mode === 'damage';
  const [productId, setProductId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [direction, setDirection] = useState('increase'); // adjustments only
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (!open) return;
    setProductId(''); setLocationId(''); setDirection('increase');
    setQty(''); setReason(''); setNotes('');
    setConfirming(false); setErrors({});
  }, [open, mode]);

  const selectedProduct = useMemo(
    () => productOptions.find((p) => p.id === productId) || null,
    [productOptions, productId]
  );

  // Current balance at the chosen location for the chosen product (0 if none).
  const currentItem = useMemo(
    () => (stockItems || []).find((si) => si.locationId === locationId) || null,
    [stockItems, locationId]
  );
  const current = currentItem ? Number(currentItem.qtyBottles) : 0;

  const qtyNum = Number(qty);
  const qtyValid = Number.isInteger(qtyNum) && qtyNum > 0;

  // Signed delta for the preview + submission.
  const signedDelta = isDamage
    ? (qtyValid ? -qtyNum : 0)
    : (qtyValid ? (direction === 'decrease' ? -qtyNum : qtyNum) : 0);
  const resultingQty = current + signedDelta;
  const isDecrease = signedDelta < 0;

  const selectedLocation = useMemo(
    () => locationOptions.find((l) => l.id === locationId) || null,
    [locationOptions, locationId]
  );

  const handleProductChange = (value) => {
    setProductId(value); setLocationId(''); setQty(''); setErrors({});
    onProductChange?.(value);
  };

  const validate = () => {
    const next = {};
    if (!productId) next.productId = 'Select a product.';
    if (!locationId) next.locationId = 'Select a location.';
    if (!qtyValid) next.qty = 'Enter a positive whole number of bottles.';
    else if (isDecrease && qtyNum > current) {
      next.qty = `Only ${formatNumber(current, { maximumFractionDigits: 0 })} bottles available at this location.`;
    }
    if (!reason.trim()) next.reason = 'A reason is required.';
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const goToConfirm = () => { if (validate()) setConfirming(true); };
  const handleConfirm = () => {
    if (saving) return;
    onConfirm({
      productId,
      locationId,
      qtyBottles: isDamage ? qtyNum : signedDelta, // damage sends positive; adjustment sends signed
      reason: reason.trim(),
      notes: notes.trim() === '' ? null : notes.trim(),
    });
  };

  const done = Boolean(result);
  const title = isDamage ? 'Record Stock Damage' : 'Adjust Stock';
  const changeLabel = isDamage ? 'Damaged' : 'Adjustment';

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>{title}</DialogTitle>

      <DialogContent>
        {errorText && <Alert severity="error" sx={{ mb: 2 }}>{errorText}</Alert>}

        {done ? (
          <Alert severity="success" icon={<CheckCircleOutlineOutlinedIcon />}>
            {isDamage
              ? `Recorded ${formatNumber(qtyNum, { maximumFractionDigits: 0 })} damaged bottles. `
              : `Adjustment applied (${signedDelta > 0 ? '+' : ''}${formatNumber(signedDelta, { maximumFractionDigits: 0 })} bottles). `}
            Stock at {selectedLocation?.name || 'the location'} for {selectedProduct?.name || 'the product'} is now{' '}
            <strong>{formatNumber(result.qtyBottles, { maximumFractionDigits: 0 })} bottles</strong>.
          </Alert>
        ) : confirming ? (
          <Box>
            <Alert severity="warning" sx={{ mb: 2 }}>
              {isDamage
                ? 'This permanently reduces stock to record damage.'
                : 'This records a manual stock correction.'}
            </Alert>
            <Box sx={{ p: 2, borderRadius: 2, border: (t) => `1px solid ${t.palette.divider}` }}>
              <Row label="Product" value={`${selectedProduct?.name || '—'}${selectedProduct?.skuCode ? ` (${selectedProduct.skuCode})` : ''}`} />
              <Row label="Location" value={`${selectedLocation?.name || '—'}${selectedLocation?.locationCode ? ` (${selectedLocation.locationCode})` : ''}`} />
              <Row label="Reason" value={reason.trim()} />
              <Divider sx={{ my: 1 }} />
              <Row label="Current stock" value={`${formatNumber(current, { maximumFractionDigits: 0 })} bottles`} />
              <Row label={changeLabel} value={`${signedDelta > 0 ? '+' : ''}${formatNumber(signedDelta, { maximumFractionDigits: 0 })} bottles`} />
              <Row label="Resulting stock" value={`${formatNumber(resultingQty, { maximumFractionDigits: 0 })} bottles`} strong />
            </Box>
          </Box>
        ) : (
          <Stack spacing={2.5} sx={{ mt: 0.5 }}>
            <TextField
              label="Finished Product" value={productId} onChange={(e) => handleProductChange(e.target.value)}
              error={Boolean(errors.productId)} helperText={errors.productId || 'Select the product'}
              fullWidth select required disabled={saving}
            >
              {productOptions.length === 0 ? (
                <MenuItem value="" disabled><em>No active finished products</em></MenuItem>
              ) : (
                productOptions.map((p) => (
                  <MenuItem key={p.id} value={p.id}>{p.name}{p.skuCode ? ` — ${p.skuCode}` : ''}</MenuItem>
                ))
              )}
            </TextField>

            <TextField
              label="Location" value={locationId}
              onChange={(e) => { setLocationId(e.target.value); setErrors((p) => ({ ...p, locationId: undefined, qty: undefined })); }}
              error={Boolean(errors.locationId)}
              helperText={errors.locationId || (isDamage ? 'Only locations holding this product are shown' : 'Where the correction applies')}
              fullWidth select required disabled={saving || !productId}
            >
              {/* Damage can only decrease, so only locations with stock make sense.
                  Adjustment increases may target any active location. */}
              {isDamage ? (
                (stockItems || []).length === 0 ? (
                  <MenuItem value="" disabled><em>{productId ? 'No stock of this product anywhere' : 'Select a product first'}</em></MenuItem>
                ) : (
                  (stockItems || []).map((si) => (
                    <MenuItem key={si.locationId} value={si.locationId}>
                      {si.locationName}{si.locationCode ? ` — ${si.locationCode}` : ''} · {formatNumber(si.qtyBottles, { maximumFractionDigits: 0 })} bottles
                    </MenuItem>
                  ))
                )
              ) : (
                locationOptions.length === 0 ? (
                  <MenuItem value="" disabled><em>No active stock locations</em></MenuItem>
                ) : (
                  locationOptions.map((l) => (
                    <MenuItem key={l.id} value={l.id}>{l.name}{l.locationCode ? ` — ${l.locationCode}` : ''}</MenuItem>
                  ))
                )
              )}
            </TextField>

            {!isDamage && (
              <ToggleButtonGroup
                value={direction}
                exclusive
                onChange={(_e, v) => { if (v) { setDirection(v); setErrors((p) => ({ ...p, qty: undefined })); } }}
                size="small"
                color="primary"
                disabled={saving}
              >
                <ToggleButton value="increase">Increase</ToggleButton>
                <ToggleButton value="decrease">Decrease</ToggleButton>
              </ToggleButtonGroup>
            )}

            <TextField
              label={isDamage ? 'Bottles damaged' : 'Adjustment quantity'} type="number" value={qty}
              onChange={(e) => { setQty(e.target.value); setErrors((p) => ({ ...p, qty: undefined })); }}
              error={Boolean(errors.qty)} helperText={errors.qty || (isDamage ? 'Positive number of bottles' : 'Positive number; use the toggle for direction')}
              fullWidth required disabled={saving || !locationId}
              inputProps={{ step: 1, min: 1, max: isDecrease ? current : undefined }}
              InputProps={{ endAdornment: <InputAdornment position="end">bottles</InputAdornment> }}
            />

            {/* Live preview. */}
            {locationId && qtyValid && (
              <Box sx={{ p: 1.5, borderRadius: 2, bgcolor: 'background.subtle' }}>
                <Row label="Current stock" value={`${formatNumber(current, { maximumFractionDigits: 0 })} bottles`} />
                <Row label={changeLabel} value={`${signedDelta > 0 ? '+' : ''}${formatNumber(signedDelta, { maximumFractionDigits: 0 })} bottles`} />
                <Row label="Result" value={`${formatNumber(resultingQty, { maximumFractionDigits: 0 })} bottles`} strong />
              </Box>
            )}

            <TextField
              label="Reason" value={reason} onChange={(e) => { setReason(e.target.value); setErrors((p) => ({ ...p, reason: undefined })); }}
              error={Boolean(errors.reason)} helperText={errors.reason || 'Required'}
              fullWidth required disabled={saving}
              placeholder={isDamage ? 'e.g. Breakage in store' : 'e.g. Stock-take correction'}
            />

            <TextField
              label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)}
              helperText="Optional" fullWidth multiline minRows={2} disabled={saving}
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
            <Button onClick={handleConfirm} variant="contained" color={isDamage ? 'error' : 'primary'} disabled={saving}>
              {saving ? <CircularProgress size={20} color="inherit" /> : (isDamage ? 'Confirm Damage' : 'Confirm Adjustment')}
            </Button>
          </>
        ) : (
          <>
            <Button onClick={onClose} color="inherit" disabled={saving}>Cancel</Button>
            <Button onClick={goToConfirm} variant="contained" color="primary" disabled={saving || productOptions.length === 0}>Review</Button>
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

export default StockAdjustmentDialog;
