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
import AssignmentTurnedInOutlinedIcon from '@mui/icons-material/AssignmentTurnedInOutlined';
import PageContainer from '../components/layout/PageContainer';
import { useOrganisation } from '../context/OrganisationContext';
import { formatDate } from '../components/common/formatters';
import {
  getDeliveries, friendlyDeliveryError, deliveryStatusLabel, deliveryStatusColor, DELIVERY_STATUSES,
} from '../services/deliveryService';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Deliveries page (P2M-5, delivery confirmation management)
// Read-only list of delivery confirmations (an attestation layer over dispatch).
// Creation happens from a dispatch (see Dispatch profile). All access via
// deliveryService; org-scoped; clears + refetches on activeOrgId change.
// ─────────────────────────────────────────────────────────────────────────────

const ALL = 'all';

function Deliveries() {
  const navigate = useNavigate();
  const { activeOrgId } = useOrganisation();

  const [deliveries, setDeliveries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState(ALL);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    const { data, error: err } = await getDeliveries();
    if (err) {
      const friendly = friendlyDeliveryError(err);
      if (/not set up yet/i.test(friendly)) setDeliveries([]); else setError(friendly);
    } else {
      setDeliveries(data || []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!activeOrgId) { setDeliveries([]); return; }
    setDeliveries([]); load();
  }, [activeOrgId, load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return deliveries.filter((d) => {
      const matchStatus = statusFilter === ALL || d.status === statusFilter;
      const matchQuery = !q ||
        (d.deliveryNumber || '').toLowerCase().includes(q) ||
        (d.dispatchNumber || '').toLowerCase().includes(q) ||
        (d.orderNumber || '').toLowerCase().includes(q) ||
        (d.customerLegalName || '').toLowerCase().includes(q) ||
        (d.customerTradingName || '').toLowerCase().includes(q);
      return matchStatus && matchQuery;
    });
  }, [deliveries, search, statusFilter]);

  const filtersActive = search.trim() !== '' || statusFilter !== ALL;
  const clearFilters = () => { setSearch(''); setStatusFilter(ALL); };
  const noneAtAll = !loading && deliveries.length === 0;
  const noMatches = !loading && deliveries.length > 0 && filtered.length === 0;

  return (
    <PageContainer maxWidth={1600} sx={{ px: { xs: 2, sm: 3, md: 4, lg: 5 } }}>
      <Box sx={{ mb: 1 }}>
        <Typography variant="h2" component="h1" sx={{ mb: 0.5 }}>Deliveries</Typography>
        <Typography variant="body1" sx={{ color: 'text.secondary' }}>
          Confirm receipt of dispatched stock and capture proof of delivery. Deliveries do not change physical stock.
        </Typography>
      </Box>

      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ my: 3 }} alignItems={{ md: 'center' }}>
        <TextField
          value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by delivery #, dispatch #, order # or customer" fullWidth sx={{ maxWidth: { md: 360 } }}
          InputProps={{ startAdornment: <InputAdornment position="start"><SearchOutlinedIcon fontSize="small" /></InputAdornment> }}
        />
        <TextField select label="Status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} fullWidth sx={{ maxWidth: { md: 220 } }}>
          <MenuItem value={ALL}>All statuses</MenuItem>
          {DELIVERY_STATUSES.map((s) => <MenuItem key={s.value} value={s.value}>{s.label}</MenuItem>)}
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
        <EmptyDeliveries />
      ) : noMatches ? (
        <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', p: 4, textAlign: 'center' }}>
          <Typography variant="body1" sx={{ color: 'text.secondary', mb: 2 }}>No deliveries match your filters.</Typography>
          <Button onClick={clearFilters} variant="outlined" color="primary">Clear filters</Button>
        </Paper>
      ) : (
        <DeliveryTable deliveries={filtered} onOpen={(d) => navigate(`/deliveries/${d.id}`)} />
      )}
    </PageContainer>
  );
}

function DeliveryTable({ deliveries, onOpen }) {
  return (
    <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 3, overflowX: 'auto' }}>
      <Table sx={{ minWidth: 980 }} aria-label="Deliveries">
        <TableHead>
          <TableRow>
            <TableCell>Delivery #</TableCell>
            <TableCell>Dispatch</TableCell>
            <TableCell>Sales Order</TableCell>
            <TableCell>Customer</TableCell>
            <TableCell>Delivered</TableCell>
            <TableCell>Status</TableCell>
            <TableCell align="right">Actions</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {deliveries.map((d) => (
            <TableRow key={d.id} hover sx={{ '& .MuiTableCell-root': { py: 1.75 } }}>
              <TableCell>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
                  <Box sx={{ width: 34, height: 34, borderRadius: 1.5, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'primary.main', bgcolor: (t) => alpha(t.palette.primary.main, 0.12) }}>
                    <AssignmentTurnedInOutlinedIcon sx={{ fontSize: '1.1rem' }} />
                  </Box>
                  <Link component="button" type="button" underline="hover" onClick={() => onOpen?.(d)} sx={{ fontWeight: 600, color: 'text.primary', textAlign: 'left' }}>
                    {d.deliveryNumber}
                  </Link>
                </Box>
              </TableCell>
              <TableCell><Typography variant="body2" sx={{ color: 'text.secondary' }}>{d.dispatchNumber || '—'}</Typography></TableCell>
              <TableCell><Typography variant="body2" sx={{ color: 'text.secondary' }}>{d.orderNumber || '—'}</Typography></TableCell>
              <TableCell>
                <Typography variant="body2" sx={{ color: 'text.primary' }}>{d.customerLegalName || '—'}</Typography>
                {d.customerTradingName && <Typography variant="caption" sx={{ color: 'text.secondary' }}>{d.customerTradingName}</Typography>}
              </TableCell>
              <TableCell><Typography variant="body2" sx={{ color: d.deliveredAt ? 'text.secondary' : 'text.disabled' }}>{d.deliveredAt ? formatDate(d.deliveredAt) : '—'}</Typography></TableCell>
              <TableCell><Chip label={deliveryStatusLabel(d.status)} size="small" color={deliveryStatusColor(d.status)} sx={{ fontWeight: 600 }} /></TableCell>
              <TableCell align="right">
                <Tooltip title="Open">
                  <IconButton size="small" color="primary" aria-label={`Open ${d.deliveryNumber}`} onClick={() => onOpen?.(d)}>
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

function EmptyDeliveries() {
  return (
    <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', px: 3, py: { xs: 5, md: 7 }, textAlign: 'center' }}>
      <Box sx={{ width: 64, height: 64, borderRadius: '50%', bgcolor: 'background.paper', display: 'flex', alignItems: 'center', justifyContent: 'center', mx: 'auto', mb: 2, color: 'primary.main' }}>
        <AssignmentTurnedInOutlinedIcon sx={{ fontSize: '2rem' }} />
      </Box>
      <Typography variant="h4" component="p" sx={{ mb: 0.5 }}>No deliveries yet</Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary', maxWidth: 480, mx: 'auto' }}>
        Create a delivery confirmation from a recorded dispatch to track receipt and proof of delivery.
      </Typography>
    </Paper>
  );
}

export default Deliveries;
