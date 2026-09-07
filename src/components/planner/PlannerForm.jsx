import { useEffect, useMemo, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, TextField, MenuItem,
  Button, Stack, CircularProgress, Alert,
} from '@mui/material';
import {
  PLANNER_STATUSES, getVineyardOptions, getBlockOptions, friendlyPlannerError,
} from '../../services/plannerService';

const NO_BLOCK = '';
const NO_VINEYARD = '';
const EMPTY = { title: '', status: 'pending', dueDate: '', vineyardId: NO_VINEYARD, blockId: NO_BLOCK };

function PlannerForm({ open, record, vineyardOptions, blockOptions, defaultVineyardId = '', saving = false, onSubmit, onClose }) {
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
        status: record.status || 'pending',
        dueDate: record.dueDate || '',
        vineyardId: record.vineyardId || NO_VINEYARD,
        blockId: record.blockId || NO_BLOCK,
      });
    } else setValues({ ...EMPTY, vineyardId: defaultVineyardId || NO_VINEYARD });
    setErrors({});
  }, [open, record, defaultVineyardId]);

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
    if (!values.title.trim()) next.title = 'Task title is required.';
    else if (values.title.trim().length > 200) next.title = 'Title must be 200 characters or fewer.';
    if (!values.status) next.status = 'Please select a status.';
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
      status: values.status,
      dueDate: values.dueDate || null,
      vineyardId: values.vineyardId || null,
      blockId: values.blockId || null,
    });
  };

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} fullWidth maxWidth="sm" component="form" onSubmit={handleSubmit} noValidate>
      <DialogTitle>{isEdit ? 'Edit Task' : 'Add Task'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          <TextField label="Task Title" value={values.title} onChange={setField('title')}
            error={Boolean(errors.title)} helperText={errors.title || 'Required'} fullWidth autoFocus required disabled={saving} />
          <TextField label="Due Date" type="date" value={values.dueDate} onChange={setField('dueDate')}
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
          <TextField label="Status" value={values.status} onChange={setField('status')}
            error={Boolean(errors.status)} helperText={errors.status || ' '} fullWidth select required disabled={saving}>
            {PLANNER_STATUSES.map((s) => <MenuItem key={s.value} value={s.value}>{s.label}</MenuItem>)}
          </TextField>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        <Button onClick={onClose} color="inherit" disabled={saving}>Cancel</Button>
        <Button type="submit" variant="contained" color="primary" disabled={saving}>
          {saving ? <CircularProgress size={20} color="inherit" /> : isEdit ? 'Save Changes' : 'Add Task'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default PlannerForm;
