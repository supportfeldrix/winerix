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
import PropaneTankOutlinedIcon from '@mui/icons-material/PropaneTankOutlined';
import SwapHorizOutlinedIcon from '@mui/icons-material/SwapHorizOutlined';
import LogoutOutlinedIcon from '@mui/icons-material/LogoutOutlined';
import AddOutlinedIcon from '@mui/icons-material/AddOutlined';
import PageContainer from '../layout/PageContainer';
import WineLotForm from './WineLotForm';
import { lotStatusColor, lotStatusLabel } from './WineLotTable';
import PlaceLotDialog from '../vessels/PlaceLotDialog';
import ConfirmDialog from '../common/ConfirmDialog';
import { formatDate, formatNumber } from '../common/formatters';
import { useOrganisation } from '../../context/OrganisationContext';
import {
  getWineLotWithBatch, updateWineLot, deleteWineLot, friendlyWineLotError,
} from '../../services/wineLotService';
import {
  getCurrentWineLotPlacement, getAvailableVesselOptions, getWineLotPlacements,
  placeWineLot, transferWineLot, removeWineLotFromVessel, friendlyVesselError,
} from '../../services/vesselService';
import ProductionEventForm from './ProductionEventForm';
import {
  getProductionEventsByLot, createProductionEvent,
  productionEventTypeLabel, friendlyProductionEventError,
} from '../../services/productionEventService';
import HistoryOutlinedIcon from '@mui/icons-material/HistoryOutlined';

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

  // ── Current vessel placement state ──────────────────────────────────────
  const [placement, setPlacement] = useState(null);
  const [placementLoading, setPlacementLoading] = useState(true);
  const [placementError, setPlacementError] = useState('');
  const [vesselDialog, setVesselDialog] = useState(null); // 'place' | 'transfer' | null
  const [vesselOptions, setVesselOptions] = useState([]);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [vesselSaving, setVesselSaving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);

  // ── Production events (immutable history) ───────────────────────────────
  const [events, setEvents] = useState([]);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [eventsError, setEventsError] = useState('');
  const [eventFormOpen, setEventFormOpen] = useState(false);
  const [eventSaving, setEventSaving] = useState(false);
  const [lotPlacements, setLotPlacements] = useState([]);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    const { data, error: err } = await getWineLotWithBatch(id);
    if (err) { setError(friendlyWineLotError(err)); setLot(null); setIntakes([]); }
    else { setLot(data.lot); setIntakes(data.intakes || []); }
    setLoading(false);
  }, [id]);

  const loadPlacement = useCallback(async () => {
    setPlacementLoading(true); setPlacementError('');
    const { data, error: err } = await getCurrentWineLotPlacement(id);
    if (err) { setPlacementError(friendlyVesselError(err)); setPlacement(null); }
    else setPlacement(data);
    setPlacementLoading(false);
  }, [id]);

  const loadEvents = useCallback(async () => {
    setEventsLoading(true); setEventsError('');
    const { data, error: err } = await getProductionEventsByLot(id);
    if (err) { setEventsError(friendlyProductionEventError(err)); setEvents([]); }
    else setEvents(data || []);
    setEventsLoading(false);
  }, [id]);

  // Reload on mount, id change, and whenever the active organisation changes
  // (so no stale cross-org data is shown).
  useEffect(() => {
    if (!activeOrgId) return;
    load();
    loadPlacement();
    loadEvents();
  }, [activeOrgId, load, loadPlacement, loadEvents]);

  const openEventForm = async () => {
    setEventFormOpen(true);
    // Load active vessels + this lot's placements for the (optional) selectors.
    setOptionsLoading(true);
    const [{ data: vessels, error: vErr }, { data: placements, error: pErr }] = await Promise.all([
      getAvailableVesselOptions(),
      getWineLotPlacements(id),
    ]);
    setOptionsLoading(false);
    if (vErr) { setEventsError(friendlyVesselError(vErr)); setVesselOptions([]); }
    else setVesselOptions(vessels || []);
    if (pErr) setLotPlacements([]);
    else setLotPlacements(placements || []);
  };

  const handleEventSubmit = async (values) => {
    setEventSaving(true);
    const { error: err } = await createProductionEvent({ ...values, wineLotId: id });
    setEventSaving(false);
    if (err) { setEventsError(friendlyProductionEventError(err)); return; }
    setEventFormOpen(false);
    setToast('Production event recorded.');
    await loadEvents();
  };

  const openVesselDialog = async (mode) => {
    setVesselDialog(mode);
    setOptionsLoading(true);
    const { data, error: err } = await getAvailableVesselOptions();
    setOptionsLoading(false);
    if (err) { setPlacementError(friendlyVesselError(err)); setVesselOptions([]); return; }
    setVesselOptions(data || []);
  };

  const handleVesselSubmit = async ({ vesselId, at }) => {
    setVesselSaving(true);
    const isTransfer = vesselDialog === 'transfer';
    const { error: err } = isTransfer
      ? await transferWineLot(id, vesselId, at)
      : await placeWineLot(id, vesselId, undefined, at);
    setVesselSaving(false);
    if (err) { setPlacementError(friendlyVesselError(err)); return; }
    setVesselDialog(null);
    setToast(isTransfer ? 'Wine lot transferred.' : 'Wine lot placed in vessel.');
    await loadPlacement();
  };

  const handleRemoveFromVessel = async () => {
    setRemoving(true);
    const { error: err } = await removeWineLotFromVessel(id);
    setRemoving(false); setConfirmRemove(false);
    if (err) { setPlacementError(friendlyVesselError(err)); return; }
    setToast('Wine lot removed from vessel.');
    await loadPlacement();
  };

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

          {/* ── Current Vessel ────────────────────────────────────────── */}
          <Paper sx={{ p: { xs: 2.5, md: 4 }, mt: { xs: 3, md: 4 } }}>
            <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, alignItems: { xs: 'stretch', sm: 'center' }, justifyContent: 'space-between', gap: 2, mb: 1 }}>
              <Box>
                <Typography variant="h4" component="h2" sx={{ mb: 0.5 }}>Current Vessel</Typography>
                <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                  Where this lot is currently held in the cellar.
                </Typography>
              </Box>
              <Box sx={{ display: 'flex', gap: 1, flexShrink: 0, flexWrap: 'wrap' }}>
                {placement ? (
                  <>
                    <Button variant="outlined" color="primary" startIcon={<SwapHorizOutlinedIcon />} onClick={() => openVesselDialog('transfer')}>Transfer</Button>
                    <Button variant="outlined" color="secondary" startIcon={<LogoutOutlinedIcon />} onClick={() => setConfirmRemove(true)}>Remove</Button>
                  </>
                ) : (
                  <Button variant="contained" color="primary" startIcon={<AddOutlinedIcon />} onClick={() => openVesselDialog('place')}>Place in Vessel</Button>
                )}
              </Box>
            </Box>

            {placementError && (
              <Alert severity="error" sx={{ my: 2 }} onClose={() => setPlacementError('')}>{placementError}</Alert>
            )}

            <Box sx={{ mt: 2 }}>
              {placementLoading ? (
                <Skeleton height={72} />
              ) : placement ? (
                <Paper variant="outlined" sx={{ borderRadius: 3, p: { xs: 2, md: 2.5 }, display: 'flex', alignItems: 'center', gap: 2 }}>
                  <Box sx={{ width: 44, height: 44, borderRadius: 1.5, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'primary.main', bgcolor: 'action.hover' }}>
                    <PropaneTankOutlinedIcon />
                  </Box>
                  <Grid container spacing={2} sx={{ flex: 1 }}>
                    <Grid item xs={6} sm={3}>
                      <DetailItem label="Vessel">
                        <Link component="button" type="button" underline="hover" onClick={() => navigate(`/vessels/${placement.vesselId}`)} sx={{ color: 'primary.main', fontWeight: 600 }}>
                          {placement.vesselCode || 'View vessel'}
                        </Link>
                      </DetailItem>
                    </Grid>
                    <Grid item xs={6} sm={3}><DetailItem label="Vessel Name">{placement.vesselName || '—'}</DetailItem></Grid>
                    <Grid item xs={6} sm={3}><DetailItem label="Volume">{placement.volumeLitres != null ? `${formatNumber(placement.volumeLitres)} L` : '—'}</DetailItem></Grid>
                    <Grid item xs={6} sm={3}><DetailItem label="Placed">{formatDate(placement.placedAt)}</DetailItem></Grid>
                  </Grid>
                </Paper>
              ) : (
                <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', px: 3, py: { xs: 3, md: 4 }, textAlign: 'center' }}>
                  <Typography variant="body1" sx={{ color: 'text.secondary' }}>Not currently assigned to a vessel.</Typography>
                </Paper>
              )}
            </Box>
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

          {/* ── Production History (immutable events) ──────────────────── */}
          <Paper sx={{ p: { xs: 2.5, md: 4 }, mt: { xs: 3, md: 4 } }}>
            <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, alignItems: { xs: 'stretch', sm: 'center' }, justifyContent: 'space-between', gap: 2, mb: 1 }}>
              <Box>
                <Typography variant="h4" component="h2" sx={{ mb: 0.5 }}>Production History</Typography>
                <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                  A record of cellar operations performed on this lot. Events are kept as history and cannot be edited.
                </Typography>
              </Box>
              <Button variant="contained" color="primary" startIcon={<AddOutlinedIcon />} onClick={openEventForm} sx={{ flexShrink: 0 }}>
                Add Event
              </Button>
            </Box>

            {eventsError && (
              <Alert severity="error" sx={{ my: 2 }} onClose={() => setEventsError('')}>{eventsError}</Alert>
            )}

            <Box sx={{ mt: 2 }}>
              {eventsLoading ? (
                <Box>
                  <Skeleton height={44} />
                  <Skeleton height={44} sx={{ mt: 1 }} />
                </Box>
              ) : events.length === 0 ? (
                <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', px: 3, py: { xs: 4, md: 5 }, textAlign: 'center' }}>
                  <Box sx={{ width: 56, height: 56, borderRadius: '50%', bgcolor: 'background.paper', display: 'flex', alignItems: 'center', justifyContent: 'center', mx: 'auto', mb: 1.5, color: 'accent.main' }}>
                    <HistoryOutlinedIcon sx={{ fontSize: '1.7rem' }} />
                  </Box>
                  <Typography variant="body1" sx={{ color: 'text.secondary', maxWidth: 460, mx: 'auto' }}>
                    No production events recorded yet. Add an event to record a cellar operation on this lot.
                  </Typography>
                </Paper>
              ) : (
                <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 3, overflow: 'hidden' }}>
                  <Table sx={{ minWidth: 720 }} aria-label="Production history">
                    <TableHead>
                      <TableRow>
                        <TableCell>Event</TableCell>
                        <TableCell>Date &amp; Time</TableCell>
                        <TableCell>Vessel</TableCell>
                        <TableCell>Notes</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {events.map((ev) => (
                        <TableRow key={ev.id} hover sx={{ '& .MuiTableCell-root': { py: 1.5 } }}>
                          <TableCell>
                            <Chip label={productionEventTypeLabel(ev.eventType)} size="small" color="secondary" sx={{ fontWeight: 600 }} />
                          </TableCell>
                          <TableCell sx={{ color: 'text.secondary' }}>{formatDate(ev.eventAt)}</TableCell>
                          <TableCell>
                            {ev.vesselId ? (
                              <Link component="button" type="button" underline="hover" onClick={() => navigate(`/vessels/${ev.vesselId}`)} sx={{ color: 'primary.main', fontWeight: 600, textAlign: 'left' }}>
                                {ev.vesselCode || 'View vessel'}
                              </Link>
                            ) : <Typography variant="body2" sx={{ color: 'text.secondary' }}>—</Typography>}
                          </TableCell>
                          <TableCell sx={{ color: 'text.secondary', maxWidth: 320 }}>
                            <Typography variant="body2" sx={{ color: 'text.secondary', whiteSpace: 'pre-wrap' }}>{ev.notes || '—'}</Typography>
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

      <ProductionEventForm
        open={eventFormOpen}
        vesselOptions={vesselOptions}
        lotPlacements={lotPlacements}
        optionsLoading={optionsLoading}
        saving={eventSaving}
        onSubmit={handleEventSubmit}
        onClose={() => setEventFormOpen(false)}
      />

      <PlaceLotDialog
        open={Boolean(vesselDialog)}
        mode={vesselDialog === 'transfer' ? 'transfer' : 'place'}
        volumeLitres={lot ? lot.volumeLitres : null}
        currentVesselId={placement ? placement.vesselId : null}
        currentVesselLabel={placement ? [placement.vesselCode, placement.vesselName].filter(Boolean).join('  ·  ') : null}
        options={vesselOptions}
        optionsLoading={optionsLoading}
        saving={vesselSaving}
        onSubmit={handleVesselSubmit}
        onClose={() => setVesselDialog(null)}
      />

      <ConfirmDialog open={confirmRemove} title="Remove from Vessel"
        message={placement ? `Remove this lot from ${placement.vesselCode || 'its vessel'}? The placement history is preserved.` : ''}
        confirmLabel="Remove" confirmColor="error" loading={removing} onConfirm={handleRemoveFromVessel} onClose={() => setConfirmRemove(false)} />

      <ConfirmDialog open={confirmDelete} title="Delete Wine Lot"
        message={lot ? `Delete lot "${lot.lotCode}"? This cannot be undone.` : ''}
        confirmLabel="Delete" confirmColor="error" loading={deleting} onConfirm={handleDelete} onClose={() => setConfirmDelete(false)} />

      <Snackbar open={Boolean(toast)} autoHideDuration={4000} onClose={() => setToast('')} message={toast} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }} />
    </PageContainer>
  );
}

export default WineLotProfile;
