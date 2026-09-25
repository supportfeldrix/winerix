import { useEffect, useMemo, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, TextField, MenuItem,
  Button, Stack, CircularProgress,
} from '@mui/material';
import { PRODUCTION_EVENT_TYPES } from '../../services/productionEventService';
import { formatDate } from '../common/formatters';

const NONE = '';

/**
 * Add Production Event dialog (create-only — events are immutable history).
 *
 * The parent (Wine Lot Profile) already knows the wine lot, so there is no lot
 * selector and no volume field. Fields: event type + date/time (required),
 * optional vessel, optional placement (only when a vessel is selected and only
 * placements belonging to THIS lot AND that vessel are offered), and notes.
 *
 * Calls onSubmit with { eventType, eventAt (ISO), vesselId|null,
 * vesselPlacementId|null, notes|null }. The parent performs the Supabase write
 * and controls `saving` and `open`. Mirrors PlaceLotDialog / WineLotForm.
 *
 * @param {boolean} open
 * @param {Array} vesselOptions - active vessel options ({ id, vesselCode, name })
 * @param {Array} lotPlacements - this lot's placements ({ id, vesselId, vesselCode, placedAt, isOpen })
 * @param {boolean} optionsLoading
 * @param {boolean} saving
 * @param {function} onSubmit
 * @param {function} onClose
 */
function ProductionEventForm({
  open, vesselOptions = [], lotPlacements = [], optionsLoading = false,
  saving = false, onSubmit, onClose,
}) {
  const [eventType, setEventType] = useState('transfer');
  const [eventAt, setEventAt] = useState('');
  const [vesselId, setVesselId] = useState(NONE);
  const [vesselPlacementId, setVesselPlacementId] = useState(NONE);
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (!open) return;
    setEventType('transfer');
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    setEventAt(`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`);
    setVesselId(NONE);
    setVesselPlacementId(NONE);
    setNotes('');
    setErrors({});
  }, [open]);

  // Placements selectable for the chosen vessel and this lot only.
  const selectablePlacements = useMemo(
    () => (vesselId ? lotPlacements.filter((p) => p.vesselId === vesselId) : []),
    [lotPlacements, vesselId]
  );

  // Changing the vessel clears any placement that no longer matches.
  const handleVesselChange = (e) => {
    const next = e.target.value;
    setVesselId(next);
    setVesselPlacementId((prev) => {
      if (!next) return NONE;
      const stillValid = lotPlacements.some((p) => p.id === prev && p.vesselId === next);
      return stillValid ? prev : NONE;
    });
    setErrors((prev) => ({ ...prev, vesselId: undefined }));
  };

  const validate = () => {
    const next = {};
    if (!eventType) next.eventType = 'Please select an event type.';
    if (!eventAt) next.eventAt = 'Please choose a date and time.';
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (saving) return;
    if (!validate()) return;
    onSubmit({
      eventType,
      eventAt: new Date(eventAt).toISOString(),
      vesselId: vesselId || null,
      vesselPlacementId: vesselId ? (vesselPlacementId || null) : null,
      notes: notes.trim() || null,
    });
  };

  const placementLabel = (p) => {
    const bits = [formatDate(p.placedAt)];
    if (p.isOpen) bits.push('current');
    return bits.join('  ·  ');
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
      <DialogTitle>Add Production Event</DialogTitle>

      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          <TextField
            label="Event Type"
            value={eventType}
            onChange={(e) => { setEventType(e.target.value); setErrors((p) => ({ ...p, eventType: undefined })); }}
            error={Boolean(errors.eventType)}
            helperText={errors.eventType || ' '}
            fullWidth
            select
            required
            disabled={saving}
          >
            {PRODUCTION_EVENT_TYPES.map((t) => (
              <MenuItem key={t.value} value={t.value}>{t.label}</MenuItem>
            ))}
          </TextField>

          <TextField
            label="Date & Time"
            type="datetime-local"
            value={eventAt}
            onChange={(e) => { setEventAt(e.target.value); setErrors((p) => ({ ...p, eventAt: undefined })); }}
            error={Boolean(errors.eventAt)}
            helperText={errors.eventAt || ' '}
            fullWidth
            required
            disabled={saving}
            InputLabelProps={{ shrink: true }}
          />

          <TextField
            label="Vessel"
            value={vesselId}
            onChange={handleVesselChange}
            helperText={optionsLoading ? 'Loading vessels…' : 'Optional — active vessels only'}
            fullWidth
            select
            disabled={saving || optionsLoading}
          >
            <MenuItem value={NONE}><em>None</em></MenuItem>
            {vesselOptions.map((v) => (
              <MenuItem key={v.id} value={v.id}>
                {[v.vesselCode, v.name].filter(Boolean).join('  ·  ')}
              </MenuItem>
            ))}
          </TextField>

          {vesselId && (
            <TextField
              label="Vessel Placement"
              value={vesselPlacementId}
              onChange={(e) => setVesselPlacementId(e.target.value)}
              helperText={
                selectablePlacements.length === 0
                  ? 'This lot has no placements in the selected vessel'
                  : 'Optional — this lot’s placements in the selected vessel'
              }
              fullWidth
              select
              disabled={saving || selectablePlacements.length === 0}
            >
              <MenuItem value={NONE}><em>None</em></MenuItem>
              {selectablePlacements.map((p) => (
                <MenuItem key={p.id} value={p.id}>{placementLabel(p)}</MenuItem>
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
        <Button type="submit" variant="contained" color="primary" disabled={saving}>
          {saving ? <CircularProgress size={20} color="inherit" /> : 'Add Event'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default ProductionEventForm;
