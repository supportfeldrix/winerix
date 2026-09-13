import { useEffect, useMemo, useState, useCallback } from 'react';
import {
  Box, Typography, Button, TextField, InputAdornment, MenuItem, Grid, Paper,
  Skeleton, Alert, Snackbar, Stack,
} from '@mui/material';
import AddOutlinedIcon from '@mui/icons-material/AddOutlined';
import SearchOutlinedIcon from '@mui/icons-material/SearchOutlined';
import LocalBarOutlinedIcon from '@mui/icons-material/LocalBarOutlined';
import PageContainer from '../components/layout/PageContainer';
import { useOrganisation } from '../context/OrganisationContext';
import CultivarTable from '../components/cultivars/CultivarTable';
import CultivarForm from '../components/cultivars/CultivarForm';
import ConfirmDialog from '../components/common/ConfirmDialog';
import {
  getCultivars, createCultivar, updateCultivar,
  deactivateCultivar, reactivateCultivar, friendlyCultivarError,
} from '../services/cultivarService';

const ALL_STATUSES = 'all';

function Cultivars() {
  const { activeOrgId } = useOrganisation();

  const [cultivars, setCultivars] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState(ALL_STATUSES);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  const [deactivateTarget, setDeactivateTarget] = useState(null);
  const [deactivating, setDeactivating] = useState(false);
  const [toast, setToast] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    const { data, error: err } = await getCultivars();
    if (err) {
      const friendly = friendlyCultivarError(err);
      if (/not set up yet/i.test(friendly)) setCultivars([]); else setError(friendly);
    } else {
      setCultivars(data || []);
    }
    setLoading(false);
  }, []);

  useEffect(() => { if (!activeOrgId) return; load(); }, [activeOrgId, load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return cultivars.filter((c) => {
      const ms =
        statusFilter === ALL_STATUSES ||
        (statusFilter === 'active' ? c.isActive : !c.isActive);
      const mq = !q || (c.name || '').toLowerCase().includes(q);
      return ms && mq;
    });
  }, [cultivars, search, statusFilter]);

  const openAdd = () => { setEditing(null); setFormOpen(true); };
  const openEdit = (c) => { setEditing(c); setFormOpen(true); };

  const handleSubmit = async (values) => {
    setSaving(true);
    const isEdit = Boolean(editing);
    const { error: err } = isEdit
      ? await updateCultivar(editing.id, values)
      : await createCultivar(values);
    setSaving(false);
    if (err) { setError(friendlyCultivarError(err)); return; }
    setFormOpen(false); setEditing(null);
    setToast(isEdit ? 'Cultivar updated.' : 'Cultivar added.');
    await load();
  };

  const handleDeactivate = async () => {
    if (!deactivateTarget) return;
    setDeactivating(true);
    const { error: err } = await deactivateCultivar(deactivateTarget.id);
    setDeactivating(false); setDeactivateTarget(null);
    if (err) { setError(friendlyCultivarError(err)); return; }
    setToast('Cultivar deactivated.'); await load();
  };

  const handleReactivate = async (c) => {
    const { error: err } = await reactivateCultivar(c.id);
    if (err) { setError(friendlyCultivarError(err)); return; }
    setToast('Cultivar reactivated.'); await load();
  };

  const noneAtAll = !loading && cultivars.length === 0;
  const noMatches = !loading && cultivars.length > 0 && filtered.length === 0;

  return (
    <PageContainer maxWidth={1600} sx={{ px: { xs: 2, sm: 3, md: 4, lg: 5 } }}>
      <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, alignItems: { xs: 'stretch', sm: 'center' }, justifyContent: 'space-between', gap: 2, mb: 1 }}>
        <Box>
          <Typography variant="h2" component="h1" sx={{ mb: 0.5 }}>Cultivars</Typography>
          <Typography variant="body1" sx={{ color: 'text.secondary' }}>
            Manage the grape varieties used across your vineyards and blocks.
          </Typography>
        </Box>
        <Button variant="contained" color="primary" startIcon={<AddOutlinedIcon />} onClick={openAdd} sx={{ flexShrink: 0 }}>Add Cultivar</Button>
      </Box>

      {!noneAtAll && (
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ my: 3 }}>
          <TextField
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name"
            fullWidth
            sx={{ maxWidth: { md: 340 } }}
            InputProps={{ startAdornment: <InputAdornment position="start"><SearchOutlinedIcon fontSize="small" /></InputAdornment> }}
          />
          <TextField select label="Status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} fullWidth sx={{ maxWidth: { md: 190 } }}>
            <MenuItem value={ALL_STATUSES}>All statuses</MenuItem>
            <MenuItem value="active">Active</MenuItem>
            <MenuItem value="inactive">Inactive</MenuItem>
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
        <EmptyCultivars onAdd={openAdd} />
      ) : noMatches ? (
        <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', p: 4, textAlign: 'center' }}>
          <Typography variant="body1" sx={{ color: 'text.secondary' }}>No cultivars match your filters.</Typography>
        </Paper>
      ) : (
        <CultivarTable
          cultivars={filtered}
          onEdit={openEdit}
          onDeactivate={setDeactivateTarget}
          onReactivate={handleReactivate}
        />
      )}

      <CultivarForm
        open={formOpen}
        cultivar={editing}
        saving={saving}
        onSubmit={handleSubmit}
        onClose={() => { setFormOpen(false); setEditing(null); }}
      />
      <ConfirmDialog
        open={Boolean(deactivateTarget)}
        title="Deactivate Cultivar"
        message={deactivateTarget ? `Deactivate "${deactivateTarget.name}"? It will be hidden from new plantings but existing records are preserved. You can reactivate it later.` : ''}
        confirmLabel="Deactivate"
        confirmColor="error"
        loading={deactivating}
        onConfirm={handleDeactivate}
        onClose={() => setDeactivateTarget(null)}
      />
      <Snackbar open={Boolean(toast)} autoHideDuration={4000} onClose={() => setToast('')} message={toast} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }} />
    </PageContainer>
  );
}

function EmptyCultivars({ onAdd }) {
  return (
    <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', px: 3, py: { xs: 5, md: 7 }, textAlign: 'center', mt: 3 }}>
      <Box sx={{ width: 64, height: 64, borderRadius: '50%', bgcolor: 'background.paper', display: 'flex', alignItems: 'center', justifyContent: 'center', mx: 'auto', mb: 2, color: 'secondary.main' }}>
        <LocalBarOutlinedIcon sx={{ fontSize: '2rem' }} />
      </Box>
      <Typography variant="h4" component="p" sx={{ mb: 0.5 }}>No cultivars yet</Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary', maxWidth: 440, mx: 'auto', mb: 3 }}>
        Add the grape varieties you grow so you can assign them to plantings across your blocks.
      </Typography>
      <Button variant="contained" color="primary" startIcon={<AddOutlinedIcon />} onClick={onAdd}>Add Cultivar</Button>
    </Paper>
  );
}

export default Cultivars;
