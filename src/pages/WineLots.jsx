import { useEffect, useMemo, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Typography, Button, TextField, InputAdornment, MenuItem, Paper,
  Skeleton, Alert, Snackbar, Stack,
} from '@mui/material';
import AddOutlinedIcon from '@mui/icons-material/AddOutlined';
import SearchOutlinedIcon from '@mui/icons-material/SearchOutlined';
import WaterOutlinedIcon from '@mui/icons-material/WaterOutlined';
import PageContainer from '../components/layout/PageContainer';
import { useOrganisation } from '../context/OrganisationContext';
import WineLotTable from '../components/lots/WineLotTable';
import WineLotForm from '../components/lots/WineLotForm';
import ConfirmDialog from '../components/common/ConfirmDialog';
import {
  getWineLots, createWineLot, updateWineLot, deleteWineLot,
  getBatchOptions, friendlyWineLotError, WINE_LOT_STATUSES,
} from '../services/wineLotService';

const ALL_STATUSES = 'all';

function WineLots() {
  const { activeOrgId } = useOrganisation();
  const navigate = useNavigate();

  const [lots, setLots] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState(ALL_STATUSES);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  const [batchOptions, setBatchOptions] = useState([]);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [toast, setToast] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    const { data, error: err } = await getWineLots();
    if (err) {
      const friendly = friendlyWineLotError(err);
      if (/not set up yet/i.test(friendly)) setLots([]); else setError(friendly);
    } else {
      setLots(data || []);
    }
    setLoading(false);
  }, []);

  useEffect(() => { if (!activeOrgId) return; load(); }, [activeOrgId, load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return lots.filter((l) => {
      const ms = statusFilter === ALL_STATUSES || l.status === statusFilter;
      const mq =
        !q ||
        (l.lotCode || '').toLowerCase().includes(q) ||
        (l.batchCode || '').toLowerCase().includes(q);
      return ms && mq;
    });
  }, [lots, search, statusFilter]);

  const openAdd = async () => {
    setEditing(null); setFormOpen(true);
    setOptionsLoading(true);
    const { data, error: err } = await getBatchOptions();
    setOptionsLoading(false);
    if (err) { setError(friendlyWineLotError(err)); setBatchOptions([]); return; }
    setBatchOptions(data || []);
  };
  const openEdit = (l) => { setEditing(l); setFormOpen(true); };
  const openProfile = (l) => navigate(`/wine-lots/${l.id}`);

  const handleSubmit = async (values) => {
    setSaving(true);
    const isEdit = Boolean(editing);
    const { error: err } = isEdit
      ? await updateWineLot(editing.id, values)
      : await createWineLot(values);
    setSaving(false);
    if (err) { setError(friendlyWineLotError(err)); return; }
    setFormOpen(false); setEditing(null);
    setToast(isEdit ? 'Wine lot updated.' : 'Wine lot added.');
    await load();
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    const { error: err } = await deleteWineLot(deleteTarget.id);
    setDeleting(false); setDeleteTarget(null);
    if (err) { setError(friendlyWineLotError(err)); return; }
    setToast('Wine lot deleted.'); await load();
  };

  const noneAtAll = !loading && lots.length === 0;
  const noMatches = !loading && lots.length > 0 && filtered.length === 0;

  return (
    <PageContainer maxWidth={1600} sx={{ px: { xs: 2, sm: 3, md: 4, lg: 5 } }}>
      <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, alignItems: { xs: 'stretch', sm: 'center' }, justifyContent: 'space-between', gap: 2, mb: 1 }}>
        <Box>
          <Typography variant="h2" component="h1" sx={{ mb: 0.5 }}>Wine Lots</Typography>
          <Typography variant="body1" sx={{ color: 'text.secondary' }}>
            Track the movable volumes of wine produced from your batches.
          </Typography>
        </Box>
        <Button variant="contained" color="primary" startIcon={<AddOutlinedIcon />} onClick={openAdd} sx={{ flexShrink: 0 }}>Add Lot</Button>
      </Box>

      {!noneAtAll && (
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ my: 3 }}>
          <TextField
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by lot or batch code"
            fullWidth
            sx={{ maxWidth: { md: 360 } }}
            InputProps={{ startAdornment: <InputAdornment position="start"><SearchOutlinedIcon fontSize="small" /></InputAdornment> }}
          />
          <TextField select label="Status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} fullWidth sx={{ maxWidth: { md: 220 } }}>
            <MenuItem value={ALL_STATUSES}>All statuses</MenuItem>
            {WINE_LOT_STATUSES.map((s) => (
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
        <EmptyLots onAdd={openAdd} />
      ) : noMatches ? (
        <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', p: 4, textAlign: 'center' }}>
          <Typography variant="body1" sx={{ color: 'text.secondary' }}>No lots match your filters.</Typography>
        </Paper>
      ) : (
        <WineLotTable
          lots={filtered}
          onOpen={openProfile}
          onEdit={openEdit}
          onDelete={setDeleteTarget}
        />
      )}

      <WineLotForm
        open={formOpen}
        lot={editing}
        batchOptions={batchOptions}
        optionsLoading={optionsLoading}
        saving={saving}
        onSubmit={handleSubmit}
        onClose={() => { setFormOpen(false); setEditing(null); }}
      />
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Delete Wine Lot"
        message={deleteTarget ? `Delete lot "${deleteTarget.lotCode}"? This cannot be undone.` : ''}
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

function EmptyLots({ onAdd }) {
  return (
    <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', px: 3, py: { xs: 5, md: 7 }, textAlign: 'center', mt: 3 }}>
      <Box sx={{ width: 64, height: 64, borderRadius: '50%', bgcolor: 'background.paper', display: 'flex', alignItems: 'center', justifyContent: 'center', mx: 'auto', mb: 2, color: 'secondary.main' }}>
        <WaterOutlinedIcon sx={{ fontSize: '2rem' }} />
      </Box>
      <Typography variant="h4" component="p" sx={{ mb: 0.5 }}>No wine lots yet</Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary', maxWidth: 440, mx: 'auto', mb: 3 }}>
        Add a lot to record a volume of wine produced from one of your batches.
      </Typography>
      <Button variant="contained" color="primary" startIcon={<AddOutlinedIcon />} onClick={onAdd}>Add Lot</Button>
    </Paper>
  );
}

export default WineLots;
