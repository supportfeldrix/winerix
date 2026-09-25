import { useEffect, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, TextField, MenuItem,
  Button, Stack, CircularProgress, InputAdornment,
} from '@mui/material';
import { VESSEL_TYPES, VESSEL_STATUSES } from '../../services/vesselService';

const EMPTY = {
  vesselCode: '', name: '', vesselType: 'tank', capacityLitres: '',
  location: '', status: 'active', notes: '',
};

/**
 * Add / Edit vessel dialog form.
 *
 * Controlled locally; validates required code / type / status and optional
 * non-negative capacity before calling onSubmit with normalised values. The
 * parent performs the Supabase write and controls `saving` and `open`. Mirrors
 * WineBatchForm / WineLotForm conventions.
 *
 * @param {boolean} open
 * @param {object|null} vessel - When provided, the form is in edit mode.
 * @param {boolean} saving
 * @param {function} onSubmit - (values) => void
 * @param {function} onClose
 */
function VesselForm({ open, vessel, saving = false, onSubmit, onClose }) {
  const isEdit = Boolean(vessel);
  const [values, setValues] = useState(EMPTY);
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (!open) return;
    if (vessel) {
      setValues({
        vesselCode: vessel.vesselCode || '',
        name: vessel.name || '',
        vesselType: vessel.vesselType || 'tank',
        capacityLitres: vessel.capacityLitres != null ? String(vessel.capacityLitres) : '',
        location: vessel.location || '',
        status: vessel.status || 'active',
        notes: vessel.notes || '',
      });
    } else {
      setValues(EMPTY);
    }
    setErrors({});
  }, [open, vessel]);

  const setField = (field) => (e) => {
    setValues((prev) => ({ ...prev, [field]: e.target.value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const validate = () => {
    const next = {};

    if (!values.vesselCode.trim()) {
      next.vesselCode = 'Vessel code is required.';
    } else if (values.vesselCode.trim().length > 60) {
      next.vesselCode = 'Vessel code must be 60 characters or fewer.';
    }

    if (values.name && values.name.trim().length > 120) {
      next.name = 'Name must be 120 characters or fewer.';
    }

    if (!values.vesselType) next.vesselType = 'Please select a type.';

    if (values.capacityLitres !== '') {
      const c = Number(values.capacityLitres);
      if (Number.isNaN(c)) next.capacityLitres = 'Capacity must be a number.';
      else if (c < 0) next.capacityLitres = 'Capacity cannot be negative.';
      else if (c > 100000000) next.capacityLitres = 'Please enter a realistic capacity.';
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
      vesselCode: values.vesselCode.trim(),
      name: values.name.trim() || null,
      vesselType: values.vesselType,
      capacityLitres: values.capacityLitres === '' ? null : Number(values.capacityLitres),
      location: values.location.trim() || null,
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
      <DialogTitle>{isEdit ? 'Edit Vessel' : 'Add Vessel'}</DialogTitle>

      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          <TextField
            label="Vessel Code"
            value={values.vesselCode}
            onChange={setField('vesselCode')}
            error={Boolean(errors.vesselCode)}
            helperText={errors.vesselCode || 'Required — unique within your organisation'}
            fullWidth
            autoFocus
            required
            disabled={saving}
            placeholder="e.g. TK-01"
          />

          <TextField
            label="Name"
            value={values.name}
            onChange={setField('name')}
            error={Boolean(errors.name)}
            helperText={errors.name || 'Optional'}
            fullWidth
            disabled={saving}
            placeholder="e.g. Stainless Tank 1"
          />

          <TextField
            label="Type"
            value={values.vesselType}
            onChange={setField('vesselType')}
            error={Boolean(errors.vesselType)}
            helperText={errors.vesselType || ' '}
            fullWidth
            select
            required
            disabled={saving}
          >
            {VESSEL_TYPES.map((t) => (
              <MenuItem key={t.value} value={t.value}>{t.label}</MenuItem>
            ))}
          </TextField>

          <TextField
            label="Capacity"
            type="number"
            value={values.capacityLitres}
            onChange={setField('capacityLitres')}
            error={Boolean(errors.capacityLitres)}
            helperText={errors.capacityLitres || 'Optional'}
            fullWidth
            disabled={saving}
            inputProps={{ min: 0, step: 'any' }}
            InputProps={{ endAdornment: <InputAdornment position="end">L</InputAdornment> }}
          />

          <TextField
            label="Location"
            value={values.location}
            onChange={setField('location')}
            fullWidth
            disabled={saving}
            helperText="Optional — e.g. Cellar A"
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
            {VESSEL_STATUSES.map((s) => (
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
          {saving ? <CircularProgress size={20} color="inherit" /> : isEdit ? 'Save Changes' : 'Add Vessel'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default VesselForm;
