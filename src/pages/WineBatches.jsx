import { useEffect, useMemo, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Typography, Button, TextField, InputAdornment, MenuItem, Paper,
  Skeleton, Alert, Snackbar, Stack,
} from '@mui/material';
import AddOutlinedIcon from '@mui/icons-material/AddOutlined';
import SearchOutlinedIcon from '@mui/icons-material/SearchOutlined';
import ScienceOutlinedIcon from '@mui/icons-material/ScienceOutlined';
import PageContainer from '../components/layout/PageContainer';
import { useOrganisation } from '../context/OrganisationContext';
import WineBatchTable from '../components/batches/WineBatchTable';
import WineBatchForm from '../components/batches/WineBatchForm';
import ConfirmDialog from '../components/common/ConfirmDialog';
import {
  getWineBatches, createWineBatch, updateWineBatch, deleteWineBatch,
  friendlyWineBatchError, WINE_BATCH_STATUSES,
} from '../services/wineBatchService';

const ALL_STATUSES = 'all';

function WineBatches() {
  const { activeOrgId } = useOrganisation();
  const navigate = useNavigate();

  const [batches, setBatches] = useState([]);
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
    const { data, error: err } = await getWineBatches();
    if (err) {
      const friendly = friendlyWineBatchError(err);
      if (/not set up yet/i.test(friendly)) setBatches([]); else setError(friendly);
    } else {
      setBatches(data || []);
    }
    setLoading(false);
  }, []);

  useEffect(() => { if (!activeOrgId) return; load(); }, [activeOrgId, load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return batches.filter((b) => {
      const ms = statusFilter === ALL_STATUSES || b.status === statusFilter;
      const mq =
        !q ||
        (b.batchCode || '').toLowerCase().includes(q) ||
        (b.name || '').toLowerCase().includes(q) ||
        (b.vintage != null && String(b.vintage).includes(q));
      return ms && mq;
    });
  }, [batches, search, statusFilter]);

  const openAdd = () => { setEditing(null); setFormOpen(true); };
  const openEdit = (b) => { setEditing(b); setFormOpen(true); };
  const openProfile = (b) => navigate(`/wine-batches/${b.id}`);

  const handleSubmit = async (values) => {
    setSaving(true);
    const isEdit = Boolean(editing);
    const { error: err } = isEdit
      ? await updateWineBatch(editing.id, values)
      : await createWineBatch(values);
    setSaving(false);
    if (err) { setError(friendlyWineBatchError(err)); return; }
    setFormOpen(false); setEditing(null);
    setToast(isEdit ? 'Wine batch updated.' : 'Wine batch added.');
    await load();
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    const { error: err } = await deleteWineBatch(deleteTarget.id);
    setDeleting(false); setDeleteTarget(null);
    if (err) { setError(friendlyWineBatchError(err)); return; }
    setToast('Wine batch deleted.'); await load();
  };

  const noneAtAll = !loading && batches.length === 0;
  const noMatches = !loading && batches.length > 0 && filtered.length === 0;

  return (
    <PageContainer maxWidth={1600} sx={{ px: { xs: 2, sm: 3, md: 4, lg: 5 } }}>
      <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, alignItems: { xs: 'stretch', sm: 'center' }, justifyContent: 'space-between', gap: 2, mb: 1 }}>
        <Box>
          <Typography variant="h2" component="h1" sx={{ mb: 0.5 }}>Wine Batches</Typography>
          <Typography variant="body1" sx={{ color: 'text.secondary' }}>
            Group grape intakes into production batches by vintage.
          </Typography>
        </Box>
        <Button variant="contained" color="primary" startIcon={<AddOutlinedIcon />} onClick={openAdd} sx={{ flexShrink: 0 }}>Add Batch</Button>
      </Box>

      {!noneAtAll && (
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ my: 3 }}>
          <TextField
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by code, name or vintage"
            fullWidth
            sx={{ maxWidth: { md: 360 } }}
            InputProps={{ startAdornment: <InputAdornment position="start"><SearchOutlinedIcon fontSize="small" /></InputAdornment> }}
          />
          <TextField select label="Status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} fullWidth sx={{ maxWidth: { md: 200 } }}>
            <MenuItem value={ALL_STATUSES}>All statuses</MenuItem>
            {WINE_BATCH_STATUSES.map((s) => (
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
        <EmptyBatches onAdd={openAdd} />
      ) : noMatches ? (
        <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', p: 4, textAlign: 'center' }}>
          <Typography variant="body1" sx={{ color: 'text.secondary' }}>No batches match your filters.</Typography>
        </Paper>
      ) : (
        <WineBatchTable
          batches={filtered}
          onOpen={openProfile}
          onEdit={openEdit}
          onDelete={setDeleteTarget}
        />
      )}

      <WineBatchForm
        open={formOpen}
        batch={editing}
        saving={saving}
        onSubmit={handleSubmit}
        onClose={() => { setFormOpen(false); setEditing(null); }}
      />
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Delete Wine Batch"
        message={deleteTarget ? `Delete batch "${deleteTarget.batchCode}"? This removes the batch and its grape-intake links. The grape intakes themselves are not affected. This cannot be undone.` : ''}
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

function EmptyBatches({ onAdd }) {
  return (
    <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', px: 3, py: { xs: 5, md: 7 }, textAlign: 'center', mt: 3 }}>
      <Box sx={{ width: 64, height: 64, borderRadius: '50%', bgcolor: 'background.paper', display: 'flex', alignItems: 'center', justifyContent: 'center', mx: 'auto', mb: 2, color: 'primary.main' }}>
        <ScienceOutlinedIcon sx={{ fontSize: '2rem' }} />
      </Box>
      <Typography variant="h4" component="p" sx={{ mb: 0.5 }}>No wine batches yet</Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary', maxWidth: 440, mx: 'auto', mb: 3 }}>
        Create a batch to group the grape intakes that go into a production run, then link intakes to it from the batch profile.
      </Typography>
      <Button variant="contained" color="primary" startIcon={<AddOutlinedIcon />} onClick={onAdd}>Add Batch</Button>
    </Paper>
  );
}

export default WineBatches;
