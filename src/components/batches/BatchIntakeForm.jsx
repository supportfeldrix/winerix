import { useEffect, useMemo, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, TextField, MenuItem,
  Button, Stack, CircularProgress, InputAdornment, Typography, Box,
} from '@mui/material';
import { formatDate, formatNumber } from '../common/formatters';

const EMPTY = { grapeIntakeId: '', contributedKg: '' };

// Build a readable label for an intake option (date · received · cultivar/harvest).
function intakeLabel(o) {
  const bits = [];
  bits.push(formatDate(o.intakeDate));
  if (o.receivedKg != null) bits.push(`${formatNumber(o.receivedKg)} kg`);
  const context = o.cultivarName || o.harvestTitle || o.blockName || o.vineyardName;
  if (context) bits.push(context);
  return bits.join('  ·  ');
}

/**
 * Add-existing-intake / Edit-contribution dialog for a wine batch.
 *
 * Add mode: choose one of the organisation's grape intakes (already-linked ones
 * are excluded by the parent) and enter contributed kg.
 * Edit mode: the intake is fixed; only contributed kg is editable.
 *
 * Does NOT create grape intakes — those remain owned by the Harvest → Grape
 * Intake workflow. Calls onSubmit with { grapeIntakeId, contributedKg }.
 *
 * @param {boolean} open
 * @param {object|null} link - When provided, edit mode (fixed intake).
 * @param {Array} options - selectable intake options (already-linked removed)
 * @param {boolean} optionsLoading
 * @param {boolean} saving
 * @param {function} onSubmit - (values) => void
 * @param {function} onClose
 */
function BatchIntakeForm({
  open, link, options = [], optionsLoading = false, saving = false, onSubmit, onClose,
}) {
  const isEdit = Boolean(link);
  const [values, setValues] = useState(EMPTY);
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (!open) return;
    if (link) {
      setValues({
        grapeIntakeId: link.grapeIntakeId || '',
        contributedKg: link.contributedKg != null ? String(link.contributedKg) : '',
      });
    } else {
      setValues(EMPTY);
    }
    setErrors({});
  }, [open, link]);

  const setField = (field) => (e) => {
    setValues((prev) => ({ ...prev, [field]: e.target.value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  // In edit mode the linked intake is fixed; show a static summary line.
  const editingIntakeSummary = useMemo(() => {
    if (!link) return '';
    const bits = [formatDate(link.intakeDate)];
    if (link.intakeReceivedKg != null) bits.push(`${formatNumber(link.intakeReceivedKg)} kg received`);
    const context = link.cultivarName || link.harvestTitle;
    if (context) bits.push(context);
    return bits.join('  ·  ');
  }, [link]);

  const validate = () => {
    const next = {};

    if (!isEdit && !values.grapeIntakeId) {
      next.grapeIntakeId = 'Please select a grape intake.';
    }

    if (values.contributedKg === '' || values.contributedKg == null) {
      next.contributedKg = 'Contributed weight is required.';
    } else {
      const kg = Number(values.contributedKg);
      if (Number.isNaN(kg)) next.contributedKg = 'Weight must be a number.';
      else if (kg < 0) next.contributedKg = 'Weight cannot be negative.';
      else if (kg > 100000000) next.contributedKg = 'Please enter a realistic weight.';
    }

    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (saving) return;
    if (!validate()) return;

    onSubmit({
      grapeIntakeId: isEdit ? link.grapeIntakeId : values.grapeIntakeId,
      contributedKg: Number(values.contributedKg),
    });
  };

  const noOptions = !isEdit && !optionsLoading && options.length === 0;

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
      <DialogTitle>{isEdit ? 'Edit Contribution' : 'Add Grape Intake'}</DialogTitle>

      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          {isEdit ? (
            <Box>
              <Typography variant="overline" sx={{ display: 'block', color: 'text.secondary' }}>Grape Intake</Typography>
              <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>{editingIntakeSummary || '—'}</Typography>
            </Box>
          ) : noOptions ? (
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              No grape intakes are available to link. Record grape intakes from a harvest first,
              or all existing intakes are already linked to this batch.
            </Typography>
          ) : (
            <TextField
              label="Grape Intake"
              value={values.grapeIntakeId}
              onChange={setField('grapeIntakeId')}
              error={Boolean(errors.grapeIntakeId)}
              helperText={errors.grapeIntakeId || (optionsLoading ? 'Loading intakes…' : 'Select an intake from your organisation')}
              fullWidth
              select
              required
              disabled={saving || optionsLoading}
            >
              {options.map((o) => (
                <MenuItem key={o.id} value={o.id}>{intakeLabel(o)}</MenuItem>
              ))}
            </TextField>
          )}

          <TextField
            label="Contributed Weight"
            type="number"
            value={values.contributedKg}
            onChange={setField('contributedKg')}
            error={Boolean(errors.contributedKg)}
            helperText={errors.contributedKg || 'Required — grapes from this intake used in the batch'}
            fullWidth
            required
            disabled={saving || (!isEdit && noOptions)}
            inputProps={{ min: 0, step: 'any' }}
            InputProps={{ endAdornment: <InputAdornment position="end">kg</InputAdornment> }}
          />
        </Stack>
      </DialogContent>

      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        <Button onClick={onClose} color="inherit" disabled={saving}>Cancel</Button>
        <Button type="submit" variant="contained" color="primary" disabled={saving || (!isEdit && noOptions)}>
          {saving ? <CircularProgress size={20} color="inherit" /> : isEdit ? 'Save Changes' : 'Add Intake'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default BatchIntakeForm;
