import { useEffect, useMemo, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, TextField, MenuItem,
  Button, Stack, CircularProgress, Alert, InputAdornment,
} from '@mui/material';
import {
  HARVEST_STATUSES, getVineyardOptions, getBlockOptions, friendlyHarvestError,
} from '../../services/harvestService';

const NO_BLOCK = '';
const EMPTY = { title: '', vineyardId: '', blockId: NO_BLOCK, status: 'planned', harvestDate: '', yieldTons: '' };

function HarvestForm({
  open, record, vineyardOptions, blockOptions, defaultVineyardId = '',
  saving = false, onSubmit, onClose,
}) {
  const isEdit = Boolean(record);
  const [values, setValues] = useState(EMPTY);
  const [errors, setErrors] = useState({});
  const [vineyards, setVineyards] = useState(vineyardOptions || []);
  const [blocks, setBlocks] = useState(blockOptions || []);
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [optionsError, setOptionsError] = useState('');

  useEffect(() => {
    if (!open) return;
    if (record) {
      setValues({
        title: record.title || '',
        vineyardId: record.vineyardId || '',
        blockId: record.blockId || NO_BLOCK,
        status: record.status || 'planned',
        harvestDate: record.harvestDate || '',
        yieldTons: record.yieldTons != null ? String(record.yieldTons) : '',
      });
    } else {
      setValues({ ...EMPTY, vineyardId: defaultVineyardId || '' });
    }
    setErrors({});
  }, [open, record, defaultVineyardId]);

  useEffect(() => {
    if (!open) return;
    if (vineyardOptions && blockOptions) { setVineyards(vineyardOptions); setBlocks(blockOptions); return; }
    let active = true;
    setLoadingOptions(true); setOptionsError('');
    Promise.all([getVineyardOptions(), getBlockOptions()]).then(([vRes, bRes]) => {
      if (!active) return;
      if (vRes.error || bRes.error) { setOptionsError(friendlyHarvestError(vRes.error || bRes.error)); setVineyards([]); setBlocks([]); }
      else { setVineyards(vRes.data || []); setBlocks(bRes.data || []); }
      setLoadingOptions(false);
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
    if (!values.title.trim()) next.title = 'Harvest title is required.';
    else if (values.title.trim().length > 200) next.title = 'Title must be 200 characters or fewer.';
    if (!values.vineyardId) next.vineyardId = 'Please select a vineyard.';
    if (values.blockId) {
      const belongs = blocks.some((b) => b.id === values.blockId && b.vineyardId === values.vineyardId);
      if (!belongs) next.blockId = 'The block must belong to the selected vineyard.';
    }
    if (values.yieldTons !== '') {
      const y = Number(values.yieldTons);
      if (Number.isNaN(y)) next.yieldTons = 'Yield must be a number.';
      else if (y < 0) next.yieldTons = 'Yield cannot be negative.';
    }
    if (!values.status) next.status = 'Please select a status.';
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (saving) return;
    if (!validate()) return;
    onSubmit({
      title: values.title.trim(),
      vineyardId: values.vineyardId,
      blockId: values.blockId || null,
      status: values.status,
      harvestDate: values.harvestDate || null,
      yieldTons: values.yieldTons === '' ? null : Number(values.yieldTons),
    });
  };

  const noVineyards = !loadingOptions && !optionsError && vineyards.length === 0;

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} fullWidth maxWidth="sm"
      component="form" onSubmit={handleSubmit} noValidate>
      <DialogTitle>{isEdit ? 'Edit Harvest' : 'Add Harvest'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          {optionsError && <Alert severity="error">{optionsError}</Alert>}
          {noVineyards && (
            <Alert severity="info">You need at least one vineyard before adding a harvest. Create a vineyard first.</Alert>
          )}
          <TextField label="Harvest Title" value={values.title} onChange={setField('title')}
            error={Boolean(errors.title)} helperText={errors.title || 'Required'} fullWidth autoFocus required disabled={saving} />
          <TextField label="Vineyard" value={loadingOptions ? '' : values.vineyardId} onChange={setField('vineyardId')}
            error={Boolean(errors.vineyardId)} helperText={errors.vineyardId || (loadingOptions ? 'Loading…' : 'Required')}
            fullWidth select required disabled={saving || loadingOptions || noVineyards}>
            {vineyards.map((v) => <MenuItem key={v.id} value={v.id}>{v.name}</MenuItem>)}
          </TextField>
          <TextField label="Block" value={values.blockId} onChange={setField('blockId')}
            error={Boolean(errors.blockId)}
            helperText={errors.blockId || (!values.vineyardId ? 'Select a vineyard first' : availableBlocks.length === 0 ? 'No blocks in this vineyard' : 'Optional')}
            fullWidth select disabled={saving || loadingOptions || !values.vineyardId}>
            <MenuItem value={NO_BLOCK}><em>None</em></MenuItem>
            {availableBlocks.map((b) => <MenuItem key={b.id} value={b.id}>{b.name}</MenuItem>)}
          </TextField>
          <TextField label="Harvest Date" type="date" value={values.harvestDate} onChange={setField('harvestDate')}
            fullWidth disabled={saving} InputLabelProps={{ shrink: true }} helperText="Optional" />
          <TextField label="Yield" type="number" value={values.yieldTons} onChange={setField('yieldTons')}
            error={Boolean(errors.yieldTons)} helperText={errors.yieldTons || 'Optional'} fullWidth disabled={saving}
            inputProps={{ min: 0, step: 'any' }}
            InputProps={{ endAdornment: <InputAdornment position="end">tons</InputAdornment> }} />
          <TextField label="Status" value={values.status} onChange={setField('status')}
            error={Boolean(errors.status)} helperText={errors.status || ' '} fullWidth select required disabled={saving}>
            {HARVEST_STATUSES.map((s) => <MenuItem key={s.value} value={s.value}>{s.label}</MenuItem>)}
          </TextField>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        <Button onClick={onClose} color="inherit" disabled={saving}>Cancel</Button>
        <Button type="submit" variant="contained" color="primary" disabled={saving || loadingOptions || noVineyards}>
          {saving ? <CircularProgress size={20} color="inherit" /> : isEdit ? 'Save Changes' : 'Add Harvest'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default HarvestForm;
