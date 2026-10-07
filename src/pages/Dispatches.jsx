import { useEffect, useMemo, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Typography, TextField, InputAdornment, MenuItem, Paper,
  Skeleton, Alert, Button, Stack,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Chip,
  IconButton, Tooltip, Link,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import SearchOutlinedIcon from '@mui/icons-material/SearchOutlined';
import OpenInNewOutlinedIcon from '@mui/icons-material/OpenInNewOutlined';
import LocalShippingOutlinedIcon from '@mui/icons-material/LocalShippingOutlined';
import PageContainer from '../components/layout/PageContainer';
import { useOrganisation } from '../context/OrganisationContext';
import { formatDate, formatNumber } from '../components/common/formatters';
import {
  getDispatches, friendlyDispatchError, dispatchStatusLabel, dispatchStatusColor,
  DISPATCH_STATUSES,
} from '../services/dispatchService';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Dispatches page (P2M-3, read-only Dispatch Management)
//
// Lists the active organisation's physical dispatches (P2M-2 record_dispatch
// output). Read-only: no create/edit/delete here — dispatches are produced only
// by the backend RPC. All data access goes through dispatchService (never
// Supabase directly). Org-scoped: clears + refetches on activeOrgId change.
// Clicking a dispatch opens /dispatches/:id.
// ─────────────────────────────────────────────────────────────────────────────

const ALL = 'all';

function Dispatches() {
  const navigate = useNavigate();
  const { activeOrgId } = useOrganisation();

  const [dispatches, setDispatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState(ALL);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    const { data, error: err } = await getDispatches();
    if (err) {
      const friendly = friendlyDispatchError(err);
      if (/not set up yet/i.test(friendly)) setDispatches([]); else setError(friendly);
    } else {
      setDispatches(data || []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!activeOrgId) { setDispatches([]); return; }
    setDispatches([]);
    load();
  }, [activeOrgId, load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return dispatches.filter((d) => {
      const matchStatus = statusFilter === ALL || d.status === statusFilter;
      const matchQuery = !q ||
        (d.dispatchNumber || '').toLowerCase().includes(q) ||
        (d.orderNumber || '').toLowerCase().includes(q) ||
        (d.customerLegalName || '').toLowerCase().includes(q) ||
        (d.customerTradingName || '').toLowerCase().includes(q);
      // Date range filter on the dispatch date (inclusive).
      const dispDay = d.dispatchedAt ? d.dispatchedAt.slice(0, 10) : '';
      const matchFrom = !fromDate || (dispDay && dispDay >= fromDate);
      const matchTo = !toDate || (dispDay && dispDay <= toDate);
      return matchStatus && matchQuery && matchFrom && matchTo;
    });
  }, [dispatches, search, statusFilter, fromDate, toDate]);

  const filtersActive = search.trim() !== '' || statusFilter !== ALL || fromDate !== '' || toDate !== '';
  const clearFilters = () => { setSearch(''); setStatusFilter(ALL); setFromDate(''); setToDate(''); };

  const noneAtAll = !loading && dispatches.length === 0;
  const noMatches = !loading && dispatches.length > 0 && filtered.length === 0;

  return (
    <PageContainer maxWidth={1600} sx={{ px: { xs: 2, sm: 3, md: 4, lg: 5 } }}>
      <Box sx={{ mb: 1 }}>
        <Typography variant="h2" component="h1" sx={{ mb: 0.5 }}>Dispatches</Typography>
        <Typography variant="body1" sx={{ color: 'text.secondary' }}>
          Track physical dispatches of finished stock against your sales orders.
        </Typography>
      </Box>

      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ my: 3 }} alignItems={{ md: 'center' }}>
        <TextField
          value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by dispatch #, order # or customer" fullWidth sx={{ maxWidth: { md: 320 } }}
          InputProps={{ startAdornment: <InputAdornment position="start"><SearchOutlinedIcon fontSize="small" /></InputAdornment> }}
        />
        <TextField select label="Status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} fullWidth sx={{ maxWidth: { md: 180 } }}>
          <MenuItem value={ALL}>All statuses</MenuItem>
          {DISPATCH_STATUSES.map((s) => <MenuItem key={s.value} value={s.value}>{s.label}</MenuItem>)}
        </TextField>
        <TextField
          type="date" label="From" value={fromDate} onChange={(e) => setFromDate(e.target.value)}
          fullWidth sx={{ maxWidth: { md: 170 } }} InputLabelProps={{ shrink: true }}
        />
        <TextField
          type="date" label="To" value={toDate} onChange={(e) => setToDate(e.target.value)}
          fullWidth sx={{ maxWidth: { md: 170 } }} InputLabelProps={{ shrink: true }}
        />
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
        <EmptyDispatches />
      ) : noMatches ? (
        <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', p: 4, textAlign: 'center' }}>
          <Typography variant="body1" sx={{ color: 'text.secondary', mb: 2 }}>No dispatches match your filters.</Typography>
          <Button onClick={clearFilters} variant="outlined" color="primary">Clear filters</Button>
        </Paper>
      ) : (
        <DispatchTable dispatches={filtered} onOpen={(d) => navigate(`/dispatches/${d.id}`)} />
      )}
    </PageContainer>
  );
}

function DispatchTable({ dispatches, onOpen }) {
  return (
    <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 3, overflowX: 'auto' }}>
      <Table sx={{ minWidth: 900 }} aria-label="Dispatches">
        <TableHead>
          <TableRow>
            <TableCell>Dispatch #</TableCell>
            <TableCell>Sales Order</TableCell>
            <TableCell>Customer</TableCell>
            <TableCell>Date</TableCell>
            <TableCell>Status</TableCell>
            <TableCell align="right">Bottles</TableCell>
            <TableCell align="right">Actions</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {dispatches.map((d) => (
            <TableRow key={d.id} hover sx={{ '& .MuiTableCell-root': { py: 1.75 } }}>
              <TableCell>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
                  <Box
                    sx={{
                      width: 34, height: 34, borderRadius: 1.5, flexShrink: 0,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: 'primary.main', bgcolor: (t) => alpha(t.palette.primary.main, 0.12),
                    }}
                  >
                    <LocalShippingOutlinedIcon sx={{ fontSize: '1.1rem' }} />
                  </Box>
                  <Link component="button" type="button" underline="hover" onClick={() => onOpen?.(d)} sx={{ fontWeight: 600, color: 'text.primary', textAlign: 'left' }}>
                    {d.dispatchNumber}
                  </Link>
                </Box>
              </TableCell>
              <TableCell><Typography variant="body2" sx={{ color: 'text.secondary' }}>{d.orderNumber || '—'}</Typography></TableCell>
              <TableCell>
                <Typography variant="body2" sx={{ color: 'text.primary' }}>{d.customerLegalName || '—'}</Typography>
                {d.customerTradingName && <Typography variant="caption" sx={{ color: 'text.secondary' }}>{d.customerTradingName}</Typography>}
              </TableCell>
              <TableCell><Typography variant="body2" sx={{ color: 'text.secondary' }}>{formatDate(d.dispatchedAt)}</Typography></TableCell>
              <TableCell><Chip label={dispatchStatusLabel(d.status)} size="small" color={dispatchStatusColor(d.status)} sx={{ fontWeight: 600 }} /></TableCell>
              <TableCell align="right"><Typography variant="body2" sx={{ color: 'text.primary', fontWeight: 600 }}>{formatNumber(d.totalBottles, { maximumFractionDigits: 0 })}</Typography></TableCell>
              <TableCell align="right">
                <Tooltip title="Open">
                  <IconButton size="small" color="primary" aria-label={`Open ${d.dispatchNumber}`} onClick={() => onOpen?.(d)}>
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

function EmptyDispatches() {
  return (
    <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', px: 3, py: { xs: 5, md: 7 }, textAlign: 'center' }}>
      <Box sx={{ width: 64, height: 64, borderRadius: '50%', bgcolor: 'background.paper', display: 'flex', alignItems: 'center', justifyContent: 'center', mx: 'auto', mb: 2, color: 'primary.main' }}>
        <LocalShippingOutlinedIcon sx={{ fontSize: '2rem' }} />
      </Box>
      <Typography variant="h4" component="p" sx={{ mb: 0.5 }}>No dispatches yet</Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary', maxWidth: 460, mx: 'auto' }}>
        Dispatches appear here once stock is physically dispatched against a ready-to-dispatch sales order.
      </Typography>
    </Paper>
  );
}

export default Dispatches;
