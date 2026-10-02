import { useEffect, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, TextField,
  Button, Stack, CircularProgress, InputAdornment, Typography,
} from '@mui/material';
import { formatNumber } from '../common/formatters';

/**
 * "End Fermentation" dialog — a permanent WineRix Cellar Processing operation.
 *
 * Enter an optional measured loss (litres) + notes, then confirm. The parent
 * calls lotLineageService.endFermentation(lotId, lossLitres, notes), which
 * invokes the secured RPC via the authenticated session. The RPC transitions
 * processing_state fermenting -> settling, records any loss through the P2H
 * ledger, and leaves the vessel placement unchanged. No security or volume
 * values are computed here. Mirrors StartFermentationDialog conventions.
 *
 * @param {boolean} open
 * @param {object|null} lot - the fermenting lot (for display + loss bound)
 * @param {boolean} saving
 * @param {function} onSubmit - ({ lossLitres, notes }) => void
 * @param {function} onClose
 */
function EndFermentationDialog({ open, lot, saving = false, onSubmit, onClose }) {
  const [loss, setLoss] = useState('');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState({});

  const currentVolume = lot && lot.volumeLitres != null ? Number(lot.volumeLitres) : null;

  useEffect(() => {
    if (!open) return;
    setLoss('');
    setNotes('');
    setErrors({});
  }, [open]);

  const validate = () => {
    const next = {};
    // Loss is optional (default 0 = no loss). Validate only when provided.
    if (loss !== '') {
      const v = Number(loss);
      if (Number.isNaN(v)) next.loss = 'Loss must be a number.';
      else if (v < 0) next.loss = 'Loss cannot be negative.';
      else if (currentVolume != null && v > currentVolume) {
        next.loss = `Loss cannot exceed the lot's current volume (${formatNumber(currentVolume)} L).`;
      } else if (v > 100000000) next.loss = 'Please enter a realistic volume.';
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (saving) return;
    if (!validate()) return;
    // Empty or 0 -> no loss (send null so the RPC records no loss movement).
    const parsed = loss === '' ? 0 : Number(loss);
    onSubmit({
      lossLitres: parsed > 0 ? parsed : null,
      notes: notes.trim() || null,
    });
  };

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
      <DialogTitle>End Fermentation</DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          {lot && (
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              Lot <strong>{lot.lotCode}</strong>
              {currentVolume != null ? ` · ${formatNumber(currentVolume)} L` : ''}
              {' · fermentation will move to settling.'}
            </Typography>
          )}

          <TextField
            label="Loss"
            type="number"
            value={loss}
            onChange={(e) => { setLoss(e.target.value); setErrors((p) => ({ ...p, loss: undefined })); }}
            error={Boolean(errors.loss)}
            helperText={errors.loss || 'Optional — measured volume lost (default 0)'}
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
        <Button type="submit" variant="contained" color="primary" disabled={saving}>
          {saving ? <CircularProgress size={20} color="inherit" /> : 'End Fermentation'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default EndFermentationDialog;
