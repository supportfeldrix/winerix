import { useEffect, useState, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Box, Paper, Typography, Chip, Button, Divider, Grid, Skeleton, Alert, Link,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
} from '@mui/material';
import ArrowBackOutlinedIcon from '@mui/icons-material/ArrowBackOutlined';
import LocalShippingOutlinedIcon from '@mui/icons-material/LocalShippingOutlined';
import ListAltOutlinedIcon from '@mui/icons-material/ListAltOutlined';
import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import PageContainer from '../components/layout/PageContainer';
import { useOrganisation } from '../context/OrganisationContext';
import { formatDate, formatNumber } from '../components/common/formatters';
import {
  getDispatch, getDispatchLines, friendlyDispatchError,
  dispatchStatusLabel, dispatchStatusColor,
} from '../services/dispatchService';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Dispatch profile (P2M-3, read-only)
//
// Shows a single physical dispatch (P2M-2): header (number, status, date, order,
// customer, shipping address snapshot, notes, total bottles), the dispatch lines
// (product, SKU, bottle size, qty, location, order line, allocation, stock
// movement), and the full traceability chain. Read-only — no writes. Dispatch
// quantities come straight from dispatch_lines.qty_bottles (never recomputed).
// Related entities link to existing routes (sales order, finished products,
// stock locations). All data access goes through dispatchService.
// ─────────────────────────────────────────────────────────────────────────────

function Field({ label, children }) {
  return (
    <Box>
      <Typography variant="overline" sx={{ color: 'text.disabled', letterSpacing: '0.08em' }}>{label}</Typography>
      <Typography variant="body1" sx={{ color: 'text.primary' }}>{children}</Typography>
    </Box>
  );
}

// Build a readable address line from the dispatch's JSONB shipping snapshot.
// The snapshot shape mirrors the sales order shipping_address_snapshot.
function snapshotAddressText(s) {
  if (!s || typeof s !== 'object') return null;
  const parts = [
    s.address_line_1 || s.addressLine1,
    s.address_line_2 || s.addressLine2,
    s.city,
    s.province,
    s.postal_code || s.postalCode,
    s.country,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

function DispatchProfile() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { activeOrgId } = useOrganisation();

  const [dispatch, setDispatch] = useState(null);
  const [lines, setLines] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    const { data, error: err } = await getDispatch(id);
    if (err) { setError(friendlyDispatchError(err)); setLoading(false); return; }
    if (!data) { setError('Dispatch not found.'); setLoading(false); return; }
    setDispatch(data);
    const { data: lineData, error: lineErr } = await getDispatchLines(id);
    if (lineErr) { setError(friendlyDispatchError(lineErr)); setLoading(false); return; }
    setLines(lineData || []);
    setLoading(false);
  }, [id]);

  useEffect(() => {
    if (!activeOrgId) return;
    load();
  }, [activeOrgId, load]);

  const shippingText = snapshotAddressText(dispatch?.addressSnapshot);

  // Total dispatched bottles across all lines (from dispatch_lines.qty_bottles).
  const totalBottles = lines.reduce((sum, l) => sum + (Number(l.qtyBottles) || 0), 0);

  return (
    <PageContainer maxWidth={1600} sx={{ px: { xs: 2, sm: 3, md: 4, lg: 5 } }}>
      <Button
        startIcon={<ArrowBackOutlinedIcon />} onClick={() => navigate('/dispatches')}
        color="inherit" sx={{ mb: 2 }}
      >
        Back to Dispatches
      </Button>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} action={<Button color="inherit" size="small" onClick={load}>Retry</Button>}>
          {error}
        </Alert>
      )}

      {loading ? (
        <Paper variant="outlined" sx={{ borderRadius: 3, p: { xs: 2.5, md: 3.5 } }}>
          <Skeleton width="30%" height={40} sx={{ mb: 2 }} />
          <Grid container spacing={3}>
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <Grid item xs={12} sm={6} md={4} key={i}><Skeleton width="80%" height={48} /></Grid>
            ))}
          </Grid>
        </Paper>
      ) : !dispatch ? null : (
        <>
          {/* ── Header ── */}
          <Paper variant="outlined" sx={{ borderRadius: 3, p: { xs: 2.5, md: 3.5 } }}>
            <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, alignItems: { sm: 'center' }, justifyContent: 'space-between', gap: 2, mb: 1 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                <Box sx={{ width: 44, height: 44, borderRadius: 2, bgcolor: 'background.subtle', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'primary.main' }}>
                  <LocalShippingOutlinedIcon />
                </Box>
                <Box>
                  <Typography variant="h3" component="h1">{dispatch.dispatchNumber}</Typography>
                  <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                    Dispatched {formatDate(dispatch.dispatchedAt)}
                  </Typography>
                </Box>
              </Box>
              <Chip label={dispatchStatusLabel(dispatch.status)} color={dispatchStatusColor(dispatch.status)} sx={{ fontWeight: 600 }} />
            </Box>

            <Divider sx={{ my: 3 }} />

            <Grid container spacing={3}>
              <Grid item xs={12} sm={6} md={4}>
                <Field label="Sales Order">
                  {dispatch.salesOrderId ? (
                    <Link component="button" type="button" underline="hover" onClick={() => navigate(`/sales-orders/${dispatch.salesOrderId}`)}>
                      {dispatch.orderNumber || '—'}
                    </Link>
                  ) : (dispatch.orderNumber || '—')}
                </Field>
              </Grid>
              <Grid item xs={12} sm={6} md={4}>
                <Field label="Customer">
                  {dispatch.customerId ? (
                    <Link component="button" type="button" underline="hover" onClick={() => navigate(`/customers/${dispatch.customerId}`)}>
                      {dispatch.customerLegalName || dispatch.customerName || '—'}
                    </Link>
                  ) : (dispatch.customerLegalName || dispatch.customerName || '—')}
                </Field>
              </Grid>
              <Grid item xs={12} sm={6} md={4}><Field label="Status">{dispatchStatusLabel(dispatch.status)}</Field></Grid>
              <Grid item xs={12} sm={6} md={4}><Field label="Dispatch Date">{formatDate(dispatch.dispatchedAt)}</Field></Grid>
              <Grid item xs={12} sm={6} md={4}><Field label="Total Bottles">{formatNumber(totalBottles, { maximumFractionDigits: 0 })}</Field></Grid>
              <Grid item xs={12} sm={6} md={4}><Field label="Lines">{formatNumber(lines.length, { maximumFractionDigits: 0 })}</Field></Grid>
              <Grid item xs={12} sm={6}><Field label="Shipping Address Snapshot">{shippingText || '—'}</Field></Grid>
              <Grid item xs={12} sm={6}><Field label="Notes">{dispatch.notes || '—'}</Field></Grid>
            </Grid>
          </Paper>

          {/* ── Dispatch lines ── */}
          <Paper variant="outlined" sx={{ borderRadius: 3, p: { xs: 2.5, md: 3.5 }, mt: 3 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, mb: 2 }}>
              <Box sx={{ width: 36, height: 36, borderRadius: 1.5, bgcolor: 'background.subtle', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'secondary.main' }}><ListAltOutlinedIcon /></Box>
              <Typography variant="h5" component="h2">Dispatch Lines</Typography>
            </Box>

            {lines.length === 0 ? (
              <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', px: 3, py: { xs: 4, md: 5 }, textAlign: 'center' }}>
                <Typography variant="body2" sx={{ color: 'text.secondary' }}>This dispatch has no lines.</Typography>
              </Paper>
            ) : (
              <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 2, overflowX: 'auto' }}>
                <Table sx={{ minWidth: 1100 }} aria-label="Dispatch lines">
                  <TableHead>
                    <TableRow>
                      <TableCell>Product / SKU</TableCell>
                      <TableCell align="right">Bottle Size</TableCell>
                      <TableCell align="right">Qty</TableCell>
                      <TableCell>Location</TableCell>
                      <TableCell align="right">Order Line</TableCell>
                      <TableCell>Allocation</TableCell>
                      <TableCell>Stock Movement</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {lines.map((l) => (
                      <TableRow key={l.id} hover sx={{ '& .MuiTableCell-root': { py: 1.5 } }}>
                        <TableCell>
                          {l.finishedProductId ? (
                            <Link component="button" type="button" underline="hover" onClick={() => navigate('/finished-products')} sx={{ fontWeight: 600, color: 'text.primary', textAlign: 'left' }}>
                              {l.productName || '—'}
                            </Link>
                          ) : (
                            <Typography variant="body2" sx={{ fontWeight: 600, color: 'text.primary' }}>{l.productName || '—'}</Typography>
                          )}
                          <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>{l.productSku || '—'}</Typography>
                        </TableCell>
                        <TableCell align="right"><Typography variant="body2" sx={{ color: 'text.secondary' }}>{l.productBottleVolumeMl ? `${formatNumber(l.productBottleVolumeMl, { maximumFractionDigits: 0 })} ml` : '—'}</Typography></TableCell>
                        <TableCell align="right"><Typography variant="body2" sx={{ color: 'text.primary', fontWeight: 600 }}>{formatNumber(l.qtyBottles, { maximumFractionDigits: 0 })}</Typography></TableCell>
                        <TableCell>
                          {l.locationId ? (
                            <Link component="button" type="button" underline="hover" onClick={() => navigate('/stock-locations')} sx={{ textAlign: 'left' }}>
                              {l.locationCode || l.locationName || '—'}
                            </Link>
                          ) : (l.locationCode || l.locationName || '—')}
                          {l.locationName && l.locationCode && (
                            <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>{l.locationName}</Typography>
                          )}
                        </TableCell>
                        <TableCell align="right"><Typography variant="body2" sx={{ color: 'text.secondary' }}>{l.salesOrderLineNumber != null ? `#${l.salesOrderLineNumber}` : '—'}</Typography></TableCell>
                        <TableCell>
                          <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>
                            {l.allocationStatus ? `${l.allocationStatus}` : '—'}
                          </Typography>
                          {l.allocationFulfilledQty != null && l.allocationQtyBottles != null && (
                            <Typography variant="caption" sx={{ color: 'text.disabled', display: 'block' }}>
                              {formatNumber(l.allocationFulfilledQty, { maximumFractionDigits: 0 })} / {formatNumber(l.allocationQtyBottles, { maximumFractionDigits: 0 })} fulfilled
                            </Typography>
                          )}
                        </TableCell>
                        <TableCell>
                          <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>
                            {l.movementType || '—'}
                          </Typography>
                          {l.movementQtyDelta != null && (
                            <Typography variant="caption" sx={{ color: 'text.disabled', display: 'block' }}>
                              {formatNumber(l.movementQtyDelta, { maximumFractionDigits: 0 })} bottles
                            </Typography>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </Paper>

          {/* ── Traceability ── */}
          <Paper variant="outlined" sx={{ borderRadius: 3, p: { xs: 2.5, md: 3.5 }, mt: 3 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, mb: 2 }}>
              <Box sx={{ width: 36, height: 36, borderRadius: 1.5, bgcolor: 'background.subtle', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'secondary.main' }}><AccountTreeOutlinedIcon /></Box>
              <Typography variant="h5" component="h2">Traceability</Typography>
            </Box>
            <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>
              Each dispatched bottle traces back through the existing commercial and stock records.
            </Typography>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1 }}>
              <TraceStep label="Customer" value={dispatch.customerLegalName || dispatch.customerName || '—'} />
              <TraceArrow />
              <TraceStep label="Sales Order" value={dispatch.orderNumber || '—'} />
              <TraceArrow />
              <TraceStep label="Sales Order Line" value={lines.length === 1 && lines[0].salesOrderLineNumber != null ? `#${lines[0].salesOrderLineNumber}` : `${lines.length} line${lines.length === 1 ? '' : 's'}`} />
              <TraceArrow />
              <TraceStep label="Stock Allocation" value={lines.length === 1 ? (lines[0].allocationStatus || '—') : `${lines.length}`} />
              <TraceArrow />
              <TraceStep label="Dispatch" value={dispatch.dispatchNumber} />
              <TraceArrow />
              <TraceStep label="Dispatch Line" value={`${lines.length}`} />
              <TraceArrow />
              <TraceStep label="Stock Movement" value={lines.length ? (lines[0].movementType || 'dispatch') : '—'} />
            </Box>
          </Paper>
        </>
      )}
    </PageContainer>
  );
}

function TraceStep({ label, value }) {
  return (
    <Box sx={{ px: 1.5, py: 1, borderRadius: 1.5, bgcolor: 'background.subtle', border: '1px solid', borderColor: 'divider', minWidth: 120 }}>
      <Typography variant="overline" sx={{ color: 'text.disabled', letterSpacing: '0.06em', display: 'block', lineHeight: 1.4 }}>{label}</Typography>
      <Typography variant="body2" sx={{ color: 'text.primary', fontWeight: 600 }}>{value}</Typography>
    </Box>
  );
}

function TraceArrow() {
  return <Typography sx={{ color: 'text.disabled', fontWeight: 700 }}>→</Typography>;
}

export default DispatchProfile;
