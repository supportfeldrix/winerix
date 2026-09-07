import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  MenuItem,
  Button,
  Stack,
  InputAdornment,
  CircularProgress,
  Alert,
} from '@mui/material';
import {
  BLOCK_STATUSES,
  getVineyardOptions,
  friendlyBlockError,
} from '../../services/blockService';

const EMPTY = { name: '', vineyardId: '', areaHectares: '', status: 'active' };

/**
 * Add / Edit block dialog form.
 *
 * Mirrors VineyardForm: controlled locally, validates required fields and a
 * non-negative numeric area before calling onSubmit with normalised values
 * ({ name, vineyardId, areaHectares, status }). The parent performs the
 * Supabase write and controls `saving` and `open`.
 *
 * The vineyard selector is populated from the authenticated user's own
 * vineyards (RLS-scoped), so a block can never be assigned to another user's
 * vineyard. Options can be supplied via `vineyardOptions` to avoid re-fetching;
 * otherwise they are loaded when the dialog opens.
 *
 * @param {boolean} open
 * @param {object|null} block - When provided, the form is in edit mode.
 * @param {Array<{id,name}>} [vineyardOptions] - Optional pre-loaded options.
 * @param {string} [defaultVineyardId] - Preselect a vineyard when adding.
 * @param {boolean} saving
 * @param {function} onSubmit - (values) => void
 * @param {function} onClose
 */
function BlockForm({
  open,
  block,
  vineyardOptions,
  defaultVineyardId = '',
  saving = false,
  onSubmit,
  onClose,
}) {
  const isEdit = Boolean(block);
  const [values, setValues] = useState(EMPTY);
  const [errors, setErrors] = useState({});

  const [options, setOptions] = useState(vineyardOptions || []);
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [optionsError, setOptionsError] = useState('');

  // Populate / reset the form whenever it opens.
  useEffect(() => {
    if (!open) return;
    if (block) {
      setValues({
        name: block.name || '',
        vineyardId: block.vineyardId || '',
        areaHectares: block.areaHectares != null ? String(block.areaHectares) : '',
        status: block.status || 'active',
      });
    } else {
      setValues({ ...EMPTY, vineyardId: defaultVineyardId || '' });
    }
    setErrors({});
  }, [open, block, defaultVineyardId]);

  // Load vineyard options when the dialog opens (unless provided by parent).
  useEffect(() => {
    if (!open) return;

    if (vineyardOptions) {
      setOptions(vineyardOptions);
      return;
    }

    let active = true;
    setLoadingOptions(true);
    setOptionsError('');
    getVineyardOptions().then(({ data, error }) => {
      if (!active) return;
      if (error) {
        setOptionsError(friendlyBlockError(error));
        setOptions([]);
      } else {
        setOptions(data || []);
      }
      setLoadingOptions(false);
    });
    return () => {
      active = false;
    };
  }, [open, vineyardOptions]);

  const setField = (field) => (e) => {
    setValues((prev) => ({ ...prev, [field]: e.target.value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const validate = () => {
    const next = {};

    if (!values.name.trim()) {
      next.name = 'Block name is required.';
    } else if (values.name.trim().length > 120) {
      next.name = 'Name must be 120 characters or fewer.';
    }

    if (!values.vineyardId) {
      next.vineyardId = 'Please select a vineyard.';
    }

    if (values.areaHectares === '') {
      next.areaHectares = 'Area is required.';
    } else {
      const area = Number(values.areaHectares);
      if (Number.isNaN(area)) {
        next.areaHectares = 'Area must be a number.';
      } else if (area < 0) {
        next.areaHectares = 'Area cannot be negative.';
      } else if (area > 1000000) {
        next.areaHectares = 'Please enter a realistic area.';
      }
    }

    if (!values.status) {
      next.status = 'Please select a status.';
    }

    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (saving) return;
    if (!validate()) return;

    onSubmit({
      name: values.name.trim(),
      vineyardId: values.vineyardId,
      areaHectares: values.areaHectares === '' ? null : Number(values.areaHectares),
      status: values.status,
    });
  };

  const noVineyards = !loadingOptions && !optionsError && options.length === 0;

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
      <DialogTitle>{isEdit ? 'Edit Block' : 'Add Block'}</DialogTitle>

      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          {optionsError && <Alert severity="error">{optionsError}</Alert>}
          {noVineyards && (
            <Alert severity="info">
              You need at least one vineyard before adding a block. Create a
              vineyard first.
            </Alert>
          )}

          <TextField
            label="Block Name"
            value={values.name}
            onChange={setField('name')}
            error={Boolean(errors.name)}
            helperText={errors.name || 'Required'}
            fullWidth
            autoFocus
            required
            disabled={saving}
          />

          <TextField
            label="Vineyard"
            value={loadingOptions ? '' : values.vineyardId}
            onChange={setField('vineyardId')}
            error={Boolean(errors.vineyardId)}
            helperText={
              errors.vineyardId ||
              (loadingOptions ? 'Loading vineyards…' : 'Required')
            }
            fullWidth
            select
            required
            disabled={saving || loadingOptions || noVineyards}
          >
            {options.map((v) => (
              <MenuItem key={v.id} value={v.id}>
                {v.name}
              </MenuItem>
            ))}
          </TextField>

          <TextField
            label="Area"
            value={values.areaHectares}
            onChange={setField('areaHectares')}
            error={Boolean(errors.areaHectares)}
            helperText={errors.areaHectares || 'Required'}
            fullWidth
            required
            disabled={saving}
            type="number"
            inputProps={{ min: 0, step: 'any' }}
            InputProps={{
              endAdornment: <InputAdornment position="end">ha</InputAdornment>,
            }}
          />

          <TextField
            label="Status"
            value={values.status}
            onChange={setField('status')}
            error={Boolean(errors.status)}
            helperText={errors.status || ' '}
            fullWidth
            select
            required
            disabled={saving}
          >
            {BLOCK_STATUSES.map((s) => (
              <MenuItem key={s.value} value={s.value}>
                {s.label}
              </MenuItem>
            ))}
          </TextField>
        </Stack>
      </DialogContent>

      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        <Button onClick={onClose} color="inherit" disabled={saving}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="contained"
          color="primary"
          disabled={saving || loadingOptions || noVineyards}
        >
          {saving ? (
            <CircularProgress size={20} color="inherit" />
          ) : isEdit ? (
            'Save Changes'
          ) : (
            'Add Block'
          )}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default BlockForm;
