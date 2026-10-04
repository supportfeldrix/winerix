import { useEffect, useMemo, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, TextField, MenuItem,
  Button, Stack, CircularProgress, Alert, Typography,
} from '@mui/material';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Create / Edit Bottling Run dialog form (P2J-B5-1)
//
// Controlled locally. The parent (BottlingRuns / BottlingRunProfile) performs
// the Supabase write via bottlingService (createBottlingRun / updateBottlingRun)
// and owns `saving`, `open` and supplies `labSampleOptions`. The form NEVER
// queries Supabase itself.
//
// Scope guards for B5-1:
//   • A NEW run is ALWAYS created as 'planned'. Status is shown read-only here;
//     the service also omits status on create (DB default 'planned'). The user
//     cannot create a completed/cancelled run.
//   • Status is NEVER editable through this generic form (lifecycle transitions
//     are a separate future workflow). Edit touches header fields only.
//   • Release Lab Sample is OPTIONAL and is purely a reference — there is no
//     release gate or lab logic here.
// ─────────────────────────────────────────────────────────────────────────────

const NONE = '__none__'; // sentinel for "no release lab sample"

function isoToDateInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function emptyValues() {
  return {
    bottlingCode: '',
    bottlingDate: '',
    notes: '',
    releaseLabSampleId: NONE,
  };
}

function BottlingRunForm({
  open, mode = 'create', run, labSampleOptions = [], saving = false, onSubmit, onClose,
}) {
  const isEdit = mode === 'edit';
  const [values, setValues] = useState(emptyValues());
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (!open) return;
    if (run && isEdit) {
      setValues({
        bottlingCode: run.bottlingCode || '',
        bottlingDate: isoToDateInput(run.bottlingDate),
        notes: run.notes || '',
        releaseLabSampleId: run.releaseLabSampleId || NONE,
      });
    } else {
      setValues(emptyValues());
    }
    setErrors({});
  }, [open, run, mode, isEdit]);

  const setField = (field) => (e) => {
    setValues((prev) => ({ ...prev, [field]: e.target.value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  // Ensure a currently-selected sample that is no longer in the option list
  // (e.g. a sample from another context) still renders as a stable choice.
  const sampleOptions = useMemo(() => labSampleOptions || [], [labSampleOptions]);

  const validate = () => {
    const next = {};
    if (!values.bottlingCode.trim()) next.bottlingCode = 'A bottling code is required.';
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (saving) return;
    if (!validate()) return;

    const payload = {
      bottlingCode: values.bottlingCode.trim(),
      bottlingDate: values.bottlingDate ? values.bottlingDate : null,
      notes: values.notes.trim() === '' ? null : values.notes.trim(),
      releaseLabSampleId: values.releaseLabSampleId === NONE ? null : values.releaseLabSampleId,
    };
    // status is intentionally never included — create defaults to 'planned'
    // (DB default) and edit must not change the lifecycle status.
    onSubmit(payload);
  };

  const title = isEdit ? 'Edit Bottling Run' : 'Create Bottling Run';
  const submitLabel = isEdit ? 'Save Changes' : 'Create Bottling Run';

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
          {!isEdit && (
            <Alert severity="info" sx={{ mb: 0 }}>
              New bottling runs always start as <strong>Planned</strong>. Source wine lots,
              outputs and completion are added later from the run’s profile.
            </Alert>
          )}

          <TextField
            label="Bottling Code"
            value={values.bottlingCode}
            onChange={setField('bottlingCode')}
            error={Boolean(errors.bottlingCode)}
            helperText={errors.bottlingCode || 'A unique code for this bottling run'}
            fullWidth required autoFocus disabled={saving}
            placeholder="e.g. BR-2026-001"
          />

          <TextField
            label="Bottling Date"
            type="date"
            value={values.bottlingDate}
            onChange={setField('bottlingDate')}
            helperText="Optional — when the run is scheduled or took place"
            fullWidth disabled={saving}
            InputLabelProps={{ shrink: true }}
          />

          {/* Status is read-only in this form. For create it is always Planned;
              for edit the lifecycle status is managed by a separate workflow. */}
          <TextField
            label="Status"
            value={isEdit ? 'Managed by lifecycle actions' : 'Planned'}
            fullWidth disabled
            helperText={
              isEdit
                ? 'Status changes are handled by dedicated lifecycle actions, not this form.'
                : 'New runs always start as Planned.'
            }
          />

          <TextField
            label="Release Lab Sample"
            value={values.releaseLabSampleId}
            onChange={setField('releaseLabSampleId')}
            fullWidth select disabled={saving}
            helperText="Optional — a reference lab sample. This is not a release gate."
          >
            <MenuItem value={NONE}><em>None</em></MenuItem>
            {sampleOptions.map((s) => (
              <MenuItem key={s.id} value={s.id}>
                {s.sampleCode}{s.lotCode ? ` — ${s.lotCode}` : ''}
              </MenuItem>
            ))}
          </TextField>

          <TextField
            label="Notes"
            value={values.notes}
            onChange={setField('notes')}
            helperText="Optional"
            fullWidth multiline minRows={2} disabled={saving}
          />

          {!isEdit && (
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              You can allocate source wine lots and record bottling outputs after the run is created.
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

export default BottlingRunForm;
