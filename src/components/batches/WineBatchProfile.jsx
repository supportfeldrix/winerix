import { useEffect, useState, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Box, Paper, Typography, Chip, Button, Divider, Grid, Skeleton, Alert, Link, Snackbar,
  Table, TableHead, TableBody, TableRow, TableCell, TableContainer, IconButton, Tooltip,
} from '@mui/material';
import ArrowBackOutlinedIcon from '@mui/icons-material/ArrowBackOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined';
import LinkOffOutlinedIcon from '@mui/icons-material/LinkOffOutlined';
import AddOutlinedIcon from '@mui/icons-material/AddOutlined';
import ScaleOutlinedIcon from '@mui/icons-material/ScaleOutlined';
import PageContainer from '../layout/PageContainer';
import WineBatchForm from './WineBatchForm';
import BatchIntakeForm from './BatchIntakeForm';
import { batchStatusColor } from './WineBatchTable';
import ConfirmDialog from '../common/ConfirmDialog';
import { formatDate, formatNumber } from '../common/formatters';
import { useOrganisation } from '../../context/OrganisationContext';
import {
  getWineBatch, updateWineBatch, deleteWineBatch,
  getBatchIntakes, getIntakeOptions, addIntakeToBatch, updateBatchIntake,
  removeIntakeFromBatch, sumContributedKg, friendlyWineBatchError,
} from '../../services/wineBatchService';

// Grape-intake status → chip colour (matches the harvest-side convention).
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

function WineBatchProfile() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { activeOrgId } = useOrganisation();

  const [batch, setBatch] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editOpen, setEditOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDeleteBatch, setConfirmDeleteBatch] = useState(false);
  const [deletingBatch, setDeletingBatch] = useState(false);
  const [toast, setToast] = useState('');

  // ── Linked grape intakes state ──────────────────────────────────────────
  const [links, setLinks] = useState([]);
  const [linksLoading, setLinksLoading] = useState(true);
  const [linksError, setLinksError] = useState('');
  const [linkFormOpen, setLinkFormOpen] = useState(false);
  const [editingLink, setEditingLink] = useState(null);
  const [linkSaving, setLinkSaving] = useState(false);
  const [intakeOptions, setIntakeOptions] = useState([]);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [removeTarget, setRemoveTarget] = useState(null);
  const [removing, setRemoving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    const { data, error: err } = await getWineBatch(id);
    if (err) { setError(friendlyWineBatchError(err)); setBatch(null); }
    else setBatch(data);
    setLoading(false);
  }, [id]);

  const loadLinks = useCallback(async () => {
    setLinksLoading(true); setLinksError('');
    const { data, error: err } = await getBatchIntakes(id);
    if (err) { setLinksError(friendlyWineBatchError(err)); setLinks([]); }
    else setLinks(data || []);
    setLinksLoading(false);
  }, [id]);

  // Reload batch + links on mount, id change, and whenever the active
  // organisation changes (so no stale cross-org data is shown).
  useEffect(() => {
    if (!activeOrgId) return;
    load();
    loadLinks();
  }, [activeOrgId, load, loadLinks]);

  const handleEditSubmit = async (values) => {
    setSaving(true);
    const { data, error: err } = await updateWineBatch(id, values);
    setSaving(false);
    if (err) { setError(friendlyWineBatchError(err)); return; }
    setBatch(data); setEditOpen(false); setToast('Wine batch updated.');
  };

  const handleDeleteBatch = async () => {
    setDeletingBatch(true);
    const { error: err } = await deleteWineBatch(id);
    setDeletingBatch(false); setConfirmDeleteBatch(false);
    if (err) { setError(friendlyWineBatchError(err)); return; }
    navigate('/wine-batches', { replace: true });
  };

  // ── Link handlers ─────────────────────────────────────────────────────────
  const openAddLink = async () => {
    setEditingLink(null);
    setLinkFormOpen(true);
    // Load selectable intakes, excluding those already linked to this batch.
    setOptionsLoading(true);
    const { data, error: err } = await getIntakeOptions();
    setOptionsLoading(false);
    if (err) { setLinksError(friendlyWineBatchError(err)); setIntakeOptions([]); return; }
    const linkedIds = new Set(links.map((l) => l.grapeIntakeId));
    setIntakeOptions((data || []).filter((o) => !linkedIds.has(o.id)));
  };

  const openEditLink = (l) => { setEditingLink(l); setLinkFormOpen(true); };

  const handleLinkSubmit = async (values) => {
    setLinkSaving(true);
    const isEdit = Boolean(editingLink);
    const { error: err } = isEdit
      ? await updateBatchIntake(editingLink.id, values.contributedKg)
      : await addIntakeToBatch(id, values.grapeIntakeId, values.contributedKg);
    setLinkSaving(false);
    if (err) { setLinksError(friendlyWineBatchError(err)); return; }
    setLinkFormOpen(false); setEditingLink(null);
    setToast(isEdit ? 'Contribution updated.' : 'Grape intake linked.');
    await loadLinks();
  };

  const handleRemoveLink = async () => {
    if (!removeTarget) return;
    setRemoving(true);
    const { error: err } = await removeIntakeFromBatch(removeTarget.id);
    setRemoving(false); setRemoveTarget(null);
    if (err) { setLinksError(friendlyWineBatchError(err)); return; }
    setToast('Grape intake unlinked.'); await loadLinks();
  };

  const totalKg = sumContributedKg(links);

  return (
    <PageContainer>
      <Link component="button" type="button" underline="hover" onClick={() => navigate('/wine-batches')}
        sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, color: 'text.secondary', mb: 2 }}>
        <ArrowBackOutlinedIcon sx={{ fontSize: '1.1rem' }} /> Back to Wine Batches
      </Link>

      {loading ? (
        <Paper sx={{ p: { xs: 2.5, md: 4 } }}>
          <Skeleton width="40%" height={40} /><Skeleton width="25%" height={24} sx={{ mt: 1 }} />
          <Divider sx={{ my: 3 }} /><Skeleton width="80%" height={24} />
        </Paper>
      ) : error && !batch ? (
        <Alert severity="error">{error}</Alert>
      ) : batch ? (
        <>
          {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}
          <Paper sx={{ p: { xs: 2.5, md: 4 } }}>
            <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, alignItems: { xs: 'flex-start', sm: 'center' }, justifyContent: 'space-between', gap: 2 }}>
              <Box sx={{ minWidth: 0 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
                  <Typography variant="h2" component="h1" sx={{ minWidth: 0 }}>{batch.batchCode}</Typography>
                  <Chip label={batch.status} color={batchStatusColor(batch.status)} sx={{ textTransform: 'capitalize' }} />
                </Box>
                {batch.name && (
                  <Typography variant="body1" sx={{ mt: 1, color: 'text.secondary' }}>{batch.name}</Typography>
                )}
              </Box>
              <Box sx={{ display: 'flex', gap: 1, flexShrink: 0 }}>
                <Button variant="outlined" color="primary" startIcon={<EditOutlinedIcon />} onClick={() => setEditOpen(true)}>Edit</Button>
                <Button variant="outlined" color="secondary" startIcon={<DeleteOutlineOutlinedIcon />} onClick={() => setConfirmDeleteBatch(true)}>Delete</Button>
              </Box>
            </Box>
            <Divider sx={{ my: 3 }} />
            <Grid container spacing={3}>
              <Grid item xs={6} sm={3}><DetailItem label="Vintage">{batch.vintage != null ? batch.vintage : '—'}</DetailItem></Grid>
              <Grid item xs={6} sm={3}><DetailItem label="Status"><Box sx={{ textTransform: 'capitalize' }}>{batch.status}</Box></DetailItem></Grid>
              <Grid item xs={6} sm={3}><DetailItem label="Total Contributed">{formatNumber(totalKg)} kg</DetailItem></Grid>
              <Grid item xs={6} sm={3}><DetailItem label="Grape Intakes">{links.length}</DetailItem></Grid>
              <Grid item xs={12} sm={6}><DetailItem label="Created">{formatDate(batch.createdAt)}</DetailItem></Grid>
              <Grid item xs={12} sm={6}><DetailItem label="Last Updated">{formatDate(batch.updatedAt)}</DetailItem></Grid>
              {batch.notes && (
                <Grid item xs={12}><DetailItem label="Notes"><Typography variant="body2" sx={{ fontWeight: 400, color: 'text.secondary', whiteSpace: 'pre-wrap' }}>{batch.notes}</Typography></DetailItem></Grid>
              )}
            </Grid>
          </Paper>

          {/* ── Grape Intakes (linkage) ───────────────────────────────── */}
          <Paper sx={{ p: { xs: 2.5, md: 4 }, mt: { xs: 3, md: 4 } }}>
            <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, alignItems: { xs: 'stretch', sm: 'center' }, justifyContent: 'space-between', gap: 2, mb: 1 }}>
              <Box>
                <Typography variant="h4" component="h2" sx={{ mb: 0.5 }}>Grape Intakes</Typography>
                <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                  Grape deliveries contributing to this batch. Trace each back to its harvest and cultivar.
                </Typography>
              </Box>
              <Button variant="contained" color="primary" startIcon={<AddOutlinedIcon />} onClick={openAddLink} sx={{ flexShrink: 0 }}>
                Add Intake
              </Button>
            </Box>

            {linksError && (
              <Alert severity="error" sx={{ my: 2 }} onClose={() => setLinksError('')}>{linksError}</Alert>
            )}

            <Box sx={{ mt: 2 }}>
              {linksLoading ? (
                <Box>
                  <Skeleton height={44} />
                  <Skeleton height={44} sx={{ mt: 1 }} />
                </Box>
              ) : links.length === 0 ? (
                <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', px: 3, py: { xs: 4, md: 5 }, textAlign: 'center' }}>
                  <Box sx={{ width: 56, height: 56, borderRadius: '50%', bgcolor: 'background.paper', display: 'flex', alignItems: 'center', justifyContent: 'center', mx: 'auto', mb: 1.5, color: 'accent.main' }}>
                    <ScaleOutlinedIcon sx={{ fontSize: '1.7rem' }} />
                  </Box>
                  <Typography variant="body1" sx={{ color: 'text.secondary', maxWidth: 460, mx: 'auto' }}>
                    No grape intakes linked yet. Add an existing grape intake to record what went into this batch.
                  </Typography>
                </Paper>
              ) : (
                <>
                  <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 3, overflow: 'hidden' }}>
                    <Table sx={{ minWidth: 820 }} aria-label="Linked grape intakes">
                      <TableHead>
                        <TableRow>
                          <TableCell>Intake Date</TableCell>
                          <TableCell align="right">Received</TableCell>
                          <TableCell align="right">Contributed</TableCell>
                          <TableCell>Status</TableCell>
                          <TableCell>Cultivar</TableCell>
                          <TableCell>Harvest</TableCell>
                          <TableCell align="right">Actions</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {links.map((l) => (
                          <TableRow key={l.id} hover sx={{ '& .MuiTableCell-root': { py: 1.5 } }}>
                            <TableCell sx={{ color: 'text.secondary' }}>{formatDate(l.intakeDate)}</TableCell>
                            <TableCell align="right" sx={{ color: 'text.secondary' }}>
                              {l.intakeReceivedKg != null ? `${formatNumber(l.intakeReceivedKg)} kg` : '—'}
                            </TableCell>
                            <TableCell align="right" sx={{ fontWeight: 600 }}>
                              {l.contributedKg != null ? `${formatNumber(l.contributedKg)} kg` : '—'}
                            </TableCell>
                            <TableCell>
                              <Chip label={l.intakeStatus || '—'} size="small" color={intakeStatusChip(l.intakeStatus)} sx={{ textTransform: 'capitalize', fontWeight: 600 }} />
                            </TableCell>
                            <TableCell sx={{ color: 'text.secondary' }}>{l.cultivarName || '—'}</TableCell>
                            <TableCell>
                              {l.harvestId ? (
                                <Link component="button" type="button" underline="hover" onClick={() => navigate(`/harvest/${l.harvestId}`)} sx={{ color: 'primary.main', fontWeight: 600, textAlign: 'left' }}>
                                  {l.harvestTitle || 'View harvest'}
                                </Link>
                              ) : '—'}
                            </TableCell>
                            <TableCell align="right">
                              <Box sx={{ display: 'inline-flex' }}>
                                <Tooltip title="Edit contribution"><IconButton size="small" aria-label="Edit contribution" onClick={() => openEditLink(l)}><EditOutlinedIcon fontSize="small" /></IconButton></Tooltip>
                                <Tooltip title="Unlink"><IconButton size="small" color="error" aria-label="Unlink grape intake" onClick={() => setRemoveTarget(l)}><LinkOffOutlinedIcon fontSize="small" /></IconButton></Tooltip>
                              </Box>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableContainer>
                  <Box sx={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'baseline', gap: 1, mt: 2 }}>
                    <Typography variant="overline" sx={{ color: 'text.secondary' }}>Total Contributed</Typography>
                    <Typography variant="h6" component="p" sx={{ fontWeight: 700 }}>
                      {formatNumber(totalKg)} kg
                    </Typography>
                    {totalKg > 0 && (
                      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                        ({formatNumber(totalKg / 1000)} t)
                      </Typography>
                    )}
                  </Box>
                </>
              )}
            </Box>
          </Paper>
        </>
      ) : null}

      <WineBatchForm open={editOpen} batch={batch} saving={saving} onSubmit={handleEditSubmit} onClose={() => setEditOpen(false)} />

      <BatchIntakeForm
        open={linkFormOpen}
        link={editingLink}
        options={intakeOptions}
        optionsLoading={optionsLoading}
        saving={linkSaving}
        onSubmit={handleLinkSubmit}
        onClose={() => { setLinkFormOpen(false); setEditingLink(null); }}
      />

      <ConfirmDialog open={confirmDeleteBatch} title="Delete Wine Batch"
        message={batch ? `Delete batch "${batch.batchCode}"? This removes the batch and its grape-intake links. The grape intakes themselves are not affected. This cannot be undone.` : ''}
        confirmLabel="Delete" confirmColor="error" loading={deletingBatch} onConfirm={handleDeleteBatch} onClose={() => setConfirmDeleteBatch(false)} />

      <ConfirmDialog open={Boolean(removeTarget)} title="Unlink Grape Intake"
        message={removeTarget ? `Remove this grape intake from the batch? The intake itself is not deleted.` : ''}
        confirmLabel="Unlink" confirmColor="error" loading={removing} onConfirm={handleRemoveLink} onClose={() => setRemoveTarget(null)} />

      <Snackbar open={Boolean(toast)} autoHideDuration={4000} onClose={() => setToast('')} message={toast} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }} />
    </PageContainer>
  );
}

export default WineBatchProfile;
