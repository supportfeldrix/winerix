import { useEffect, useMemo, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, TextField, MenuItem,
  Button, Stack, CircularProgress, InputAdornment, Typography,
} from '@mui/material';
import { formatNumber } from '../common/formatters';

// Sentinel for the "filter in place" (no target vessel) option.
const IN_PLACE = '';

/**
 * "Filtration" dialog — a permanent WineRix Cellar Processing operation.
 *
 * Filtration records a 'filtration' production event. A target vessel is
 * OPTIONAL: choosing "None (filter in place)" keeps the lot in its current
 * vessel (no placement change); choosing a vessel moves the lot there. An
 * optional loss is recorded through the P2H ledger. It is distinct from the
 * Current Vessel "Transfer" action (a pure location move with no event).
 *
 * The parent calls lotLineageService.filterLot(lotId, toVesselId, lossLitres,
 * notes), which invokes the secured RPC via the authenticated session. The RPC
 * handles placement, loss, event + correlation, and audit. No security or
 * volume values are computed here. Mirrors RackLotDialog conventions.
 *
 * @param {boolean} open
 * @param {object|null} lot - the lot being filtered (for display + loss bound)
 * @param {Array} vesselOptions - active vessel options, current vessel already excluded by the parent
 * @param {boolean} optionsLoading
 * @param {boolean} saving
 * @param {function} onSubmit - ({ toVesselId, lossLitres, notes }) => void
 * @param {function} onClose
 */
function FiltrationDialog({
  open, lot, vesselOptions = [], optionsLoading = false, saving = false, onSubmit, onClose,
}) {
  const [vesselId, setVesselId] = useState(IN_PLACE); // '' = filter in place
  const [loss, setLoss] = useState('');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState({});

  const currentVolume = lot && lot.volumeLitres != null ? Number(lot.volumeLitres) : null;

  useEffect(() => {
    if (!open) return;
    setVesselId(IN_PLACE);
    setLoss('');
    setNotes('');
    setErrors({});
  }, [open]);

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
      // '' sentinel -> null (filter in place).
      toVesselId: vesselId || null,
      lossLitres: parsed > 0 ? parsed : null,
      notes: notes.trim() || null,
    });
  };

  // Nothing is required for a filtration; confirm is gated only on validity.
  const canConfirm = !saving && !lossError;

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
      <DialogTitle>Filter Lot</DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          {lot && (
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              Lot <strong>{lot.lotCode}</strong>
              {currentVolume != null ? ` · ${formatNumber(currentVolume)} L` : ''}
              {' · records a filtration event; optionally moves the lot and records loss.'}
            </Typography>
          )}

          <TextField
            label="Target Vessel"
            value={vesselId}
            onChange={(e) => setVesselId(e.target.value)}
            helperText={optionsLoading ? 'Loading vessels…' : 'Optional — leave as "None" to filter in place'}
            fullWidth
            select
            disabled={saving || optionsLoading}
          >
            <MenuItem value={IN_PLACE}><em>None (filter in place)</em></MenuItem>
            {vesselOptions.map((v) => (
              <MenuItem key={v.id} value={v.id}>
                {[v.vesselCode, v.name].filter(Boolean).join('  ·  ')}
                {v.capacityLitres != null ? `  ·  ${formatNumber(v.capacityLitres)} L` : ''}
              </MenuItem>
            ))}
          </TextField>

          <TextField
            label="Loss"
            type="number"
            value={loss}
            onChange={(e) => { setLoss(e.target.value); setErrors((p) => ({ ...p, loss: undefined })); }}
            error={Boolean(errors.loss || lossError)}
            helperText={errors.loss || lossError || 'Optional — measured volume lost during filtration (default 0)'}
            fullWidth
            disabled={saving}
            inputProps={{ min: 0, step: 'any' }}
            InputProps={{ endAdornment: <InputAdornment position="end">L</InputAdornment> }}
          />

          <TextField
            label="Notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            fullWidth
            disabled={saving}
            multiline
            minRows={2}
            helperText="Optional"
          />
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        <Button onClick={onClose} color="inherit" disabled={saving}>Cancel</Button>
        <Button type="submit" variant="contained" color="primary" disabled={!canConfirm}>
          {saving ? <CircularProgress size={20} color="inherit" /> : 'Filter'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default FiltrationDialog;
