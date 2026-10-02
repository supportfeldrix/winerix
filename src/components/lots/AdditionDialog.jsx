import { useEffect, useMemo, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, TextField,
  Button, Stack, CircularProgress, InputAdornment, Typography,
} from '@mui/material';
import { formatNumber } from '../common/formatters';

// Practical upper bound for a single addition (litres) — UX guard only to catch
// obviously accidental input. NOT a database/business rule; the RPC/P2H ledger
// remains authoritative. Matches the realistic-volume cap used elsewhere.
const MAX_ADDITION_LITRES = 100000000;

/**
 * "Addition" dialog — a permanent WineRix Cellar Processing operation.
 *
 * Addition records an 'addition' production event representing material/liquid
 * added to the lot, and applies the positive volume change through the P2H
 * ledger. It is DISTINCT from the corrective Adjustment action (different
 * production_events.event_type) — do not conflate them.
 *
 * Fields are intentionally minimal: Addition Volume (L) and Notes. There is NO
 * vessel, lineage, ingredient, processing-state, or adjustment-type selector.
 * The parent calls lotLineageService.addToLot(lotId, volumeLitres, notes),
 * which invokes the secured RPC via the authenticated session. No security or
 * volume values are computed here. Mirrors the other cellar dialogs.
 *
 * @param {boolean} open
 * @param {object|null} lot - the lot receiving the addition (for display)
 * @param {boolean} saving
 * @param {function} onSubmit - ({ volumeLitres, notes }) => void
 * @param {function} onClose
 */
function AdditionDialog({ open, lot, saving = false, onSubmit, onClose }) {
  const [volume, setVolume] = useState('');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState({});

  const currentVolume = lot && lot.volumeLitres != null ? Number(lot.volumeLitres) : null;

  useEffect(() => {
    if (!open) return;
    setVolume('');
    setNotes('');
    setErrors({});
  }, [open]);

  // Addition requires a positive volume (an addition increases the lot).
  const volumeError = useMemo(() => {
    if (volume === '') return 'Addition volume is required.';
    const v = Number(volume);
    if (Number.isNaN(v)) return 'Volume must be a number.';
    if (v <= 0) return 'Addition volume must be greater than zero.';
    if (v > MAX_ADDITION_LITRES) return 'Please enter a realistic volume.';
    return undefined;
  }, [volume]);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (saving) return;
    if (volumeError) { setErrors({ volume: volumeError }); return; }
    onSubmit({ volumeLitres: Number(volume), notes: notes.trim() || null });
  };

  const canConfirm = !saving && !volumeError;

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
      <DialogTitle>Record Addition</DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          {lot && (
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              Lot <strong>{lot.lotCode}</strong>
              {currentVolume != null ? ` · ${formatNumber(currentVolume)} L` : ''}
              {' · records an addition and increases the lot volume.'}
            </Typography>
          )}

          <TextField
            label="Addition Volume"
            type="number"
            value={volume}
            onChange={(e) => { setVolume(e.target.value); setErrors((p) => ({ ...p, volume: undefined })); }}
            error={Boolean(errors.volume || volumeError)}
            helperText={errors.volume || volumeError || 'Required — volume added to the lot'}
            fullWidth
            required
            autoFocus
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
          {saving ? <CircularProgress size={20} color="inherit" /> : 'Record Addition'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default AdditionDialog;
