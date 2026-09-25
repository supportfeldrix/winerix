import { useEffect, useState, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Box, Paper, Typography, Chip, Button, Divider, Grid, Skeleton, Alert, Link, Snackbar,
  Table, TableHead, TableBody, TableRow, TableCell, TableContainer,
} from '@mui/material';
import ArrowBackOutlinedIcon from '@mui/icons-material/ArrowBackOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined';
import WarningAmberOutlinedIcon from '@mui/icons-material/WarningAmberOutlined';
import InventoryOutlinedIcon from '@mui/icons-material/Inventory2Outlined';
import PageContainer from '../layout/PageContainer';
import VesselForm from './VesselForm';
import { vesselStatusColor, vesselTypeLabel } from './VesselTable';
import ConfirmDialog from '../common/ConfirmDialog';
import { formatDate, formatNumber } from '../common/formatters';
import { useOrganisation } from '../../context/OrganisationContext';
import {
  getVessel, updateVessel, deleteVessel, getVesselPlacements, friendlyVesselError,
} from '../../services/vesselService';

function DetailItem({ label, children }) {
  return (
    <Box>
      <Typography variant="overline" sx={{ display: 'block' }}>{label}</Typography>
      <Typography variant="subtitle1" sx={{ color: 'text.primary', fontWeight: 600 }}>{children}</Typography>
    </Box>
  );
}

function VesselProfile() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { activeOrgId } = useOrganisation();

  const [vessel, setVessel] = useState(null);
  const [placements, setPlacements] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [placementsError, setPlacementsError] = useState('');
  const [editOpen, setEditOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [toast, setToast] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError(''); setPlacementsError('');
    const { data, error: err } = await getVessel(id);
    if (err) { setError(friendlyVesselError(err)); setVessel(null); setPlacements([]); setLoading(false); return; }
    setVessel(data);
    // Placements are a SECONDARY lookup: a failure here must not blank the
    // vessel record or raise the primary fatal banner. Surface it as a soft,
    // non-blocking notice scoped to the placement sections instead.
    const { data: pl, error: plErr } = await getVesselPlacements(id);
    if (plErr) { setPlacementsError(friendlyVesselError(plErr)); setPlacements([]); }
    else setPlacements(pl || []);
    setLoading(false);
  }, [id]);

  useEffect(() => { if (!activeOrgId) return; load(); }, [activeOrgId, load]);

  const handleEditSubmit = async (values) => {
    setSaving(true);
    const { error: err } = await updateVessel(id, values);
    setSaving(false);
    if (err) { setError(friendlyVesselError(err)); return; }
    setEditOpen(false); setToast('Vessel updated.'); await load();
  };

  const handleDelete = async () => {
    setDeleting(true);
    const { error: err } = await deleteVessel(id);
    setDeleting(false); setConfirmDelete(false);
    if (err) { setError(friendlyVesselError(err)); return; }
    navigate('/vessels', { replace: true });
  };

  const openPlacements = placements.filter((p) => p.isOpen);
  const currentVolume = openPlacements.reduce((s, p) => s + (Number(p.volumeLitres) || 0), 0);
  const capacity = vessel && vessel.capacityLitres != null ? Number(vessel.capacityLitres) : null;
  const available = capacity != null ? capacity - currentVolume : null;
  const overCapacity = capacity != null && currentVolume > capacity;

  return (
    <PageContainer>
      <Link component="button" type="button" underline="hover" onClick={() => navigate('/vessels')}
        sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, color: 'text.secondary', mb: 2 }}>
        <ArrowBackOutlinedIcon sx={{ fontSize: '1.1rem' }} /> Back to Vessels
      </Link>

      {loading ? (
        <Paper sx={{ p: { xs: 2.5, md: 4 } }}>
          <Skeleton width="40%" height={40} /><Skeleton width="25%" height={24} sx={{ mt: 1 }} />
          <Divider sx={{ my: 3 }} /><Skeleton width="80%" height={24} />
        </Paper>
      ) : error && !vessel ? (
        <Alert severity="error">{error}</Alert>
      ) : vessel ? (
        <>
          {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}
          <Paper sx={{ p: { xs: 2.5, md: 4 } }}>
            <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, alignItems: { xs: 'flex-start', sm: 'center' }, justifyContent: 'space-between', gap: 2 }}>
              <Box sx={{ minWidth: 0 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
                  <Typography variant="h2" component="h1" sx={{ minWidth: 0 }}>{vessel.vesselCode}</Typography>
                  <Chip label={vessel.status} color={vesselStatusColor(vessel.status)} sx={{ textTransform: 'capitalize' }} />
                </Box>
                {vessel.name && <Typography variant="body1" sx={{ mt: 1, color: 'text.secondary' }}>{vessel.name}</Typography>}
              </Box>
              <Box sx={{ display: 'flex', gap: 1, flexShrink: 0 }}>
                <Button variant="outlined" color="primary" startIcon={<EditOutlinedIcon />} onClick={() => setEditOpen(true)}>Edit</Button>
                <Button variant="outlined" color="secondary" startIcon={<DeleteOutlineOutlinedIcon />} onClick={() => setConfirmDelete(true)}>Delete</Button>
              </Box>
            </Box>
            <Divider sx={{ my: 3 }} />
            <Grid container spacing={3}>
              <Grid item xs={6} sm={3}><DetailItem label="Type">{vesselTypeLabel(vessel.vesselType)}</DetailItem></Grid>
              <Grid item xs={6} sm={3}><DetailItem label="Capacity">{capacity != null ? `${formatNumber(capacity)} L` : '—'}</DetailItem></Grid>
              <Grid item xs={6} sm={3}><DetailItem label="Location">{vessel.location || '—'}</DetailItem></Grid>
              <Grid item xs={6} sm={3}><DetailItem label="Status"><Box sx={{ textTransform: 'capitalize' }}>{vessel.status}</Box></DetailItem></Grid>
              <Grid item xs={6} sm={3}>
                <DetailItem label="Current Volume">
                  <Box component="span" sx={{ color: overCapacity ? 'warning.main' : 'text.primary' }}>{formatNumber(currentVolume)} L</Box>
                </DetailItem>
              </Grid>
              <Grid item xs={6} sm={3}>
                <DetailItem label="Available">
                  {available != null ? `${formatNumber(available)} L` : '—'}
                </DetailItem>
              </Grid>
              <Grid item xs={12} sm={6}><DetailItem label="Created">{formatDate(vessel.createdAt)}</DetailItem></Grid>
              {vessel.notes && (
                <Grid item xs={12}><DetailItem label="Notes"><Typography variant="body2" sx={{ fontWeight: 400, color: 'text.secondary', whiteSpace: 'pre-wrap' }}>{vessel.notes}</Typography></DetailItem></Grid>
              )}
            </Grid>

            {overCapacity && (
              <Alert severity="warning" icon={<WarningAmberOutlinedIcon />} sx={{ mt: 3 }}>
                Current volume ({formatNumber(currentVolume)} L) exceeds this vessel&apos;s capacity ({formatNumber(capacity)} L).
              </Alert>
            )}
          </Paper>

          {/* ── Current Contents (open placements) ─────────────────────── */}
          <Paper sx={{ p: { xs: 2.5, md: 4 }, mt: { xs: 3, md: 4 } }}>
            <Typography variant="h4" component="h2" sx={{ mb: 0.5 }}>Current Contents</Typography>
            <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>
              Wine lots currently held in this vessel.
            </Typography>
            {placementsError && (
              <Alert severity="info" sx={{ mb: 2 }} onClose={() => setPlacementsError('')}>{placementsError}</Alert>
            )}
            {openPlacements.length === 0 ? (
              <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', px: 3, py: { xs: 4, md: 5 }, textAlign: 'center' }}>
                <Box sx={{ width: 56, height: 56, borderRadius: '50%', bgcolor: 'background.paper', display: 'flex', alignItems: 'center', justifyContent: 'center', mx: 'auto', mb: 1.5, color: 'accent.main' }}>
                  <InventoryOutlinedIcon sx={{ fontSize: '1.6rem' }} />
                </Box>
                <Typography variant="body1" sx={{ color: 'text.secondary' }}>This vessel is currently empty.</Typography>
              </Paper>
            ) : (
              <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 3, overflow: 'hidden' }}>
                <Table sx={{ minWidth: 620 }} aria-label="Current contents">
                  <TableHead>
                    <TableRow>
                      <TableCell>Wine Lot</TableCell>
                      <TableCell align="right">Volume</TableCell>
                      <TableCell>Lot Status</TableCell>
                      <TableCell>Placed</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {openPlacements.map((p) => (
                      <TableRow key={p.id} hover sx={{ '& .MuiTableCell-root': { py: 1.5 } }}>
                        <TableCell>
                          <Link component="button" type="button" underline="hover" onClick={() => navigate(`/wine-lots/${p.wineLotId}`)} sx={{ color: 'primary.main', fontWeight: 700, textAlign: 'left' }}>
                            {p.lotCode || 'View lot'}
                          </Link>
                        </TableCell>
                        <TableCell align="right" sx={{ fontWeight: 600 }}>{p.volumeLitres != null ? `${formatNumber(p.volumeLitres)} L` : '—'}</TableCell>
                        <TableCell sx={{ color: 'text.secondary', textTransform: 'capitalize' }}>{p.lotStatus || '—'}</TableCell>
                        <TableCell sx={{ color: 'text.secondary' }}>{formatDate(p.placedAt)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </Paper>

          {/* ── Placement History ─────────────────────────────────────── */}
          <Paper sx={{ p: { xs: 2.5, md: 4 }, mt: { xs: 3, md: 4 } }}>
            <Typography variant="h4" component="h2" sx={{ mb: 0.5 }}>Placement History</Typography>
            <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>
              Every lot that has occupied this vessel, past and present.
            </Typography>
            {placements.length === 0 ? (
              <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', px: 3, py: { xs: 4, md: 5 }, textAlign: 'center' }}>
                <Typography variant="body1" sx={{ color: 'text.secondary' }}>No placement history yet.</Typography>
              </Paper>
            ) : (
              <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 3, overflow: 'hidden' }}>
                <Table sx={{ minWidth: 680 }} aria-label="Placement history">
                  <TableHead>
                    <TableRow>
                      <TableCell>Wine Lot</TableCell>
                      <TableCell align="right">Volume</TableCell>
                      <TableCell>Placed</TableCell>
                      <TableCell>Removed</TableCell>
                      <TableCell>State</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {placements.map((p) => (
                      <TableRow key={p.id} hover sx={{ '& .MuiTableCell-root': { py: 1.5 }, opacity: p.isOpen ? 1 : 0.7 }}>
                        <TableCell>
                          <Link component="button" type="button" underline="hover" onClick={() => navigate(`/wine-lots/${p.wineLotId}`)} sx={{ color: 'primary.main', fontWeight: 600, textAlign: 'left' }}>
                            {p.lotCode || 'View lot'}
                          </Link>
                        </TableCell>
                        <TableCell align="right" sx={{ fontWeight: 600 }}>{p.volumeLitres != null ? `${formatNumber(p.volumeLitres)} L` : '—'}</TableCell>
                        <TableCell sx={{ color: 'text.secondary' }}>{formatDate(p.placedAt)}</TableCell>
                        <TableCell sx={{ color: 'text.secondary' }}>{p.removedAt ? formatDate(p.removedAt) : '—'}</TableCell>
                        <TableCell>
                          <Chip label={p.isOpen ? 'Current' : 'Past'} size="small" color={p.isOpen ? 'success' : 'default'} sx={{ fontWeight: 600 }} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </Paper>
        </>
      ) : null}

      <VesselForm open={editOpen} vessel={vessel} saving={saving} onSubmit={handleEditSubmit} onClose={() => setEditOpen(false)} />

      <ConfirmDialog open={confirmDelete} title="Delete Vessel"
        message={vessel ? `Delete vessel "${vessel.vesselCode}"? This cannot be undone. Vessels with placement history cannot be deleted.` : ''}
        confirmLabel="Delete" confirmColor="error" loading={deleting} onConfirm={handleDelete} onClose={() => setConfirmDelete(false)} />

      <Snackbar open={Boolean(toast)} autoHideDuration={4000} onClose={() => setToast('')} message={toast} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }} />
    </PageContainer>
  );
}

export default VesselProfile;
