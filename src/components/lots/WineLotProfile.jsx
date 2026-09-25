import { useEffect, useState, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Box, Paper, Typography, Chip, Button, Divider, Grid, Skeleton, Alert, Link, Snackbar,
  Table, TableHead, TableBody, TableRow, TableCell, TableContainer,
} from '@mui/material';
import ArrowBackOutlinedIcon from '@mui/icons-material/ArrowBackOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined';
import ScienceOutlinedIcon from '@mui/icons-material/ScienceOutlined';
import ScaleOutlinedIcon from '@mui/icons-material/ScaleOutlined';
import PageContainer from '../layout/PageContainer';
import WineLotForm from './WineLotForm';
import { lotStatusColor, lotStatusLabel } from './WineLotTable';
import ConfirmDialog from '../common/ConfirmDialog';
import { formatDate, formatNumber } from '../common/formatters';
import { useOrganisation } from '../../context/OrganisationContext';
import {
  getWineLotWithBatch, updateWineLot, deleteWineLot, friendlyWineLotError,
} from '../../services/wineLotService';

// Grape-intake status → chip colour (matches the harvest/batch-side convention).
function intakeStatusChip(status) {
  const s = (status || '').toLowerCase();
  if (s === 'processed') return 'success';
  if (s === 'rejected') return 'default';
  return 'secondary'; // received
}

function DetailItem({ label, children }) {
  return (
    <Box>
      <Typography variant="overline" sx={{ display: 'block' }}>{label}</Typography>
      <Typography variant="subtitle1" sx={{ color: 'text.primary', fontWeight: 600 }}>{children}</Typography>
    </Box>
  );
}

function WineLotProfile() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { activeOrgId } = useOrganisation();

  const [lot, setLot] = useState(null);
  const [intakes, setIntakes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editOpen, setEditOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [toast, setToast] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    const { data, error: err } = await getWineLotWithBatch(id);
    if (err) { setError(friendlyWineLotError(err)); setLot(null); setIntakes([]); }
    else { setLot(data.lot); setIntakes(data.intakes || []); }
    setLoading(false);
  }, [id]);

  // Reload on mount, id change, and whenever the active organisation changes
  // (so no stale cross-org data is shown).
  useEffect(() => {
    if (!activeOrgId) return;
    load();
  }, [activeOrgId, load]);

  const handleEditSubmit = async (values) => {
    setSaving(true);
    const { error: err } = await updateWineLot(id, values);
    setSaving(false);
    if (err) { setError(friendlyWineLotError(err)); return; }
    setEditOpen(false); setToast('Wine lot updated.');
    await load();
  };

  const handleDelete = async () => {
    setDeleting(true);
    const { error: err } = await deleteWineLot(id);
    setDeleting(false); setConfirmDelete(false);
    if (err) { setError(friendlyWineLotError(err)); return; }
    navigate('/wine-lots', { replace: true });
  };

  return (
    <PageContainer>
      <Link component="button" type="button" underline="hover" onClick={() => navigate('/wine-lots')}
        sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, color: 'text.secondary', mb: 2 }}>
        <ArrowBackOutlinedIcon sx={{ fontSize: '1.1rem' }} /> Back to Wine Lots
      </Link>

      {loading ? (
        <Paper sx={{ p: { xs: 2.5, md: 4 } }}>
          <Skeleton width="40%" height={40} /><Skeleton width="25%" height={24} sx={{ mt: 1 }} />
          <Divider sx={{ my: 3 }} /><Skeleton width="80%" height={24} />
        </Paper>
      ) : error && !lot ? (
        <Alert severity="error">{error}</Alert>
      ) : lot ? (
        <>
          {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}
          <Paper sx={{ p: { xs: 2.5, md: 4 } }}>
            <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, alignItems: { xs: 'flex-start', sm: 'center' }, justifyContent: 'space-between', gap: 2 }}>
              <Box sx={{ minWidth: 0 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
                  <Typography variant="h2" component="h1" sx={{ minWidth: 0 }}>{lot.lotCode}</Typography>
                  <Chip label={lotStatusLabel(lot.status)} color={lotStatusColor(lot.status)} />
                </Box>
                {lot.wineBatchId && (
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 1, color: 'text.secondary' }}>
                    <ScienceOutlinedIcon sx={{ fontSize: '1.1rem' }} />
                    <Link component="button" type="button" underline="hover" onClick={() => navigate(`/wine-batches/${lot.wineBatchId}`)} sx={{ color: 'primary.main', fontWeight: 600 }}>
                      {lot.batchCode || 'View batch'}
                      {lot.batchVintage != null ? ` (${lot.batchVintage})` : ''}
                    </Link>
                  </Box>
                )}
              </Box>
              <Box sx={{ display: 'flex', gap: 1, flexShrink: 0 }}>
                <Button variant="outlined" color="primary" startIcon={<EditOutlinedIcon />} onClick={() => setEditOpen(true)}>Edit</Button>
                <Button variant="outlined" color="secondary" startIcon={<DeleteOutlineOutlinedIcon />} onClick={() => setConfirmDelete(true)}>Delete</Button>
              </Box>
            </Box>
            <Divider sx={{ my: 3 }} />
            <Grid container spacing={3}>
              <Grid item xs={6} sm={3}><DetailItem label="Volume">{lot.volumeLitres != null ? `${formatNumber(lot.volumeLitres)} L` : '—'}</DetailItem></Grid>
              <Grid item xs={6} sm={3}><DetailItem label="Status"><Box sx={{ textTransform: 'capitalize' }}>{lotStatusLabel(lot.status)}</Box></DetailItem></Grid>
              <Grid item xs={6} sm={3}>
                <DetailItem label="Batch">
                  <Link component="button" type="button" underline="hover" onClick={() => navigate(`/wine-batches/${lot.wineBatchId}`)} sx={{ color: 'primary.main', fontWeight: 600 }}>
                    {lot.batchCode || 'View batch'}
                  </Link>
                </DetailItem>
              </Grid>
              <Grid item xs={6} sm={3}><DetailItem label="Vintage">{lot.batchVintage != null ? lot.batchVintage : '—'}</DetailItem></Grid>
              <Grid item xs={12} sm={6}><DetailItem label="Created">{formatDate(lot.createdAt)}</DetailItem></Grid>
              <Grid item xs={12} sm={6}><DetailItem label="Last Updated">{formatDate(lot.updatedAt)}</DetailItem></Grid>
              {lot.notes && (
                <Grid item xs={12}><DetailItem label="Notes"><Typography variant="body2" sx={{ fontWeight: 400, color: 'text.secondary', whiteSpace: 'pre-wrap' }}>{lot.notes}</Typography></DetailItem></Grid>
              )}
            </Grid>
          </Paper>

          {/* ── Traceability: grape intakes contributing to this lot's batch ── */}
          <Paper sx={{ p: { xs: 2.5, md: 4 }, mt: { xs: 3, md: 4 } }}>
            <Box sx={{ mb: 1 }}>
              <Typography variant="h4" component="h2" sx={{ mb: 0.5 }}>Grape Source</Typography>
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                Grape intakes that contributed to this lot&apos;s batch — traced back to harvest and cultivar.
              </Typography>
            </Box>

            <Box sx={{ mt: 2 }}>
              {intakes.length === 0 ? (
                <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', px: 3, py: { xs: 4, md: 5 }, textAlign: 'center' }}>
                  <Box sx={{ width: 56, height: 56, borderRadius: '50%', bgcolor: 'background.paper', display: 'flex', alignItems: 'center', justifyContent: 'center', mx: 'auto', mb: 1.5, color: 'accent.main' }}>
                    <ScaleOutlinedIcon sx={{ fontSize: '1.7rem' }} />
                  </Box>
                  <Typography variant="body1" sx={{ color: 'text.secondary', maxWidth: 460, mx: 'auto' }}>
                    This lot&apos;s batch has no linked grape intakes yet. Link grape intakes from the batch profile.
                  </Typography>
                </Paper>
              ) : (
                <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 3, overflow: 'hidden' }}>
                  <Table sx={{ minWidth: 820 }} aria-label="Grape source">
                    <TableHead>
                      <TableRow>
                        <TableCell>Intake Date</TableCell>
                        <TableCell align="right">Contributed</TableCell>
                        <TableCell>Status</TableCell>
                        <TableCell>Cultivar</TableCell>
                        <TableCell>Block</TableCell>
                        <TableCell>Harvest</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {intakes.map((i) => (
                        <TableRow key={i.id} hover sx={{ '& .MuiTableCell-root': { py: 1.5 } }}>
                          <TableCell sx={{ color: 'text.secondary' }}>{formatDate(i.intakeDate)}</TableCell>
                          <TableCell align="right" sx={{ fontWeight: 600 }}>
                            {i.contributedKg != null ? `${formatNumber(i.contributedKg)} kg` : '—'}
                          </TableCell>
                          <TableCell>
                            <Chip label={i.intakeStatus || '—'} size="small" color={intakeStatusChip(i.intakeStatus)} sx={{ textTransform: 'capitalize', fontWeight: 600 }} />
                          </TableCell>
                          <TableCell sx={{ color: 'text.secondary' }}>{i.cultivarName || '—'}</TableCell>
                          <TableCell sx={{ color: 'text.secondary' }}>{i.blockName || i.vineyardName || '—'}</TableCell>
                          <TableCell>
                            {i.harvestId ? (
                              <Link component="button" type="button" underline="hover" onClick={() => navigate(`/harvest/${i.harvestId}`)} sx={{ color: 'primary.main', fontWeight: 600, textAlign: 'left' }}>
                                {i.harvestTitle || 'View harvest'}
                              </Link>
                            ) : '—'}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              )}
            </Box>
          </Paper>
        </>
      ) : null}

      <WineLotForm open={editOpen} lot={lot} saving={saving} onSubmit={handleEditSubmit} onClose={() => setEditOpen(false)} />

      <ConfirmDialog open={confirmDelete} title="Delete Wine Lot"
        message={lot ? `Delete lot "${lot.lotCode}"? This cannot be undone.` : ''}
        confirmLabel="Delete" confirmColor="error" loading={deleting} onConfirm={handleDelete} onClose={() => setConfirmDelete(false)} />

      <Snackbar open={Boolean(toast)} autoHideDuration={4000} onClose={() => setToast('')} message={toast} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }} />
    </PageContainer>
  );
}

export default WineLotProfile;
