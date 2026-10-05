import { useEffect, useState, useCallback } from 'react';
import {
  Box, Typography, Button, Paper, Skeleton, Alert, Snackbar, Chip,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
} from '@mui/material';
import RefreshOutlinedIcon from '@mui/icons-material/RefreshOutlined';
import Inventory2OutlinedIcon from '@mui/icons-material/Inventory2Outlined';
import MoveToInboxOutlinedIcon from '@mui/icons-material/MoveToInboxOutlined';
import { alpha } from '@mui/material/styles';
import PageContainer from '../components/layout/PageContainer';
import { useOrganisation } from '../context/OrganisationContext';
import ReceiveFinishedGoodsDialog from '../components/stock/ReceiveFinishedGoodsDialog';
import { formatNumber, formatDate } from '../components/common/formatters';
import {
  getReceivableBottlingOutputs, receiveBottlingOutput, friendlyStockError,
} from '../services/stockService';
import { getFinishedProductOptions } from '../services/finishedProductService';
import { getStockLocationOptions } from '../services/stockLocationService';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Receive Finished Goods page (P2K-5)
//
// Lists completed, not-yet-received bottling outputs and lets an authorised user
// receive each (in full) into a chosen finished product + active stock location
// via the atomic receive_bottling_output RPC. All data access is through
// services (never Supabase directly). Org-scoped: clears + refetches on
// activeOrgId change. Does not create products or locations.
// ─────────────────────────────────────────────────────────────────────────────

function ReceiveFinishedGoods() {
  const { activeOrgId } = useOrganisation();

  const [outputs, setOutputs] = useState([]);
  const [productOptions, setProductOptions] = useState([]);
  const [locationOptions, setLocationOptions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [dialogOpen, setDialogOpen] = useState(false);
  const [target, setTarget] = useState(null);
  const [saving, setSaving] = useState(false);
  const [dialogError, setDialogError] = useState('');
  const [result, setResult] = useState(null);
  const [toast, setToast] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    const [outRes, prodRes, locRes] = await Promise.all([
      getReceivableBottlingOutputs(),
      getFinishedProductOptions(),
      getStockLocationOptions(),
    ]);

    if (outRes.error) {
      const friendly = friendlyStockError(outRes.error);
      if (/not set up yet/i.test(friendly)) setOutputs([]); else setError(friendly);
    } else {
      setOutputs(outRes.data || []);
    }
    setProductOptions(prodRes.error ? [] : (prodRes.data || []));
    setLocationOptions(locRes.error ? [] : (locRes.data || []));

    setLoading(false);
  }, []);

  // Refetch on active-organisation change. Clear first so no previous-org rows
  // are shown mid-switch.
  useEffect(() => {
    if (!activeOrgId) { setOutputs([]); setProductOptions([]); setLocationOptions([]); return; }
    setOutputs([]); setProductOptions([]); setLocationOptions([]);
    load();
  }, [activeOrgId, load]);

  const openReceive = (output) => {
    setTarget(output);
    setResult(null);
    setDialogError('');
    setDialogOpen(true);
  };

  const closeDialog = async () => {
    const hadResult = Boolean(result);
    setDialogOpen(false); setTarget(null); setDialogError(''); setResult(null);
    // If a receipt succeeded, refresh the receivable list so the output drops off.
    if (hadResult) await load();
  };

  const handleConfirm = async (input) => {
    setSaving(true); setDialogError('');
    const { data, error: err } = await receiveBottlingOutput(input);
    setSaving(false);
    if (err) { setDialogError(friendlyStockError(err)); return; }
    setResult(data);
    setToast('Finished goods received.');
  };

  const noneAtAll = !loading && outputs.length === 0;

  return (
    <PageContainer maxWidth={1600} sx={{ px: { xs: 2, sm: 3, md: 4, lg: 5 } }}>
      <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, alignItems: { xs: 'stretch', sm: 'center' }, justifyContent: 'space-between', gap: 2, mb: 1 }}>
        <Box>
          <Typography variant="h2" component="h1" sx={{ mb: 0.5 }}>Receive Finished Goods</Typography>
          <Typography variant="body1" sx={{ color: 'text.secondary' }}>
            Receive bottled output from completed bottling runs into finished-goods stock.
          </Typography>
        </Box>
        <Button onClick={load} color="inherit" startIcon={<RefreshOutlinedIcon />} disabled={loading} sx={{ flexShrink: 0 }}>Refresh</Button>
      </Box>

      <Box sx={{ my: 2 }}>
        {productOptions.length === 0 && !loading && (
          <Alert severity="info" sx={{ mb: 1 }}>You have no active finished products. Create one in Finished Products before receiving stock.</Alert>
        )}
        {locationOptions.length === 0 && !loading && (
          <Alert severity="info">You have no active stock locations. Create one in Stock Locations before receiving stock.</Alert>
        )}
      </Box>

      {error && <Alert severity="error" sx={{ mb: 2 }} action={<Button color="inherit" size="small" onClick={load}>Retry</Button>} onClose={() => setError('')}>{error}</Alert>}

      {loading ? (
        <Paper variant="outlined" sx={{ borderRadius: 3, p: 2.5 }}>
          {[0, 1, 2].map((i) => (
            <Box key={i} sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 1 }}>
              <Skeleton variant="rounded" width={34} height={34} />
              <Skeleton width="35%" height={24} />
              <Skeleton width="15%" height={24} sx={{ ml: 'auto' }} />
            </Box>
          ))}
        </Paper>
      ) : noneAtAll ? (
        <EmptyReceivable />
      ) : (
        <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 3, overflowX: 'auto' }}>
          <Table sx={{ minWidth: 900 }} aria-label="Receivable bottling outputs">
            <TableHead>
              <TableRow>
                <TableCell>Bottling Run</TableCell>
                <TableCell>Date</TableCell>
                <TableCell align="right">Bottle Size</TableCell>
                <TableCell align="right">Bottle Count</TableCell>
                <TableCell>Packaging</TableCell>
                <TableCell>Output Product</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {outputs.map((o) => (
                <TableRow key={o.id} hover sx={{ '& .MuiTableCell-root': { py: 1.75 } }}>
                  <TableCell>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
                      <Box
                        sx={{
                          width: 34, height: 34, borderRadius: 1.5, flexShrink: 0,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          color: 'secondary.main', bgcolor: (t) => alpha(t.palette.secondary.main, 0.12),
                        }}
                      >
                        <Inventory2OutlinedIcon sx={{ fontSize: '1.1rem' }} />
                      </Box>
                      <Typography variant="body2" sx={{ fontWeight: 600, color: 'text.primary' }}>{o.bottlingCode || '—'}</Typography>
                      <Chip label="Completed" size="small" color="success" sx={{ height: 20, fontSize: '0.68rem', fontWeight: 600 }} />
                    </Box>
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" sx={{ color: 'text.secondary' }}>{formatDate(o.bottlingDate)}</Typography>
                  </TableCell>
                  <TableCell align="right">
                    <Typography variant="body2" sx={{ color: 'text.secondary' }}>{o.bottleVolumeMl != null ? `${formatNumber(o.bottleVolumeMl, { maximumFractionDigits: 0 })} ml` : '—'}</Typography>
                  </TableCell>
                  <TableCell align="right">
                    <Typography variant="body2" sx={{ color: 'text.primary', fontWeight: 600 }}>{formatNumber(o.bottleCount, { maximumFractionDigits: 0 })}</Typography>
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" sx={{ color: 'text.secondary' }}>{o.packagingFormat || '—'}</Typography>
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" sx={{ color: o.productName ? 'text.secondary' : 'text.disabled' }}>
                      {o.productName || '—'}{o.vintage ? ` · ${o.vintage}` : ''}
                    </Typography>
                  </TableCell>
                  <TableCell align="right">
                    <Button
                      size="small"
                      variant="outlined"
                      color="primary"
                      startIcon={<MoveToInboxOutlinedIcon />}
                      onClick={() => openReceive(o)}
                    >
                      Receive
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <ReceiveFinishedGoodsDialog
        open={dialogOpen}
        output={target}
        productOptions={productOptions}
        locationOptions={locationOptions}
        saving={saving}
        result={result}
        errorText={dialogError}
        onConfirm={handleConfirm}
        onClose={closeDialog}
      />
      <Snackbar open={Boolean(toast)} autoHideDuration={4000} onClose={() => setToast('')} message={toast} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }} />
    </PageContainer>
  );
}

function EmptyReceivable() {
  return (
    <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', px: 3, py: { xs: 5, md: 7 }, textAlign: 'center' }}>
      <Box sx={{ width: 64, height: 64, borderRadius: '50%', bgcolor: 'background.paper', display: 'flex', alignItems: 'center', justifyContent: 'center', mx: 'auto', mb: 2, color: 'secondary.main' }}>
        <MoveToInboxOutlinedIcon sx={{ fontSize: '2rem' }} />
      </Box>
      <Typography variant="h4" component="p" sx={{ mb: 0.5 }}>Nothing to receive</Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary', maxWidth: 460, mx: 'auto' }}>
        There are no completed bottling outputs awaiting receipt. Complete a bottling run, or check that its outputs haven’t already been received.
      </Typography>
    </Paper>
  );
}

export default ReceiveFinishedGoods;
