import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Box, Paper, Typography, Button, Chip, Divider, Stack, Table, TableBody, TableCell,
  TableContainer, TableHead, TableRow, IconButton, Tooltip, Dialog, DialogTitle,
  DialogContent, DialogActions, TextField, MenuItem, InputAdornment, CircularProgress,
  Alert, LinearProgress,
} from '@mui/material';
import Inventory2OutlinedIcon from '@mui/icons-material/Inventory2Outlined';
import PlaylistAddCheckOutlinedIcon from '@mui/icons-material/PlaylistAddCheckOutlined';
import UndoOutlinedIcon from '@mui/icons-material/UndoOutlined';
import RefreshOutlinedIcon from '@mui/icons-material/RefreshOutlined';
import { formatNumber } from '../common/formatters';
import {
  getAllocationsBySalesOrder, allocateStockForSalesOrderLine, releaseStockAllocation,
  getAvailableStockForProductLocation, friendlyStockAllocationError,
} from '../../services/stockAllocationService';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Stock Allocation panel (P2L-6)
//
// Rendered inside the Sales Order profile for orders in the allocation flow
// (confirmed / partially_allocated / ready_to_dispatch). For each order line it
// shows ordered / allocated (open) / remaining, the open allocations (with the
// location + release action), and an Allocate dialog that lets an OWNER/ADMIN/
// SALES user reserve a partial quantity at a chosen ACTIVE location.
//
// Allocation NEVER reduces physical stock. Available = physical − reserved(open),
// computed from the database. All writes go through the secure RPCs in
// stockAllocationService; this component performs no direct ledger writes.
//
// Props:
//   orderId    sales order id
//   lines      normalised sales order lines (from salesOrderLineService)
//   currency   display currency (unused for bottle maths; kept for consistency)
//   locationOptions  active stock-location options [{ id, locationCode, name }]
//   canWrite   boolean — OWNER/ADMIN/SALES (gates allocate/release controls)
//   onChanged  callback(orderStatus?) after a successful allocate/release so the
//              parent can refresh the order header/status
// ─────────────────────────────────────────────────────────────────────────────

function lineLabel(line) {
  const name = line.productNameSnapshot || 'Product';
  return line.skuCodeSnapshot ? `${name} (${line.skuCodeSnapshot})` : name;
}

function StockAllocationPanel({ orderId, lines = [], locationOptions = [], canWrite = false, onChanged }) {
  const [allocations, setAllocations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Allocate dialog state.
  const [dialogLine, setDialogLine] = useState(null);
  const [locationId, setLocationId] = useState('');
  const [qty, setQty] = useState('');
  const [notes, setNotes] = useState('');
  const [avail, setAvail] = useState(null);       // { physical, reserved, available }
  const [availLoading, setAvailLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [dialogError, setDialogError] = useState('');

  // Release state.
  const [releasingId, setReleasingId] = useState(null);

  const loadAllocations = useCallback(async () => {
    if (!orderId) return;
    setLoading(true); setError('');
    const { data, error: err } = await getAllocationsBySalesOrder(orderId);
    if (err) setError(friendlyStockAllocationError(err));
    else setAllocations(data || []);
    setLoading(false);
  }, [orderId]);

  useEffect(() => { loadAllocations(); }, [loadAllocations]);

  // Open allocations grouped per line, plus per-line open totals.
  const openByLine = useMemo(() => {
    const map = new Map();
    for (const a of allocations) {
      if (a.status !== 'open') continue;
      if (!map.has(a.salesOrderLineId)) map.set(a.salesOrderLineId, []);
      map.get(a.salesOrderLineId).push(a);
    }
    return map;
  }, [allocations]);

  const openTotalForLine = useCallback(
    (lineId) => (openByLine.get(lineId) || []).reduce((s, a) => s + (Number(a.qtyBottles) || 0), 0),
    [openByLine]
  );

  const refreshAvailability = useCallback(async (productId, locId) => {
    if (!productId || !locId) { setAvail(null); return; }
    setAvailLoading(true);
    const { data, error: err } = await getAvailableStockForProductLocation(productId, locId);
    setAvailLoading(false);
    if (err) { setAvail(null); return; }
    setAvail(data);
  }, []);

  const openAllocateDialog = (line) => {
    setDialogLine(line);
    setLocationId('');
    setQty('');
    setNotes('');
    setAvail(null);
    setDialogError('');
  };
  const closeAllocateDialog = () => {
    if (submitting) return;
    setDialogLine(null);
  };

  const handleLocationChange = (e) => {
    const id = e.target.value;
    setLocationId(id);
    setDialogError('');
    if (dialogLine) refreshAvailability(dialogLine.finishedProductId, id);
  };

  const remainingForDialogLine = dialogLine
    ? Number(dialogLine.quantityBottles) - openTotalForLine(dialogLine.id)
    : 0;

  const qtyNum = Number(qty);
  const qtyValid = Number.isInteger(qtyNum) && qtyNum > 0;
  const exceedsRemaining = qtyValid && qtyNum > remainingForDialogLine;
  const exceedsAvailable = qtyValid && avail && qtyNum > avail.available;

  const handleAllocate = async () => {
    if (!dialogLine) return;
    setDialogError('');
    if (!locationId) { setDialogError('Please choose a stock location.'); return; }
    if (!qtyValid) { setDialogError('Enter a whole number of bottles greater than zero.'); return; }
    if (exceedsRemaining) { setDialogError(`Only ${formatNumber(remainingForDialogLine, { maximumFractionDigits: 0 })} bottles still need allocating on this line.`); return; }
    if (exceedsAvailable) { setDialogError(`Only ${formatNumber(avail.available, { maximumFractionDigits: 0 })} bottles are available at that location.`); return; }

    setSubmitting(true);
    const { data, error: err } = await allocateStockForSalesOrderLine(dialogLine.id, locationId, qtyNum, notes);
    setSubmitting(false);
    if (err) { setDialogError(friendlyStockAllocationError(err)); return; }
    setDialogLine(null);
    await loadAllocations();
    if (onChanged) onChanged(data ? data.orderStatus : undefined);
  };

  const handleRelease = async (allocationId) => {
    setReleasingId(allocationId);
    const { error: err } = await releaseStockAllocation(allocationId);
    setReleasingId(null);
    if (err) { setError(friendlyStockAllocationError(err)); return; }
    await loadAllocations();
    if (onChanged) onChanged();
  };

  return (
    <Paper variant="outlined" sx={{ borderRadius: 3, p: { xs: 2.5, md: 3.5 }, mt: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, mb: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
          <Box sx={{ width: 36, height: 36, borderRadius: 1.5, bgcolor: 'background.subtle', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'secondary.main' }}>
            <Inventory2OutlinedIcon />
          </Box>
          <Box>
            <Typography variant="h5" component="h2">Stock Allocation</Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              Reserves available stock. Physical stock is not reduced until dispatch.
            </Typography>
          </Box>
        </Box>
        <Tooltip title="Refresh allocations">
          <span>
            <IconButton onClick={loadAllocations} aria-label="Refresh allocations" disabled={loading}>
              <RefreshOutlinedIcon />
            </IconButton>
          </span>
        </Tooltip>
      </Box>

      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}
      {loading && <LinearProgress sx={{ mb: 2, borderRadius: 1 }} />}

      {lines.length === 0 ? (
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>This order has no lines to allocate.</Typography>
      ) : (
        <Stack spacing={2.5}>
          {lines.map((line) => {
            const ordered = Number(line.quantityBottles) || 0;
            const allocated = openTotalForLine(line.id);
            const remaining = ordered - allocated;
            const openRows = openByLine.get(line.id) || [];
            const fullyAllocated = remaining <= 0 && ordered > 0;
            return (
              <Paper key={line.id} variant="outlined" sx={{ borderRadius: 2, p: { xs: 2, md: 2.5 } }}>
                <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, alignItems: { xs: 'flex-start', sm: 'center' }, justifyContent: 'space-between', gap: 1.5 }}>
                  <Box>
                    <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>{lineLabel(line)}</Typography>
                    <Stack direction="row" spacing={2} sx={{ mt: 0.5 }} useFlexGap flexWrap="wrap">
                      <Metric label="Ordered" value={formatNumber(ordered, { maximumFractionDigits: 0 })} />
                      <Metric label="Allocated" value={formatNumber(allocated, { maximumFractionDigits: 0 })} />
                      <Metric label="Remaining" value={formatNumber(Math.max(0, remaining), { maximumFractionDigits: 0 })} emphasise={remaining > 0} />
                    </Stack>
                  </Box>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexShrink: 0 }}>
                    {fullyAllocated
                      ? <Chip label="Fully allocated" size="small" color="success" sx={{ fontWeight: 600 }} />
                      : <Chip label={`${formatNumber(Math.max(0, remaining), { maximumFractionDigits: 0 })} to allocate`} size="small" color="warning" sx={{ fontWeight: 600 }} />}
                    {canWrite && remaining > 0 && (
                      <Button
                        variant="outlined" color="primary" size="small"
                        startIcon={<PlaylistAddCheckOutlinedIcon />}
                        onClick={() => openAllocateDialog(line)}
                      >
                        Allocate Stock
                      </Button>
                    )}
                  </Box>
                </Box>

                {openRows.length > 0 && (
                  <>
                    <Divider sx={{ my: 1.5 }} />
                    <TableContainer>
                      <Table size="small" aria-label={`Open allocations for ${lineLabel(line)}`}>
                        <TableHead>
                          <TableRow>
                            <TableCell>Location</TableCell>
                            <TableCell align="right">Bottles</TableCell>
                            <TableCell>Status</TableCell>
                            {canWrite && <TableCell align="right">Actions</TableCell>}
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {openRows.map((a) => (
                            <TableRow key={a.id} hover>
                              <TableCell>
                                <Typography variant="body2" sx={{ color: 'text.primary' }}>
                                  {a.locationName || a.locationId}
                                </Typography>
                                {a.locationCode && <Typography variant="caption" sx={{ color: 'text.secondary' }}>{a.locationCode}</Typography>}
                              </TableCell>
                              <TableCell align="right"><Typography variant="body2" sx={{ fontWeight: 600 }}>{formatNumber(a.qtyBottles, { maximumFractionDigits: 0 })}</Typography></TableCell>
                              <TableCell><Chip label="Open" size="small" color="info" sx={{ fontWeight: 600 }} /></TableCell>
                              {canWrite && (
                                <TableCell align="right">
                                  <Tooltip title="Release allocation">
                                    <span>
                                      <IconButton
                                        size="small" color="warning"
                                        aria-label="Release allocation"
                                        onClick={() => handleRelease(a.id)}
                                        disabled={releasingId === a.id}
                                      >
                                        {releasingId === a.id ? <CircularProgress size={16} /> : <UndoOutlinedIcon fontSize="small" />}
                                      </IconButton>
                                    </span>
                                  </Tooltip>
                                </TableCell>
                              )}
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </TableContainer>
                  </>
                )}
              </Paper>
            );
          })}
        </Stack>
      )}

      {/* Allocate dialog */}
      <Dialog open={Boolean(dialogLine)} onClose={closeAllocateDialog} fullWidth maxWidth="sm">
        <DialogTitle>Allocate Stock</DialogTitle>
        <DialogContent>
          {dialogLine && (
            <Stack spacing={2.5} sx={{ mt: 1 }}>
              <Box>
                <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>{lineLabel(dialogLine)}</Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                  {formatNumber(remainingForDialogLine, { maximumFractionDigits: 0 })} of {formatNumber(dialogLine.quantityBottles, { maximumFractionDigits: 0 })} bottles still to allocate
                </Typography>
              </Box>

              {dialogError && <Alert severity="error">{dialogError}</Alert>}

              <TextField
                label="Stock Location" value={locationId} onChange={handleLocationChange}
                select fullWidth required
                helperText={locationOptions.length === 0 ? 'No active stock locations' : 'Choose where to reserve from'}
              >
                {locationOptions.length === 0 ? (
                  <MenuItem value="" disabled><em>No active stock locations</em></MenuItem>
                ) : (
                  locationOptions.map((l) => (
                    <MenuItem key={l.id} value={l.id}>
                      {l.name}{l.locationCode ? ` — ${l.locationCode}` : ''}
                    </MenuItem>
                  ))
                )}
              </TextField>

              {locationId && (
                <Box sx={{ p: 1.5, borderRadius: 2, bgcolor: 'background.subtle' }}>
                  {availLoading ? (
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <CircularProgress size={16} />
                      <Typography variant="body2" sx={{ color: 'text.secondary' }}>Checking availability…</Typography>
                    </Box>
                  ) : avail ? (
                    <Stack direction="row" spacing={3} useFlexGap flexWrap="wrap">
                      <Metric label="Physical" value={formatNumber(avail.physical, { maximumFractionDigits: 0 })} />
                      <Metric label="Reserved" value={formatNumber(avail.reserved, { maximumFractionDigits: 0 })} />
                      <Metric label="Available" value={formatNumber(avail.available, { maximumFractionDigits: 0 })} emphasise />
                    </Stack>
                  ) : (
                    <Typography variant="body2" sx={{ color: 'text.secondary' }}>No availability data.</Typography>
                  )}
                  <Typography variant="caption" sx={{ color: 'text.disabled', display: 'block', mt: 0.5 }}>
                    Physical stock is not reduced by allocation. Available = physical − open reservations.
                  </Typography>
                </Box>
              )}

              <TextField
                label="Quantity (bottles)" type="number" value={qty}
                onChange={(e) => { setQty(e.target.value); setDialogError(''); }}
                fullWidth required inputProps={{ step: 1, min: 1 }}
                error={exceedsRemaining || exceedsAvailable}
                helperText={
                  exceedsRemaining ? 'More than the line still needs.'
                    : exceedsAvailable ? 'More than is available at this location.'
                    : 'Whole bottles, > 0. Partial allocation is allowed.'
                }
                InputProps={{ endAdornment: <InputAdornment position="end">bottles</InputAdornment> }}
              />

              <TextField
                label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)}
                helperText="Optional" fullWidth multiline minRows={2}
              />
            </Stack>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2.5 }}>
          <Button onClick={closeAllocateDialog} color="inherit" disabled={submitting}>Cancel</Button>
          <Button
            onClick={handleAllocate} variant="contained" color="primary"
            disabled={submitting || !locationId || !qtyValid || exceedsRemaining || exceedsAvailable || availLoading}
          >
            {submitting ? <CircularProgress size={20} color="inherit" /> : 'Allocate'}
          </Button>
        </DialogActions>
      </Dialog>
    </Paper>
  );
}

function Metric({ label, value, emphasise }) {
  return (
    <Box>
      <Typography variant="overline" sx={{ color: 'text.disabled', letterSpacing: '0.06em', lineHeight: 1.4 }}>{label}</Typography>
      <Typography variant="body1" sx={{ color: emphasise ? 'primary.main' : 'text.primary', fontWeight: emphasise ? 700 : 600 }}>{value}</Typography>
    </Box>
  );
}

export default StockAllocationPanel;
