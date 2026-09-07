import { useEffect, useMemo, useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  MenuItem,
  Button,
  Stack,
  CircularProgress,
  Alert,
} from '@mui/material';
import {
  OPERATION_STATUSES,
  getVineyardOptions,
  getBlockOptions,
  friendlyOperationError,
} from '../../services/operationsService';

const NO_BLOCK = '';
const EMPTY = { title: '', vineyardId: '', blockId: NO_BLOCK, status: 'planned' };

/**
 * Add / Edit operation dialog form.
 *
 * Fields: Operation Title (required), Vineyard (required select of the user's
 * vineyards), Block (optional, filtered to the selected vineyard), Status.
 * Controlled locally; the parent performs the Supabase write and controls
 * `saving` and `open`. Options may be supplied via props to avoid re-fetching;
 * otherwise they are loaded when the dialog opens. All options are RLS-scoped.
 *
 * @param {boolean} open
 * @param {object|null} operation - When provided, the form is in edit mode.
 * @param {Array<{id,name}>} [vineyardOptions]
 * @param {Array<{id,name,vineyardId}>} [blockOptions]
 * @param {string} [defaultVineyardId]
 * @param {string} [defaultBlockId]
 * @param {boolean} saving
 * @param {function} onSubmit - (values) => void
 * @param {function} onClose
 */
function OperationForm({
  open,
  operation,
  vineyardOptions,
  blockOptions,
  defaultVineyardId = '',
  defaultBlockId = '',
  saving = false,
  onSubmit,
  onClose,
}) {
  const isEdit = Boolean(operation);
  const [values, setValues] = useState(EMPTY);
  const [errors, setErrors] = useState({});

  const [vineyards, setVineyards] = useState(vineyardOptions || []);
  const [blocks, setBlocks] = useState(blockOptions || []);
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [optionsError, setOptionsError] = useState('');

  // Populate / reset the form whenever it opens.
  useEffect(() => {
    if (!open) return;
    if (operation) {
      setValues({
        title: operation.title || '',
        vineyardId: operation.vineyardId || '',
        blockId: operation.blockId || NO_BLOCK,
        status: operation.status || 'planned',
      });
    } else {
      setValues({
        ...EMPTY,
        vineyardId: defaultVineyardId || '',
        blockId: defaultBlockId || NO_BLOCK,
      });
    }
    setErrors({});
  }, [open, operation, defaultVineyardId, defaultBlockId]);

  // Load option lists when the dialog opens (unless provided by parent).
  useEffect(() => {
    if (!open) return;

    if (vineyardOptions && blockOptions) {
      setVineyards(vineyardOptions);
      setBlocks(blockOptions);
      return;
    }

    let active = true;
    setLoadingOptions(true);
    setOptionsError('');
    Promise.all([getVineyardOptions(), getBlockOptions()]).then(
      ([vRes, bRes]) => {
        if (!active) return;
        if (vRes.error || bRes.error) {
          setOptionsError(friendlyOperationError(vRes.error || bRes.error));
          setVineyards([]);
          setBlocks([]);
        } else {
          setVineyards(vRes.data || []);
          setBlocks(bRes.data || []);
        }
        setLoadingOptions(false);
      }
    );
    return () => {
      active = false;
    };
  }, [open, vineyardOptions, blockOptions]);

  // Blocks available for the currently selected vineyard.
  const availableBlocks = useMemo(
    () => blocks.filter((b) => b.vineyardId === values.vineyardId),
    [blocks, values.vineyardId]
  );

  const setField = (field) => (e) => {
    const value = e.target.value;
    setValues((prev) => {
      const next = { ...prev, [field]: value };
      // Changing the vineyard clears a block that no longer belongs to it.
      if (field === 'vineyardId') {
        next.blockId = NO_BLOCK;
      }
      return next;
    });
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const validate = () => {
    const next = {};

    if (!values.title.trim()) {
      next.title = 'Operation title is required.';
    } else if (values.title.trim().length > 200) {
      next.title = 'Title must be 200 characters or fewer.';
    }

    if (!values.vineyardId) {
      next.vineyardId = 'Please select a vineyard.';
    }

    // A selected block must belong to the selected vineyard.
    if (values.blockId) {
      const belongs = blocks.some(
        (b) => b.id === values.blockId && b.vineyardId === values.vineyardId
      );
      if (!belongs) {
        next.blockId = 'The block must belong to the selected vineyard.';
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
      title: values.title.trim(),
      vineyardId: values.vineyardId,
      blockId: values.blockId || null,
      status: values.status,
    });
  };

  const noVineyards = !loadingOptions && !optionsError && vineyards.length === 0;

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
      <DialogTitle>{isEdit ? 'Edit Operation' : 'Add Operation'}</DialogTitle>

      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          {optionsError && <Alert severity="error">{optionsError}</Alert>}
          {noVineyards && (
            <Alert severity="info">
              You need at least one vineyard before adding an operation. Create a
              vineyard first.
            </Alert>
          )}

          <TextField
            label="Operation Title"
            value={values.title}
            onChange={setField('title')}
            error={Boolean(errors.title)}
            helperText={errors.title || 'Required'}
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
              errors.vineyardId || (loadingOptions ? 'Loading…' : 'Required')
            }
            fullWidth
            select
            required
            disabled={saving || loadingOptions || noVineyards}
          >
            {vineyards.map((v) => (
              <MenuItem key={v.id} value={v.id}>
                {v.name}
              </MenuItem>
            ))}
          </TextField>

          <TextField
            label="Block"
            value={values.blockId}
            onChange={setField('blockId')}
            error={Boolean(errors.blockId)}
            helperText={
              errors.blockId ||
              (!values.vineyardId
                ? 'Select a vineyard first'
                : availableBlocks.length === 0
                ? 'No blocks in this vineyard'
                : 'Optional')
            }
            fullWidth
            select
            disabled={saving || loadingOptions || !values.vineyardId}
          >
            <MenuItem value={NO_BLOCK}>
              <em>None</em>
            </MenuItem>
            {availableBlocks.map((b) => (
              <MenuItem key={b.id} value={b.id}>
                {b.name}
              </MenuItem>
            ))}
          </TextField>

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
            {OPERATION_STATUSES.map((s) => (
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
            'Add Operation'
          )}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default OperationForm;
