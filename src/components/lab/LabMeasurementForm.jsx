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
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Add Lab Measurement dialog form (append-only; create only)
//
// Controlled locally; validates the required fields before calling onSubmit
// with normalised values. The parent (LabMeasurementsSection) performs the
// Supabase write via labMeasurementService.createLabMeasurement, supplies the
// ACTIVE analyte options (loaded from labAnalyteService) and controls `saving`
// and `open`. The sample id is owned by the sample profile context, NOT this
// form — it is added by the parent on submit.
//
// Unit is a SNAPSHOT: it is auto-populated (read-only) from the selected
// analyte's current canonical unit and submitted as-is. A measurement stores
// EITHER a numeric value OR a text value (never both, never neither) — enforced
// by the value-type toggle and validation here (and again in the service/DB).
// There is no edit path — measurements are append-only.
// ─────────────────────────────────────────────────────────────────────────────

function isoToLocalInput(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localInputToIso(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function emptyValues() {
  return {
    labAnalyteId: '',
    valueType: 'numeric', // 'numeric' | 'text'
    valueNumeric: '',
    valueText: '',
    measuredAt: isoToLocalInput(null), // defaults to current date/time
    notes: '',
  };
}

function LabMeasurementForm({ open, analyteOptions = [], saving = false, onSubmit, onClose }) {
  const [values, setValues] = useState(emptyValues());
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (!open) return;
    setValues(emptyValues());
    setErrors({});
  }, [open]);

  const selectedAnalyte = analyteOptions.find((a) => a.id === values.labAnalyteId) || null;
  // Unit snapshot comes from the selected analyte's canonical unit (read-only).
  const unit = selectedAnalyte ? selectedAnalyte.canonicalUnit || '' : '';

  const setField = (field) => (e) => {
    setValues((prev) => ({ ...prev, [field]: e.target.value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const setValueType = (_e, next) => {
    if (!next) return; // ignore de-selection; one mode is always active
    setValues((prev) => ({ ...prev, valueType: next }));
    setErrors((prev) => ({ ...prev, valueNumeric: undefined, valueText: undefined }));
  };

  const validate = () => {
    const next = {};
    if (!values.labAnalyteId) next.labAnalyteId = 'An analyte is required.';
    // Unit must exist (snapshot). Active analytes always have a canonical unit.
    if (values.labAnalyteId && !unit.trim()) next.labAnalyteId = 'The selected analyte has no unit.';

    if (values.valueType === 'numeric') {
      const raw = String(values.valueNumeric).trim();
      if (raw === '') {
        next.valueNumeric = 'A value is required.';
      } else if (!Number.isFinite(Number(raw))) {
        next.valueNumeric = 'Enter a valid number.';
      }
    } else {
      if (!values.valueText.trim()) next.valueText = 'A value is required.';
    }

    if (!values.measuredAt || !localInputToIso(values.measuredAt)) {
      next.measuredAt = 'A valid measured-at date/time is required.';
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (saving) return;
    if (!validate()) return;

    const isNumeric = values.valueType === 'numeric';
    onSubmit({
      labAnalyteId: values.labAnalyteId,
      unit, // snapshot from the selected analyte
      measuredAt: localInputToIso(values.measuredAt),
      // Exactly one of the two is populated; the other stays null.
      valueNumeric: isNumeric ? Number(String(values.valueNumeric).trim()) : null,
      valueText: isNumeric ? null : values.valueText.trim(),
      notes: values.notes.trim() === '' ? null : values.notes.trim(),
    });
  };

  const isNumeric = values.valueType === 'numeric';

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
      <DialogTitle>Add Measurement</DialogTitle>

      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          <TextField
            label="Analyte"
            value={values.labAnalyteId}
            onChange={setField('labAnalyteId')}
            error={Boolean(errors.labAnalyteId)}
            helperText={errors.labAnalyteId || 'Select the laboratory analyte being measured'}
            fullWidth
            select
            required
            autoFocus
            disabled={saving}
          >
            {analyteOptions.length === 0 ? (
              <MenuItem value="" disabled>
                <em>No active analytes available</em>
              </MenuItem>
            ) : (
              analyteOptions.map((a) => (
                <MenuItem key={a.id} value={a.id}>
                  {a.code}{a.displayName && a.displayName !== a.code ? ` — ${a.displayName}` : ''}
                </MenuItem>
              ))
            )}
          </TextField>

          <Box_ValueType value={values.valueType} onChange={setValueType} disabled={saving} />

          {isNumeric ? (
            <TextField
              label="Value"
              type="number"
              value={values.valueNumeric}
              onChange={setField('valueNumeric')}
              error={Boolean(errors.valueNumeric)}
              helperText={errors.valueNumeric || 'Numeric reading'}
              fullWidth
              required
              disabled={saving}
              inputProps={{ step: 'any' }}
              placeholder="e.g. 3.42"
            />
          ) : (
            <TextField
              label="Value"
              value={values.valueText}
              onChange={setField('valueText')}
              error={Boolean(errors.valueText)}
              helperText={errors.valueText || 'Text reading'}
              fullWidth
              required
              disabled={saving}
              placeholder="e.g. clear, no haze"
            />
          )}

          <TextField
            label="Unit"
            value={unit || ''}
            fullWidth
            disabled
            helperText="Taken from the analyte’s canonical unit and stored with this measurement"
            placeholder="Select an analyte"
          />

          <TextField
            label="Measured At"
            type="datetime-local"
            value={values.measuredAt}
            onChange={setField('measuredAt')}
            error={Boolean(errors.measuredAt)}
            helperText={errors.measuredAt || 'When the laboratory reading was taken'}
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
        </Stack>
      </DialogContent>

      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        <Button onClick={onClose} color="inherit" disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" variant="contained" color="primary" disabled={saving}>
          {saving ? <CircularProgress size={20} color="inherit" /> : 'Save Measurement'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// Small labelled value-type toggle (Numeric / Text).
function Box_ValueType({ value, onChange, disabled }) {
  return (
    <Stack spacing={0.75}>
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>Value type</Typography>
      <ToggleButtonGroup
        value={value}
        exclusive
        onChange={onChange}
        size="small"
        color="primary"
        disabled={disabled}
      >
        <ToggleButton value="numeric">Numeric</ToggleButton>
        <ToggleButton value="text">Text</ToggleButton>
      </ToggleButtonGroup>
    </Stack>
  );
}

export default LabMeasurementForm;
