import { useEffect, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, TextField, MenuItem,
  Button, Stack, CircularProgress, Alert,
} from '@mui/material';
import {
  MACHINERY_STATUSES, MACHINERY_CATEGORIES, getVineyardOptions, friendlyMachineryError,
} from '../../services/machineryService';

const NO_VINEYARD = '';
const EMPTY = { name: '', category: '', registration: '', status: 'operational', lastServiceDate: '', vineyardId: NO_VINEYARD };

function MachineryForm({ open, record, vineyardOptions, saving = false, onSubmit, onClose }) {
  const isEdit = Boolean(record);
  const [values, setValues] = useState(EMPTY);
  const [errors, setErrors] = useState({});
  const [vineyards, setVineyards] = useState(vineyardOptions || []);
  const [loadingOptions, setLoadingOptions] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (record) {
      setValues({
        name: record.name || '',
        category: record.category || '',
        registration: record.registration || '',
        status: record.status || 'operational',
        lastServiceDate: record.lastServiceDate || '',
        vineyardId: record.vineyardId || NO_VINEYARD,
      });
    } else setValues(EMPTY);
    setErrors({});
  }, [open, record]);

  useEffect(() => {
    if (!open) return;
    if (vineyardOptions) { setVineyards(vineyardOptions); return; }
    let active = true; setLoadingOptions(true);
    getVineyardOptions().then(({ data }) => { if (active) { setVineyards(data || []); setLoadingOptions(false); } });
    return () => { active = false; };
  }, [open, vineyardOptions]);

  const setField = (field) => (e) => {
    setValues((prev) => ({ ...prev, [field]: e.target.value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const validate = () => {
    const next = {};
    if (!values.name.trim()) next.name = 'Machinery name is required.';
    else if (values.name.trim().length > 120) next.name = 'Name must be 120 characters or fewer.';
    if (!values.status) next.status = 'Please select a status.';
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (saving) return;
    if (!validate()) return;
    onSubmit({
      name: values.name.trim(),
      category: values.category || null,
      registration: values.registration.trim() || null,
      status: values.status,
      lastServiceDate: values.lastServiceDate || null,
      vineyardId: values.vineyardId || null,
    });
  };

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} fullWidth maxWidth="sm" component="form" onSubmit={handleSubmit} noValidate>
      <DialogTitle>{isEdit ? 'Edit Machinery' : 'Add Machinery'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          <TextField label="Machinery Name" value={values.name} onChange={setField('name')}
            error={Boolean(errors.name)} helperText={errors.name || 'Required'} fullWidth autoFocus required disabled={saving} />
          <TextField label="Category" value={values.category} onChange={setField('category')} fullWidth select disabled={saving} helperText="Optional">
            <MenuItem value=""><em>None</em></MenuItem>
            {MACHINERY_CATEGORIES.map((c) => <MenuItem key={c.value} value={c.value}>{c.label}</MenuItem>)}
          </TextField>
          <TextField label="Registration / Identifier" value={values.registration} onChange={setField('registration')} fullWidth disabled={saving} helperText="Optional" />
          <TextField label="Assigned Vineyard" value={loadingOptions ? '' : values.vineyardId} onChange={setField('vineyardId')} fullWidth select disabled={saving || loadingOptions} helperText="Optional">
            <MenuItem value={NO_VINEYARD}><em>None</em></MenuItem>
            {vineyards.map((v) => <MenuItem key={v.id} value={v.id}>{v.name}</MenuItem>)}
          </TextField>
          <TextField label="Last Service Date" type="date" value={values.lastServiceDate} onChange={setField('lastServiceDate')}
            fullWidth disabled={saving} InputLabelProps={{ shrink: true }} helperText="Optional" />
          <TextField label="Status" value={values.status} onChange={setField('status')}
            error={Boolean(errors.status)} helperText={errors.status || ' '} fullWidth select required disabled={saving}>
            {MACHINERY_STATUSES.map((s) => <MenuItem key={s.value} value={s.value}>{s.label}</MenuItem>)}
          </TextField>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        <Button onClick={onClose} color="inherit" disabled={saving}>Cancel</Button>
        <Button type="submit" variant="contained" color="primary" disabled={saving}>
          {saving ? <CircularProgress size={20} color="inherit" /> : isEdit ? 'Save Changes' : 'Add Machinery'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default MachineryForm;
