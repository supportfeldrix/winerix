import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  MenuItem,
  Button,
  Stack,
  CircularProgress,
  Typography,
} from '@mui/material';
import { LAB_SAMPLE_TYPES } from '../../services/labSampleService';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Add / Edit Lab Sample dialog form
//
// Controlled locally; validates the required fields (wine lot, sample type,
// sampled-at) before calling onSubmit with normalised values. The parent
// performs the Supabase write (via labSampleService) and controls `saving`,
// `open` and supplies `lotOptions` (loaded from wineLotService — the form never
// queries Supabase itself).
//
// Create mode: Wine Lot is a required dropdown of the active organisation's
// lots. Edit mode: the Wine Lot relationship is IMMUTABLE, so the lot is shown
// read-only and cannot be changed. The form never exposes org_id / owner_id /
// status / reviewed_by / reviewed_at / timestamps — status defaults to
// 'pending' in the service, and review/status are managed on the profile.
// ─────────────────────────────────────────────────────────────────────────────

// Convert an ISO timestamp to the value a <input type="datetime-local"> expects
// (local time, no timezone suffix, minute precision).
function isoToLocalInput(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Convert a datetime-local input value back to an ISO timestamp.
function localInputToIso(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function emptyValues() {
  return {
    wineLotId: '',
    sampleCode: '',
    sampleType: 'fermentation',
    sampledAt: isoToLocalInput(null), // defaults to current date/time
    notes: '',
  };
}

function LabSampleForm({ open, sample, lotOptions = [], saving = false, onSubmit, onClose }) {
  const isEdit = Boolean(sample);
  const [values, setValues] = useState(emptyValues());
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (!open) return;
    if (sample) {
      setValues({
        wineLotId: sample.wineLotId || '',
        sampleCode: sample.sampleCode || '',
        sampleType: sample.sampleType || 'fermentation',
        sampledAt: isoToLocalInput(sample.sampledAt),
        notes: sample.notes || '',
      });
    } else {
      setValues(emptyValues());
    }
    setErrors({});
  }, [open, sample]);

  const setField = (field) => (e) => {
    setValues((prev) => ({ ...prev, [field]: e.target.value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const validate = () => {
    const next = {};
    if (!isEdit && !values.wineLotId) next.wineLotId = 'A wine lot is required.';
    if (!values.sampleType) next.sampleType = 'A sample type is required.';
    if (!values.sampledAt) next.sampledAt = 'A sampled-at date/time is required.';
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (saving) return;
    if (!validate()) return;

    const base = {
      sampleCode: values.sampleCode.trim() === '' ? null : values.sampleCode.trim(),
      sampleType: values.sampleType,
      sampledAt: localInputToIso(values.sampledAt),
      notes: values.notes.trim() === '' ? null : values.notes.trim(),
    };
    // wine_lot_id is only set on create — it is immutable thereafter.
    onSubmit(isEdit ? base : { ...base, wineLotId: values.wineLotId });
  };

  // In edit mode, resolve the lot's label for read-only display.
  const editLot = isEdit ? lotOptions.find((o) => o.id === values.wineLotId) : null;
  const editLotLabel = editLot
    ? `${editLot.lotCode}${editLot.batchCode ? ` — ${editLot.batchCode}` : ''}`
    : (sample && sample.lotCode) || '—';

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
      <DialogTitle>{isEdit ? 'Edit Sample' : 'New Sample'}</DialogTitle>

      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          {isEdit ? (
            <TextField
              label="Wine Lot"
              value={editLotLabel}
              fullWidth
              disabled
              helperText="The wine lot cannot be changed after a sample is created."
            />
          ) : (
            <TextField
              label="Wine Lot"
              value={values.wineLotId}
              onChange={setField('wineLotId')}
              error={Boolean(errors.wineLotId)}
              helperText={errors.wineLotId || 'Select the wine lot this sample was drawn from'}
              fullWidth
              select
              required
              autoFocus
              disabled={saving}
            >
              {lotOptions.length === 0 ? (
                <MenuItem value="" disabled>
                  <em>No wine lots available</em>
                </MenuItem>
              ) : (
                lotOptions.map((o) => (
                  <MenuItem key={o.id} value={o.id}>
                    {o.lotCode}{o.batchCode ? ` — ${o.batchCode}` : ''}
                  </MenuItem>
                ))
              )}
            </TextField>
          )}

          <TextField
            label="Sample Code"
            value={values.sampleCode}
            onChange={setField('sampleCode')}
            helperText="Optional — your laboratory reference for this sample"
            fullWidth
            disabled={saving}
            placeholder="e.g. LAB-2026-001"
          />

          <TextField
            label="Sample Type"
            value={values.sampleType}
            onChange={setField('sampleType')}
            error={Boolean(errors.sampleType)}
            helperText={errors.sampleType || 'The point in the wine-making process the sample represents'}
            fullWidth
            select
            required
            disabled={saving}
          >
            {LAB_SAMPLE_TYPES.map((t) => (
              <MenuItem key={t.value} value={t.value}>{t.label}</MenuItem>
            ))}
          </TextField>

          <TextField
            label="Sampled At"
            type="datetime-local"
            value={values.sampledAt}
            onChange={setField('sampledAt')}
            error={Boolean(errors.sampledAt)}
            helperText={errors.sampledAt || 'When the sample was taken'}
            fullWidth
            required
            disabled={saving}
            InputLabelProps={{ shrink: true }}
          />

          <TextField
            label="Notes"
            value={values.notes}
            onChange={setField('notes')}
            helperText="Optional"
            fullWidth
            multiline
            minRows={2}
            disabled={saving}
          />

          {!isEdit && (
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              New samples start with a status of “Pending”. Status and review are managed from the sample’s page.
            </Typography>
          )}
        </Stack>
      </DialogContent>

      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        <Button onClick={onClose} color="inherit" disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" variant="contained" color="primary" disabled={saving}>
          {saving ? (
            <CircularProgress size={20} color="inherit" />
          ) : isEdit ? (
            'Save Changes'
          ) : (
            'Create Sample'
          )}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default LabSampleForm;
