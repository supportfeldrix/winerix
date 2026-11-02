import { useEffect, useMemo, useState, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Box, Typography, TextField, InputAdornment, MenuItem, Paper,
  Skeleton, Alert, Button, Stack,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Chip,
  IconButton, Tooltip, Link,
  Dialog, DialogTitle, DialogContent, DialogActions, Divider,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import SearchOutlinedIcon from '@mui/icons-material/SearchOutlined';
import OpenInNewOutlinedIcon from '@mui/icons-material/OpenInNewOutlined';
import AssignmentReturnOutlinedIcon from '@mui/icons-material/AssignmentReturnOutlined';
import AddOutlinedIcon from '@mui/icons-material/AddOutlined';
import PageContainer from '../components/layout/PageContainer';
import { useOrganisation } from '../context/OrganisationContext';
import { formatDate } from '../components/common/formatters';
import { getStockLocationOptions } from '../services/stockLocationService';
import {
  getReturns, friendlyReturnError, returnStatusLabel, returnStatusColor, RETURN_STATUSES,
  getEligibleDeliveriesForReturn, getReturnableLines, createReturn,
  canCreateReturn, RETURN_REASON_CODES, RETURN_CONDITION_CODES,
} from '../services/returnService';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Returns page (P2M-6, returned finished goods)
// List of returns + a create flow (pick an eligible confirmed delivery, choose
// lines within returnable headroom, reason/condition per line, a quarantine
// location). All access via returnService; org-scoped; refetches on org change.
// A return can also be started from a delivery via ?createForDelivery=<id>.
// ─────────────────────────────────────────────────────────────────────────────

const ALL = 'all';

function Returns() {
  const navigate = useNavigate();
  const { activeOrgId, activeRole } = useOrganisation();
  const [searchParams, setSearchParams] = useSearchParams();

  const [returns, setReturns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState(ALL);
  const [createOpen, setCreateOpen] = useState(false);
  const [presetDeliveryId, setPresetDeliveryId] = useState(null);

  const canCreate = canCreateReturn(activeRole);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    const { data, error: err } = await getReturns();
    if (err) {
      const friendly = friendlyReturnError(err);
      if (/not set up yet/i.test(friendly)) setReturns([]); else setError(friendly);
    } else {
      setReturns(data || []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!activeOrgId) { setReturns([]); return; }
    setReturns([]); load();
  }, [activeOrgId, load]);

  // Deep link: /returns?createForDelivery=<id> opens the create dialog preset.
  useEffect(() => {
    const createFor = searchParams.get('createForDelivery');
    if (createFor && canCreate) {
      setPresetDeliveryId(createFor);
      setCreateOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, canCreate]);

  const closeCreate = () => {
    setCreateOpen(false);
    setPresetDeliveryId(null);
    if (searchParams.get('createForDelivery')) {
      searchParams.delete('createForDelivery');
      setSearchParams(searchParams, { replace: true });
    }
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return returns.filter((r) => {
      const matchStatus = statusFilter === ALL || r.status === statusFilter;
      const matchQuery = !q ||
        (r.returnNumber || '').toLowerCase().includes(q) ||
        (r.dispatchNumber || '').toLowerCase().includes(q) ||
        (r.deliveryNumber || '').toLowerCase().includes(q) ||
        (r.orderNumber || '').toLowerCase().includes(q) ||
        (r.customerLegalName || '').toLowerCase().includes(q) ||
        (r.customerTradingName || '').toLowerCase().includes(q);
      return matchStatus && matchQuery;
    });
  }, [returns, search, statusFilter]);

  const filtersActive = search.trim() !== '' || statusFilter !== ALL;
  const clearFilters = () => { setSearch(''); setStatusFilter(ALL); };
  const noneAtAll = !loading && returns.length === 0;
  const noMatches = !loading && returns.length > 0 && filtered.length === 0;

  return (
    <PageContainer maxWidth={1600} sx={{ px: { xs: 2, sm: 3, md: 4, lg: 5 } }}>
      <Box sx={{ mb: 1, display: 'flex', alignItems: 'flex-start', gap: 2 }}>
        <Box sx={{ flexGrow: 1 }}>
          <Typography variant="h2" component="h1" sx={{ mb: 0.5 }}>Returns</Typography>
          <Typography variant="body1" sx={{ color: 'text.secondary' }}>
            Handle returned finished goods after delivery. Returned stock enters quarantine first, then is restocked or written off.
          </Typography>
        </Box>
        {canCreate && (
          <Button variant="contained" startIcon={<AddOutlinedIcon />} onClick={() => { setPresetDeliveryId(null); setCreateOpen(true); }} sx={{ flexShrink: 0, mt: 0.5 }}>
            New return
          </Button>
        )}
      </Box>

      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ my: 3 }} alignItems={{ md: 'center' }}>
        <TextField
          value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by return #, dispatch #, delivery #, order # or customer" fullWidth sx={{ maxWidth: { md: 400 } }}
          InputProps={{ startAdornment: <InputAdornment position="start"><SearchOutlinedIcon fontSize="small" /></InputAdornment> }}
        />
        <TextField select label="Status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} fullWidth sx={{ maxWidth: { md: 220 } }}>
          <MenuItem value={ALL}>All statuses</MenuItem>
          {RETURN_STATUSES.map((s) => <MenuItem key={s.value} value={s.value}>{s.label}</MenuItem>)}
        </TextField>
        {filtersActive && <Button onClick={clearFilters} color="inherit" sx={{ flexShrink: 0 }}>Clear filters</Button>}
      </Stack>

      {error && <Alert severity="error" sx={{ mb: 2 }} action={<Button color="inherit" size="small" onClick={load}>Retry</Button>} onClose={() => setError('')}>{error}</Alert>}

      {loading ? (
        <Paper variant="outlined" sx={{ borderRadius: 3, p: 2.5 }}>
          {[0, 1, 2].map((i) => (
            <Box key={i} sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 1 }}>
              <Skeleton variant="rounded" width={34} height={34} />
              <Skeleton width="30%" height={24} />
              <Skeleton width="15%" height={24} sx={{ ml: 'auto' }} />
            </Box>
          ))}
        </Paper>
      ) : noneAtAll ? (
        <EmptyReturns canCreate={canCreate} onCreate={() => { setPresetDeliveryId(null); setCreateOpen(true); }} />
      ) : noMatches ? (
        <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', p: 4, textAlign: 'center' }}>
          <Typography variant="body1" sx={{ color: 'text.secondary', mb: 2 }}>No returns match your filters.</Typography>
          <Button onClick={clearFilters} variant="outlined" color="primary">Clear filters</Button>
        </Paper>
      ) : (
        <ReturnTable returns={filtered} onOpen={(r) => navigate(`/returns/${r.id}`)} />
      )}

      {createOpen && (
        <CreateReturnDialog
          open={createOpen}
          onClose={closeCreate}
          presetDeliveryId={presetDeliveryId}
          onCreated={(created) => { closeCreate(); load(); if (created?.id) navigate(`/returns/${created.id}`); }}
        />
      )}
    </PageContainer>
  );
}

function ReturnTable({ returns, onOpen }) {
  return (
    <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 3, overflowX: 'auto' }}>
      <Table sx={{ minWidth: 1040 }} aria-label="Returns">
        <TableHead>
          <TableRow>
            <TableCell>Return #</TableCell>
            <TableCell>Delivery</TableCell>
            <TableCell>Dispatch</TableCell>
            <TableCell>Customer</TableCell>
            <TableCell>Created</TableCell>
            <TableCell>Status</TableCell>
            <TableCell align="right">Actions</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {returns.map((r) => (
            <TableRow key={r.id} hover sx={{ '& .MuiTableCell-root': { py: 1.75 } }}>
              <TableCell>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
                  <Box sx={{ width: 34, height: 34, borderRadius: 1.5, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'primary.main', bgcolor: (t) => alpha(t.palette.primary.main, 0.12) }}>
                    <AssignmentReturnOutlinedIcon sx={{ fontSize: '1.1rem' }} />
                  </Box>
                  <Link component="button" type="button" underline="hover" onClick={() => onOpen?.(r)} sx={{ fontWeight: 600, color: 'text.primary', textAlign: 'left' }}>
                    {r.returnNumber}
                  </Link>
                </Box>
              </TableCell>
              <TableCell><Typography variant="body2" sx={{ color: 'text.secondary' }}>{r.deliveryNumber || '—'}</Typography></TableCell>
              <TableCell><Typography variant="body2" sx={{ color: 'text.secondary' }}>{r.dispatchNumber || '—'}</Typography></TableCell>
              <TableCell>
                <Typography variant="body2" sx={{ color: 'text.primary' }}>{r.customerLegalName || '—'}</Typography>
                {r.customerTradingName && <Typography variant="caption" sx={{ color: 'text.secondary' }}>{r.customerTradingName}</Typography>}
              </TableCell>
              <TableCell><Typography variant="body2" sx={{ color: 'text.secondary' }}>{r.createdAt ? formatDate(r.createdAt) : '—'}</Typography></TableCell>
              <TableCell><Chip label={returnStatusLabel(r.status)} size="small" color={returnStatusColor(r.status)} sx={{ fontWeight: 600 }} /></TableCell>
              <TableCell align="right">
                <Tooltip title="Open">
                  <IconButton size="small" color="primary" aria-label={`Open ${r.returnNumber}`} onClick={() => onOpen?.(r)}>
                    <OpenInNewOutlinedIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

function EmptyReturns({ canCreate, onCreate }) {
  return (
    <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', px: 3, py: { xs: 5, md: 7 }, textAlign: 'center' }}>
      <Box sx={{ width: 64, height: 64, borderRadius: '50%', bgcolor: 'background.paper', display: 'flex', alignItems: 'center', justifyContent: 'center', mx: 'auto', mb: 2, color: 'primary.main' }}>
        <AssignmentReturnOutlinedIcon sx={{ fontSize: '2rem' }} />
      </Box>
      <Typography variant="h4" component="p" sx={{ mb: 0.5 }}>No returns yet</Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary', maxWidth: 480, mx: 'auto', mb: canCreate ? 2 : 0 }}>
        Start a return against a confirmed delivery to bring finished goods back into quarantine for inspection.
      </Typography>
      {canCreate && <Button variant="contained" startIcon={<AddOutlinedIcon />} onClick={onCreate}>New return</Button>}
    </Paper>
  );
}

// ── Create-return dialog ──────────────────────────────────────────────────────

function CreateReturnDialog({ open, onClose, presetDeliveryId, onCreated }) {
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [deliveries, setDeliveries] = useState([]);
  const [locations, setLocations] = useState([]);
  const [deliveryId, setDeliveryId] = useState(presetDeliveryId || '');
  const [quarantineLocationId, setQuarantineLocationId] = useState('');
  const [reasonSummary, setReasonSummary] = useState('');
  const [lines, setLines] = useState([]); // [{ dispatchLineId, productName, returnable, qty, reasonCode, conditionCode, include }]
  const [linesLoading, setLinesLoading] = useState(false);

  // Load eligible deliveries + active locations on open.
  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true); setError('');
      const [delRes, locRes] = await Promise.all([
        getEligibleDeliveriesForReturn(),
        getStockLocationOptions(),
      ]);
      if (!active) return;
      if (delRes.error) { setError(friendlyReturnError(delRes.error)); }
      setDeliveries(delRes.data || []);
      setLocations(locRes.data || []);
      setLoading(false);
    })();
    return () => { active = false; };
  }, []);

  // When a delivery is chosen, load its returnable lines.
  useEffect(() => {
    if (!deliveryId) { setLines([]); return; }
    let active = true;
    (async () => {
      setLinesLoading(true); setError('');
      const { data, error: err } = await getReturnableLines(deliveryId);
      if (!active) return;
      if (err) { setError(friendlyReturnError(err)); setLines([]); setLinesLoading(false); return; }
      setLines((data || []).map((l) => ({
        dispatchLineId: l.dispatchLineId,
        productName: l.productName,
        productSku: l.productSku,
        deliveredQty: l.deliveredQty,
        alreadyReturned: l.alreadyReturned,
        returnable: l.returnable,
        qty: '',
        reasonCode: 'ORDER_ERROR',
        conditionCode: 'SELLABLE',
        include: false,
      })));
      setLinesLoading(false);
    })();
    return () => { active = false; };
  }, [deliveryId]);

  const updateLine = (idx, patch) => {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  };

  const selectedLines = lines.filter((l) => l.include);
  const canSubmit = Boolean(deliveryId) && Boolean(quarantineLocationId) && selectedLines.length > 0
    && selectedLines.every((l) => {
      const n = Number(l.qty);
      return Number.isInteger(n) && n >= 1 && n <= l.returnable;
    });

  async function handleSubmit() {
    setSubmitting(true); setError('');
    const payload = selectedLines.map((l) => ({
      dispatch_line_id: l.dispatchLineId,
      returned_qty: Number(l.qty),
      reason_code: l.reasonCode,
      condition_code: l.conditionCode,
    }));
    const { data, error: err } = await createReturn(deliveryId, quarantineLocationId, payload, reasonSummary.trim() || null);
    if (err) { setError(friendlyReturnError(err)); setSubmitting(false); return; }
    setSubmitting(false);
    onCreated?.(data);
  }

  return (
    <Dialog open={open} onClose={submitting ? undefined : onClose} maxWidth="md" fullWidth>
      <DialogTitle>New return</DialogTitle>
      <DialogContent dividers>
        {loading ? (
          <Stack spacing={1}><Skeleton height={56} /><Skeleton height={56} /><Skeleton height={120} /></Stack>
        ) : (
          <Stack spacing={2.5} sx={{ pt: 1 }}>
            {error && <Alert severity="error" onClose={() => setError('')}>{error}</Alert>}

            <TextField
              select label="Confirmed delivery" value={deliveryId}
              onChange={(e) => setDeliveryId(e.target.value)} fullWidth
              helperText={deliveries.length === 0 ? 'No confirmed delivery is currently eligible (none, or all have an active return).' : 'Only confirmed deliveries with no active return are shown.'}
              disabled={Boolean(presetDeliveryId)}
            >
              {deliveries.length === 0 && <MenuItem value="" disabled>No eligible deliveries</MenuItem>}
              {/* If preset is not in the eligible list, still show it so the control renders. */}
              {presetDeliveryId && !deliveries.some((d) => d.id === presetDeliveryId) && (
                <MenuItem value={presetDeliveryId}>{presetDeliveryId}</MenuItem>
              )}
              {deliveries.map((d) => (
                <MenuItem key={d.id} value={d.id}>
                  {d.deliveryNumber} — {d.customerName || 'Customer'} ({d.dispatchNumber || 'dispatch'})
                </MenuItem>
              ))}
            </TextField>

            <TextField
              select label="Quarantine location" value={quarantineLocationId}
              onChange={(e) => setQuarantineLocationId(e.target.value)} fullWidth
              helperText="Returned goods are received into this location first."
            >
              {locations.length === 0 && <MenuItem value="" disabled>No active locations</MenuItem>}
              {locations.map((l) => (
                <MenuItem key={l.id} value={l.id}>{l.name} ({l.locationCode})</MenuItem>
              ))}
            </TextField>

            <TextField
              label="Reason summary (optional)" value={reasonSummary}
              onChange={(e) => setReasonSummary(e.target.value)} fullWidth multiline minRows={1}
            />

            <Divider />
            <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>Lines to return</Typography>
            {!deliveryId ? (
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>Choose a delivery to see its returnable lines.</Typography>
            ) : linesLoading ? (
              <Skeleton height={120} />
            ) : lines.length === 0 ? (
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>This delivery has no returnable lines.</Typography>
            ) : (
              <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 2 }}>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell padding="checkbox">Incl.</TableCell>
                      <TableCell>Product</TableCell>
                      <TableCell align="right">Returnable</TableCell>
                      <TableCell align="right" sx={{ width: 110 }}>Qty</TableCell>
                      <TableCell sx={{ width: 180 }}>Reason</TableCell>
                      <TableCell sx={{ width: 170 }}>Condition</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {lines.map((l, idx) => {
                      const n = Number(l.qty);
                      const qtyError = l.include && (!Number.isInteger(n) || n < 1 || n > l.returnable);
                      return (
                        <TableRow key={l.dispatchLineId}>
                          <TableCell padding="checkbox">
                            <input
                              type="checkbox" checked={l.include} disabled={l.returnable < 1}
                              onChange={(e) => updateLine(idx, { include: e.target.checked })}
                              aria-label={`Include ${l.productName}`}
                            />
                          </TableCell>
                          <TableCell>
                            <Typography variant="body2" sx={{ fontWeight: 600 }}>{l.productName || '—'}</Typography>
                            {l.productSku && <Typography variant="caption" sx={{ color: 'text.secondary' }}>{l.productSku}</Typography>}
                          </TableCell>
                          <TableCell align="right">
                            <Typography variant="body2">{l.returnable}</Typography>
                            <Typography variant="caption" sx={{ color: 'text.secondary' }}>of {l.deliveredQty} delivered</Typography>
                          </TableCell>
                          <TableCell align="right">
                            <TextField
                              size="small" type="number" value={l.qty} disabled={!l.include}
                              onChange={(e) => updateLine(idx, { qty: e.target.value })}
                              error={qtyError}
                              inputProps={{ min: 1, max: l.returnable, 'aria-label': `Quantity for ${l.productName}` }}
                              sx={{ width: 90 }}
                            />
                          </TableCell>
                          <TableCell>
                            <TextField select size="small" value={l.reasonCode} disabled={!l.include}
                              onChange={(e) => updateLine(idx, { reasonCode: e.target.value })} fullWidth>
                              {RETURN_REASON_CODES.map((r) => <MenuItem key={r.value} value={r.value}>{r.label}</MenuItem>)}
                            </TextField>
                          </TableCell>
                          <TableCell>
                            <TextField select size="small" value={l.conditionCode} disabled={!l.include}
                              onChange={(e) => updateLine(idx, { conditionCode: e.target.value })} fullWidth>
                              {RETURN_CONDITION_CODES.map((c) => <MenuItem key={c.value} value={c.value}>{c.label}</MenuItem>)}
                            </TextField>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} color="inherit" disabled={submitting}>Cancel</Button>
        <Button onClick={handleSubmit} variant="contained" disabled={!canSubmit || submitting}>
          {submitting ? 'Creating…' : 'Create return'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default Returns;
