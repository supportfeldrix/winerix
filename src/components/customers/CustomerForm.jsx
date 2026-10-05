import { useEffect, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, TextField, MenuItem,
  Button, Stack, CircularProgress, Typography,
} from '@mui/material';
import { CUSTOMER_TYPES } from '../../services/customerService';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Add / Edit Customer dialog (P2L-2)
//
// Controlled locally. The parent (Customers) performs the Supabase write via
// customerService (createCustomer / updateCustomer) and owns `saving`, `open`.
// This form NEVER queries Supabase.
//
// Commercial customer-master identity ONLY — no contacts, addresses, orders,
// pricing or stock. Required: Legal Name, Customer Type. Everything else optional.
// ─────────────────────────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function emptyValues() {
  return {
    legalName: '',
    customerType: '',
    tradingName: '',
    registrationNumber: '',
    vatNumber: '',
    email: '',
    phone: '',
    website: '',
    notes: '',
  };
}

function CustomerForm({ open, mode = 'create', customer, saving = false, onSubmit, onClose }) {
  const isEdit = mode === 'edit';
  const [values, setValues] = useState(emptyValues());
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (!open) return;
    if (customer && isEdit) {
      setValues({
        legalName: customer.legalName || '',
        customerType: customer.customerType || '',
        tradingName: customer.tradingName || '',
        registrationNumber: customer.registrationNumber || '',
        vatNumber: customer.vatNumber || '',
        email: customer.email || '',
        phone: customer.phone || '',
        website: customer.website || '',
        notes: customer.notes || '',
      });
    } else {
      setValues(emptyValues());
    }
    setErrors({});
  }, [open, customer, mode, isEdit]);

  const setField = (field) => (e) => {
    setValues((prev) => ({ ...prev, [field]: e.target.value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const validate = () => {
    const next = {};
    if (!values.legalName.trim()) next.legalName = 'A legal name is required.';
    if (!values.customerType) next.customerType = 'A customer type is required.';
    if (values.email.trim() && !EMAIL_RE.test(values.email.trim())) {
      next.email = 'Enter a valid email address.';
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (saving) return;
    if (!validate()) return;

    const trimOrNull = (v) => (v.trim() === '' ? null : v.trim());
    onSubmit({
      legalName: values.legalName.trim(),
      customerType: values.customerType,
      tradingName: trimOrNull(values.tradingName),
      registrationNumber: trimOrNull(values.registrationNumber),
      vatNumber: trimOrNull(values.vatNumber),
      email: trimOrNull(values.email),
      phone: trimOrNull(values.phone),
      website: trimOrNull(values.website),
      notes: trimOrNull(values.notes),
    });
  };

  const title = isEdit ? 'Edit Customer' : 'Create Customer';
  const submitLabel = isEdit ? 'Save Changes' : 'Create Customer';

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
          <TextField
            label="Legal Name" value={values.legalName} onChange={setField('legalName')}
            error={Boolean(errors.legalName)} helperText={errors.legalName || 'The invoiceable legal entity name'}
            fullWidth required autoFocus disabled={saving}
          />

          <TextField
            label="Customer Type" value={values.customerType} onChange={setField('customerType')}
            error={Boolean(errors.customerType)} helperText={errors.customerType || 'Required'}
            fullWidth select required disabled={saving}
          >
            {CUSTOMER_TYPES.map((t) => <MenuItem key={t} value={t}>{t}</MenuItem>)}
          </TextField>

          <TextField
            label="Trading Name" value={values.tradingName} onChange={setField('tradingName')}
            helperText="Optional — the name the customer trades as" fullWidth disabled={saving}
          />

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField
              label="Registration Number" value={values.registrationNumber} onChange={setField('registrationNumber')}
              helperText="Optional" fullWidth disabled={saving}
            />
            <TextField
              label="VAT Number" value={values.vatNumber} onChange={setField('vatNumber')}
              helperText="Optional — unique per organisation when supplied" fullWidth disabled={saving}
            />
          </Stack>

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField
              label="Email" type="email" value={values.email} onChange={setField('email')}
              error={Boolean(errors.email)} helperText={errors.email || 'Optional'} fullWidth disabled={saving}
            />
            <TextField
              label="Phone" value={values.phone} onChange={setField('phone')}
              helperText="Optional" fullWidth disabled={saving}
            />
          </Stack>

          <TextField
            label="Website" value={values.website} onChange={setField('website')}
            helperText="Optional" fullWidth disabled={saving}
          />

          <TextField
            label="Notes" value={values.notes} onChange={setField('notes')}
            helperText="Optional" fullWidth multiline minRows={2} disabled={saving}
          />

          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            A customer is the commercial entity that places sales orders. Contacts and addresses are managed separately in a later step.
          </Typography>
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

export default CustomerForm;
