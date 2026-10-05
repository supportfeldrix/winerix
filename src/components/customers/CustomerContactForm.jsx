import { useEffect, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, TextField,
  Button, Stack, CircularProgress, FormControlLabel, Switch, Typography,
} from '@mui/material';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Add / Edit Customer Contact dialog (P2L-3)
// Controlled locally. The parent performs the write via customerContactService.
// "Primary" is sent on CREATE only; on edit, primary is changed via the atomic
// "Set as primary" action (not this form) to avoid unique-index collisions.
// ─────────────────────────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function emptyValues() {
  return { firstName: '', lastName: '', jobTitle: '', email: '', phone: '', mobile: '', isPrimary: false, notes: '' };
}

function CustomerContactForm({ open, mode = 'create', contact, saving = false, onSubmit, onClose }) {
  const isEdit = mode === 'edit';
  const [values, setValues] = useState(emptyValues());
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (!open) return;
    if (contact && isEdit) {
      setValues({
        firstName: contact.firstName || '',
        lastName: contact.lastName || '',
        jobTitle: contact.jobTitle || '',
        email: contact.email || '',
        phone: contact.phone || '',
        mobile: contact.mobile || '',
        isPrimary: Boolean(contact.isPrimary),
        notes: contact.notes || '',
      });
    } else {
      setValues(emptyValues());
    }
    setErrors({});
  }, [open, contact, mode, isEdit]);

  const setField = (field) => (e) => {
    setValues((prev) => ({ ...prev, [field]: e.target.value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const validate = () => {
    const next = {};
    if (!values.firstName.trim()) next.firstName = 'First name is required.';
    if (!values.lastName.trim()) next.lastName = 'Last name is required.';
    if (values.email.trim() && !EMAIL_RE.test(values.email.trim())) next.email = 'Enter a valid email address.';
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (saving) return;
    if (!validate()) return;
    const t = (v) => (v.trim() === '' ? null : v.trim());
    const payload = {
      firstName: values.firstName.trim(),
      lastName: values.lastName.trim(),
      jobTitle: t(values.jobTitle),
      email: t(values.email),
      phone: t(values.phone),
      mobile: t(values.mobile),
      notes: t(values.notes),
    };
    // Primary only honoured on create (edit uses the dedicated set-primary action).
    if (!isEdit) payload.isPrimary = values.isPrimary;
    onSubmit(payload);
  };

  const title = isEdit ? 'Edit Contact' : 'Add Contact';

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} fullWidth maxWidth="sm" component="form" onSubmit={handleSubmit} noValidate>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField label="First Name" value={values.firstName} onChange={setField('firstName')}
              error={Boolean(errors.firstName)} helperText={errors.firstName || ' '} fullWidth required autoFocus disabled={saving} />
            <TextField label="Last Name" value={values.lastName} onChange={setField('lastName')}
              error={Boolean(errors.lastName)} helperText={errors.lastName || ' '} fullWidth required disabled={saving} />
          </Stack>
          <TextField label="Job Title" value={values.jobTitle} onChange={setField('jobTitle')} helperText="Optional" fullWidth disabled={saving} />
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField label="Email" type="email" value={values.email} onChange={setField('email')}
              error={Boolean(errors.email)} helperText={errors.email || 'Optional'} fullWidth disabled={saving} />
            <TextField label="Phone" value={values.phone} onChange={setField('phone')} helperText="Optional" fullWidth disabled={saving} />
          </Stack>
          <TextField label="Mobile" value={values.mobile} onChange={setField('mobile')} helperText="Optional" fullWidth disabled={saving} />
          <TextField label="Notes" value={values.notes} onChange={setField('notes')} helperText="Optional" fullWidth multiline minRows={2} disabled={saving} />
          {!isEdit && (
            <FormControlLabel
              control={<Switch checked={values.isPrimary} onChange={(e) => setValues((p) => ({ ...p, isPrimary: e.target.checked }))} disabled={saving} color="primary" />}
              label="Primary contact"
            />
          )}
          {isEdit && (
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              Use “Set as primary” on the contact row to change the primary contact.
            </Typography>
          )}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        <Button onClick={onClose} color="inherit" disabled={saving}>Cancel</Button>
        <Button type="submit" variant="contained" color="primary" disabled={saving}>
          {saving ? <CircularProgress size={20} color="inherit" /> : (isEdit ? 'Save Changes' : 'Add Contact')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default CustomerContactForm;
