import { useEffect, useMemo, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, TextField, MenuItem,
  Button, Stack, CircularProgress, Alert, Typography, InputAdornment, Box,
} from '@mui/material';
import { formatNumber } from '../common/formatters';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Add / Edit Bottling Run source Wine Lot dialog (P2J-B5-2)
//
// PLANNING DATA ONLY. The parent (BottlingRunLotsSection) performs the Supabase
// write via bottlingService (addBottlingRunLot / updateBottlingRunLot) and owns
// `saving`, `open`. This form NEVER queries Supabase.
//
// Scope guards:
//   • 'add'  — Wine Lot is selectable from `lotOptions`
//              (getWineLotOptionsForBottling; already-allocated lots are
//              excluded by the parent). Available volume comes from the chosen lot.
//   • 'edit' — Wine Lot identity is LOCKED (read-only). Only volumes/notes change.
//
// Front-end validation (DB remains authoritative):
//   • consumed, bottled, loss are non-negative finite numbers
//   • consumed === bottled + loss  (reconciliation)
//   • consumed <= available lot volume
//
// NOTE on edit availability: a planned allocation does NOT reduce the Wine Lot
// volume (no deduction happens until complete_bottling_run runs). So the ceiling
// for consumed is simply the lot's CURRENT volume — we never subtract the
// existing allocation from it (that would double-count).
// ─────────────────────────────────────────────────────────────────────────────

const EPSILON = 1e-6; // tolerance for floating-point reconciliation checks

function emptyValues() {
  return { wineLotId: '', consumedVolumeLitres: '', bottledLitres: '', lossLitres: '', notes: '' };
}

function isValidNonNegative(v) {
  if (v === '' || v === null || v === undefined) return false;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0;
}

function BottlingRunLotForm({
  open, mode = 'add', allocation, lotOptions = [], saving = false, onSubmit, onClose,
}) {
  const isEdit = mode === 'edit';
  const [values, setValues] = useState(emptyValues());
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (!open) return;
    if (allocation && isEdit) {
      setValues({
        wineLotId: allocation.wineLotId || '',
        consumedVolumeLitres: allocation.consumedVolumeLitres ?? '',
        bottledLitres: allocation.bottledLitres ?? '',
        lossLitres: allocation.lossLitres ?? '',
        notes: allocation.notes || '',
      });
    } else {
      setValues(emptyValues());
    }
    setErrors({});
  }, [open, allocation, mode, isEdit]);

  const setField = (field) => (e) => {
    setValues((prev) => ({ ...prev, [field]: e.target.value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  // Resolve the available volume for the selected / locked Wine Lot. On add it
  // comes from the selected option; on edit it comes from the allocation's
  // (current) lot volume carried on the row.
  const selectedLot = useMemo(
    () => lotOptions.find((l) => l.id === values.wineLotId) || null,
    [lotOptions, values.wineLotId]
  );
  const availableVolume = isEdit
    ? (allocation ? Number(allocation.lotVolumeLitres) : null)
    : (selectedLot ? Number(selectedLot.volumeLitres) : null);
  const hasAvailable = availableVolume !== null && Number.isFinite(availableVolume);

  // Live reconciliation preview (display only).
  const consumedNum = Number(values.consumedVolumeLitres);
  const bottledNum = Number(values.bottledLitres);
  const lossNum = Number(values.lossLitres);
  const accountedNum = (Number.isFinite(bottledNum) ? bottledNum : 0) + (Number.isFinite(lossNum) ? lossNum : 0);

  const validate = () => {
    const next = {};

    if (!isEdit && !values.wineLotId) next.wineLotId = 'Select a wine lot.';

    [['consumedVolumeLitres', 'Consumed volume'], ['bottledLitres', 'Bottled volume'], ['lossLitres', 'Loss volume']]
      .forEach(([field, label]) => {
        if (!isValidNonNegative(values[field])) next[field] = `${label} must be a non-negative number.`;
      });

    // Reconciliation + availability only once the individual numbers are valid.
    if (!next.consumedVolumeLitres && !next.bottledLitres && !next.lossLitres) {
      if (Math.abs(consumedNum - accountedNum) > EPSILON) {
        next.consumedVolumeLitres = 'Consumed must equal bottled plus loss.';
      }
      if (hasAvailable && consumedNum - availableVolume > EPSILON) {
        next.consumedVolumeLitres = `Consumed volume cannot exceed the available ${formatNumber(availableVolume)} L.`;
      }
    }

    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (saving) return;
    if (!validate()) return;

    const num = (v) => Number(v);
    if (isEdit) {
      // Wine Lot identity is never sent on edit.
      onSubmit({
        consumedVolumeLitres: num(values.consumedVolumeLitres),
        bottledLitres: num(values.bottledLitres),
        lossLitres: num(values.lossLitres),
        notes: values.notes.trim() === '' ? null : values.notes.trim(),
      });
      return;
    }
    onSubmit({
      wineLotId: values.wineLotId,
      consumedVolumeLitres: num(values.consumedVolumeLitres),
      bottledLitres: num(values.bottledLitres),
      lossLitres: num(values.lossLitres),
      notes: values.notes.trim() === '' ? null : values.notes.trim(),
      // org_id / owner_id / bottlingRunId are set by the parent + service.
    });
  };

  const title = isEdit ? 'Edit Source Wine Lot' : 'Add Source Wine Lot';
  const submitLabel = isEdit ? 'Save Changes' : 'Add Source Lot';

  const lockedLotLabel = allocation
    ? `${allocation.lotCode || '—'}${allocation.batchCode ? ` — ${allocation.batchCode}` : ''}`
    : '—';

  // Reconciliation hint shown under the consumed field.
  const reconciliationOk =
    isValidNonNegative(values.consumedVolumeLitres) &&
    isValidNonNegative(values.bottledLitres) &&
    isValidNonNegative(values.lossLitres) &&
    Math.abs(consumedNum - accountedNum) <= EPSILON;

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
          <Alert severity="info" sx={{ mb: 0 }}>
            This is a planned allocation. The wine lot’s volume is <strong>not</strong> reduced
            until the bottling run is completed.
          </Alert>

          {isEdit ? (
            <TextField
              label="Wine Lot"
              value={lockedLotLabel}
              fullWidth disabled
              helperText="The wine lot cannot be changed after allocation."
            />
          ) : (
            <TextField
              label="Wine Lot"
              value={values.wineLotId}
              onChange={setField('wineLotId')}
              error={Boolean(errors.wineLotId)}
              helperText={errors.wineLotId || 'Select the source wine lot for this run'}
              fullWidth select required autoFocus disabled={saving}
            >
              {lotOptions.length === 0 ? (
                <MenuItem value="" disabled><em>No available wine lots</em></MenuItem>
              ) : (
                lotOptions.map((l) => (
                  <MenuItem key={l.id} value={l.id}>
                    {l.lotCode}
                    {l.batchCode ? ` — ${l.batchCode}` : ''}
                    {` · ${formatNumber(l.volumeLitres)} L`}
                    {l.status ? ` · ${l.status}` : ''}
                  </MenuItem>
                ))
              )}
            </TextField>
          )}

          {/* Available volume for the chosen/locked lot. */}
          <Box sx={{ px: 0.5 }}>
            <Typography variant="overline" sx={{ color: 'text.disabled', letterSpacing: '0.08em' }}>Available Volume</Typography>
            <Typography variant="h6" sx={{ color: 'text.primary' }}>
              {hasAvailable ? `${formatNumber(availableVolume)} L` : (isEdit ? '—' : 'Select a wine lot')}
            </Typography>
          </Box>

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField
              label="Consumed Volume" type="number" value={values.consumedVolumeLitres}
              onChange={setField('consumedVolumeLitres')} error={Boolean(errors.consumedVolumeLitres)}
              helperText={errors.consumedVolumeLitres || 'Required — must equal bottled + loss'}
              fullWidth required disabled={saving}
              inputProps={{ step: 'any', min: 0 }}
              InputProps={{ endAdornment: <InputAdornment position="end">L</InputAdornment> }}
            />
          </Stack>

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField
              label="Bottled Volume" type="number" value={values.bottledLitres}
              onChange={setField('bottledLitres')} error={Boolean(errors.bottledLitres)}
              helperText={errors.bottledLitres || 'Required'}
              fullWidth required disabled={saving}
              inputProps={{ step: 'any', min: 0 }}
              InputProps={{ endAdornment: <InputAdornment position="end">L</InputAdornment> }}
            />
            <TextField
              label="Loss Volume" type="number" value={values.lossLitres}
              onChange={setField('lossLitres')} error={Boolean(errors.lossLitres)}
              helperText={errors.lossLitres || 'Required'}
              fullWidth required disabled={saving}
              inputProps={{ step: 'any', min: 0 }}
              InputProps={{ endAdornment: <InputAdornment position="end">L</InputAdornment> }}
            />
          </Stack>

          {/* Live reconciliation feedback. */}
          {isValidNonNegative(values.bottledLitres) && isValidNonNegative(values.lossLitres) && (
            <Typography
              variant="caption"
              sx={{ color: reconciliationOk ? 'success.main' : 'text.secondary' }}
            >
              Bottled + Loss = {formatNumber(accountedNum)} L
              {isValidNonNegative(values.consumedVolumeLitres)
                ? reconciliationOk
                  ? ' · matches consumed'
                  : ` · must equal consumed (${formatNumber(consumedNum)} L)`
                : ''}
            </Typography>
          )}

          <TextField
            label="Notes" value={values.notes} onChange={setField('notes')}
            helperText="Optional" fullWidth multiline minRows={2} disabled={saving}
          />
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

export default BottlingRunLotForm;
