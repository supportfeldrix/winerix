import { useEffect, useMemo, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Typography, Button, TextField, InputAdornment, MenuItem, Paper,
  Skeleton, Alert, Snackbar, Stack,
} from '@mui/material';
import AddOutlinedIcon from '@mui/icons-material/AddOutlined';
import SearchOutlinedIcon from '@mui/icons-material/SearchOutlined';
import PropaneTankOutlinedIcon from '@mui/icons-material/PropaneTankOutlined';
import PageContainer from '../components/layout/PageContainer';
import { useOrganisation } from '../context/OrganisationContext';
import VesselTable from '../components/vessels/VesselTable';
import VesselForm from '../components/vessels/VesselForm';
import ConfirmDialog from '../components/common/ConfirmDialog';
import {
  getVessels, createVessel, updateVessel, deleteVessel,
  getOpenVolumesByVessel, friendlyVesselError, VESSEL_STATUSES,
} from '../services/vesselService';

const ALL_STATUSES = 'all';

function Vessels() {
  const { activeOrgId } = useOrganisation();
  const navigate = useNavigate();

  const [vessels, setVessels] = useState([]);
  const [volumeByVessel, setVolumeByVessel] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState(ALL_STATUSES);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [toast, setToast] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    const { data, error: err } = await getVessels();
    if (err) {
      const friendly = friendlyVesselError(err);
      if (/not set up yet/i.test(friendly)) { setVessels([]); setLoading(false); return; }
      setError(friendly); setLoading(false); return;
    }
    setVessels(data || []);
    // Current volumes from open placements (best-effort; non-fatal on error).
    const { data: volumes } = await getOpenVolumesByVessel();
    setVolumeByVessel(volumes || {});
    setLoading(false);
  }, []);

  useEffect(() => { if (!activeOrgId) return; load(); }, [activeOrgId, load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return vessels.filter((v) => {
      const ms = statusFilter === ALL_STATUSES || v.status === statusFilter;
      const mq =
        !q ||
        (v.vesselCode || '').toLowerCase().includes(q) ||
        (v.name || '').toLowerCase().includes(q) ||
        (v.location || '').toLowerCase().includes(q);
      return ms && mq;
    });
  }, [vessels, search, statusFilter]);

  const openAdd = () => { setEditing(null); setFormOpen(true); };
  const openEdit = (v) => { setEditing(v); setFormOpen(true); };
  const openProfile = (v) => navigate(`/vessels/${v.id}`);

  const handleSubmit = async (values) => {
    setSaving(true);
    const isEdit = Boolean(editing);
    const { error: err } = isEdit
      ? await updateVessel(editing.id, values)
      : await createVessel(values);
    setSaving(false);
    if (err) { setError(friendlyVesselError(err)); return; }
    setFormOpen(false); setEditing(null);
    setToast(isEdit ? 'Vessel updated.' : 'Vessel added.');
    await load();
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    const { error: err } = await deleteVessel(deleteTarget.id);
    setDeleting(false); setDeleteTarget(null);
    if (err) { setError(friendlyVesselError(err)); return; }
    setToast('Vessel deleted.'); await load();
  };

  const noneAtAll = !loading && vessels.length === 0;
  const noMatches = !loading && vessels.length > 0 && filtered.length === 0;

  return (
    <PageContainer maxWidth={1600} sx={{ px: { xs: 2, sm: 3, md: 4, lg: 5 } }}>
      <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, alignItems: { xs: 'stretch', sm: 'center' }, justifyContent: 'space-between', gap: 2, mb: 1 }}>
        <Box>
          <Typography variant="h2" component="h1" sx={{ mb: 0.5 }}>Vessels</Typography>
          <Typography variant="body1" sx={{ color: 'text.secondary' }}>
            Manage cellar tanks, barrels and other vessels, and see what they currently hold.
          </Typography>
        </Box>
        <Button variant="contained" color="primary" startIcon={<AddOutlinedIcon />} onClick={openAdd} sx={{ flexShrink: 0 }}>Add Vessel</Button>
      </Box>

      {!noneAtAll && (
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ my: 3 }}>
          <TextField
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by code, name or location"
            fullWidth
            sx={{ maxWidth: { md: 380 } }}
            InputProps={{ startAdornment: <InputAdornment position="start"><SearchOutlinedIcon fontSize="small" /></InputAdornment> }}
          />
          <TextField select label="Status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} fullWidth sx={{ maxWidth: { md: 220 } }}>
            <MenuItem value={ALL_STATUSES}>All statuses</MenuItem>
            {VESSEL_STATUSES.map((s) => (
              <MenuItem key={s.value} value={s.value}>{s.label}</MenuItem>
            ))}
          </TextField>
        </Stack>
      )}

      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}

      {loading ? (
        <Paper variant="outlined" sx={{ borderRadius: 3, p: 2.5 }}>
          {[0, 1, 2].map((i) => (
            <Box key={i} sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 1 }}>
              <Skeleton variant="rounded" width={34} height={34} />
              <Skeleton width="40%" height={24} />
              <Skeleton width="15%" height={24} sx={{ ml: 'auto' }} />
            </Box>
          ))}
        </Paper>
      ) : noneAtAll ? (
        <EmptyVessels onAdd={openAdd} />
      ) : noMatches ? (
        <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', p: 4, textAlign: 'center' }}>
          <Typography variant="body1" sx={{ color: 'text.secondary' }}>No vessels match your filters.</Typography>
        </Paper>
      ) : (
        <VesselTable
          vessels={filtered}
          volumeByVessel={volumeByVessel}
          onOpen={openProfile}
          onEdit={openEdit}
          onDelete={setDeleteTarget}
        />
      )}

      <VesselForm
        open={formOpen}
        vessel={editing}
        saving={saving}
        onSubmit={handleSubmit}
        onClose={() => { setFormOpen(false); setEditing(null); }}
      />
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Delete Vessel"
        message={deleteTarget ? `Delete vessel "${deleteTarget.vesselCode}"? This cannot be undone. Vessels with placement history cannot be deleted.` : ''}
        confirmLabel="Delete"
        confirmColor="error"
        loading={deleting}
        onConfirm={handleDelete}
        onClose={() => setDeleteTarget(null)}
      />
      <Snackbar open={Boolean(toast)} autoHideDuration={4000} onClose={() => setToast('')} message={toast} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }} />
    </PageContainer>
  );
}

function EmptyVessels({ onAdd }) {
  return (
    <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', px: 3, py: { xs: 5, md: 7 }, textAlign: 'center', mt: 3 }}>
      <Box sx={{ width: 64, height: 64, borderRadius: '50%', bgcolor: 'background.paper', display: 'flex', alignItems: 'center', justifyContent: 'center', mx: 'auto', mb: 2, color: 'primary.main' }}>
        <PropaneTankOutlinedIcon sx={{ fontSize: '2rem' }} />
      </Box>
      <Typography variant="h4" component="p" sx={{ mb: 0.5 }}>No vessels yet</Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary', maxWidth: 440, mx: 'auto', mb: 3 }}>
        Add the tanks and barrels in your cellar so you can place and transfer wine lots between them.
      </Typography>
      <Button variant="contained" color="primary" startIcon={<AddOutlinedIcon />} onClick={onAdd}>Add Vessel</Button>
    </Paper>
  );
}

export default Vessels;
