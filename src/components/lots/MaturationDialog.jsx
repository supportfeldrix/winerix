import { useEffect, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, TextField,
  Button, Stack, CircularProgress, Typography,
} from '@mui/material';

/**
 * "Start Maturation" dialog — a permanent WineRix Cellar Processing operation.
 *
 * Maturation is a controlled processing-state transition (→ maturing) plus a
 * 'maturation' production event. It does NOT move the lot, change volume, or
 * change lineage — so the dialog has Notes only (no vessel/volume/loss/state
 * selectors). The parent calls lotLineageService.startMaturation(lotId, notes),
 * which invokes the secured RPC via the authenticated session; the RPC performs
 * the atomic transition. Mirrors EndFermentationDialog conventions.
 *
 * @param {boolean} open
 * @param {object|null} lot - the lot entering maturation (for display)
 * @param {boolean} saving
 * @param {function} onSubmit - ({ notes }) => void
 * @param {function} onClose
 */
function MaturationDialog({ open, lot, saving = false, onSubmit, onClose }) {
  const [notes, setNotes] = useState('');

  useEffect(() => {
    if (!open) return;
    setNotes('');
  }, [open]);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (saving) return;
    onSubmit({ notes: notes.trim() || null });
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
      <DialogTitle>Start Maturation</DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          {lot && (
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              Lot <strong>{lot.lotCode}</strong>
              {' · moves the lot into maturation. Volume, vessel and lineage are unchanged.'}
            </Typography>
          )}

          <TextField
            label="Notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            fullWidth
            autoFocus
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
          {saving ? <CircularProgress size={20} color="inherit" /> : 'Start Maturation'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default MaturationDialog;
