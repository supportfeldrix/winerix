import { useEffect, useMemo, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, TextField, MenuItem,
  Button, Stack, CircularProgress, InputAdornment, Typography,
} from '@mui/material';
import { formatNumber } from '../common/formatters';

/**
 * "Rack" dialog — a permanent WineRix Cellar Processing operation.
 *
 * Racking moves a lot to another vessel and records a 'racking' production
 * event with an optional measured loss. It is distinct from the Current Vessel
 * "Transfer" action, which is a pure location move with no production event.
 *
 * Select a target vessel (the current vessel is excluded), optionally enter a
 * loss (litres) + notes, then confirm. The parent calls
 * lotLineageService.rackLot(lotId, toVesselId, lossLitres, notes), which invokes
 * the secured RPC via the authenticated session. The RPC handles placement,
 * loss (via the P2H ledger), event + correlation, and audit. No security or
 * volume values are computed here. Mirrors Start/End Fermentation conventions.
 *
 * @param {boolean} open
 * @param {object|null} lot - the lot being racked (for display + loss bound)
 * @param {Array} vesselOptions - active vessel options, current vessel already excluded by the parent
 * @param {boolean} optionsLoading
 * @param {boolean} saving
 * @param {function} onSubmit - ({ toVesselId, lossLitres, notes }) => void
 * @param {function} onClose
 */
function RackLotDialog({
  open, lot, vesselOptions = [], optionsLoading = false, saving = false, onSubmit, onClose,
}) {
  const [vesselId, setVesselId] = useState('');
  const [loss, setLoss] = useState('');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState({});

  const currentVolume = lot && lot.volumeLitres != null ? Number(lot.volumeLitres) : null;

  useEffect(() => {
    if (!open) return;
    setVesselId('');
    setLoss('');
    setNotes('');
    setErrors({});
  }, [open]);

  const noVessels = !optionsLoading && vesselOptions.length === 0;

  const lossError = useMemo(() => {
    if (loss === '') return undefined;
    const v = Number(loss);
    if (Number.isNaN(v)) return 'Loss must be a number.';
    if (v < 0) return 'Loss cannot be negative.';
    if (currentVolume != null && v > currentVolume) {
      return `Loss cannot exceed the lot's current volume (${formatNumber(currentVolume)} L).`;
    }
    if (v > 100000000) return 'Please enter a realistic volume.';
    return undefined;
  }, [loss, currentVolume]);

  const validate = () => {
    const next = {};
    if (!vesselId) next.vesselId = 'Please select a target vessel.';
    if (lossError) next.loss = lossError;
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (saving) return;
    if (!validate()) return;
    const parsed = loss === '' ? 0 : Number(loss);
    onSubmit({
      toVesselId: vesselId,
      lossLitres: parsed > 0 ? parsed : null,
      notes: notes.trim() || null,
    });
  };

  // Confirm enabled only when a target vessel is chosen, not submitting, and
  // the (optional) loss passes validation.
  const canConfirm = Boolean(vesselId) && !saving && !lossError;

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
      <DialogTitle>Rack Lot</DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          {lot && (
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              Lot <strong>{lot.lotCode}</strong>
              {currentVolume != null ? ` · ${formatNumber(currentVolume)} L` : ''}
              {' · moves the lot to another vessel and records a racking event.'}
            </Typography>
          )}

          {noVessels ? (
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              No other active vessels are available to rack into. Add an active vessel first.
            </Typography>
          ) : (
            <TextField
              label="Target Vessel"
              value={vesselId}
              onChange={(e) => { setVesselId(e.target.value); setErrors((p) => ({ ...p, vesselId: undefined })); }}
              error={Boolean(errors.vesselId)}
              helperText={errors.vesselId || (optionsLoading ? 'Loading vessels…' : 'Active vessels only (current vessel excluded)')}
              fullWidth
              select
              required
              disabled={saving || optionsLoading}
            >
              {vesselOptions.map((v) => (
                <MenuItem key={v.id} value={v.id}>
                  {[v.vesselCode, v.name].filter(Boolean).join('  ·  ')}
                  {v.capacityLitres != null ? `  ·  ${formatNumber(v.capacityLitres)} L` : ''}
                </MenuItem>
              ))}
            </TextField>
          )}

          <TextField
            label="Loss"
            type="number"
            value={loss}
            onChange={(e) => { setLoss(e.target.value); setErrors((p) => ({ ...p, loss: undefined })); }}
            error={Boolean(errors.loss || lossError)}
            helperText={errors.loss || lossError || 'Optional — measured volume lost during racking (default 0)'}
            fullWidth
            disabled={saving || noVessels}
            inputProps={{ min: 0, step: 'any' }}
            InputProps={{ endAdornment: <InputAdornment position="end">L</InputAdornment> }}
          />

          <TextField
            label="Notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            fullWidth
            disabled={saving || noVessels}
            multiline
            minRows={2}
            helperText="Optional"
          />
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        <Button onClick={onClose} color="inherit" disabled={saving}>Cancel</Button>
        <Button type="submit" variant="contained" color="primary" disabled={!canConfirm}>
          {saving ? <CircularProgress size={20} color="inherit" /> : 'Rack'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default RackLotDialog;
