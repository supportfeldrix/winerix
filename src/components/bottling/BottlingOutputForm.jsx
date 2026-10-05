import { useEffect, useMemo, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, TextField,
  Button, Stack, CircularProgress, Alert, Typography, InputAdornment,
} from '@mui/material';
import { formatNumber } from '../common/formatters';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Add / Edit Bottling Output dialog (P2J-B5-3)
//
// Records a declared output line for a bottling run (bottling_outputs). The
// parent (BottlingOutputsSection) performs the Supabase write via bottlingService
// (createBottlingOutput / updateBottlingOutput) and owns `saving`, `open`. This
// form NEVER queries Supabase and NEVER creates product/SKU/stock.
//
// Volume handling: Bottled Litres is an EXPLICIT user value. We show an
// informational "bottle volume × count" calculation and a non-blocking warning
// when it differs from the declared Bottled Litres — we never silently overwrite
// the user's value. There is an optional "Use calculated value" helper the user
// may click to copy the calculation into Bottled Litres.
//
// Front-end validation (DB remains authoritative):
//   • bottleVolumeMl: required, numeric, > 0
//   • bottleCount:    required, integer, >= 0
//   • bottledLitres:  required, numeric, >= 0
//   • packagingFormat: required, non-blank
//   • vintage:        optional, integer, 1900–2200
// ─────────────────────────────────────────────────────────────────────────────

const EPSILON = 1e-6;

function emptyValues() {
  return {
    bottleVolumeMl: '',
    bottleCount: '',
    bottledLitres: '',
    packagingFormat: '',
    productName: '',
    vintage: '',
    notes: '',
  };
}

function isPositiveNumber(v) {
  if (v === '' || v === null || v === undefined) return false;
  const n = Number(v);
  return Number.isFinite(n) && n > 0;
}

function isNonNegativeNumber(v) {
  if (v === '' || v === null || v === undefined) return false;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0;
}

function isNonNegativeInteger(v) {
  if (v === '' || v === null || v === undefined) return false;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0;
}

function BottlingOutputForm({
  open, mode = 'add', output, saving = false, onSubmit, onClose,
}) {
  const isEdit = mode === 'edit';
  const [values, setValues] = useState(emptyValues());
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (!open) return;
    if (output && isEdit) {
      setValues({
        bottleVolumeMl: output.bottleVolumeMl ?? '',
        bottleCount: output.bottleCount ?? '',
        bottledLitres: output.bottledLitres ?? '',
        packagingFormat: output.packagingFormat || '',
        productName: output.productName || '',
        vintage: output.vintage ?? '',
        notes: output.notes || '',
      });
    } else {
      setValues(emptyValues());
    }
    setErrors({});
  }, [open, output, mode, isEdit]);

  const setField = (field) => (e) => {
    setValues((prev) => ({ ...prev, [field]: e.target.value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  // Informational calculation: bottle volume (ml) × count → litres.
  const calculatedLitres = useMemo(() => {
    const vol = Number(values.bottleVolumeMl);
    const count = Number(values.bottleCount);
    if (!Number.isFinite(vol) || !Number.isFinite(count) || vol <= 0 || count < 0) return null;
    return (vol * count) / 1000;
  }, [values.bottleVolumeMl, values.bottleCount]);

  const declaredLitres = Number(values.bottledLitres);
  const litresMismatch =
    calculatedLitres !== null &&
    isNonNegativeNumber(values.bottledLitres) &&
    Math.abs(calculatedLitres - declaredLitres) > EPSILON;

  const useCalculatedValue = () => {
    if (calculatedLitres === null) return;
    setValues((prev) => ({ ...prev, bottledLitres: String(calculatedLitres) }));
    setErrors((prev) => ({ ...prev, bottledLitres: undefined }));
  };

  const validate = () => {
    const next = {};
    if (!isPositiveNumber(values.bottleVolumeMl)) next.bottleVolumeMl = 'Bottle volume must be a number greater than zero.';
    if (!isNonNegativeInteger(values.bottleCount)) next.bottleCount = 'Bottle count must be a whole number of zero or more.';
    if (!isNonNegativeNumber(values.bottledLitres)) next.bottledLitres = 'Bottled litres must be a non-negative number.';
    if (!values.packagingFormat.trim()) next.packagingFormat = 'A packaging format is required.';
    if (values.vintage !== '' && values.vintage !== null) {
      const vy = Number(values.vintage);
      if (!Number.isInteger(vy) || vy < 1900 || vy > 2200) next.vintage = 'Vintage must be a whole year between 1900 and 2200.';
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (saving) return;
    if (!validate()) return;

    const payload = {
      bottleVolumeMl: Number(values.bottleVolumeMl),
      bottleCount: Number(values.bottleCount),
      bottledLitres: Number(values.bottledLitres),
      packagingFormat: values.packagingFormat.trim(),
      productName: values.productName.trim() === '' ? null : values.productName.trim(),
      vintage: values.vintage === '' || values.vintage === null ? null : Number(values.vintage),
      notes: values.notes.trim() === '' ? null : values.notes.trim(),
      // bottlingRunId / org_id / owner_id are set by the parent + service.
    };
    onSubmit(payload);
  };

  const title = isEdit ? 'Edit Bottling Output' : 'Add Bottling Output';
  const submitLabel = isEdit ? 'Save Changes' : 'Add Output';

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
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField
              label="Bottle Volume" type="number" value={values.bottleVolumeMl}
              onChange={setField('bottleVolumeMl')} error={Boolean(errors.bottleVolumeMl)}
              helperText={errors.bottleVolumeMl || 'Required — e.g. 750'}
              fullWidth required autoFocus disabled={saving}
              inputProps={{ step: 'any', min: 0 }}
              InputProps={{ endAdornment: <InputAdornment position="end">ml</InputAdornment> }}
            />
            <TextField
              label="Bottle Count" type="number" value={values.bottleCount}
              onChange={setField('bottleCount')} error={Boolean(errors.bottleCount)}
              helperText={errors.bottleCount || 'Required — whole number'}
              fullWidth required disabled={saving}
              inputProps={{ step: 1, min: 0 }}
            />
          </Stack>

          <TextField
            label="Bottled Litres" type="number" value={values.bottledLitres}
            onChange={setField('bottledLitres')} error={Boolean(errors.bottledLitres)}
            helperText={errors.bottledLitres || 'Required — the declared bottled volume for this line'}
            fullWidth required disabled={saving}
            inputProps={{ step: 'any', min: 0 }}
            InputProps={{ endAdornment: <InputAdornment position="end">L</InputAdornment> }}
          />

          {/* Informational calculation (never auto-applied). */}
          {calculatedLitres !== null && (
            <Alert
              severity={litresMismatch ? 'warning' : 'info'}
              action={
                litresMismatch
                  ? <Button color="inherit" size="small" onClick={useCalculatedValue} disabled={saving}>Use calculated</Button>
                  : null
              }
              sx={{ mb: 0 }}
            >
              Bottle volume × count = <strong>{formatNumber(calculatedLitres)} L</strong>
              {litresMismatch
                ? ` — this differs from the declared ${formatNumber(declaredLitres)} L. The declared value will be saved as entered.`
                : isNonNegativeNumber(values.bottledLitres)
                  ? ' — matches the declared bottled litres.'
                  : ''}
            </Alert>
          )}

          <TextField
            label="Packaging Format" value={values.packagingFormat}
            onChange={setField('packagingFormat')} error={Boolean(errors.packagingFormat)}
            helperText={errors.packagingFormat || 'Required — e.g. Bottle, Magnum, Bag-in-Box'}
            fullWidth required disabled={saving}
            placeholder="e.g. Bottle"
          />

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField
              label="Product Name" value={values.productName}
              onChange={setField('productName')} helperText="Optional"
              fullWidth disabled={saving}
            />
            <TextField
              label="Vintage" type="number" value={values.vintage}
              onChange={setField('vintage')} error={Boolean(errors.vintage)}
              helperText={errors.vintage || 'Optional — e.g. 2026'}
              fullWidth disabled={saving}
              inputProps={{ step: 1, min: 1900, max: 2200 }}
            />
          </Stack>

          <TextField
            label="Notes" value={values.notes} onChange={setField('notes')}
            helperText="Optional" fullWidth multiline minRows={2} disabled={saving}
          />

          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            Bottling outputs are declared records for this run. They do not create products, SKUs or stock.
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

export default BottlingOutputForm;
