import { useEffect, useState, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Box, Paper, Typography, Chip, Button, Divider, Grid, Skeleton, Alert, Link, Snackbar,
  Table, TableHead, TableBody, TableRow, TableCell, TableContainer, IconButton, Tooltip,
} from '@mui/material';
import ArrowBackOutlinedIcon from '@mui/icons-material/ArrowBackOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined';
import TerrainOutlinedIcon from '@mui/icons-material/TerrainOutlined';
import AddOutlinedIcon from '@mui/icons-material/AddOutlined';
import ScaleOutlinedIcon from '@mui/icons-material/ScaleOutlined';
import PageContainer from '../layout/PageContainer';
import HarvestForm from './HarvestForm';
import GrapeIntakeForm from './GrapeIntakeForm';
import ConfirmDialog from '../common/ConfirmDialog';
import { formatDate, formatNumber, activityStatusColor } from '../common/formatters';
import { useOrganisation } from '../../context/OrganisationContext';
import {
  getHarvest, updateHarvest, deleteHarvest, friendlyHarvestError,
} from '../../services/harvestService';
import {
  getIntakesByHarvest, createIntake, updateIntake,
  totalReceivedKg, friendlyIntakeError, INTAKE_STATUSES,
} from '../../services/intakeService';

// Grape-intake status → chip colour.
function intakeStatusChip(status) {
  const s = (status || '').toLowerCase();
  if (s === 'processed') return 'success';
  if (s === 'rejected') return 'default';
  return 'secondary'; // received
}

function intakeStatusLabel(status) {
  const found = INTAKE_STATUSES.find((s) => s.value === status);
  return found ? found.label : status;
}

function DetailItem({ label, children }) {
  return (
    <Box>
      <Typography variant="overline" sx={{ display: 'block' }}>{label}</Typography>
      <Typography variant="subtitle1" sx={{ color: 'text.primary', fontWeight: 600 }}>{children}</Typography>
    </Box>
  );
}

function HarvestProfile() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { activeOrgId } = useOrganisation();
  const [record, setRecord] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editOpen, setEditOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [toast, setToast] = useState('');

  // ── Grape intakes state ─────────────────────────────────────────────────
  const [intakes, setIntakes] = useState([]);
  const [intakesLoading, setIntakesLoading] = useState(true);
  const [intakesError, setIntakesError] = useState('');
  const [intakeFormOpen, setIntakeFormOpen] = useState(false);
  const [editingIntake, setEditingIntake] = useState(null);
  const [intakeSaving, setIntakeSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    const { data, error: err } = await getHarvest(id);
    if (err) { setError(friendlyHarvestError(err)); setRecord(null); }
    else setRecord(data);
    setLoading(false);
  }, [id]);

  const loadIntakes = useCallback(async () => {
    setIntakesLoading(true); setIntakesError('');
    const { data, error: err } = await getIntakesByHarvest(id);
    if (err) { setIntakesError(friendlyIntakeError(err)); setIntakes([]); }
    else setIntakes(data || []);
    setIntakesLoading(false);
  }, [id]);

  // Reload harvest + intakes on mount, on harvest id change, and whenever the
  // active organisation changes (so no stale cross-org data is shown).
  useEffect(() => {
    if (!activeOrgId) return;
    load();
    loadIntakes();
  }, [activeOrgId, load, loadIntakes]);

  const handleEditSubmit = async (values) => {
    setSaving(true);
    const { data, error: err } = await updateHarvest(id, values);
    setSaving(false);
    if (err) { setError(friendlyHarvestError(err)); return; }
    setRecord(data); setEditOpen(false); setToast('Harvest updated.');
  };

  const handleDelete = async () => {
    setDeleting(true);
    const { error: err } = await deleteHarvest(id);
    setDeleting(false); setConfirmOpen(false);
    if (err) { setError(friendlyHarvestError(err)); return; }
    navigate('/harvest', { replace: true });
  };

  // ── Grape intake handlers ────────────────────────────────────────────────
  const openAddIntake = () => { setEditingIntake(null); setIntakeFormOpen(true); };
  const openEditIntake = (i) => { setEditingIntake(i); setIntakeFormOpen(true); };

  const handleIntakeSubmit = async (values) => {
    setIntakeSaving(true);
    const isEdit = Boolean(editingIntake);
    const { error: err } = isEdit
      ? await updateIntake(editingIntake.id, values)
      : await createIntake({ ...values, harvestId: id });
    setIntakeSaving(false);
    if (err) { setIntakesError(friendlyIntakeError(err)); return; }
    setIntakeFormOpen(false); setEditingIntake(null);
    setToast(isEdit ? 'Grape intake updated.' : 'Grape intake added.');
    await loadIntakes();
  };

  const totalKg = totalReceivedKg(intakes);

  return (
    <PageContainer>
      <Link component="button" type="button" underline="hover" onClick={() => navigate('/harvest')}
        sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, color: 'text.secondary', mb: 2 }}>
        <ArrowBackOutlinedIcon sx={{ fontSize: '1.1rem' }} /> Back to Harvest
      </Link>

      {loading ? (
        <Paper sx={{ p: { xs: 2.5, md: 4 } }}>
          <Skeleton width="40%" height={40} /><Skeleton width="25%" height={24} sx={{ mt: 1 }} />
          <Divider sx={{ my: 3 }} /><Skeleton width="80%" height={24} />
        </Paper>
      ) : error && !record ? (
        <Alert severity="error">{error}</Alert>
      ) : record ? (
        <>
          {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}
          <Paper sx={{ p: { xs: 2.5, md: 4 } }}>
            <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, alignItems: { xs: 'flex-start', sm: 'center' }, justifyContent: 'space-between', gap: 2 }}>
              <Box sx={{ minWidth: 0 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
                  <Typography variant="h2" component="h1" sx={{ minWidth: 0 }}>{record.title}</Typography>
                  {record.status && <Chip label={record.status} color={activityStatusColor(record.status)} sx={{ textTransform: 'capitalize' }} />}
                </Box>
                {record.vineyardId && (
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 1, color: 'text.secondary' }}>
                    <TerrainOutlinedIcon sx={{ fontSize: '1.1rem' }} />
                    <Link component="button" type="button" underline="hover" onClick={() => navigate(`/vineyards/${record.vineyardId}`)} sx={{ color: 'primary.main', fontWeight: 600 }}>
                      {record.vineyardName || 'View vineyard'}
                    </Link>
                  </Box>
                )}
              </Box>
              <Box sx={{ display: 'flex', gap: 1, flexShrink: 0 }}>
                <Button variant="outlined" color="primary" startIcon={<EditOutlinedIcon />} onClick={() => setEditOpen(true)}>Edit</Button>
                <Button variant="outlined" color="secondary" startIcon={<DeleteOutlineOutlinedIcon />} onClick={() => setConfirmOpen(true)}>Delete</Button>
              </Box>
            </Box>
            <Divider sx={{ my: 3 }} />
            <Grid container spacing={3}>
              <Grid item xs={6} sm={3}><DetailItem label="Vineyard">{record.vineyardName || '—'}</DetailItem></Grid>
              <Grid item xs={6} sm={3}>
                <DetailItem label="Block">
                  {record.blockId ? (
                    <Link component="button" type="button" underline="hover" onClick={() => navigate(`/blocks/${record.blockId}`)} sx={{ color: 'primary.main', fontWeight: 600 }}>
                      {record.blockName || 'View block'}
                    </Link>
                  ) : '—'}
                </DetailItem>
              </Grid>
              {record.plantingId && (
                <>
                  <Grid item xs={6} sm={3}>
                    <DetailItem label="Planting">
                      {record.blockId ? (
                        <Link component="button" type="button" underline="hover" onClick={() => navigate(`/blocks/${record.blockId}`)} sx={{ color: 'primary.main', fontWeight: 600 }}>
                          {record.cultivarName || 'View planting'}
                          {record.plantingStatus && record.plantingStatus !== 'active' ? ` (${record.plantingStatus})` : ''}
                        </Link>
                      ) : (
                        `${record.cultivarName || 'Planting'}${record.plantingStatus && record.plantingStatus !== 'active' ? ` (${record.plantingStatus})` : ''}`
                      )}
                    </DetailItem>
                  </Grid>
                  <Grid item xs={6} sm={3}>
                    <DetailItem label="Cultivar">{record.cultivarName || '—'}</DetailItem>
                  </Grid>
                </>
              )}
              <Grid item xs={6} sm={3}><DetailItem label="Harvest Date">{formatDate(record.harvestDate)}</DetailItem></Grid>
              <Grid item xs={6} sm={3}><DetailItem label="Yield">{record.yieldTons != null ? `${formatNumber(record.yieldTons)} t` : '—'}</DetailItem></Grid>
              <Grid item xs={6} sm={3}><DetailItem label="Created">{formatDate(record.createdAt)}</DetailItem></Grid>
              <Grid item xs={6} sm={3}><DetailItem label="Last Updated">{formatDate(record.updatedAt)}</DetailItem></Grid>
            </Grid>
          </Paper>

          {/* ── Grape Intakes ─────────────────────────────────────────── */}
          <Paper sx={{ p: { xs: 2.5, md: 4 }, mt: { xs: 3, md: 4 } }}>
            <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, alignItems: { xs: 'stretch', sm: 'center' }, justifyContent: 'space-between', gap: 2, mb: 1 }}>
              <Box>
                <Typography variant="h4" component="h2" sx={{ mb: 0.5 }}>Grape Intakes</Typography>
                <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                  Deliveries of grapes received at the cellar for this harvest.
                </Typography>
              </Box>
              <Button variant="contained" color="primary" startIcon={<AddOutlinedIcon />} onClick={openAddIntake} sx={{ flexShrink: 0 }}>
                Add Intake
              </Button>
            </Box>

            {intakesError && (
              <Alert severity="error" sx={{ my: 2 }} onClose={() => setIntakesError('')}>{intakesError}</Alert>
            )}

            <Box sx={{ mt: 2 }}>
              {intakesLoading ? (
                <Box>
                  <Skeleton height={44} />
                  <Skeleton height={44} sx={{ mt: 1 }} />
                </Box>
              ) : intakes.length === 0 ? (
                <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', px: 3, py: { xs: 4, md: 5 }, textAlign: 'center' }}>
                  <Box sx={{ width: 56, height: 56, borderRadius: '50%', bgcolor: 'background.paper', display: 'flex', alignItems: 'center', justifyContent: 'center', mx: 'auto', mb: 1.5, color: 'accent.main' }}>
                    <ScaleOutlinedIcon sx={{ fontSize: '1.7rem' }} />
                  </Box>
                  <Typography variant="body1" sx={{ color: 'text.secondary', maxWidth: 420, mx: 'auto' }}>
                    No grape intakes recorded yet. Add an intake to record grapes received at the cellar.
                  </Typography>
                </Paper>
              ) : (
                <>
                  <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 3, overflow: 'hidden' }}>
                    <Table sx={{ minWidth: 640 }} aria-label="Grape intakes">
                      <TableHead>
                        <TableRow>
                          <TableCell>Intake Date</TableCell>
                          <TableCell align="right">Received</TableCell>
                          <TableCell>Status</TableCell>
                          <TableCell>Notes</TableCell>
                          <TableCell align="right">Actions</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {intakes.map((i) => (
                          <TableRow key={i.id} hover sx={{ '& .MuiTableCell-root': { py: 1.5 }, opacity: i.status === 'rejected' ? 0.6 : 1 }}>
                            <TableCell sx={{ color: 'text.secondary' }}>{formatDate(i.intakeDate)}</TableCell>
                            <TableCell align="right" sx={{ fontWeight: 600 }}>
                              {i.receivedKg != null ? `${formatNumber(i.receivedKg)} kg` : '—'}
                            </TableCell>
                            <TableCell>
                              <Chip label={intakeStatusLabel(i.status)} size="small" color={intakeStatusChip(i.status)} sx={{ fontWeight: 600 }} />
                            </TableCell>
                            <TableCell sx={{ color: 'text.secondary', maxWidth: 260 }}>
                              <Typography variant="body2" noWrap sx={{ color: 'text.secondary' }}>{i.notes || '—'}</Typography>
                            </TableCell>
                            <TableCell align="right">
                              <Tooltip title="Edit"><IconButton size="small" aria-label="Edit intake" onClick={() => openEditIntake(i)}><EditOutlinedIcon fontSize="small" /></IconButton></Tooltip>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableContainer>
                  <Box sx={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'baseline', gap: 1, mt: 2 }}>
                    <Typography variant="overline" sx={{ color: 'text.secondary' }}>Total Received</Typography>
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

      <HarvestForm open={editOpen} record={record} saving={saving} onSubmit={handleEditSubmit} onClose={() => setEditOpen(false)} />
      <ConfirmDialog open={confirmOpen} title="Delete Harvest"
        message={record ? `Are you sure you want to delete "${record.title}"? This cannot be undone.` : ''}
        confirmLabel="Delete" confirmColor="error" loading={deleting} onConfirm={handleDelete} onClose={() => setConfirmOpen(false)} />

      {/* Grape intake add/edit dialog */}
      <GrapeIntakeForm
        open={intakeFormOpen}
        intake={editingIntake}
        saving={intakeSaving}
        onSubmit={handleIntakeSubmit}
        onClose={() => { setIntakeFormOpen(false); setEditingIntake(null); }}
      />

      <Snackbar open={Boolean(toast)} autoHideDuration={4000} onClose={() => setToast('')} message={toast} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }} />
    </PageContainer>
  );
}

export default HarvestProfile;
