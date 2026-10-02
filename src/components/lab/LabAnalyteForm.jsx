import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Button,
  Stack,
  CircularProgress,
} from '@mui/material';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Add / Edit Lab Analyte dialog form
//
// Controlled locally; validates the required fields (code, display name,
// canonical unit — all trimmed, non-blank) before calling onSubmit with
// normalised values ({ code, displayName, canonicalUnit, notes }). The parent
// performs the Supabase write (via labAnalyteService) and controls `saving` and
// `open`. Mirrors CultivarForm conventions.
//
// Deliberately does NOT expose org_id / owner_id / is_active / created_at /
// updated_at. New analytes are created active; activation state is managed via
// the dedicated Deactivate/Reactivate actions, not this form.
// ─────────────────────────────────────────────────────────────────────────────

const EMPTY = { code: '', displayName: '', canonicalUnit: '', notes: '' };

function LabAnalyteForm({ open, analyte, saving = false, onSubmit, onClose }) {
  const isEdit = Boolean(analyte);
  const [values, setValues] = useState(EMPTY);
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (!open) return;
    if (analyte) {
      setValues({
        code: analyte.code || '',
        displayName: analyte.displayName || '',
        canonicalUnit: analyte.canonicalUnit || '',
        notes: analyte.notes || '',
      });
    } else {
      setValues(EMPTY);
    }
    setErrors({});
  }, [open, analyte]);

  const setField = (field) => (e) => {
    setValues((prev) => ({ ...prev, [field]: e.target.value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const validate = () => {
    const next = {};
    if (!values.code.trim()) {
      next.code = 'Code is required.';
    } else if (values.code.trim().length > 128) {
      next.code = 'Code must be 128 characters or fewer.';
    }
    if (!values.displayName.trim()) next.displayName = 'Display name is required.';
    if (!values.canonicalUnit.trim()) next.canonicalUnit = 'Canonical unit is required.';
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (saving) return;
    if (!validate()) return;

    onSubmit({
      code: values.code.trim(),
      displayName: values.displayName.trim(),
      canonicalUnit: values.canonicalUnit.trim(),
      notes: values.notes.trim() === '' ? null : values.notes.trim(),
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
      <DialogTitle>{isEdit ? 'Edit Analyte' : 'Add Analyte'}</DialogTitle>

      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          <TextField
            label="Code"
            value={values.code}
            onChange={setField('code')}
            error={Boolean(errors.code)}
            helperText={errors.code || 'Short identifier, e.g. pH, TA, VA, FSO2'}
            fullWidth
            autoFocus
            required
            disabled={saving}
            placeholder="e.g. pH"
          />

          <TextField
            label="Display Name"
            value={values.displayName}
            onChange={setField('displayName')}
            error={Boolean(errors.displayName)}
            helperText={errors.displayName || 'Human-friendly name, e.g. Titratable Acidity'}
            fullWidth
            required
            disabled={saving}
            placeholder="e.g. Titratable Acidity"
          />

          <TextField
            label="Canonical Unit"
            value={values.canonicalUnit}
            onChange={setField('canonicalUnit')}
            error={Boolean(errors.canonicalUnit)}
            helperText={errors.canonicalUnit || 'Default unit of measure, e.g. g/L, mg/L, % v/v'}
            fullWidth
            required
            disabled={saving}
            placeholder="e.g. g/L"
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
          {saving ? (
            <CircularProgress size={20} color="inherit" />
          ) : isEdit ? (
            'Save Changes'
          ) : (
            'Add Analyte'
          )}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default LabAnalyteForm;
