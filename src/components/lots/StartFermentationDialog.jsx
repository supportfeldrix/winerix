import { useEffect, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, TextField, MenuItem,
  Button, Stack, CircularProgress, Typography,
} from '@mui/material';
import { formatNumber } from '../common/formatters';

/**
 * "Start Fermentation" dialog — the first permanent WineRix Cellar Processing
 * operation.
 *
 * Select an active vessel + notes, then confirm. The parent calls
 * lotLineageService.startFermentation(lotId, vesselId, notes) which invokes the
 * secured RPC via the authenticated session. No security values are set here.
 *
 * @param {boolean} open
 * @param {object|null} lot - the lot being fermented (for display)
 * @param {Array} vesselOptions - active vessel options ({ id, vesselCode, name, capacityLitres })
 * @param {boolean} optionsLoading
 * @param {boolean} saving
 * @param {function} onSubmit - ({ vesselId, notes }) => void
 * @param {function} onClose
 */
function StartFermentationDialog({
  open, lot, vesselOptions = [], optionsLoading = false, saving = false, onSubmit, onClose,
}) {
  const [vesselId, setVesselId] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setVesselId('');
    setNotes('');
    setError('');
  }, [open]);

  const noVessels = !optionsLoading && vesselOptions.length === 0;

  const handleSubmit = (e) => {
    e.preventDefault();
    if (saving) return;
    if (!vesselId) { setError('Please select a vessel.'); return; }
    onSubmit({ vesselId, notes: notes.trim() || null });
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
      <DialogTitle>Start Fermentation</DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          {lot && (
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              Lot <strong>{lot.lotCode}</strong>
              {lot.volumeLitres != null ? ` · ${formatNumber(lot.volumeLitres)} L` : ''}
            </Typography>
          )}

          {noVessels ? (
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              No active vessels are available. Add a vessel with status Active first.
            </Typography>
          ) : (
            <TextField
              label="Vessel"
              value={vesselId}
              onChange={(e) => { setVesselId(e.target.value); setError(''); }}
              error={Boolean(error)}
              helperText={error || (optionsLoading ? 'Loading vessels…' : 'Active vessels only')}
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
        <Button type="submit" variant="contained" color="primary" disabled={saving || noVessels}>
          {saving ? <CircularProgress size={20} color="inherit" /> : 'Start Fermentation'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default StartFermentationDialog;
