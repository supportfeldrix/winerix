import { useEffect, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, TextField, MenuItem,
  Button, Stack, CircularProgress,
} from '@mui/material';
import { WINE_BATCH_STATUSES } from '../../services/wineBatchService';

const EMPTY = { batchCode: '', name: '', vintage: '', status: 'planned', notes: '' };

/**
 * Add / Edit wine batch dialog form.
 *
 * Controlled locally; validates the required batch code and (optional) vintage
 * before calling onSubmit with normalised values ({ batchCode, name, vintage,
 * status, notes }). The parent performs the Supabase write and controls
 * `saving` and `open`. Mirrors CultivarForm / GrapeIntakeForm conventions.
 *
 * @param {boolean} open
 * @param {object|null} batch - When provided, the form is in edit mode.
 * @param {boolean} saving
 * @param {function} onSubmit - (values) => void
 * @param {function} onClose
 */
function WineBatchForm({ open, batch, saving = false, onSubmit, onClose }) {
  const isEdit = Boolean(batch);
  const [values, setValues] = useState(EMPTY);
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (!open) return;
    if (batch) {
      setValues({
        batchCode: batch.batchCode || '',
        name: batch.name || '',
        vintage: batch.vintage != null ? String(batch.vintage) : '',
        status: batch.status || 'planned',
        notes: batch.notes || '',
      });
    } else {
      setValues(EMPTY);
    }
    setErrors({});
  }, [open, batch]);

  const setField = (field) => (e) => {
    setValues((prev) => ({ ...prev, [field]: e.target.value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const validate = () => {
    const next = {};

    if (!values.batchCode.trim()) {
      next.batchCode = 'Batch code is required.';
    } else if (values.batchCode.trim().length > 60) {
      next.batchCode = 'Batch code must be 60 characters or fewer.';
    }

    if (values.name && values.name.trim().length > 120) {
      next.name = 'Name must be 120 characters or fewer.';
    }

    if (values.vintage !== '') {
      const v = Number(values.vintage);
      if (!Number.isInteger(v)) next.vintage = 'Vintage must be a whole year.';
      else if (v < 1900 || v > 2200) next.vintage = 'Enter a realistic vintage year.';
    }

    if (!values.status) next.status = 'Please select a status.';

    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (saving) return;
    if (!validate()) return;

    onSubmit({
      batchCode: values.batchCode.trim(),
      name: values.name.trim() || null,
      vintage: values.vintage === '' ? null : Number(values.vintage),
      status: values.status,
      notes: values.notes.trim() || null,
    });
  };

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
      <DialogTitle>{isEdit ? 'Edit Wine Batch' : 'Add Wine Batch'}</DialogTitle>

      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          <TextField
            label="Batch Code"
            value={values.batchCode}
            onChange={setField('batchCode')}
            error={Boolean(errors.batchCode)}
            helperText={errors.batchCode || 'Required — unique within your organisation'}
            fullWidth
            autoFocus
            required
            disabled={saving}
            placeholder="e.g. SB-2026-01"
          />

          <TextField
            label="Name"
            value={values.name}
            onChange={setField('name')}
            error={Boolean(errors.name)}
            helperText={errors.name || 'Optional'}
            fullWidth
            disabled={saving}
            placeholder="e.g. Estate Sauvignon Blanc"
          />

          <TextField
            label="Vintage"
            type="number"
            value={values.vintage}
            onChange={setField('vintage')}
            error={Boolean(errors.vintage)}
            helperText={errors.vintage || 'Optional — production/harvest year'}
            fullWidth
            disabled={saving}
            inputProps={{ min: 1900, max: 2200, step: 1 }}
            placeholder="e.g. 2026"
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
            disabled={saving}
          >
            {WINE_BATCH_STATUSES.map((s) => (
              <MenuItem key={s.value} value={s.value}>{s.label}</MenuItem>
            ))}
          </TextField>

          <TextField
            label="Notes"
            value={values.notes}
            onChange={setField('notes')}
            fullWidth
            disabled={saving}
            multiline
            minRows={2}
            helperText="Optional"
          />
        </Stack>
      </DialogContent>

      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        <Button onClick={onClose} color="inherit" disabled={saving}>Cancel</Button>
        <Button type="submit" variant="contained" color="primary" disabled={saving}>
          {saving ? <CircularProgress size={20} color="inherit" /> : isEdit ? 'Save Changes' : 'Add Batch'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default WineBatchForm;
