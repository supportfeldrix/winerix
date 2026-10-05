import { useEffect, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, TextField, MenuItem,
  Button, Stack, CircularProgress, Typography,
} from '@mui/material';
import { STOCK_LOCATION_TYPES } from '../../services/stockLocationService';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Add / Edit Stock Location dialog (P2K-3)
//
// Controlled locally. The parent (StockLocations) performs the Supabase write
// via stockLocationService (createStockLocation / updateStockLocation) and owns
// `saving`, `open`. This form NEVER queries Supabase.
//
// A location only describes WHERE finished goods are held — no stock, bottles,
// litres, quantities or capacity fields.
// ─────────────────────────────────────────────────────────────────────────────

function emptyValues() {
  return { locationCode: '', name: '', locationType: 'finished_goods_store', notes: '' };
}

function StockLocationForm({ open, mode = 'create', location, saving = false, onSubmit, onClose }) {
  const isEdit = mode === 'edit';
  const [values, setValues] = useState(emptyValues());
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (!open) return;
    if (location && isEdit) {
      setValues({
        locationCode: location.locationCode || '',
        name: location.name || '',
        locationType: location.locationType || 'finished_goods_store',
        notes: location.notes || '',
      });
    } else {
      setValues(emptyValues());
    }
    setErrors({});
  }, [open, location, mode, isEdit]);

  const setField = (field) => (e) => {
    setValues((prev) => ({ ...prev, [field]: e.target.value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const validate = () => {
    const next = {};
    if (!values.locationCode.trim()) next.locationCode = 'A location code is required.';
    if (!values.name.trim()) next.name = 'A name is required.';
    if (!values.locationType) next.locationType = 'A location type is required.';
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (saving) return;
    if (!validate()) return;
    onSubmit({
      locationCode: values.locationCode.trim(),
      name: values.name.trim(),
      locationType: values.locationType,
      notes: values.notes.trim() === '' ? null : values.notes.trim(),
    });
  };

  const title = isEdit ? 'Edit Stock Location' : 'Create Stock Location';
  const submitLabel = isEdit ? 'Save Changes' : 'Create Location';

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
            label="Location Code" value={values.locationCode} onChange={setField('locationCode')}
            error={Boolean(errors.locationCode)} helperText={errors.locationCode || 'Unique within your organisation (case-insensitive)'}
            fullWidth required autoFocus disabled={saving} placeholder="e.g. FG-STORE-01"
          />

          <TextField
            label="Name" value={values.name} onChange={setField('name')}
            error={Boolean(errors.name)} helperText={errors.name || 'e.g. Main Finished Goods Store'}
            fullWidth required disabled={saving}
          />

          <TextField
            label="Location Type" value={values.locationType} onChange={setField('locationType')}
            error={Boolean(errors.locationType)} helperText={errors.locationType || 'Where finished goods are held'}
            fullWidth select required disabled={saving}
          >
            {STOCK_LOCATION_TYPES.map((t) => (
              <MenuItem key={t.value} value={t.value}>{t.label}</MenuItem>
            ))}
          </TextField>

          <TextField
            label="Notes" value={values.notes} onChange={setField('notes')}
            helperText="Optional" fullWidth multiline minRows={2} disabled={saving}
          />

          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            A stock location describes where finished goods can be stored. It holds no stock quantities.
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

export default StockLocationForm;
