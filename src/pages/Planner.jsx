import { useEffect, useMemo, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Typography, Button, TextField, InputAdornment, MenuItem, Grid, Paper,
  Skeleton, Alert, Snackbar, Stack, useMediaQuery,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import AddOutlinedIcon from '@mui/icons-material/AddOutlined';
import SearchOutlinedIcon from '@mui/icons-material/SearchOutlined';
import EventNoteOutlinedIcon from '@mui/icons-material/EventNoteOutlined';
import PendingActionsOutlinedIcon from '@mui/icons-material/PendingActionsOutlined';
import PlayCircleOutlineOutlinedIcon from '@mui/icons-material/PlayCircleOutlineOutlined';
import CheckCircleOutlineOutlinedIcon from '@mui/icons-material/CheckCircleOutlineOutlined';
import PageContainer from '../components/layout/PageContainer';
import StatCard from '../components/dashboard/StatCard';
import PlannerCard from '../components/planner/PlannerCard';
import PlannerTable from '../components/planner/PlannerTable';
import PlannerForm from '../components/planner/PlannerForm';
import ConfirmDialog from '../components/common/ConfirmDialog';
import {
  getPlannerTasks, createPlannerTask, updatePlannerTask, deletePlannerTask,
  getVineyardOptions, getBlockOptions, friendlyPlannerError, PLANNER_STATUSES,
} from '../services/plannerService';

const ALL_STATUSES = 'all';

function Planner() {
  const navigate = useNavigate();
  const theme = useTheme();
  const isDesktop = useMediaQuery(theme.breakpoints.up('md'));

  const [records, setRecords] = useState([]);
  const [vineyardOptions, setVineyardOptions] = useState([]);
  const [blockOptions, setBlockOptions] = useState([]);
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
    const [recRes, vRes, bRes] = await Promise.all([getPlannerTasks(), getVineyardOptions(), getBlockOptions()]);
    if (!vRes.error) setVineyardOptions(vRes.data || []);
    if (!bRes.error) setBlockOptions(bRes.data || []);
    if (recRes.error) {
      const friendly = friendlyPlannerError(recRes.error);
      if (/not set up yet/i.test(friendly)) setRecords([]); else setError(friendly);
    } else setRecords(recRes.data || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return records.filter((r) => {
      const ms = statusFilter === ALL_STATUSES || (r.status || '').toLowerCase() === statusFilter;
      const mq = !q || (r.title || '').toLowerCase().includes(q);
      return ms && mq;
    });
  }, [records, search, statusFilter]);

  // Summary metrics computed from the already-loaded tasks (no extra query).
  const summary = useMemo(() => {
    const total = records.length;
    let pending = 0;
    let inProgress = 0;
    let completed = 0;
    records.forEach((r) => {
      const status = (r.status || '').toLowerCase();
      if (status === 'pending') pending += 1;
      if (status === 'in_progress') inProgress += 1;
      if (status === 'completed') completed += 1;
    });
    return { total, pending, inProgress, completed };
  }, [records]);

  const openAdd = () => { setEditing(null); setFormOpen(true); };
  const openEdit = (r) => { setEditing(r); setFormOpen(true); };
  const handleView = (r) => navigate(`/planner/${r.id}`);

  const handleSubmit = async (values) => {
    setSaving(true);
    const isEdit = Boolean(editing);
    const { error: err } = isEdit ? await updatePlannerTask(editing.id, values) : await createPlannerTask(values);
    setSaving(false);
    if (err) { setError(friendlyPlannerError(err)); return; }
    setFormOpen(false); setEditing(null); setToast(isEdit ? 'Task updated.' : 'Task added.'); await load();
  };
  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    const { error: err } = await deletePlannerTask(deleteTarget.id);
    setDeleting(false); setDeleteTarget(null);
    if (err) { setError(friendlyPlannerError(err)); return; }
    setToast('Task deleted.'); await load();
  };

  const noneAtAll = !loading && records.length === 0;
  const noMatches = !loading && records.length > 0 && filtered.length === 0;

  return (
    <PageContainer maxWidth={1600} sx={{ px: { xs: 2, sm: 3, md: 4, lg: 5 } }}>
      <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, alignItems: { xs: 'stretch', sm: 'center' }, justifyContent: 'space-between', gap: 2, mb: 1 }}>
        <Box>
          <Typography variant="h2" component="h1" sx={{ mb: 0.5 }}>Planner</Typography>
          <Typography variant="body1" sx={{ color: 'text.secondary' }}>Plan and track upcoming tasks across your vineyards and blocks.</Typography>
        </Box>
        <Button variant="contained" color="primary" startIcon={<AddOutlinedIcon />} onClick={openAdd} sx={{ flexShrink: 0 }}>Add Task</Button>
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
                <StatCard icon={EventNoteOutlinedIcon} label="Total Tasks" value={summary.total} tone="primary" />
              </Grid>
              <Grid item xs={6} lg={3}>
                <StatCard icon={PendingActionsOutlinedIcon} label="Pending" value={summary.pending} tone="secondary" />
              </Grid>
              <Grid item xs={6} lg={3}>
                <StatCard icon={PlayCircleOutlineOutlinedIcon} label="In Progress" value={summary.inProgress} tone="accent" />
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
          <TextField value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by title" fullWidth sx={{ maxWidth: { md: 340 } }}
            InputProps={{ startAdornment: <InputAdornment position="start"><SearchOutlinedIcon fontSize="small" /></InputAdornment> }} />
          <TextField select label="Status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} fullWidth sx={{ maxWidth: { md: 190 } }}>
            <MenuItem value={ALL_STATUSES}>All statuses</MenuItem>
            {PLANNER_STATUSES.map((s) => <MenuItem key={s.value} value={s.value}>{s.label}</MenuItem>)}
          </TextField>
        </Stack>
      )}

      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}

      {loading ? (
        <Grid container spacing={{ xs: 2, md: 3 }}>
          {[0, 1, 2].map((i) => <Grid item xs={12} sm={6} lg={4} key={i}><Paper sx={{ p: 2.5 }}><Skeleton width="60%" height={28} /><Skeleton width="40%" height={20} sx={{ mt: 1 }} /><Skeleton width="80%" height={20} sx={{ mt: 2 }} /></Paper></Grid>)}
        </Grid>
      ) : noneAtAll ? (
        <EmptyPlanner onAdd={openAdd} />
      ) : noMatches ? (
        <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', p: 4, textAlign: 'center' }}>
          <Typography variant="body1" sx={{ color: 'text.secondary' }}>No tasks match your filters.</Typography>
        </Paper>
      ) : isDesktop ? (
        <PlannerTable records={filtered} onView={handleView} onEdit={openEdit} onDelete={setDeleteTarget} />
      ) : (
        <Grid container spacing={{ xs: 2, md: 3 }}>
          {filtered.map((r) => <Grid item xs={12} sm={6} key={r.id}><PlannerCard record={r} onView={handleView} onEdit={openEdit} onDelete={setDeleteTarget} /></Grid>)}
        </Grid>
      )}

      <PlannerForm open={formOpen} record={editing} vineyardOptions={vineyardOptions} blockOptions={blockOptions} saving={saving} onSubmit={handleSubmit}
        onClose={() => { setFormOpen(false); setEditing(null); }} />
      <ConfirmDialog open={Boolean(deleteTarget)} title="Delete Task"
        message={deleteTarget ? `Are you sure you want to delete "${deleteTarget.title}"? This cannot be undone.` : ''}
        confirmLabel="Delete" confirmColor="error" loading={deleting} onConfirm={handleDelete} onClose={() => setDeleteTarget(null)} />
      <Snackbar open={Boolean(toast)} autoHideDuration={4000} onClose={() => setToast('')} message={toast} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }} />
    </PageContainer>
  );
}

function EmptyPlanner({ onAdd }) {
  return (
    <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', px: 3, py: { xs: 5, md: 7 }, textAlign: 'center', mt: 3 }}>
      <Box sx={{ width: 64, height: 64, borderRadius: '50%', bgcolor: 'background.paper', display: 'flex', alignItems: 'center', justifyContent: 'center', mx: 'auto', mb: 2, color: 'primary.main' }}>
        <EventNoteOutlinedIcon sx={{ fontSize: '2rem' }} />
      </Box>
      <Typography variant="h4" component="p" sx={{ mb: 0.5 }}>No tasks yet</Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary', maxWidth: 440, mx: 'auto', mb: 3 }}>Add your first planned task to start organising work across your vineyards.</Typography>
      <Button variant="contained" color="primary" startIcon={<AddOutlinedIcon />} onClick={onAdd}>Add Task</Button>
    </Paper>
  );
}

export default Planner;
