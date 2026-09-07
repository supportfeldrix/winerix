import { useEffect, useMemo, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, TextField, MenuItem,
  Button, Stack, CircularProgress, Alert, InputAdornment,
} from '@mui/material';
import {
  FINANCE_TYPES, FINANCE_CATEGORIES, getVineyardOptions, getBlockOptions, friendlyFinanceError,
} from '../../services/financeService';

const NO_BLOCK = '';
const NO_VINEYARD = '';
const EMPTY = { title: '', type: 'expense', category: '', amount: '', entryDate: '', vineyardId: NO_VINEYARD, blockId: NO_BLOCK };

function FinanceForm({ open, record, vineyardOptions, blockOptions, saving = false, onSubmit, onClose }) {
  const isEdit = Boolean(record);
  const [values, setValues] = useState(EMPTY);
  const [errors, setErrors] = useState({});
  const [vineyards, setVineyards] = useState(vineyardOptions || []);
  const [blocks, setBlocks] = useState(blockOptions || []);
  const [loadingOptions, setLoadingOptions] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (record) {
      setValues({
        title: record.title || '',
        type: record.type || 'expense',
        category: record.category || '',
        amount: record.amount != null ? String(record.amount) : '',
        entryDate: record.entryDate || '',
        vineyardId: record.vineyardId || NO_VINEYARD,
        blockId: record.blockId || NO_BLOCK,
      });
    } else setValues(EMPTY);
    setErrors({});
  }, [open, record]);

  useEffect(() => {
    if (!open) return;
    if (vineyardOptions && blockOptions) { setVineyards(vineyardOptions); setBlocks(blockOptions); return; }
    let active = true; setLoadingOptions(true);
    Promise.all([getVineyardOptions(), getBlockOptions()]).then(([vRes, bRes]) => {
      if (!active) return;
      setVineyards(vRes.data || []); setBlocks(bRes.data || []); setLoadingOptions(false);
    });
    return () => { active = false; };
  }, [open, vineyardOptions, blockOptions]);

  const availableBlocks = useMemo(
    () => blocks.filter((b) => b.vineyardId === values.vineyardId),
    [blocks, values.vineyardId]
  );

  const setField = (field) => (e) => {
    const value = e.target.value;
    setValues((prev) => {
      const next = { ...prev, [field]: value };
      if (field === 'vineyardId') next.blockId = NO_BLOCK;
      return next;
    });
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const validate = () => {
    const next = {};
    if (!values.title.trim()) next.title = 'Title is required.';
    else if (values.title.trim().length > 200) next.title = 'Title must be 200 characters or fewer.';
    if (!values.type) next.type = 'Please select a type.';
    if (values.amount === '') next.amount = 'Amount is required.';
    else {
      const a = Number(values.amount);
      if (Number.isNaN(a)) next.amount = 'Amount must be a number.';
      else if (a < 0) next.amount = 'Amount cannot be negative.';
    }
    if (values.blockId) {
      const belongs = blocks.some((b) => b.id === values.blockId && b.vineyardId === values.vineyardId);
      if (!belongs) next.blockId = 'The block must belong to the selected vineyard.';
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (saving) return;
    if (!validate()) return;
    onSubmit({
      title: values.title.trim(),
      type: values.type,
      category: values.category || null,
      amount: values.amount === '' ? 0 : Number(values.amount),
      entryDate: values.entryDate || null,
      vineyardId: values.vineyardId || null,
      blockId: values.blockId || null,
    });
  };

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} fullWidth maxWidth="sm" component="form" onSubmit={handleSubmit} noValidate>
      <DialogTitle>{isEdit ? 'Edit Financial Record' : 'Add Financial Record'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          <TextField label="Title" value={values.title} onChange={setField('title')}
            error={Boolean(errors.title)} helperText={errors.title || 'Required'} fullWidth autoFocus required disabled={saving} />
          <TextField label="Type" value={values.type} onChange={setField('type')}
            error={Boolean(errors.type)} helperText={errors.type || 'Required'} fullWidth select required disabled={saving}>
            {FINANCE_TYPES.map((t) => <MenuItem key={t.value} value={t.value}>{t.label}</MenuItem>)}
          </TextField>
          <TextField label="Amount" type="number" value={values.amount} onChange={setField('amount')}
            error={Boolean(errors.amount)} helperText={errors.amount || 'Required'} fullWidth required disabled={saving}
            inputProps={{ min: 0, step: '0.01' }}
            InputProps={{ startAdornment: <InputAdornment position="start">R</InputAdornment> }} />
          <TextField label="Category" value={values.category} onChange={setField('category')} fullWidth select disabled={saving} helperText="Optional">
            <MenuItem value=""><em>None</em></MenuItem>
            {FINANCE_CATEGORIES.map((c) => <MenuItem key={c.value} value={c.value}>{c.label}</MenuItem>)}
          </TextField>
          <TextField label="Date" type="date" value={values.entryDate} onChange={setField('entryDate')}
            fullWidth disabled={saving} InputLabelProps={{ shrink: true }} helperText="Optional" />
          <TextField label="Vineyard" value={loadingOptions ? '' : values.vineyardId} onChange={setField('vineyardId')} fullWidth select disabled={saving || loadingOptions} helperText="Optional">
            <MenuItem value={NO_VINEYARD}><em>None</em></MenuItem>
            {vineyards.map((v) => <MenuItem key={v.id} value={v.id}>{v.name}</MenuItem>)}
          </TextField>
          <TextField label="Block" value={values.blockId} onChange={setField('blockId')}
            error={Boolean(errors.blockId)}
            helperText={errors.blockId || (!values.vineyardId ? 'Select a vineyard first' : availableBlocks.length === 0 ? 'No blocks in this vineyard' : 'Optional')}
            fullWidth select disabled={saving || loadingOptions || !values.vineyardId}>
            <MenuItem value={NO_BLOCK}><em>None</em></MenuItem>
            {availableBlocks.map((b) => <MenuItem key={b.id} value={b.id}>{b.name}</MenuItem>)}
          </TextField>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        <Button onClick={onClose} color="inherit" disabled={saving}>Cancel</Button>
        <Button type="submit" variant="contained" color="primary" disabled={saving}>
          {saving ? <CircularProgress size={20} color="inherit" /> : isEdit ? 'Save Changes' : 'Add Record'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default FinanceForm;
