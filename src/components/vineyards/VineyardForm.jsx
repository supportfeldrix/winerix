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
  InputAdornment,
  CircularProgress,
} from '@mui/material';
import { VINEYARD_STATUSES } from '../../services/vineyardService';

const EMPTY = { name: '', location: '', areaHectares: '', status: 'active' };

/**
 * Add / Edit vineyard dialog form.
 *
 * Controlled locally; validates required fields and numeric area before
 * calling onSubmit with normalised values ({ name, location, areaHectares,
 * status }). The parent performs the Supabase write and controls the `saving`
 * and `open` state. No technical errors are shown here.
 *
 * @param {boolean} open
 * @param {object|null} vineyard - When provided, the form is in edit mode.
 * @param {boolean} saving - Disables inputs and shows a spinner while saving.
 * @param {function} onSubmit - (values) => void
 * @param {function} onClose - () => void
 */
function VineyardForm({ open, vineyard, saving = false, onSubmit, onClose }) {
  const isEdit = Boolean(vineyard);
  const [values, setValues] = useState(EMPTY);
  const [errors, setErrors] = useState({});

  // Populate / reset the form whenever it opens.
  useEffect(() => {
    if (!open) return;
    if (vineyard) {
      setValues({
        name: vineyard.name || '',
        location: vineyard.location || '',
        areaHectares:
          vineyard.areaHectares != null ? String(vineyard.areaHectares) : '',
        status: vineyard.status || 'active',
      });
    } else {
      setValues(EMPTY);
    }
    setErrors({});
  }, [open, vineyard]);

  const setField = (field) => (e) => {
    setValues((prev) => ({ ...prev, [field]: e.target.value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const validate = () => {
    const next = {};

    if (!values.name.trim()) {
      next.name = 'Vineyard name is required.';
    } else if (values.name.trim().length > 120) {
      next.name = 'Name must be 120 characters or fewer.';
    }

    if (values.areaHectares !== '') {
      const area = Number(values.areaHectares);
      if (Number.isNaN(area)) {
        next.areaHectares = 'Area must be a number.';
      } else if (area < 0) {
        next.areaHectares = 'Area cannot be negative.';
      } else if (area > 1000000) {
        next.areaHectares = 'Please enter a realistic area.';
      }
    }

    if (!values.status) {
      next.status = 'Please select a status.';
    }

    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (saving) return;
    if (!validate()) return;

    onSubmit({
      name: values.name.trim(),
      location: values.location.trim(),
      areaHectares:
        values.areaHectares === '' ? null : Number(values.areaHectares),
      status: values.status,
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
      <DialogTitle>{isEdit ? 'Edit Vineyard' : 'Add Vineyard'}</DialogTitle>

      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          <TextField
            label="Vineyard Name"
            value={values.name}
            onChange={setField('name')}
            error={Boolean(errors.name)}
            helperText={errors.name || 'Required'}
            fullWidth
            autoFocus
            required
            disabled={saving}
          />

          <TextField
            label="Location"
            value={values.location}
            onChange={setField('location')}
            fullWidth
            disabled={saving}
            placeholder="e.g. Stellenbosch, Western Cape"
          />

          <TextField
            label="Area"
            value={values.areaHectares}
            onChange={setField('areaHectares')}
            error={Boolean(errors.areaHectares)}
            helperText={errors.areaHectares || 'Optional'}
            fullWidth
            disabled={saving}
            type="number"
            inputProps={{ min: 0, step: 'any' }}
            InputProps={{
              endAdornment: <InputAdornment position="end">ha</InputAdornment>,
            }}
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
            {VINEYARD_STATUSES.map((s) => (
              <MenuItem key={s.value} value={s.value}>
                {s.label}
              </MenuItem>
            ))}
          </TextField>
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
            'Add Vineyard'
          )}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default VineyardForm;
