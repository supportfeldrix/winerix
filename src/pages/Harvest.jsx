import { useEffect, useMemo, useState, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Box, Typography, Button, TextField, InputAdornment, MenuItem, Grid, Paper,
  Skeleton, Alert, Snackbar, Stack, useMediaQuery,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import AddOutlinedIcon from '@mui/icons-material/AddOutlined';
import SearchOutlinedIcon from '@mui/icons-material/SearchOutlined';
import AgricultureOutlinedIcon from '@mui/icons-material/AgricultureOutlined';
import ScaleOutlinedIcon from '@mui/icons-material/ScaleOutlined';
import CheckCircleOutlineOutlinedIcon from '@mui/icons-material/CheckCircleOutlineOutlined';
import TerrainOutlinedIcon from '@mui/icons-material/TerrainOutlined';
import PageContainer from '../components/layout/PageContainer';
import StatCard from '../components/dashboard/StatCard';
import { formatNumber } from '../components/common/formatters';
import HarvestCard from '../components/harvest/HarvestCard';
import HarvestTable from '../components/harvest/HarvestTable';
import HarvestForm from '../components/harvest/HarvestForm';
import ConfirmDialog from '../components/common/ConfirmDialog';
import {
  getHarvests, createHarvest, updateHarvest, deleteHarvest,
  getVineyardOptions, getBlockOptions, friendlyHarvestError, HARVEST_STATUSES,
} from '../services/harvestService';

const ALL_VINEYARDS = 'all';
const ALL_BLOCKS = 'all';
const ALL_STATUSES = 'all';

function Harvest() {
  const navigate = useNavigate();
  const theme = useTheme();
  const isDesktop = useMediaQuery(theme.breakpoints.up('md'));
  const [searchParams, setSearchParams] = useSearchParams();

  const [records, setRecords] = useState([]);
  const [vineyardOptions, setVineyardOptions] = useState([]);
  const [blockOptions, setBlockOptions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [search, setSearch] = useState('');
  const [vineyardFilter, setVineyardFilter] = useState(searchParams.get('vineyard') || ALL_VINEYARDS);
  const [blockFilter, setBlockFilter] = useState(searchParams.get('block') || ALL_BLOCKS);
  const [statusFilter, setStatusFilter] = useState(ALL_STATUSES);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [toast, setToast] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    const [recRes, vRes, bRes] = await Promise.all([getHarvests(), getVineyardOptions(), getBlockOptions()]);
    if (!vRes.error) setVineyardOptions(vRes.data || []);
    if (!bRes.error) setBlockOptions(bRes.data || []);
    if (recRes.error) {
      const friendly = friendlyHarvestError(recRes.error);
      if (/not set up yet/i.test(friendly)) setRecords([]);
      else setError(friendly);
    } else setRecords(recRes.data || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const v = searchParams.get('vineyard') || ALL_VINEYARDS;
    const b = searchParams.get('block') || ALL_BLOCKS;
    setVineyardFilter((prev) => (prev === v ? prev : v));
    setBlockFilter((prev) => (prev === b ? prev : b));
  }, [searchParams]);

  const filterBlocks = useMemo(
    () => (vineyardFilter === ALL_VINEYARDS ? blockOptions : blockOptions.filter((b) => b.vineyardId === vineyardFilter)),
    [blockOptions, vineyardFilter]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return records.filter((r) => {
      const mv = vineyardFilter === ALL_VINEYARDS || r.vineyardId === vineyardFilter;
      const mb = blockFilter === ALL_BLOCKS || r.blockId === blockFilter;
      const ms = statusFilter === ALL_STATUSES || (r.status || '').toLowerCase() === statusFilter;
      const mq = !q || (r.title || '').toLowerCase().includes(q);
      return mv && mb && ms && mq;
    });
  }, [records, search, vineyardFilter, blockFilter, statusFilter]);

  // Summary metrics computed from the already-loaded records (no extra query,
  // no change to yield calculations — sums the existing yieldTons values).
  const summary = useMemo(() => {
    const total = records.length;
    let totalYield = 0;
    let completed = 0;
    const vineyards = new Set();
    records.forEach((r) => {
      if (typeof r.yieldTons === 'number') totalYield += r.yieldTons;
      if ((r.status || '').toLowerCase() === 'completed') completed += 1;
      if (r.vineyardId) vineyards.add(r.vineyardId);
    });
    return { total, totalYield, completed, vineyards: vineyards.size };
  }, [records]);

  const updateParams = (updates) => {
    const next = new URLSearchParams(searchParams);
    Object.entries(updates).forEach(([k, v]) => { if (!v) next.delete(k); else next.set(k, v); });
    setSearchParams(next, { replace: true });
  };
  const handleVineyardFilterChange = (v) => { setVineyardFilter(v); setBlockFilter(ALL_BLOCKS); updateParams({ vineyard: v === ALL_VINEYARDS ? '' : v, block: '' }); };
  const handleBlockFilterChange = (v) => { setBlockFilter(v); updateParams({ block: v === ALL_BLOCKS ? '' : v }); };

  const openAdd = () => { setEditing(null); setFormOpen(true); };
  const openEdit = (r) => { setEditing(r); setFormOpen(true); };
  const handleView = (r) => navigate(`/harvest/${r.id}`);

  const handleSubmit = async (values) => {
    setSaving(true);
    const isEdit = Boolean(editing);
    const { error: err } = isEdit ? await updateHarvest(editing.id, values) : await createHarvest(values);
    setSaving(false);
    if (err) { setError(friendlyHarvestError(err)); return; }
    setFormOpen(false); setEditing(null); setToast(isEdit ? 'Harvest updated.' : 'Harvest added.'); await load();
  };
  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    const { error: err } = await deleteHarvest(deleteTarget.id);
    setDeleting(false); setDeleteTarget(null);
    if (err) { setError(friendlyHarvestError(err)); return; }
    setToast('Harvest deleted.'); await load();
  };

  const noneAtAll = !loading && records.length === 0;
  const noMatches = !loading && records.length > 0 && filtered.length === 0;
  const defaultFormVineyard = vineyardFilter !== ALL_VINEYARDS ? vineyardFilter : '';

  return (
    <PageContainer maxWidth={1600} sx={{ px: { xs: 2, sm: 3, md: 4, lg: 5 } }}>
      <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, alignItems: { xs: 'stretch', sm: 'center' }, justifyContent: 'space-between', gap: 2, mb: 1 }}>
        <Box>
          <Typography variant="h2" component="h1" sx={{ mb: 0.5 }}>Harvest</Typography>
          <Typography variant="body1" sx={{ color: 'text.secondary' }}>Record and track harvest activity across your vineyards and blocks.</Typography>
        </Box>
        <Button variant="contained" color="primary" startIcon={<AddOutlinedIcon />} onClick={openAdd} sx={{ flexShrink: 0 }}>Add Harvest</Button>
      </Box>

      {!noneAtAll && (
        <Grid container spacing={{ xs: 2, md: 3 }} sx={{ mt: 1, mb: 1 }}>
          {loading ? (
            [0, 1, 2, 3].map((i) => (
              <Grid item xs={6} lg={3} key={i}>
                <Paper sx={{ p: 2.5 }}>
                  <Skeleton variant="text" width="60%" />
                  <Skeleton variant="text" width="40%" height={36} />
                </Paper>
              </Grid>
            ))
          ) : (
            <>
              <Grid item xs={6} lg={3}>
                <StatCard icon={AgricultureOutlinedIcon} label="Harvest Records" value={summary.total} tone="primary" />
              </Grid>
              <Grid item xs={6} lg={3}>
                <StatCard icon={ScaleOutlinedIcon} label="Total Yield (t)" value={formatNumber(summary.totalYield)} tone="accent" />
              </Grid>
              <Grid item xs={6} lg={3}>
                <StatCard icon={TerrainOutlinedIcon} label="Vineyards" value={summary.vineyards} tone="secondary" />
              </Grid>
              <Grid item xs={6} lg={3}>
                <StatCard icon={CheckCircleOutlineOutlinedIcon} label="Completed" value={summary.completed} tone="success" />
              </Grid>
            </>
          )}
        </Grid>
      )}

      {!noneAtAll && (
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ my: 3 }}>
          <TextField value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by title" fullWidth sx={{ maxWidth: { md: 300 } }}
            InputProps={{ startAdornment: <InputAdornment position="start"><SearchOutlinedIcon fontSize="small" /></InputAdornment> }} />
          <TextField select label="Vineyard" value={vineyardFilter} onChange={(e) => handleVineyardFilterChange(e.target.value)} fullWidth sx={{ maxWidth: { md: 190 } }}>
            <MenuItem value={ALL_VINEYARDS}>All vineyards</MenuItem>
            {vineyardOptions.map((v) => <MenuItem key={v.id} value={v.id}>{v.name}</MenuItem>)}
          </TextField>
          <TextField select label="Block" value={blockFilter} onChange={(e) => handleBlockFilterChange(e.target.value)} fullWidth sx={{ maxWidth: { md: 170 } }}>
            <MenuItem value={ALL_BLOCKS}>All blocks</MenuItem>
            {filterBlocks.map((b) => <MenuItem key={b.id} value={b.id}>{b.name}</MenuItem>)}
          </TextField>
          <TextField select label="Status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} fullWidth sx={{ maxWidth: { md: 170 } }}>
            <MenuItem value={ALL_STATUSES}>All statuses</MenuItem>
            {HARVEST_STATUSES.map((s) => <MenuItem key={s.value} value={s.value}>{s.label}</MenuItem>)}
          </TextField>
        </Stack>
      )}

      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}

      {loading ? (
        <Grid container spacing={{ xs: 2, md: 3 }}>
          {[0, 1, 2].map((i) => (
            <Grid item xs={12} sm={6} lg={4} key={i}><Paper sx={{ p: 2.5 }}><Skeleton width="60%" height={28} /><Skeleton width="40%" height={20} sx={{ mt: 1 }} /><Skeleton width="80%" height={20} sx={{ mt: 2 }} /></Paper></Grid>
          ))}
        </Grid>
      ) : noneAtAll ? (
        <EmptyHarvest onAdd={openAdd} />
      ) : noMatches ? (
        <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', p: 4, textAlign: 'center' }}>
          <Typography variant="body1" sx={{ color: 'text.secondary' }}>No harvest records match your filters.</Typography>
        </Paper>
      ) : isDesktop ? (
        <HarvestTable records={filtered} onView={handleView} onEdit={openEdit} onDelete={setDeleteTarget} />
      ) : (
        <Grid container spacing={{ xs: 2, md: 3 }}>
          {filtered.map((r) => <Grid item xs={12} sm={6} key={r.id}><HarvestCard record={r} onView={handleView} onEdit={openEdit} onDelete={setDeleteTarget} /></Grid>)}
        </Grid>
      )}

      <HarvestForm open={formOpen} record={editing} vineyardOptions={vineyardOptions} blockOptions={blockOptions}
        defaultVineyardId={editing ? '' : defaultFormVineyard} saving={saving} onSubmit={handleSubmit}
        onClose={() => { setFormOpen(false); setEditing(null); }} />
      <ConfirmDialog open={Boolean(deleteTarget)} title="Delete Harvest"
        message={deleteTarget ? `Are you sure you want to delete "${deleteTarget.title}"? This cannot be undone.` : ''}
        confirmLabel="Delete" confirmColor="error" loading={deleting} onConfirm={handleDelete} onClose={() => setDeleteTarget(null)} />
      <Snackbar open={Boolean(toast)} autoHideDuration={4000} onClose={() => setToast('')} message={toast} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }} />
    </PageContainer>
  );
}

function EmptyHarvest({ onAdd }) {
  return (
    <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', px: 3, py: { xs: 5, md: 7 }, textAlign: 'center', mt: 3 }}>
      <Box sx={{ width: 64, height: 64, borderRadius: '50%', bgcolor: 'background.paper', display: 'flex', alignItems: 'center', justifyContent: 'center', mx: 'auto', mb: 2, color: 'primary.main' }}>
        <AgricultureOutlinedIcon sx={{ fontSize: '2rem' }} />
      </Box>
      <Typography variant="h4" component="p" sx={{ mb: 0.5 }}>No harvest records yet</Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary', maxWidth: 440, mx: 'auto', mb: 3 }}>Add your first harvest record to start tracking yields across your vineyards and blocks.</Typography>
      <Button variant="contained" color="primary" startIcon={<AddOutlinedIcon />} onClick={onAdd}>Add Harvest</Button>
    </Paper>
  );
}

export default Harvest;
