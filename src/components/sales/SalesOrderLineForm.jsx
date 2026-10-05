import { useEffect, useMemo, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, TextField, MenuItem,
  Button, Stack, CircularProgress, Box, Typography, Divider, InputAdornment,
} from '@mui/material';
import { formatNumber } from '../common/formatters';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Add / Edit Sales Order Line dialog (P2L-5)
//
// Controlled locally. The parent (SalesOrderProfile) performs the write via
// salesOrderLineService (addSalesOrderLine / updateSalesOrderLine) and owns
// `saving`, `open`, and supplies active `productOptions`. This form NEVER queries
// Supabase. The live calculation preview below is INDICATIVE ONLY — the server
// (DB trigger) is the authoritative source of tax_amount and line_total.
//
// Fields: Product, Quantity, Unit Price, Line Discount, Tax Rate (%), Notes.
// Stock availability is NOT shown (that is P2L-6).
// ─────────────────────────────────────────────────────────────────────────────

function emptyValues() {
  return { finishedProductId: '', quantityBottles: '', unitPrice: '', lineDiscount: '', taxRate: '', notes: '' };
}

function SalesOrderLineForm({ open, mode = 'add', line, currency = 'ZAR', productOptions = [], saving = false, onSubmit, onClose }) {
  const isEdit = mode === 'edit';
  const [values, setValues] = useState(emptyValues());
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (!open) return;
    if (line && isEdit) {
      setValues({
        finishedProductId: line.finishedProductId || '',
        quantityBottles: line.quantityBottles ?? '',
        unitPrice: line.unitPrice ?? '',
        lineDiscount: line.lineDiscount ?? '',
        taxRate: line.taxRate ?? '',
        notes: line.notes || '',
      });
    } else {
      setValues(emptyValues());
    }
    setErrors({});
  }, [open, line, mode, isEdit]);

  const setField = (field) => (e) => {
    setValues((prev) => ({ ...prev, [field]: e.target.value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const selectedProduct = useMemo(
    () => productOptions.find((p) => p.id === values.finishedProductId) || null,
    [productOptions, values.finishedProductId]
  );

  // Indicative preview (server authoritative). Mirrors the DB calculation.
  const qty = Number(values.quantityBottles);
  const price = Number(values.unitPrice);
  const discount = values.lineDiscount === '' ? 0 : Number(values.lineDiscount);
  const rate = values.taxRate === '' ? 0 : Number(values.taxRate);
  const valid = Number.isInteger(qty) && qty > 0 && Number.isFinite(price) && price >= 0
    && Number.isFinite(discount) && discount >= 0 && Number.isFinite(rate) && rate >= 0;
  const gross = valid ? Math.round(qty * price * 100) / 100 : null;
  const net = gross !== null ? Math.round((gross - discount) * 100) / 100 : null;
  const taxAmt = net !== null && net >= 0 ? Math.round((net * rate / 100) * 100) / 100 : null;
  const lineTotal = net !== null && taxAmt !== null ? Math.round((net + taxAmt) * 100) / 100 : null;
  const discountExceeds = gross !== null && discount > gross;

  const validate = () => {
    const next = {};
    if (!values.finishedProductId) next.finishedProductId = 'A product is required.';
    if (!(Number.isInteger(qty) && qty > 0)) next.quantityBottles = 'Quantity must be a whole number greater than zero.';
    if (!(Number.isFinite(price) && price >= 0) || values.unitPrice === '') next.unitPrice = 'Unit price must be a non-negative number.';
    if (values.lineDiscount !== '' && (!Number.isFinite(discount) || discount < 0)) next.lineDiscount = 'Discount must be non-negative.';
    if (values.taxRate !== '' && (!Number.isFinite(rate) || rate < 0)) next.taxRate = 'Tax rate must be non-negative.';
    if (discountExceeds) next.lineDiscount = 'Discount cannot exceed the gross (quantity × unit price).';
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (saving) return;
    if (!validate()) return;
    onSubmit({
      finishedProductId: values.finishedProductId,
      quantityBottles: qty,
      unitPrice: price,
      lineDiscount: values.lineDiscount === '' ? 0 : discount,
      taxRate: values.taxRate === '' ? 0 : rate,
      notes: values.notes.trim() === '' ? null : values.notes.trim(),
    });
  };

  const title = isEdit ? 'Edit Order Line' : 'Add Order Line';

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} fullWidth maxWidth="sm" component="form" onSubmit={handleSubmit} noValidate>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          <TextField
            label="Product" value={values.finishedProductId} onChange={setField('finishedProductId')}
            error={Boolean(errors.finishedProductId)} helperText={errors.finishedProductId || 'Active finished products'}
            fullWidth select required autoFocus disabled={saving}
          >
            {productOptions.length === 0 ? (
              <MenuItem value="" disabled><em>No active finished products — create one first</em></MenuItem>
            ) : (
              productOptions.map((p) => (
                <MenuItem key={p.id} value={p.id}>
                  {p.name}{p.skuCode ? ` — ${p.skuCode}` : ''}{p.bottleVolumeMl ? ` · ${formatNumber(p.bottleVolumeMl, { maximumFractionDigits: 0 })} ml` : ''}
                </MenuItem>
              ))
            )}
          </TextField>

          {selectedProduct && (
            <Box sx={{ px: 0.5 }}>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                {selectedProduct.skuCode} · {selectedProduct.name}
                {selectedProduct.bottleVolumeMl ? ` · ${formatNumber(selectedProduct.bottleVolumeMl, { maximumFractionDigits: 0 })} ml` : ''}
              </Typography>
            </Box>
          )}

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField
              label="Quantity (bottles)" type="number" value={values.quantityBottles} onChange={setField('quantityBottles')}
              error={Boolean(errors.quantityBottles)} helperText={errors.quantityBottles || 'Whole bottles, > 0'}
              fullWidth required disabled={saving} inputProps={{ step: 1, min: 1 }}
            />
            <TextField
              label="Unit Price" type="number" value={values.unitPrice} onChange={setField('unitPrice')}
              error={Boolean(errors.unitPrice)} helperText={errors.unitPrice || 'Per bottle'}
              fullWidth required disabled={saving} inputProps={{ step: '0.01', min: 0 }}
              InputProps={{ startAdornment: <InputAdornment position="start">{currency}</InputAdornment> }}
            />
          </Stack>

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField
              label="Line Discount" type="number" value={values.lineDiscount} onChange={setField('lineDiscount')}
              error={Boolean(errors.lineDiscount)} helperText={errors.lineDiscount || 'Optional — amount off the line'}
              fullWidth disabled={saving} inputProps={{ step: '0.01', min: 0 }}
              InputProps={{ startAdornment: <InputAdornment position="start">{currency}</InputAdornment> }}
            />
            <TextField
              label="Tax Rate" type="number" value={values.taxRate} onChange={setField('taxRate')}
              error={Boolean(errors.taxRate)} helperText={errors.taxRate || 'Percent, e.g. 15'}
              fullWidth disabled={saving} inputProps={{ step: '0.0001', min: 0 }}
              InputProps={{ endAdornment: <InputAdornment position="end">%</InputAdornment> }}
            />
          </Stack>

          {/* Indicative calculation preview — server is authoritative. */}
          {valid && !discountExceeds && (
            <Box sx={{ p: 1.5, borderRadius: 2, bgcolor: 'background.subtle' }}>
              <PreviewRow label="Gross" value={`${currency} ${formatNumber(gross, { maximumFractionDigits: 2 })}`} />
              <PreviewRow label="Discount" value={`${currency} ${formatNumber(discount, { maximumFractionDigits: 2 })}`} />
              <PreviewRow label="Net" value={`${currency} ${formatNumber(net, { maximumFractionDigits: 2 })}`} />
              <PreviewRow label={`Tax (${formatNumber(rate, { maximumFractionDigits: 4 })}%)`} value={`${currency} ${formatNumber(taxAmt, { maximumFractionDigits: 2 })}`} />
              <Divider sx={{ my: 0.5 }} />
              <PreviewRow label="Line Total" value={`${currency} ${formatNumber(lineTotal, { maximumFractionDigits: 2 })}`} strong />
              <Typography variant="caption" sx={{ color: 'text.disabled', display: 'block', mt: 0.5 }}>Preview only — the server calculates the final values.</Typography>
            </Box>
          )}

          <TextField
            label="Notes" value={values.notes} onChange={setField('notes')}
            helperText="Optional" fullWidth multiline minRows={2} disabled={saving}
          />
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        <Button onClick={onClose} color="inherit" disabled={saving}>Cancel</Button>
        <Button type="submit" variant="contained" color="primary" disabled={saving || productOptions.length === 0}>
          {saving ? <CircularProgress size={20} color="inherit" /> : (isEdit ? 'Save Changes' : 'Add Line')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function PreviewRow({ label, value, strong }) {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', py: 0.25 }}>
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>{label}</Typography>
      <Typography variant="body2" sx={{ color: 'text.primary', fontWeight: strong ? 700 : 500 }}>{value}</Typography>
    </Box>
  );
}

export default SalesOrderLineForm;
