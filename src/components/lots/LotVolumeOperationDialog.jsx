import { useEffect, useMemo, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, TextField, Button, Stack,
  CircularProgress, InputAdornment, Box, Typography, IconButton, MenuItem, Alert, Divider,
} from '@mui/material';
import AddOutlinedIcon from '@mui/icons-material/AddOutlined';
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined';
import { formatNumber } from '../common/formatters';

// ─────────────────────────────────────────────────────────────────────────────
// Focused dialog for the five wine-lot volume operations. `mode` selects the
// form shape:
//   'split'      — parent (this lot) → N children (code + volume each)
//   'merge'      — this lot + other source lots → new lot
//   'blend'      — same as merge, relation_type = blend
//   'loss'       — positive volume removed from this lot
//   'adjustment' — signed delta on this lot
//
// Volume is always entered by the user for the amounts moved, but the lot's
// resulting balance is computed server-side (this dialog never writes volume
// directly). onSubmit receives a mode-specific payload; the parent calls the
// matching lotLineageService function.
// ─────────────────────────────────────────────────────────────────────────────

function LotVolumeOperationDialog({
  open, mode, lot, otherLots = [], saving = false, onSubmit, onClose,
}) {
  const isCombine = mode === 'merge' || mode === 'blend';
  const currentVolume = lot ? Number(lot.volumeLitres) || 0 : 0;

  // split state: list of { lotCode, volumeLitres }
  const [children, setChildren] = useState([{ lotCode: '', volumeLitres: '' }]);
  // combine state
  const [newLotCode, setNewLotCode] = useState('');
  const [sources, setSources] = useState([]); // { lotId, volumeLitres }
  // loss / adjustment
  const [amount, setAmount] = useState('');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (!open) return;
    setChildren([{ lotCode: '', volumeLitres: '' }]);
    setNewLotCode('');
    // For combine, this lot is always the first source (fixed), plus user adds others.
    setSources(isCombine && lot ? [{ lotId: lot.id, volumeLitres: '' }] : []);
    setAmount('');
    setNotes('');
    setErrors({});
  }, [open, mode, lot, isCombine]);

  const title = useMemo(() => ({
    split: 'Split Wine Lot',
    merge: 'Merge Wine Lots',
    blend: 'Blend Wine Lots',
    loss: 'Record Loss',
    adjustment: 'Record Adjustment',
  }[mode] || 'Lot Operation'), [mode]);

  const submitLabel = useMemo(() => ({
    split: 'Split', merge: 'Merge', blend: 'Blend', loss: 'Record Loss', adjustment: 'Record Adjustment',
  }[mode] || 'Confirm'), [mode]);

  // ── split helpers ──
  const splitTotal = children.reduce((s, c) => s + (Number(c.volumeLitres) || 0), 0);
  const setChild = (i, field, val) => setChildren((prev) => prev.map((c, idx) => idx === i ? { ...c, [field]: val } : c));
  const addChild = () => setChildren((prev) => [...prev, { lotCode: '', volumeLitres: '' }]);
  const removeChild = (i) => setChildren((prev) => prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev);

  // ── combine helpers ──
  const availableOthers = otherLots.filter((l) => !sources.some((s) => s.lotId === l.id) || false);
  const setSource = (i, field, val) => setSources((prev) => prev.map((s, idx) => idx === i ? { ...s, [field]: val } : s));
  const addSource = () => setSources((prev) => [...prev, { lotId: '', volumeLitres: '' }]);
  const removeSource = (i) => setSources((prev) => prev.filter((_, idx) => idx !== i));
  const combineTotal = sources.reduce((s, x) => s + (Number(x.volumeLitres) || 0), 0);

  const lotLabel = (id) => {
    if (lot && id === lot.id) return `${lot.lotCode} (this lot)`;
    const o = otherLots.find((l) => l.id === id);
    return o ? o.lotCode : '';
  };

  const validate = () => {
    const next = {};
    if (mode === 'split') {
      if (splitTotal > currentVolume) next.total = `Total split (${formatNumber(splitTotal)} L) exceeds this lot (${formatNumber(currentVolume)} L).`;
      children.forEach((c, i) => {
        if (!c.lotCode.trim()) next[`code_${i}`] = 'Required';
        const v = Number(c.volumeLitres);
        if (c.volumeLitres === '' || Number.isNaN(v) || v < 0) next[`vol_${i}`] = 'Invalid';
      });
    } else if (isCombine) {
      if (!newLotCode.trim()) next.newLotCode = 'A new lot code is required.';
      if (sources.length < 2) next.sources = 'Select at least two source lots.';
      sources.forEach((s, i) => {
        if (!s.lotId) next[`src_${i}`] = 'Required';
        const v = Number(s.volumeLitres);
        if (s.volumeLitres === '' || Number.isNaN(v) || v <= 0) next[`srcvol_${i}`] = 'Invalid';
      });
      // duplicate source lots
      const ids = sources.map((s) => s.lotId).filter(Boolean);
      if (new Set(ids).size !== ids.length) next.sources = 'Each source lot can only be selected once.';
    } else if (mode === 'loss') {
      const v = Number(amount);
      if (amount === '' || Number.isNaN(v) || v <= 0) next.amount = 'Enter a volume greater than zero.';
      else if (v > currentVolume) next.amount = `Loss exceeds current volume (${formatNumber(currentVolume)} L).`;
    } else if (mode === 'adjustment') {
      const v = Number(amount);
      if (amount === '' || Number.isNaN(v) || v === 0) next.amount = 'Enter a non-zero adjustment (use - for a decrease).';
      else if (currentVolume + v < 0) next.amount = `Adjustment would take volume below zero (current ${formatNumber(currentVolume)} L).`;
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (saving) return;
    if (!validate()) return;

    if (mode === 'split') {
      onSubmit({
        children: children.map((c) => ({ lotCode: c.lotCode.trim(), volumeLitres: Number(c.volumeLitres), notes: null })),
        notes: notes.trim() || null,
      });
    } else if (isCombine) {
      onSubmit({
        sources: sources.map((s) => ({ lotId: s.lotId, volumeLitres: Number(s.volumeLitres) })),
        newLotCode: newLotCode.trim(),
        notes: notes.trim() || null,
      });
    } else if (mode === 'loss') {
      onSubmit({ volume: Number(amount), notes: notes.trim() || null });
    } else if (mode === 'adjustment') {
      onSubmit({ delta: Number(amount), notes: notes.trim() || null });
    }
  };

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} fullWidth maxWidth="sm" component="form" onSubmit={handleSubmit} noValidate>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            Current volume: <strong>{formatNumber(currentVolume)} L</strong>
          </Typography>

          {mode === 'split' && (
            <>
              {errors.total && <Alert severity="error">{errors.total}</Alert>}
              {children.map((c, i) => (
                <Stack key={i} direction="row" spacing={1.5} alignItems="flex-start">
                  <TextField
                    label={`Child ${i + 1} code`} value={c.lotCode}
                    onChange={(e) => setChild(i, 'lotCode', e.target.value)}
                    error={Boolean(errors[`code_${i}`])} helperText={errors[`code_${i}`] || ' '}
                    fullWidth disabled={saving} placeholder="e.g. LOT-...-A"
                  />
                  <TextField
                    label="Volume" type="number" value={c.volumeLitres}
                    onChange={(e) => setChild(i, 'volumeLitres', e.target.value)}
                    error={Boolean(errors[`vol_${i}`])} helperText={errors[`vol_${i}`] || ' '}
                    sx={{ maxWidth: 150 }} disabled={saving}
                    inputProps={{ min: 0, step: 'any' }}
                    InputProps={{ endAdornment: <InputAdornment position="end">L</InputAdornment> }}
                  />
                  <IconButton aria-label="Remove child" onClick={() => removeChild(i)} disabled={saving || children.length === 1} sx={{ mt: 1 }}>
                    <DeleteOutlineOutlinedIcon fontSize="small" />
                  </IconButton>
                </Stack>
              ))}
              <Button startIcon={<AddOutlinedIcon />} onClick={addChild} disabled={saving} sx={{ alignSelf: 'flex-start' }}>Add child lot</Button>
              <Divider />
              <Typography variant="body2" sx={{ color: splitTotal > currentVolume ? 'error.main' : 'text.secondary' }}>
                Total to split out: <strong>{formatNumber(splitTotal)} L</strong> · Remaining in this lot: <strong>{formatNumber(currentVolume - splitTotal)} L</strong>
              </Typography>
            </>
          )}

          {isCombine && (
            <>
              {errors.sources && <Alert severity="error">{errors.sources}</Alert>}
              {sources.map((s, i) => {
                const fixed = lot && s.lotId === lot.id && i === 0;
                return (
                  <Stack key={i} direction="row" spacing={1.5} alignItems="flex-start">
                    <TextField
                      label={`Source ${i + 1}`} value={s.lotId}
                      onChange={(e) => setSource(i, 'lotId', e.target.value)}
                      error={Boolean(errors[`src_${i}`])} helperText={errors[`src_${i}`] || (fixed ? 'This lot' : ' ')}
                      select fullWidth disabled={saving || fixed}
                    >
                      {fixed && <MenuItem value={lot.id}>{lotLabel(lot.id)}</MenuItem>}
                      {!fixed && otherLots.map((o) => (
                        <MenuItem key={o.id} value={o.id}>{o.lotCode}{o.volumeLitres != null ? `  ·  ${formatNumber(o.volumeLitres)} L` : ''}</MenuItem>
                      ))}
                    </TextField>
                    <TextField
                      label="Volume" type="number" value={s.volumeLitres}
                      onChange={(e) => setSource(i, 'volumeLitres', e.target.value)}
                      error={Boolean(errors[`srcvol_${i}`])} helperText={errors[`srcvol_${i}`] || ' '}
                      sx={{ maxWidth: 150 }} disabled={saving}
                      inputProps={{ min: 0, step: 'any' }}
                      InputProps={{ endAdornment: <InputAdornment position="end">L</InputAdornment> }}
                    />
                    <IconButton aria-label="Remove source" onClick={() => removeSource(i)} disabled={saving || fixed} sx={{ mt: 1 }}>
                      <DeleteOutlineOutlinedIcon fontSize="small" />
                    </IconButton>
                  </Stack>
                );
              })}
              <Button startIcon={<AddOutlinedIcon />} onClick={addSource} disabled={saving} sx={{ alignSelf: 'flex-start' }}>Add source lot</Button>
              <Divider />
              <TextField
                label="New Lot Code" value={newLotCode} onChange={(e) => setNewLotCode(e.target.value)}
                error={Boolean(errors.newLotCode)} helperText={errors.newLotCode || `Resulting volume: ${formatNumber(combineTotal)} L`}
                fullWidth required disabled={saving} placeholder="e.g. BLEND-2026-01"
              />
            </>
          )}

          {(mode === 'loss' || mode === 'adjustment') && (
            <TextField
              label={mode === 'loss' ? 'Volume lost' : 'Adjustment (use - to decrease)'}
              type="number" value={amount} onChange={(e) => setAmount(e.target.value)}
              error={Boolean(errors.amount)} helperText={errors.amount || (mode === 'loss' ? 'Positive litres removed' : 'Signed litres, e.g. -25 or 10')}
              fullWidth required disabled={saving}
              inputProps={mode === 'loss' ? { min: 0, step: 'any' } : { step: 'any' }}
              InputProps={{ endAdornment: <InputAdornment position="end">L</InputAdornment> }}
            />
          )}

          <TextField label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} fullWidth disabled={saving} multiline minRows={2} helperText="Optional" />
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        <Button onClick={onClose} color="inherit" disabled={saving}>Cancel</Button>
        <Button type="submit" variant="contained" color="primary" disabled={saving}>
          {saving ? <CircularProgress size={20} color="inherit" /> : submitLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default LotVolumeOperationDialog;
