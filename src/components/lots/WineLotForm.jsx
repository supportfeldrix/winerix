import { useEffect, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, TextField, MenuItem,
  Button, Stack, CircularProgress, InputAdornment, Box, Typography,
} from '@mui/material';
import { WINE_LOT_STATUSES } from '../../services/wineLotService';

const EMPTY = { wineBatchId: '', lotCode: '', volumeLitres: '', status: 'active', notes: '' };

// Readable label for a batch option (code · name · vintage).
function batchLabel(b) {
  const bits = [b.batchCode];
  if (b.name) bits.push(b.name);
  if (b.vintage != null) bits.push(String(b.vintage));
  return bits.join('  ·  ');
}

/**
 * Add / Edit wine lot dialog form.
 *
 * Create mode: choose a batch (org-scoped options), enter lot code, volume,
 * status, notes.
 * Edit mode: the originating batch is fixed and shown read-only; only lot code,
 * volume, status and notes are editable.
 *
 * Calls onSubmit with normalised values. In create mode values include
 * wineBatchId; in edit mode wineBatchId is omitted (origin is preserved).
 * The parent performs the Supabase write and controls `saving` and `open`.
 * Mirrors WineBatchForm / BatchIntakeForm conventions.
 *
 * @param {boolean} open
 * @param {object|null} lot - When provided, edit mode (batch read-only).
 * @param {Array} batchOptions - selectable batches (create mode)
 * @param {boolean} optionsLoading
 * @param {boolean} saving
 * @param {function} onSubmit - (values) => void
 * @param {function} onClose
 */
function WineLotForm({
  open, lot, batchOptions = [], optionsLoading = false, saving = false, onSubmit, onClose,
}) {
  const isEdit = Boolean(lot);
  const [values, setValues] = useState(EMPTY);
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (!open) return;
    if (lot) {
      setValues({
        wineBatchId: lot.wineBatchId || '',
        lotCode: lot.lotCode || '',
        volumeLitres: lot.volumeLitres != null ? String(lot.volumeLitres) : '',
        status: lot.status || 'active',
        notes: lot.notes || '',
      });
    } else {
      setValues(EMPTY);
    }
    setErrors({});
  }, [open, lot]);

  const setField = (field) => (e) => {
    setValues((prev) => ({ ...prev, [field]: e.target.value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const validate = () => {
    const next = {};

    if (!isEdit && !values.wineBatchId) {
      next.wineBatchId = 'Please select a wine batch.';
    }

    if (!values.lotCode.trim()) {
      next.lotCode = 'Lot code is required.';
    } else if (values.lotCode.trim().length > 60) {
      next.lotCode = 'Lot code must be 60 characters or fewer.';
    }

    if (values.volumeLitres === '' || values.volumeLitres == null) {
      next.volumeLitres = 'Volume is required.';
    } else {
      const v = Number(values.volumeLitres);
      if (Number.isNaN(v)) next.volumeLitres = 'Volume must be a number.';
      else if (v < 0) next.volumeLitres = 'Volume cannot be negative.';
      else if (v > 100000000) next.volumeLitres = 'Please enter a realistic volume.';
    }

    if (!values.status) next.status = 'Please select a status.';

    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (saving) return;
    if (!validate()) return;

    const base = {
      lotCode: values.lotCode.trim(),
      volumeLitres: Number(values.volumeLitres),
      status: values.status,
      notes: values.notes.trim() || null,
    };
    // Only include the batch on create; edit preserves the origin.
    onSubmit(isEdit ? base : { ...base, wineBatchId: values.wineBatchId });
  };

  const noBatches = !isEdit && !optionsLoading && batchOptions.length === 0;

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
      <DialogTitle>{isEdit ? 'Edit Wine Lot' : 'Add Wine Lot'}</DialogTitle>

      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          {isEdit ? (
            <Box>
              <Typography variant="overline" sx={{ display: 'block', color: 'text.secondary' }}>Wine Batch</Typography>
              <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                {[lot.batchCode, lot.batchName, lot.batchVintage != null ? String(lot.batchVintage) : null]
                  .filter(Boolean).join('  ·  ') || '—'}
              </Typography>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                The originating batch cannot be changed.
              </Typography>
            </Box>
          ) : noBatches ? (
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              No wine batches are available. Create a wine batch first, then add lots to it.
            </Typography>
          ) : (
            <TextField
              label="Wine Batch"
              value={values.wineBatchId}
              onChange={setField('wineBatchId')}
              error={Boolean(errors.wineBatchId)}
              helperText={errors.wineBatchId || (optionsLoading ? 'Loading batches…' : 'Required — the lot originates from this batch')}
              fullWidth
              select
              required
              disabled={saving || optionsLoading}
            >
              {batchOptions.map((b) => (
                <MenuItem key={b.id} value={b.id}>{batchLabel(b)}</MenuItem>
              ))}
            </TextField>
          )}

          <TextField
            label="Lot Code"
            value={values.lotCode}
            onChange={setField('lotCode')}
            error={Boolean(errors.lotCode)}
            helperText={errors.lotCode || 'Required — unique within your organisation'}
            fullWidth
            required
            disabled={saving || (!isEdit && noBatches)}
            placeholder="e.g. LOT-2026-001"
          />

          <TextField
            label="Volume"
            type="number"
            value={values.volumeLitres}
            onChange={setField('volumeLitres')}
            error={Boolean(errors.volumeLitres)}
            helperText={errors.volumeLitres || 'Required — current volume of wine'}
            fullWidth
            required
            disabled={saving || (!isEdit && noBatches)}
            inputProps={{ min: 0, step: 'any' }}
            InputProps={{ endAdornment: <InputAdornment position="end">L</InputAdornment> }}
          />

          <TextField
            label="Status"
            value={values.status}
            onChange={setField('status')}
            error={Boolean(errors.status)}
            helperText={errors.status || ' '}
            fullWidth
            select
            required
            disabled={saving || (!isEdit && noBatches)}
          >
            {WINE_LOT_STATUSES.map((s) => (
              <MenuItem key={s.value} value={s.value}>{s.label}</MenuItem>
            ))}
          </TextField>

          <TextField
            label="Notes"
            value={values.notes}
            onChange={setField('notes')}
            fullWidth
            disabled={saving || (!isEdit && noBatches)}
            multiline
            minRows={2}
            helperText="Optional"
          />
        </Stack>
      </DialogContent>

      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        <Button onClick={onClose} color="inherit" disabled={saving}>Cancel</Button>
        <Button type="submit" variant="contained" color="primary" disabled={saving || (!isEdit && noBatches)}>
          {saving ? <CircularProgress size={20} color="inherit" /> : isEdit ? 'Save Changes' : 'Add Lot'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default WineLotForm;
