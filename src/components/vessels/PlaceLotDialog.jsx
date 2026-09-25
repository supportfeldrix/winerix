import { useEffect, useMemo, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, TextField, MenuItem,
  Button, Stack, CircularProgress, InputAdornment, Box, Typography, Alert,
} from '@mui/material';
import { formatNumber } from '../common/formatters';

// Readable label for a vessel option (code · name · type).
function vesselOptionLabel(v) {
  const bits = [v.vesselCode];
  if (v.name) bits.push(v.name);
  return bits.join('  ·  ');
}

/**
 * Place-in-vessel / Transfer-vessel dialog.
 *
 * mode="place": choose a vessel + placement date/time.
 * mode="transfer": choose a NEW vessel (current vessel excluded) + transfer
 *   date/time; the current vessel is shown for context.
 *
 * Volume is READ-ONLY and comes from the lot's current volume — the user cannot
 * change it (full-lot placement/transfer only). Calls onSubmit with
 * { vesselId, at }.
 *
 * @param {boolean} open
 * @param {'place'|'transfer'} mode
 * @param {number|null} volumeLitres - the lot's current volume (read-only)
 * @param {string|null} currentVesselId - excluded from options in transfer mode
 * @param {string|null} currentVesselLabel - shown for context in transfer mode
 * @param {Array} options - active vessel options
 * @param {boolean} optionsLoading
 * @param {boolean} saving
 * @param {function} onSubmit - ({ vesselId, at }) => void
 * @param {function} onClose
 */
function PlaceLotDialog({
  open, mode = 'place', volumeLitres, currentVesselId, currentVesselLabel,
  options = [], optionsLoading = false, saving = false, onSubmit, onClose,
}) {
  const isTransfer = mode === 'transfer';
  const [vesselId, setVesselId] = useState('');
  const [at, setAt] = useState('');
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (!open) return;
    setVesselId('');
    // Default the timestamp to now (local, formatted for datetime-local input).
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    setAt(`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`);
    setErrors({});
  }, [open]);

  // In transfer mode, exclude the current vessel from the selectable options.
  const selectable = useMemo(
    () => (isTransfer ? options.filter((v) => v.id !== currentVesselId) : options),
    [options, isTransfer, currentVesselId]
  );

  const capacityHint = useMemo(() => {
    const v = selectable.find((o) => o.id === vesselId);
    if (!v || v.capacityLitres == null || volumeLitres == null) return null;
    const exceeds = Number(volumeLitres) > Number(v.capacityLitres);
    return { exceeds, capacity: v.capacityLitres };
  }, [selectable, vesselId, volumeLitres]);

  const validate = () => {
    const next = {};
    if (!vesselId) next.vesselId = 'Please select a vessel.';
    if (!at) next.at = 'Please choose a date and time.';
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (saving) return;
    if (!validate()) return;
    onSubmit({ vesselId, at: new Date(at).toISOString() });
  };

  const noOptions = !optionsLoading && selectable.length === 0;

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
      <DialogTitle>{isTransfer ? 'Transfer to Vessel' : 'Place in Vessel'}</DialogTitle>

      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          {isTransfer && (
            <Box>
              <Typography variant="overline" sx={{ display: 'block', color: 'text.secondary' }}>Current Vessel</Typography>
              <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>{currentVesselLabel || '—'}</Typography>
            </Box>
          )}

          {noOptions ? (
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              {isTransfer
                ? 'No other active vessels are available to transfer to.'
                : 'No active vessels are available. Add a vessel (with status Active) first.'}
            </Typography>
          ) : (
            <TextField
              label={isTransfer ? 'New Vessel' : 'Vessel'}
              value={vesselId}
              onChange={(e) => { setVesselId(e.target.value); setErrors((p) => ({ ...p, vesselId: undefined })); }}
              error={Boolean(errors.vesselId)}
              helperText={errors.vesselId || (optionsLoading ? 'Loading vessels…' : 'Only active vessels are shown')}
              fullWidth
              select
              required
              disabled={saving || optionsLoading}
            >
              {selectable.map((v) => (
                <MenuItem key={v.id} value={v.id}>{vesselOptionLabel(v)}</MenuItem>
              ))}
            </TextField>
          )}

          <TextField
            label={isTransfer ? 'Transfer Date & Time' : 'Placement Date & Time'}
            type="datetime-local"
            value={at}
            onChange={(e) => { setAt(e.target.value); setErrors((p) => ({ ...p, at: undefined })); }}
            error={Boolean(errors.at)}
            helperText={errors.at || ' '}
            fullWidth
            disabled={saving || (!isTransfer && noOptions)}
            InputLabelProps={{ shrink: true }}
          />

          <TextField
            label="Volume"
            value={volumeLitres != null ? formatNumber(volumeLitres) : ''}
            fullWidth
            disabled
            helperText="Full lot volume (read-only)"
            InputProps={{ endAdornment: <InputAdornment position="end">L</InputAdornment> }}
          />

          {capacityHint && capacityHint.exceeds && (
            <Alert severity="warning">
              This lot&apos;s volume exceeds the selected vessel&apos;s capacity ({formatNumber(capacityHint.capacity)} L).
              You can still proceed.
            </Alert>
          )}
        </Stack>
      </DialogContent>

      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        <Button onClick={onClose} color="inherit" disabled={saving}>Cancel</Button>
        <Button type="submit" variant="contained" color="primary" disabled={saving || noOptions}>
          {saving ? <CircularProgress size={20} color="inherit" /> : isTransfer ? 'Transfer' : 'Place'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default PlaceLotDialog;
