import { useEffect, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, TextField, MenuItem,
  Button, Stack, CircularProgress, FormControlLabel, Switch, Typography,
} from '@mui/material';
import { CUSTOMER_ADDRESS_TYPES } from '../../services/customerAddressService';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Add / Edit Customer Address dialog (P2L-3)
// Controlled locally; parent writes via customerAddressService. "Primary" on
// CREATE only; on edit, primary changes via the atomic "Set as primary" action.
// ─────────────────────────────────────────────────────────────────────────────

function emptyValues() {
  return {
    addressType: 'Billing', label: '', companyName: '',
    addressLine1: '', addressLine2: '', city: '', province: '',
    postalCode: '', country: 'South Africa', isPrimary: false, notes: '',
  };
}

function CustomerAddressForm({ open, mode = 'create', address, saving = false, onSubmit, onClose }) {
  const isEdit = mode === 'edit';
  const [values, setValues] = useState(emptyValues());
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (!open) return;
    if (address && isEdit) {
      setValues({
        addressType: address.addressType || 'Billing',
        label: address.label || '',
        companyName: address.companyName || '',
        addressLine1: address.addressLine1 || '',
        addressLine2: address.addressLine2 || '',
        city: address.city || '',
        province: address.province || '',
        postalCode: address.postalCode || '',
        country: address.country || 'South Africa',
        isPrimary: Boolean(address.isPrimary),
        notes: address.notes || '',
      });
    } else {
      setValues(emptyValues());
    }
    setErrors({});
  }, [open, address, mode, isEdit]);

  const setField = (field) => (e) => {
    setValues((prev) => ({ ...prev, [field]: e.target.value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const validate = () => {
    const next = {};
    if (!values.addressType) next.addressType = 'An address type is required.';
    if (!values.addressLine1.trim()) next.addressLine1 = 'Address line 1 is required.';
    if (!values.city.trim()) next.city = 'City is required.';
    if (!values.country.trim()) next.country = 'Country is required.';
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (saving) return;
    if (!validate()) return;
    const t = (v) => (v.trim() === '' ? null : v.trim());
    const payload = {
      addressType: values.addressType,
      label: t(values.label),
      companyName: t(values.companyName),
      addressLine1: values.addressLine1.trim(),
      addressLine2: t(values.addressLine2),
      city: values.city.trim(),
      province: t(values.province),
      postalCode: t(values.postalCode),
      country: values.country.trim(),
      notes: t(values.notes),
    };
    if (!isEdit) payload.isPrimary = values.isPrimary;
    onSubmit(payload);
  };

  const title = isEdit ? 'Edit Address' : 'Add Address';

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} fullWidth maxWidth="sm" component="form" onSubmit={handleSubmit} noValidate>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField label="Address Type" value={values.addressType} onChange={setField('addressType')} select required fullWidth disabled={saving}
              error={Boolean(errors.addressType)} helperText={errors.addressType || ' '}>
              {CUSTOMER_ADDRESS_TYPES.map((t) => <MenuItem key={t} value={t}>{t}</MenuItem>)}
            </TextField>
            <TextField label="Label" value={values.label} onChange={setField('label')} helperText="Optional — e.g. Head Office" fullWidth disabled={saving} />
          </Stack>
          <TextField label="Company Name" value={values.companyName} onChange={setField('companyName')} helperText="Optional" fullWidth disabled={saving} />
          <TextField label="Address Line 1" value={values.addressLine1} onChange={setField('addressLine1')}
            error={Boolean(errors.addressLine1)} helperText={errors.addressLine1 || 'Required'} fullWidth required autoFocus disabled={saving} />
          <TextField label="Address Line 2" value={values.addressLine2} onChange={setField('addressLine2')} helperText="Optional" fullWidth disabled={saving} />
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField label="City" value={values.city} onChange={setField('city')}
              error={Boolean(errors.city)} helperText={errors.city || 'Required'} fullWidth required disabled={saving} />
            <TextField label="Province" value={values.province} onChange={setField('province')} helperText="Optional" fullWidth disabled={saving} />
          </Stack>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField label="Postal Code" value={values.postalCode} onChange={setField('postalCode')} helperText="Optional" fullWidth disabled={saving} />
            <TextField label="Country" value={values.country} onChange={setField('country')}
              error={Boolean(errors.country)} helperText={errors.country || 'Required'} fullWidth required disabled={saving} />
          </Stack>
          <TextField label="Notes" value={values.notes} onChange={setField('notes')} helperText="Optional" fullWidth multiline minRows={2} disabled={saving} />
          {!isEdit && (
            <FormControlLabel
              control={<Switch checked={values.isPrimary} onChange={(e) => setValues((p) => ({ ...p, isPrimary: e.target.checked }))} disabled={saving} color="primary" />}
              label="Primary address"
            />
          )}
          {isEdit && (
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              Use “Set as primary” on the address row to change the primary address.
            </Typography>
          )}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        <Button onClick={onClose} color="inherit" disabled={saving}>Cancel</Button>
        <Button type="submit" variant="contained" color="primary" disabled={saving}>
          {saving ? <CircularProgress size={20} color="inherit" /> : (isEdit ? 'Save Changes' : 'Add Address')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default CustomerAddressForm;
