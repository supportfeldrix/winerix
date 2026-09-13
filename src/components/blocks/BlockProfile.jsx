import { useEffect, useState, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Box,
  Paper,
  Typography,
  Chip,
  Button,
  Divider,
  Grid,
  Skeleton,
  Alert,
  Link,
  Snackbar,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import {
  Table, TableHead, TableBody, TableRow, TableCell, TableContainer,
  IconButton, Tooltip,
} from '@mui/material';
import ArrowBackOutlinedIcon from '@mui/icons-material/ArrowBackOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined';
import TerrainOutlinedIcon from '@mui/icons-material/TerrainOutlined';
import HandymanOutlinedIcon from '@mui/icons-material/HandymanOutlined';
import WaterDropOutlinedIcon from '@mui/icons-material/WaterDropOutlined';
import SanitizerOutlinedIcon from '@mui/icons-material/SanitizerOutlined';
import AddOutlinedIcon from '@mui/icons-material/AddOutlined';
import LocalBarOutlinedIcon from '@mui/icons-material/LocalBarOutlined';
import BlockOutlinedIcon from '@mui/icons-material/BlockOutlined';
import RestartAltOutlinedIcon from '@mui/icons-material/RestartAltOutlined';
import PageContainer from '../layout/PageContainer';
import BlockForm from './BlockForm';
import PlantingForm from './PlantingForm';
import ConfirmDialog from '../common/ConfirmDialog';
import { useOrganisation } from '../../context/OrganisationContext';
import {
  getBlock,
  updateBlock,
  deleteBlock,
  friendlyBlockError,
} from '../../services/blockService';
import {
  getPlantingsByBlock,
  createPlanting,
  updatePlanting,
  deactivatePlanting,
  reactivatePlanting,
  computeAreaPercentages,
  friendlyPlantingError,
} from '../../services/plantingService';

function formatHectares(value) {
  if (value == null) return '—';
  const n = Number(value) || 0;
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 1 })} ha`;
}

function formatDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function statusChipColor(status) {
  const s = (status || '').toLowerCase();
  if (s === 'active') return 'primary';
  if (s === 'archived' || s === 'dormant') return 'default';
  return 'secondary';
}

// Cultivar colour → chip colour (matches the Cultivars page cue).
function cultivarColourChip(colour) {
  const c = (colour || '').toLowerCase();
  if (c === 'red') return 'secondary';
  if (c === 'white') return 'primary';
  if (c === 'rosé') return 'accent';
  return 'default';
}

// Planting status → chip colour.
function plantingStatusChip(status) {
  const s = (status || '').toLowerCase();
  if (s === 'active') return 'success';
  if (s === 'replanted') return 'secondary';
  return 'default'; // removed
}

function formatArea(value) {
  if (value == null) return '—';
  const n = Number(value) || 0;
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 1 })} ha`;
}

function DetailItem({ label, children }) {
  return (
    <Box>
      <Typography variant="overline" sx={{ display: 'block' }}>
        {label}
      </Typography>
      <Typography variant="subtitle1" sx={{ color: 'text.primary', fontWeight: 600 }}>
        {children}
      </Typography>
    </Box>
  );
}

/**
 * Block detail / profile page (route: /blocks/:id).
 * Loads a single block with its parent vineyard, supports edit and delete, and
 * links back to the parent Vineyard Profile.
 */
function BlockProfile() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { activeOrgId } = useOrganisation();

  const [block, setBlock] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [editOpen, setEditOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [toast, setToast] = useState('');

  // ── Plantings state ────────────────────────────────────────────────────────
  const [plantings, setPlantings] = useState([]);
  const [plantingsLoading, setPlantingsLoading] = useState(true);
  const [plantingsError, setPlantingsError] = useState('');
  const [plantingFormOpen, setPlantingFormOpen] = useState(false);
  const [editingPlanting, setEditingPlanting] = useState(null);
  const [plantingSaving, setPlantingSaving] = useState(false);
  const [deactivateTarget, setDeactivateTarget] = useState(null);
  const [deactivating, setDeactivating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    const { data, error: err } = await getBlock(id);
    if (err) {
      setError(friendlyBlockError(err));
      setBlock(null);
    } else {
      setBlock(data);
    }
    setLoading(false);
  }, [id]);

  const loadPlantings = useCallback(async () => {
    setPlantingsLoading(true);
    setPlantingsError('');
    const { data, error: err } = await getPlantingsByBlock(id);
    if (err) {
      setPlantingsError(friendlyPlantingError(err));
      setPlantings([]);
    } else {
      setPlantings(data || []);
    }
    setPlantingsLoading(false);
  }, [id]);

  // Reload block + plantings on mount, on block id change, and whenever the
  // active organisation changes (so no stale cross-org data is shown).
  useEffect(() => {
    if (!activeOrgId) return;
    load();
    loadPlantings();
  }, [activeOrgId, load, loadPlantings]);

  const handleEditSubmit = async (values) => {
    setSaving(true);
    const { data, error: err } = await updateBlock(id, values);
    setSaving(false);
    if (err) {
      setError(friendlyBlockError(err));
      return;
    }
    setBlock(data);
    setEditOpen(false);
    setToast('Block updated.');
  };

  const handleDelete = async () => {
    setDeleting(true);
    const { error: err } = await deleteBlock(id);
    setDeleting(false);
    setConfirmOpen(false);
    if (err) {
      setError(friendlyBlockError(err));
      return;
    }
    navigate('/blocks', { replace: true });
  };

  // ── Planting handlers ────────────────────────────────────────────────────
  const openAddPlanting = () => { setEditingPlanting(null); setPlantingFormOpen(true); };
  const openEditPlanting = (p) => { setEditingPlanting(p); setPlantingFormOpen(true); };

  const handlePlantingSubmit = async (values) => {
    setPlantingSaving(true);
    const isEdit = Boolean(editingPlanting);
    const { error: err } = isEdit
      ? await updatePlanting(editingPlanting.id, values)
      : await createPlanting({ ...values, blockId: id });
    setPlantingSaving(false);
    if (err) { setPlantingsError(friendlyPlantingError(err)); return; }
    setPlantingFormOpen(false); setEditingPlanting(null);
    setToast(isEdit ? 'Planting updated.' : 'Planting added.');
    await loadPlantings();
  };

  const handleDeactivatePlanting = async () => {
    if (!deactivateTarget) return;
    setDeactivating(true);
    const { error: err } = await deactivatePlanting(deactivateTarget.id);
    setDeactivating(false); setDeactivateTarget(null);
    if (err) { setPlantingsError(friendlyPlantingError(err)); return; }
    setToast('Planting removed.'); await loadPlantings();
  };

  const handleReactivatePlanting = async (p) => {
    const { error: err } = await reactivatePlanting(p.id);
    if (err) { setPlantingsError(friendlyPlantingError(err)); return; }
    setToast('Planting reactivated.'); await loadPlantings();
  };

  const { percentages, reliable: percentagesReliable } = computeAreaPercentages(plantings);

  return (
    <PageContainer>
      {/* Back link */}
      <Link
        component="button"
        type="button"
        underline="hover"
        onClick={() => navigate('/blocks')}
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.5,
          color: 'text.secondary',
          mb: 2,
        }}
      >
        <ArrowBackOutlinedIcon sx={{ fontSize: '1.1rem' }} />
        Back to Blocks
      </Link>

      {loading ? (
        <Paper sx={{ p: { xs: 2.5, md: 4 } }}>
          <Skeleton width="40%" height={40} />
          <Skeleton width="25%" height={24} sx={{ mt: 1 }} />
          <Divider sx={{ my: 3 }} />
          <Skeleton width="80%" height={24} />
          <Skeleton width="60%" height={24} sx={{ mt: 1 }} />
        </Paper>
      ) : error && !block ? (
        <Alert severity="error">{error}</Alert>
      ) : block ? (
        <>
          {error && (
            <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
              {error}
            </Alert>
          )}

          <Paper sx={{ p: { xs: 2.5, md: 4 } }}>
            {/* Header */}
            <Box
              sx={{
                display: 'flex',
                flexDirection: { xs: 'column', sm: 'row' },
                alignItems: { xs: 'flex-start', sm: 'center' },
                justifyContent: 'space-between',
                gap: 2,
              }}
            >
              <Box sx={{ minWidth: 0 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
                  <Typography variant="h2" component="h1" sx={{ minWidth: 0 }}>
                    {block.name}
                  </Typography>
                  {block.status && (
                    <Chip
                      label={block.status}
                      color={statusChipColor(block.status)}
                      sx={{ textTransform: 'capitalize' }}
                    />
                  )}
                </Box>

                {/* Parent vineyard link */}
                {block.vineyardId && (
                  <Box
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 0.5,
                      mt: 1,
                      color: 'text.secondary',
                    }}
                  >
                    <TerrainOutlinedIcon sx={{ fontSize: '1.1rem' }} />
                    <Link
                      component="button"
                      type="button"
                      underline="hover"
                      onClick={() => navigate(`/vineyards/${block.vineyardId}`)}
                      sx={{ color: 'primary.main', fontWeight: 600 }}
                    >
                      {block.vineyardName || 'View vineyard'}
                    </Link>
                  </Box>
                )}
              </Box>

              <Box sx={{ display: 'flex', gap: 1, flexShrink: 0, flexWrap: 'wrap' }}>
                <Button
                  variant="contained"
                  color="primary"
                  startIcon={<HandymanOutlinedIcon />}
                  onClick={() => navigate(`/operations?block=${block.id}`)}
                >
                  View Operations
                </Button>
                <Button
                  variant="outlined"
                  color="primary"
                  startIcon={<WaterDropOutlinedIcon />}
                  onClick={() => navigate(`/irrigation?block=${block.id}`)}
                >
                  View Irrigation
                </Button>
                <Button
                  variant="outlined"
                  color="primary"
                  startIcon={<SanitizerOutlinedIcon />}
                  onClick={() => navigate(`/spray-programme?block=${block.id}`)}
                >
                  View Spray Programme
                </Button>
                <Button
                  variant="outlined"
                  color="primary"
                  startIcon={<EditOutlinedIcon />}
                  onClick={() => setEditOpen(true)}
                >
                  Edit
                </Button>
                <Button
                  variant="outlined"
                  color="secondary"
                  startIcon={<DeleteOutlineOutlinedIcon />}
                  onClick={() => setConfirmOpen(true)}
                >
                  Delete
                </Button>
              </Box>
            </Box>

            <Divider sx={{ my: 3 }} />

            {/* Details */}
            <Grid container spacing={3}>
              <Grid item xs={6} sm={3}>
                <DetailItem label="Vineyard">{block.vineyardName || '—'}</DetailItem>
              </Grid>
              <Grid item xs={6} sm={3}>
                <DetailItem label="Area">{formatHectares(block.areaHectares)}</DetailItem>
              </Grid>
              <Grid item xs={6} sm={3}>
                <DetailItem label="Created">{formatDate(block.createdAt)}</DetailItem>
              </Grid>
              <Grid item xs={6} sm={3}>
                <DetailItem label="Last Updated">{formatDate(block.updatedAt)}</DetailItem>
              </Grid>
            </Grid>
          </Paper>

          {/* ── Plantings ─────────────────────────────────────────────── */}
          <Paper sx={{ p: { xs: 2.5, md: 4 }, mt: { xs: 3, md: 4 } }}>
            <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, alignItems: { xs: 'stretch', sm: 'center' }, justifyContent: 'space-between', gap: 2, mb: 1 }}>
              <Box>
                <Typography variant="h4" component="h2" sx={{ mb: 0.5 }}>Plantings</Typography>
                <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                  The grape varieties planted in this block.
                </Typography>
              </Box>
              <Button variant="contained" color="primary" startIcon={<AddOutlinedIcon />} onClick={openAddPlanting} sx={{ flexShrink: 0 }}>
                Add Planting
              </Button>
            </Box>

            {plantingsError && (
              <Alert severity="error" sx={{ my: 2 }} onClose={() => setPlantingsError('')}>{plantingsError}</Alert>
            )}

            <Box sx={{ mt: 2 }}>
              {plantingsLoading ? (
                <Box>
                  <Skeleton height={44} />
                  <Skeleton height={44} sx={{ mt: 1 }} />
                </Box>
              ) : plantings.length === 0 ? (
                <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', px: 3, py: { xs: 4, md: 5 }, textAlign: 'center' }}>
                  <Box sx={{ width: 56, height: 56, borderRadius: '50%', bgcolor: 'background.paper', display: 'flex', alignItems: 'center', justifyContent: 'center', mx: 'auto', mb: 1.5, color: 'secondary.main' }}>
                    <LocalBarOutlinedIcon sx={{ fontSize: '1.7rem' }} />
                  </Box>
                  <Typography variant="body1" sx={{ color: 'text.secondary', maxWidth: 420, mx: 'auto' }}>
                    This block has no plantings yet. Add a planting to record the cultivars grown here.
                  </Typography>
                </Paper>
              ) : (
                <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 3, overflow: 'hidden' }}>
                  <Table sx={{ minWidth: 760 }} aria-label="Plantings">
                    <TableHead>
                      <TableRow>
                        <TableCell>Cultivar</TableCell>
                        <TableCell>Colour</TableCell>
                        <TableCell align="right">Area</TableCell>
                        <TableCell align="right">Share</TableCell>
                        <TableCell>Year</TableCell>
                        <TableCell>Rootstock</TableCell>
                        <TableCell>Clone</TableCell>
                        <TableCell>Status</TableCell>
                        <TableCell align="right">Actions</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {plantings.map((p) => {
                        const pct = percentagesReliable && p.status === 'active' ? percentages.get(p.id) : undefined;
                        return (
                          <TableRow key={p.id} hover sx={{ '& .MuiTableCell-root': { py: 1.5 }, opacity: p.status === 'removed' ? 0.6 : 1 }}>
                            <TableCell>
                              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
                                <Box sx={{ width: 32, height: 32, borderRadius: 1.5, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'secondary.main', bgcolor: (t) => alpha(t.palette.secondary.main, 0.12) }}>
                                  <LocalBarOutlinedIcon sx={{ fontSize: '1rem' }} />
                                </Box>
                                <Typography variant="body2" sx={{ fontWeight: 600 }}>{p.cultivarName || '—'}</Typography>
                              </Box>
                            </TableCell>
                            <TableCell>
                              {p.cultivarColour
                                ? <Chip label={p.cultivarColour} size="small" color={cultivarColourChip(p.cultivarColour)} sx={{ textTransform: 'capitalize', fontWeight: 600 }} />
                                : <Typography variant="body2" sx={{ color: 'text.secondary' }}>—</Typography>}
                            </TableCell>
                            <TableCell align="right" sx={{ fontWeight: 600 }}>{formatArea(p.areaHectares)}</TableCell>
                            <TableCell align="right" sx={{ color: 'text.secondary' }}>
                              {pct != null ? `${pct.toLocaleString(undefined, { maximumFractionDigits: 1 })}%` : '—'}
                            </TableCell>
                            <TableCell sx={{ color: 'text.secondary' }}>{p.plantingYear ?? '—'}</TableCell>
                            <TableCell sx={{ color: 'text.secondary' }}>{p.rootstock || '—'}</TableCell>
                            <TableCell sx={{ color: 'text.secondary' }}>{p.clone || '—'}</TableCell>
                            <TableCell>
                              <Chip label={p.status} size="small" color={plantingStatusChip(p.status)} sx={{ textTransform: 'capitalize', fontWeight: 600 }} />
                            </TableCell>
                            <TableCell align="right">
                              <Box sx={{ display: 'inline-flex' }}>
                                <Tooltip title="Edit"><IconButton size="small" aria-label={`Edit ${p.cultivarName || 'planting'}`} onClick={() => openEditPlanting(p)}><EditOutlinedIcon fontSize="small" /></IconButton></Tooltip>
                                {p.status === 'removed' ? (
                                  <Tooltip title="Reactivate"><IconButton size="small" color="primary" aria-label="Reactivate planting" onClick={() => handleReactivatePlanting(p)}><RestartAltOutlinedIcon fontSize="small" /></IconButton></Tooltip>
                                ) : (
                                  <Tooltip title="Remove"><IconButton size="small" color="error" aria-label="Remove planting" onClick={() => setDeactivateTarget(p)}><BlockOutlinedIcon fontSize="small" /></IconButton></Tooltip>
                                )}
                              </Box>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </TableContainer>
              )}
            </Box>
          </Paper>
        </>
      ) : null}

      {/* Edit dialog */}
      <BlockForm
        open={editOpen}
        block={block}
        saving={saving}
        onSubmit={handleEditSubmit}
        onClose={() => setEditOpen(false)}
      />

      {/* Delete confirmation */}
      <ConfirmDialog
        open={confirmOpen}
        title="Delete Block"
        message={
          block
            ? `Are you sure you want to delete "${block.name}"? This cannot be undone.`
            : ''
        }
        confirmLabel="Delete"
        confirmColor="error"
        loading={deleting}
        onConfirm={handleDelete}
        onClose={() => setConfirmOpen(false)}
      />

      {/* Planting add/edit dialog */}
      <PlantingForm
        open={plantingFormOpen}
        planting={editingPlanting}
        saving={plantingSaving}
        onSubmit={handlePlantingSubmit}
        onClose={() => { setPlantingFormOpen(false); setEditingPlanting(null); }}
      />

      {/* Planting remove (deactivate) confirmation */}
      <ConfirmDialog
        open={Boolean(deactivateTarget)}
        title="Remove Planting"
        message={deactivateTarget ? `Remove the ${deactivateTarget.cultivarName || 'selected'} planting from this block? It will be marked as removed but preserved for history, and can be reactivated later.` : ''}
        confirmLabel="Remove"
        confirmColor="error"
        loading={deactivating}
        onConfirm={handleDeactivatePlanting}
        onClose={() => setDeactivateTarget(null)}
      />

      <Snackbar
        open={Boolean(toast)}
        autoHideDuration={4000}
        onClose={() => setToast('')}
        message={toast}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />
    </PageContainer>
  );
}

export default BlockProfile;
