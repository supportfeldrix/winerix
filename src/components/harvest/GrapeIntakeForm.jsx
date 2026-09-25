import { useEffect, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, TextField, MenuItem,
  Button, Stack, CircularProgress, InputAdornment,
} from '@mui/material';
import { INTAKE_STATUSES } from '../../services/intakeService';

const EMPTY = { intakeDate: '', receivedKg: '', status: 'received', notes: '' };

/**
 * Add / Edit grape intake dialog form. Opened from HarvestProfile — the parent
 * harvest is already known, so the form never asks for vineyard/harvest/org.
 *
 * Calls onSubmit with normalised values ({ intakeDate, receivedKg, status,
 * notes }). The parent performs the Supabase write and controls `saving` and
 * `open`. Mirrors HarvestForm / BlockForm conventions.
 *
 * @param {boolean} open
 * @param {object|null} intake - When provided, the form is in edit mode.
 * @param {boolean} saving
 * @param {function} onSubmit - (values) => void
 * @param {function} onClose
 */
function GrapeIntakeForm({ open, intake, saving = false, onSubmit, onClose }) {
  const isEdit = Boolean(intake);
  const [values, setValues] = useState(EMPTY);
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (!open) return;
    if (intake) {
      setValues({
        intakeDate: intake.intakeDate || '',
        receivedKg: intake.receivedKg != null ? String(intake.receivedKg) : '',
        status: intake.status || 'received',
        notes: intake.notes || '',
      });
    } else {
      setValues(EMPTY);
    }
    setErrors({});
  }, [open, intake]);

  const setField = (field) => (e) => {
    setValues((prev) => ({ ...prev, [field]: e.target.value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const validate = () => {
    const next = {};

    if (values.receivedKg !== '') {
      const kg = Number(values.receivedKg);
      if (Number.isNaN(kg)) next.receivedKg = 'Weight must be a number.';
      else if (kg < 0) next.receivedKg = 'Weight cannot be negative.';
      else if (kg > 100000000) next.receivedKg = 'Please enter a realistic weight.';
    }

    if (values.intakeDate !== '') {
      const d = new Date(values.intakeDate);
      if (Number.isNaN(d.getTime())) next.intakeDate = 'Please enter a valid date.';
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
      intakeDate: values.intakeDate || null,
      receivedKg: values.receivedKg === '' ? null : Number(values.receivedKg),
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
      <DialogTitle>{isEdit ? 'Edit Grape Intake' : 'Add Grape Intake'}</DialogTitle>

      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          <TextField
            label="Intake Date"
            type="date"
            value={values.intakeDate}
            onChange={setField('intakeDate')}
            error={Boolean(errors.intakeDate)}
            helperText={errors.intakeDate || 'Optional'}
            fullWidth
            disabled={saving}
            InputLabelProps={{ shrink: true }}
          />

          <TextField
            label="Received Weight"
            type="number"
            value={values.receivedKg}
            onChange={setField('receivedKg')}
            error={Boolean(errors.receivedKg)}
            helperText={errors.receivedKg || 'Optional'}
            fullWidth
            disabled={saving}
            inputProps={{ min: 0, step: 'any' }}
            InputProps={{ endAdornment: <InputAdornment position="end">kg</InputAdornment> }}
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
            {INTAKE_STATUSES.map((s) => (
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
          {saving ? <CircularProgress size={20} color="inherit" /> : isEdit ? 'Save Changes' : 'Add Intake'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default GrapeIntakeForm;
