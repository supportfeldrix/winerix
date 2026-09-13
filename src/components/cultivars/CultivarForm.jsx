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
  FormControlLabel,
  Switch,
  CircularProgress,
} from '@mui/material';
import { CULTIVAR_COLOURS } from '../../services/cultivarService';

const EMPTY = { name: '', colour: '', isActive: true };

/**
 * Add / Edit cultivar dialog form.
 *
 * Controlled locally; validates the required name before calling onSubmit with
 * normalised values ({ name, colour, isActive }). The parent performs the
 * Supabase write and controls `saving` and `open`. Mirrors VineyardForm /
 * BlockForm conventions. P1B fields only — no synonyms/WO/clone/etc.
 *
 * @param {boolean} open
 * @param {object|null} cultivar - When provided, the form is in edit mode.
 * @param {boolean} saving
 * @param {function} onSubmit - (values) => void
 * @param {function} onClose
 */
function CultivarForm({ open, cultivar, saving = false, onSubmit, onClose }) {
  const isEdit = Boolean(cultivar);
  const [values, setValues] = useState(EMPTY);
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (!open) return;
    if (cultivar) {
      setValues({
        name: cultivar.name || '',
        colour: cultivar.colour || '',
        isActive: cultivar.isActive ?? true,
      });
    } else {
      setValues(EMPTY);
    }
    setErrors({});
  }, [open, cultivar]);

  const setField = (field) => (e) => {
    setValues((prev) => ({ ...prev, [field]: e.target.value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const validate = () => {
    const next = {};
    if (!values.name.trim()) {
      next.name = 'Cultivar name is required.';
    } else if (values.name.trim().length > 120) {
      next.name = 'Name must be 120 characters or fewer.';
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
      colour: values.colour === '' ? null : values.colour,
      isActive: values.isActive,
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
      <DialogTitle>{isEdit ? 'Edit Cultivar' : 'Add Cultivar'}</DialogTitle>

      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          <TextField
            label="Cultivar Name"
            value={values.name}
            onChange={setField('name')}
            error={Boolean(errors.name)}
            helperText={errors.name || 'Required'}
            fullWidth
            autoFocus
            required
            disabled={saving}
            placeholder="e.g. Cabernet Sauvignon"
          />

          <TextField
            label="Colour"
            value={values.colour}
            onChange={setField('colour')}
            helperText="Optional"
            fullWidth
            select
            disabled={saving}
          >
            <MenuItem value="">
              <em>Not specified</em>
            </MenuItem>
            {CULTIVAR_COLOURS.map((c) => (
              <MenuItem key={c.value} value={c.value}>
                {c.label}
              </MenuItem>
            ))}
          </TextField>

          {isEdit && (
            <FormControlLabel
              control={
                <Switch
                  checked={values.isActive}
                  onChange={(e) => setValues((prev) => ({ ...prev, isActive: e.target.checked }))}
                  disabled={saving}
                  color="primary"
                />
              }
              label={values.isActive ? 'Active' : 'Inactive'}
            />
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
            'Add Cultivar'
          )}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default CultivarForm;
