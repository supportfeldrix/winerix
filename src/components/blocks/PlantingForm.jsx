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
  Alert,
} from '@mui/material';
import { getCultivarOptions, friendlyCultivarError } from '../../services/cultivarService';
import { PLANTING_STATUSES } from '../../services/plantingService';

const EMPTY = {
  cultivarId: '',
  areaHectares: '',
  plantingYear: '',
  rootstock: '',
  clone: '',
  notes: '',
  status: 'active',
};

/**
 * Add / Edit planting dialog form (used inside BlockProfile).
 *
 * Controlled locally; validates the required cultivar and numeric fields before
 * calling onSubmit with normalised values. The parent performs the Supabase
 * write and controls `saving` and `open`. Mirrors BlockForm conventions.
 *
 * The cultivar selector lists ACTIVE cultivars (from getCultivarOptions). In
 * edit mode, if the planting references an inactive cultivar, that option is
 * merged in so it still displays correctly.
 *
 * @param {boolean} open
 * @param {object|null} planting - When provided, the form is in edit mode.
 * @param {boolean} saving
 * @param {function} onSubmit - (values) => void
 * @param {function} onClose
 */
function PlantingForm({ open, planting, saving = false, onSubmit, onClose }) {
  const isEdit = Boolean(planting);
  const [values, setValues] = useState(EMPTY);
  const [errors, setErrors] = useState({});

  const [options, setOptions] = useState([]);
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [optionsError, setOptionsError] = useState('');

  // Populate / reset the form whenever it opens.
  useEffect(() => {
    if (!open) return;
    if (planting) {
      setValues({
        cultivarId: planting.cultivarId || '',
        areaHectares: planting.areaHectares != null ? String(planting.areaHectares) : '',
        plantingYear: planting.plantingYear != null ? String(planting.plantingYear) : '',
        rootstock: planting.rootstock || '',
        clone: planting.clone || '',
        notes: planting.notes || '',
        status: planting.status || 'active',
      });
    } else {
      setValues(EMPTY);
    }
    setErrors({});
  }, [open, planting]);

  // Load active cultivar options when the dialog opens.
  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoadingOptions(true);
    setOptionsError('');
    getCultivarOptions().then(({ data, error }) => {
      if (!active) return;
      if (error) {
        setOptionsError(friendlyCultivarError(error));
        setOptions([]);
      } else {
        let opts = data || [];
        // In edit mode, ensure the planting's cultivar is present even if it is
        // now inactive (so historical plantings display and can be saved).
        if (planting && planting.cultivarId && !opts.some((o) => o.id === planting.cultivarId)) {
          opts = [
            ...opts,
            { id: planting.cultivarId, name: planting.cultivarName || 'Unknown cultivar', colour: planting.cultivarColour || null },
          ];
        }
        setOptions(opts);
      }
      setLoadingOptions(false);
    });
    return () => { active = false; };
  }, [open, planting]);

  const setField = (field) => (e) => {
    setValues((prev) => ({ ...prev, [field]: e.target.value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const validate = () => {
    const next = {};

    if (!values.cultivarId) {
      next.cultivarId = 'Please select a cultivar.';
    }

    if (values.areaHectares !== '') {
      const area = Number(values.areaHectares);
      if (Number.isNaN(area)) next.areaHectares = 'Area must be a number.';
      else if (area < 0) next.areaHectares = 'Area cannot be negative.';
      else if (area > 1000000) next.areaHectares = 'Please enter a realistic area.';
    }

    if (values.plantingYear !== '') {
      const year = Number(values.plantingYear);
      const currentYear = new Date().getFullYear();
      if (!Number.isInteger(year)) next.plantingYear = 'Year must be a whole number.';
      else if (year < 1800 || year > currentYear + 1) next.plantingYear = 'Please enter a realistic year.';
    }

    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (saving) return;
    if (!validate()) return;

    onSubmit({
      cultivarId: values.cultivarId,
      areaHectares: values.areaHectares === '' ? null : Number(values.areaHectares),
      plantingYear: values.plantingYear === '' ? null : Number(values.plantingYear),
      rootstock: values.rootstock.trim() || null,
      clone: values.clone.trim() || null,
      notes: values.notes.trim() || null,
      status: values.status,
    });
  };

  const noCultivars = !loadingOptions && !optionsError && options.length === 0;

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
      <DialogTitle>{isEdit ? 'Edit Planting' : 'Add Planting'}</DialogTitle>

      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          {optionsError && <Alert severity="error">{optionsError}</Alert>}
          {noCultivars && (
            <Alert severity="info">
              You need at least one active cultivar before adding a planting. Add
              a cultivar on the Cultivars page first.
            </Alert>
          )}

          <TextField
            label="Cultivar"
            value={loadingOptions ? '' : values.cultivarId}
            onChange={setField('cultivarId')}
            error={Boolean(errors.cultivarId)}
            helperText={errors.cultivarId || (loadingOptions ? 'Loading cultivars…' : 'Required')}
            fullWidth
            select
            required
            disabled={saving || loadingOptions || noCultivars}
          >
            {options.map((c) => (
              <MenuItem key={c.id} value={c.id}>
                {c.name}
              </MenuItem>
            ))}
          </TextField>

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
            InputProps={{ endAdornment: <InputAdornment position="end">ha</InputAdornment> }}
          />

          <TextField
            label="Planting Year"
            value={values.plantingYear}
            onChange={setField('plantingYear')}
            error={Boolean(errors.plantingYear)}
            helperText={errors.plantingYear || 'Optional'}
            fullWidth
            disabled={saving}
            type="number"
            inputProps={{ step: 1 }}
            placeholder="e.g. 2018"
          />

          <TextField
            label="Rootstock"
            value={values.rootstock}
            onChange={setField('rootstock')}
            fullWidth
            disabled={saving}
            helperText="Optional"
          />

          <TextField
            label="Clone"
            value={values.clone}
            onChange={setField('clone')}
            fullWidth
            disabled={saving}
            helperText="Optional"
          />

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

          <TextField
            label="Status"
            value={values.status}
            onChange={setField('status')}
            fullWidth
            select
            required
            disabled={saving}
          >
            {PLANTING_STATUSES.map((s) => (
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
        <Button
          type="submit"
          variant="contained"
          color="primary"
          disabled={saving || loadingOptions || noCultivars}
        >
          {saving ? (
            <CircularProgress size={20} color="inherit" />
          ) : isEdit ? (
            'Save Changes'
          ) : (
            'Add Planting'
          )}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default PlantingForm;
