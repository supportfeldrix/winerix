import { useEffect, useMemo, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, TextField, MenuItem,
  Button, Stack, CircularProgress, Alert, Typography, InputAdornment,
} from '@mui/material';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Create / Edit Draft Sales Order dialog (P2L-4)
//
// Controlled locally. The parent (SalesOrders / SalesOrderProfile) performs the
// write via salesOrderService (createDraftSalesOrder / updateDraftSalesOrder)
// and owns `saving`, `open`, supplies `customerOptions`, and loads the chosen
// customer's addresses on demand via `onCustomerChange` (returning the address
// list through `addressOptions`). This form NEVER queries Supabase.
//
// Draft only: order number is server-generated (read-only, shown on edit only),
// status is Draft (read-only), totals are 0.00 (read-only — lines come later).
// ─────────────────────────────────────────────────────────────────────────────

const NONE = '__none__';

function todayStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function emptyValues() {
  return {
    customerId: '',
    orderDate: todayStr(),
    requestedDeliveryDate: '',
    currency: 'ZAR',
    billingAddressId: NONE,
    shippingAddressId: NONE,
    notes: '',
  };
}

function SalesOrderForm({
  open, mode = 'create', order, customerOptions = [], addressOptions = [],
  saving = false, onCustomerChange, onSubmit, onClose,
}) {
  const isEdit = mode === 'edit';
  const [values, setValues] = useState(emptyValues());
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (!open) return;
    if (order && isEdit) {
      setValues({
        customerId: order.customerId || '',
        orderDate: order.orderDate || todayStr(),
        requestedDeliveryDate: order.requestedDeliveryDate || '',
        currency: order.currency || 'ZAR',
        billingAddressId: order.billingAddressId || NONE,
        shippingAddressId: order.shippingAddressId || NONE,
        notes: order.notes || '',
      });
      // Ask the parent to load this customer's addresses.
      if (order.customerId) onCustomerChange?.(order.customerId);
    } else {
      setValues(emptyValues());
    }
    setErrors({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, order, mode, isEdit]);

  const setField = (field) => (e) => {
    setValues((prev) => ({ ...prev, [field]: e.target.value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const handleCustomerChange = (e) => {
    const customerId = e.target.value;
    // Changing customer clears address selections (they belong to a customer).
    setValues((prev) => ({ ...prev, customerId, billingAddressId: NONE, shippingAddressId: NONE }));
    setErrors((prev) => ({ ...prev, customerId: undefined }));
    onCustomerChange?.(customerId);
  };

  const addresses = useMemo(() => addressOptions || [], [addressOptions]);

  const validate = () => {
    const next = {};
    if (!values.customerId) next.customerId = 'A customer is required.';
    if (!values.orderDate) next.orderDate = 'An order date is required.';
    if (values.requestedDeliveryDate && values.orderDate && values.requestedDeliveryDate < values.orderDate) {
      next.requestedDeliveryDate = 'Delivery date cannot be before the order date.';
    }
    if (!values.currency.trim()) next.currency = 'A currency is required.';
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (saving) return;
    if (!validate()) return;
    onSubmit({
      customerId: values.customerId,
      orderDate: values.orderDate,
      requestedDeliveryDate: values.requestedDeliveryDate || null,
      currency: values.currency.trim(),
      billingAddressId: values.billingAddressId === NONE ? null : values.billingAddressId,
      shippingAddressId: values.shippingAddressId === NONE ? null : values.shippingAddressId,
      notes: values.notes.trim() === '' ? null : values.notes.trim(),
    });
  };

  const title = isEdit ? 'Edit Draft Sales Order' : 'Create Sales Order';
  const submitLabel = isEdit ? 'Save Changes' : 'Create Sales Order';

  const addressLabel = (a) =>
    `${a.addressType}${a.label ? ` · ${a.label}` : ''} — ${a.addressLine1}${a.city ? `, ${a.city}` : ''}`;

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} fullWidth maxWidth="sm" component="form" onSubmit={handleSubmit} noValidate>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          {!isEdit && (
            <Alert severity="info" sx={{ mb: 0 }}>
              A draft order is created with an auto-generated order number. Order lines and totals are added later.
            </Alert>
          )}

          {isEdit && (
            <TextField label="Order Number" value={order?.orderNumber || ''} fullWidth disabled
              helperText="Generated automatically — not editable" />
          )}

          <TextField
            label="Customer" value={values.customerId} onChange={handleCustomerChange}
            error={Boolean(errors.customerId)} helperText={errors.customerId || 'Active customers in this organisation'}
            fullWidth select required autoFocus={!isEdit} disabled={saving}
          >
            {customerOptions.length === 0 ? (
              <MenuItem value="" disabled><em>No active customers — create one first</em></MenuItem>
            ) : (
              customerOptions.map((c) => (
                <MenuItem key={c.id} value={c.id}>{c.legalName}{c.tradingName ? ` (${c.tradingName})` : ''}</MenuItem>
              ))
            )}
          </TextField>

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField
              label="Order Date" type="date" value={values.orderDate} onChange={setField('orderDate')}
              error={Boolean(errors.orderDate)} helperText={errors.orderDate || 'Required'}
              fullWidth required disabled={saving} InputLabelProps={{ shrink: true }}
            />
            <TextField
              label="Requested Delivery" type="date" value={values.requestedDeliveryDate} onChange={setField('requestedDeliveryDate')}
              error={Boolean(errors.requestedDeliveryDate)} helperText={errors.requestedDeliveryDate || 'Optional'}
              fullWidth disabled={saving} InputLabelProps={{ shrink: true }}
            />
          </Stack>

          <TextField
            label="Currency" value={values.currency} onChange={setField('currency')}
            error={Boolean(errors.currency)} helperText={errors.currency || 'Default ZAR'}
            fullWidth required disabled={saving} sx={{ maxWidth: { sm: 160 } }}
          />

          <TextField
            label="Billing Address" value={values.billingAddressId} onChange={setField('billingAddressId')}
            fullWidth select disabled={saving || !values.customerId}
            helperText={values.customerId ? "Optional — the customer's addresses" : 'Select a customer first'}
          >
            <MenuItem value={NONE}><em>None</em></MenuItem>
            {addresses.map((a) => <MenuItem key={a.id} value={a.id}>{addressLabel(a)}</MenuItem>)}
          </TextField>

          <TextField
            label="Shipping Address" value={values.shippingAddressId} onChange={setField('shippingAddressId')}
            fullWidth select disabled={saving || !values.customerId}
            helperText={values.customerId ? "Optional — the customer's addresses" : 'Select a customer first'}
          >
            <MenuItem value={NONE}><em>None</em></MenuItem>
            {addresses.map((a) => <MenuItem key={a.id} value={a.id}>{addressLabel(a)}</MenuItem>)}
          </TextField>

          <TextField
            label="Status" value="Draft" fullWidth disabled
            helperText="New orders are drafts. Confirmation is a later step."
          />

          <TextField
            label="Order Total" value="0.00" fullWidth disabled
            InputProps={{ startAdornment: <InputAdornment position="start">{values.currency || 'ZAR'}</InputAdornment> }}
            helperText="Totals are determined by order lines (added later)."
          />

          <TextField
            label="Notes" value={values.notes} onChange={setField('notes')}
            helperText="Optional" fullWidth multiline minRows={2} disabled={saving}
          />

          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            Addresses reference the customer’s current records; a historical snapshot is captured when the order is confirmed later.
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        <Button onClick={onClose} color="inherit" disabled={saving}>Cancel</Button>
        <Button type="submit" variant="contained" color="primary" disabled={saving || customerOptions.length === 0}>
          {saving ? <CircularProgress size={20} color="inherit" /> : submitLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default SalesOrderForm;
