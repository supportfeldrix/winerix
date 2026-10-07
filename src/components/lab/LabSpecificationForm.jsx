import { useEffect, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, TextField, MenuItem,
  Button, Stack, CircularProgress, Typography, Alert, FormControlLabel, Switch,
} from '@mui/material';
import { LAB_SAMPLE_TYPES } from '../../services/labSpecificationService';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Add / Edit / New-Version Lab Specification dialog form
//
// Controlled locally; validates required fields and the value-rule (≥1 of
// min/max/target; min ≤ max) before calling onSubmit with normalised values.
// The parent (LabSpecifications) performs the Supabase write via
// labSpecificationService and controls `saving`, `open`, and supplies
// `analyteOptions` (loaded from labAnalyteService). The form never queries
// Supabase itself.
//
// mode:
//   'create'  — all fields; Analyte selectable; Unit auto-filled (read-only)
//               from the selected analyte's canonical unit.
//   'edit'    — Analyte + Unit read-only (immutable); name/min/max/target/
//               effectiveFrom/effectiveTo/notes/isActive editable.
//   'version' — supersede: Analyte + Unit locked from the source spec;
//               name/min/max/target/effectiveFrom/notes editable.
// The service is the authoritative validator; this is immediate UI feedback.
// ─────────────────────────────────────────────────────────────────────────────

function isoToDateInput(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dateInputToIso(value) {
  if (!value) return null;
  const d = new Date(`${value}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function emptyValues() {
  return {
    labAnalyteId: '',
    sampleType: 'fermentation',
    name: '',
    minValue: '',
    maxValue: '',
    targetValue: '',
    effectiveFrom: isoToDateInput(null),
    effectiveTo: '',
    notes: '',
    isActive: true,
  };
}

function LabSpecificationForm({
  open, mode = 'create', spec, analyteOptions = [], saving = false, onSubmit, onClose,
}) {
  const [values, setValues] = useState(emptyValues());
  const [errors, setErrors] = useState({});

  const isEdit = mode === 'edit';
  const isVersion = mode === 'version';
  const isCreate = mode === 'create';

  useEffect(() => {
    if (!open) return;
    if (spec && (isEdit || isVersion)) {
      setValues({
        labAnalyteId: spec.labAnalyteId || '',
        sampleType: spec.sampleType || 'fermentation',
        name: spec.name || '',
        minValue: spec.minValue ?? '',
        maxValue: spec.maxValue ?? '',
        targetValue: spec.targetValue ?? '',
        // A new version defaults its effective_from to today; edit keeps the stored value.
        effectiveFrom: isVersion ? isoToDateInput(null) : isoToDateInput(spec.effectiveFrom),
        effectiveTo: isEdit && spec.effectiveTo ? isoToDateInput(spec.effectiveTo) : '',
        notes: spec.notes || '',
        isActive: spec.isActive ?? true,
      });
    } else {
      setValues(emptyValues());
    }
    setErrors({});
  }, [open, spec, mode, isEdit, isVersion]);

  const setField = (field) => (e) => {
    setValues((prev) => ({ ...prev, [field]: e.target.value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  // Resolve the unit from the selected analyte (create) or the source spec
  // (edit/version). Unit is a snapshot and is never user-editable.
  const selectedAnalyte = analyteOptions.find((a) => a.id === values.labAnalyteId) || null;
  const unit = isCreate
    ? (selectedAnalyte ? selectedAnalyte.canonicalUnit || '' : '')
    : (spec ? spec.unit || '' : '');

  const validate = () => {
    const next = {};
    if (isCreate && !values.labAnalyteId) next.labAnalyteId = 'An analyte is required.';
    if (!values.sampleType) next.sampleType = 'A sample type is required.';
    if (!values.name.trim()) next.name = 'A name is required.';
    if (!values.effectiveFrom || !dateInputToIso(values.effectiveFrom)) {
      next.effectiveFrom = 'A valid effective-from date is required.';
    }
    if (isCreate && !unit.trim()) next.labAnalyteId = 'The selected analyte has no unit.';

    const hasMin = values.minValue !== '' && values.minValue !== null;
    const hasMax = values.maxValue !== '' && values.maxValue !== null;
    const hasTarget = values.targetValue !== '' && values.targetValue !== null;

    [['minValue', hasMin], ['maxValue', hasMax], ['targetValue', hasTarget]].forEach(([f, has]) => {
      if (has && !Number.isFinite(Number(values[f]))) next[f] = 'Enter a valid number.';
    });

    if (!hasMin && !hasMax && !hasTarget) {
      next.minValue = next.minValue || 'Provide at least one of minimum, maximum or target.';
    }
    if (hasMin && hasMax && !next.minValue && !next.maxValue && Number(values.minValue) > Number(values.maxValue)) {
      next.maxValue = 'Maximum must be greater than or equal to minimum.';
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (saving) return;
    if (!validate()) return;

    const num = (v) => (v === '' || v === null ? null : Number(v));

    if (isVersion) {
      // Superseding: only the changeable fields are sent; analyte/unit are
      // preserved by the service from the source spec.
      onSubmit({
        name: values.name.trim(),
        minValue: num(values.minValue),
        maxValue: num(values.maxValue),
        targetValue: num(values.targetValue),
        effectiveFrom: dateInputToIso(values.effectiveFrom),
        notes: values.notes.trim() === '' ? null : values.notes.trim(),
      });
      return;
    }

    if (isEdit) {
      onSubmit({
        name: values.name.trim(),
        minValue: num(values.minValue),
        maxValue: num(values.maxValue),
        targetValue: num(values.targetValue),
        effectiveFrom: dateInputToIso(values.effectiveFrom),
        effectiveTo: values.effectiveTo ? dateInputToIso(values.effectiveTo) : null,
        notes: values.notes.trim() === '' ? null : values.notes.trim(),
        isActive: values.isActive,
      });
      return;
    }

    // Create.
    onSubmit({
      labAnalyteId: values.labAnalyteId,
      sampleType: values.sampleType,
      name: values.name.trim(),
      unit, // snapshot from the selected analyte
      effectiveFrom: dateInputToIso(values.effectiveFrom),
      effectiveTo: values.effectiveTo ? dateInputToIso(values.effectiveTo) : null,
      minValue: num(values.minValue),
      maxValue: num(values.maxValue),
      targetValue: num(values.targetValue),
      notes: values.notes.trim() === '' ? null : values.notes.trim(),
    });
  };

  const title = isEdit ? 'Edit Specification' : isVersion ? 'Create New Version' : 'Create Specification';
  const submitLabel = isEdit ? 'Save Changes' : isVersion ? 'Create Version' : 'Create Specification';

  // Read-only analyte label for edit/version modes.
  const lockedAnalyteLabel = spec
    ? (spec.analyteDisplayName || spec.analyteCode || '—')
    : '—';

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
      <DialogTitle>{title}</DialogTitle>

      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          {isVersion && (
            <Alert severity="info" sx={{ mb: 0 }}>
              This creates a new specification version and retires the current version.
            </Alert>
          )}

          {isCreate ? (
            <TextField
              label="Analyte"
              value={values.labAnalyteId}
              onChange={setField('labAnalyteId')}
              error={Boolean(errors.labAnalyteId)}
              helperText={errors.labAnalyteId || 'Select the analyte this specification applies to'}
              fullWidth select required autoFocus disabled={saving}
            >
              {analyteOptions.length === 0 ? (
                <MenuItem value="" disabled><em>No active analytes available</em></MenuItem>
              ) : (
                analyteOptions.map((a) => (
                  <MenuItem key={a.id} value={a.id}>
                    {a.code}{a.displayName && a.displayName !== a.code ? ` — ${a.displayName}` : ''}
                  </MenuItem>
                ))
              )}
            </TextField>
          ) : (
            <TextField
              label="Analyte"
              value={lockedAnalyteLabel}
              fullWidth disabled
              helperText="The analyte cannot be changed."
            />
          )}

          <TextField
            label="Sample Type"
            value={values.sampleType}
            onChange={setField('sampleType')}
            error={Boolean(errors.sampleType)}
            helperText={errors.sampleType || 'The process stage this specification applies at'}
            fullWidth select required
            disabled={saving || isEdit || isVersion}
          >
            {LAB_SAMPLE_TYPES.map((t) => (
              <MenuItem key={t.value} value={t.value}>{t.label}</MenuItem>
            ))}
          </TextField>

          <TextField
            label="Specification Name"
            value={values.name}
            onChange={setField('name')}
            error={Boolean(errors.name)}
            helperText={errors.name || 'e.g. Fermentation pH'}
            fullWidth required disabled={saving}
            placeholder="e.g. Fermentation pH"
          />

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField
              label="Minimum Value" type="number" value={values.minValue}
              onChange={setField('minValue')} error={Boolean(errors.minValue)}
              helperText={errors.minValue || 'Optional'} fullWidth disabled={saving}
              inputProps={{ step: 'any' }}
            />
            <TextField
              label="Maximum Value" type="number" value={values.maxValue}
              onChange={setField('maxValue')} error={Boolean(errors.maxValue)}
              helperText={errors.maxValue || 'Optional'} fullWidth disabled={saving}
              inputProps={{ step: 'any' }}
            />
          </Stack>

          <TextField
            label="Target Value" type="number" value={values.targetValue}
            onChange={setField('targetValue')} error={Boolean(errors.targetValue)}
            helperText={errors.targetValue || 'Optional'} fullWidth disabled={saving}
            inputProps={{ step: 'any' }}
          />

          <TextField
            label="Unit"
            value={unit || ''}
            fullWidth disabled
            helperText="Unit is taken from the analyte's canonical unit."
            placeholder={isCreate ? 'Select an analyte' : ''}
          />

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField
              label="Effective From" type="date" value={values.effectiveFrom}
              onChange={setField('effectiveFrom')} error={Boolean(errors.effectiveFrom)}
              helperText={errors.effectiveFrom || 'When this specification takes effect'}
              fullWidth required disabled={saving} InputLabelProps={{ shrink: true }}
            />
            {isEdit && (
              <TextField
                label="Effective To" type="date" value={values.effectiveTo}
                onChange={setField('effectiveTo')}
                helperText="Optional — leave blank for open-ended"
                fullWidth disabled={saving} InputLabelProps={{ shrink: true }}
              />
            )}
          </Stack>

          <TextField
            label="Notes" value={values.notes} onChange={setField('notes')}
            helperText="Optional" fullWidth multiline minRows={2} disabled={saving}
          />

          {isEdit && (
            <FormControlLabel
              control={
                <Switch
                  checked={values.isActive}
                  onChange={(e) => setValues((prev) => ({ ...prev, isActive: e.target.checked }))}
                  disabled={saving} color="primary"
                />
              }
              label={values.isActive ? 'Active' : 'Retired'}
            />
          )}

          {isCreate && (
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              The unit is stored as a snapshot of the analyte’s canonical unit and is not converted.
            </Typography>
          )}
        </Stack>
      </DialogContent>

      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        <Button onClick={onClose} color="inherit" disabled={saving}>Cancel</Button>
        <Button type="submit" variant="contained" color="primary" disabled={saving}>
          {saving ? <CircularProgress size={20} color="inherit" /> : submitLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default LabSpecificationForm;
