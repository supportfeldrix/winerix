import { useEffect, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, TextField,
  Button, Stack, CircularProgress, InputAdornment, Typography,
} from '@mui/material';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Add / Edit Finished Product dialog (P2K-2)
//
// Controlled locally. The parent (FinishedProducts) performs the Supabase write
// via finishedProductService (createFinishedProduct / updateFinishedProduct) and
// owns `saving`, `open`. This form NEVER queries Supabase.
//
// Product identity ONLY — no lineage (vineyard/block/harvest/cultivar/wine lot),
// no stock, litres, price, sales or compliance fields. Bottles-per-case is
// presentation metadata only (cases/pallets are deferred).
// ─────────────────────────────────────────────────────────────────────────────

function emptyValues() {
  return {
    skuCode: '',
    name: '',
    vintage: '',
    bottleVolumeMl: '',
    packagingFormat: '',
    wineStyle: '',
    bottlesPerCase: '',
    notes: '',
  };
}

function isPositiveInt(v) {
  if (v === '' || v === null || v === undefined) return false;
  const n = Number(v);
  return Number.isInteger(n) && n > 0;
}

function FinishedProductForm({ open, mode = 'create', product, saving = false, onSubmit, onClose }) {
  const isEdit = mode === 'edit';
  const [values, setValues] = useState(emptyValues());
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (!open) return;
    if (product && isEdit) {
      setValues({
        skuCode: product.skuCode || '',
        name: product.name || '',
        vintage: product.vintage ?? '',
        bottleVolumeMl: product.bottleVolumeMl ?? '',
        packagingFormat: product.packagingFormat || '',
        wineStyle: product.wineStyle || '',
        bottlesPerCase: product.bottlesPerCase ?? '',
        notes: product.notes || '',
      });
    } else {
      setValues(emptyValues());
    }
    setErrors({});
  }, [open, product, mode, isEdit]);

  const setField = (field) => (e) => {
    setValues((prev) => ({ ...prev, [field]: e.target.value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const validate = () => {
    const next = {};
    if (!values.skuCode.trim()) next.skuCode = 'A SKU code is required.';
    if (!values.name.trim()) next.name = 'A product name is required.';
    if (!isPositiveInt(values.bottleVolumeMl)) next.bottleVolumeMl = 'Bottle volume must be a whole number greater than zero.';
    if (!values.packagingFormat.trim()) next.packagingFormat = 'A packaging format is required.';
    if (values.vintage !== '' && values.vintage !== null) {
      const vy = Number(values.vintage);
      if (!Number.isInteger(vy) || vy < 1900 || vy > 2200) next.vintage = 'Vintage must be a whole year between 1900 and 2200.';
    }
    if (values.bottlesPerCase !== '' && values.bottlesPerCase !== null) {
      if (!isPositiveInt(values.bottlesPerCase)) next.bottlesPerCase = 'Bottles per case must be a whole number greater than zero.';
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (saving) return;
    if (!validate()) return;

    onSubmit({
      skuCode: values.skuCode.trim(),
      name: values.name.trim(),
      vintage: values.vintage === '' ? null : Number(values.vintage),
      bottleVolumeMl: Number(values.bottleVolumeMl),
      packagingFormat: values.packagingFormat.trim(),
      wineStyle: values.wineStyle.trim() === '' ? null : values.wineStyle.trim(),
      bottlesPerCase: values.bottlesPerCase === '' ? null : Number(values.bottlesPerCase),
      notes: values.notes.trim() === '' ? null : values.notes.trim(),
    });
  };

  const title = isEdit ? 'Edit Finished Product' : 'Create Finished Product';
  const submitLabel = isEdit ? 'Save Changes' : 'Create Product';

  return (
    <Dialog
      open={open}
      onClose={saving ? undefined : onClose}
      fullWidth
      maxWidth="sm"
      component="form"
      onSubmit={handleSubmit}
      noValidate
    >
      <DialogTitle>{title}</DialogTitle>

      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          <TextField
            label="SKU Code" value={values.skuCode} onChange={setField('skuCode')}
            error={Boolean(errors.skuCode)} helperText={errors.skuCode || 'Unique within your organisation (case-insensitive)'}
            fullWidth required autoFocus disabled={saving} placeholder="e.g. SB-2026-750"
          />

          <TextField
            label="Product Name" value={values.name} onChange={setField('name')}
            error={Boolean(errors.name)} helperText={errors.name || 'e.g. Estate Sauvignon Blanc'}
            fullWidth required disabled={saving}
          />

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField
              label="Vintage" type="number" value={values.vintage} onChange={setField('vintage')}
              error={Boolean(errors.vintage)} helperText={errors.vintage || 'Optional — e.g. 2026'}
              fullWidth disabled={saving} inputProps={{ step: 1, min: 1900, max: 2200 }}
            />
            <TextField
              label="Bottle Volume" type="number" value={values.bottleVolumeMl} onChange={setField('bottleVolumeMl')}
              error={Boolean(errors.bottleVolumeMl)} helperText={errors.bottleVolumeMl || 'Required — e.g. 750'}
              fullWidth required disabled={saving} inputProps={{ step: 1, min: 1 }}
              InputProps={{ endAdornment: <InputAdornment position="end">ml</InputAdornment> }}
            />
          </Stack>

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField
              label="Packaging Format" value={values.packagingFormat} onChange={setField('packagingFormat')}
              error={Boolean(errors.packagingFormat)} helperText={errors.packagingFormat || 'Required — e.g. Bottle'}
              fullWidth required disabled={saving} placeholder="e.g. Bottle"
            />
            <TextField
              label="Wine Style" value={values.wineStyle} onChange={setField('wineStyle')}
              helperText="Optional — e.g. Dry White" fullWidth disabled={saving}
            />
          </Stack>

          <TextField
            label="Bottles per Case" type="number" value={values.bottlesPerCase} onChange={setField('bottlesPerCase')}
            error={Boolean(errors.bottlesPerCase)}
            helperText={errors.bottlesPerCase || 'Optional — presentation only (e.g. 6 or 12)'}
            fullWidth disabled={saving} inputProps={{ step: 1, min: 1 }}
          />

          <TextField
            label="Notes" value={values.notes} onChange={setField('notes')}
            helperText="Optional" fullWidth multiline minRows={2} disabled={saving}
          />

          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            A product is the sellable finished-wine identity. It is reused across bottling runs and holds no stock quantities.
          </Typography>
        </Stack>
      </DialogContent>

      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        <Button onClick={onClose} color="inherit" disabled={saving}>Cancel</Button>
        <Button type="submit" variant="contained" color="primary" disabled={saving}>
          {saving ? <CircularProgress size={20} color="inherit" /> : submitLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default FinishedProductForm;
