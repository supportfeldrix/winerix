import { useEffect, useMemo, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Typography, Button, TextField, InputAdornment, MenuItem, Paper,
  Skeleton, Alert, Snackbar, Stack,
} from '@mui/material';
import AddOutlinedIcon from '@mui/icons-material/AddOutlined';
import SearchOutlinedIcon from '@mui/icons-material/SearchOutlined';
import RefreshOutlinedIcon from '@mui/icons-material/RefreshOutlined';
import LiquorOutlinedIcon from '@mui/icons-material/LiquorOutlined';
import PageContainer from '../components/layout/PageContainer';
import { useOrganisation } from '../context/OrganisationContext';
import BottlingRunTable from '../components/bottling/BottlingRunTable';
import BottlingRunForm from '../components/bottling/BottlingRunForm';
import {
  getBottlingRuns, createBottlingRun, getReleaseLabSampleOptions,
  friendlyBottlingError, BOTTLING_RUN_STATUSES,
} from '../services/bottlingService';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Bottling Runs workspace (P2J-B5-1)
//
// Lists the active organisation's bottling runs and supports search, status
// filtering, refresh and creating a new PLANNED run. All data access goes
// through bottlingService (never Supabase directly). Organisation scoping is
// handled inside the service via getActiveOrgId(); this page simply refetches
// whenever the active organisation changes.
//
// Out of scope for B5-1 (future tasks): source-lot allocation, bottling
// outputs, completion and cancellation workflows.
// ─────────────────────────────────────────────────────────────────────────────

const ALL = 'all';

function BottlingRuns() {
  const navigate = useNavigate();
  const { activeOrgId } = useOrganisation();

  const [runs, setRuns] = useState([]);
  const [labSampleOptions, setLabSampleOptions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState(ALL);

  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    const [runsRes, sampleRes] = await Promise.all([
      getBottlingRuns(),
      getReleaseLabSampleOptions(),
    ]);

    if (runsRes.error) {
      const friendly = friendlyBottlingError(runsRes.error);
      if (/not set up yet/i.test(friendly)) setRuns([]); else setError(friendly);
    } else {
      setRuns(runsRes.data || []);
    }

    // Lab-sample options are optional context for the create form; a failure
    // here must never block the list.
    if (sampleRes.error) setLabSampleOptions([]);
    else setLabSampleOptions(sampleRes.data || []);

    setLoading(false);
  }, []);

  // Refetch on active-organisation change. Clear first so no previous-org rows
  // are shown mid-switch — never expose another organisation's runs.
  useEffect(() => {
    if (!activeOrgId) { setRuns([]); setLabSampleOptions([]); return; }
    setRuns([]); setLabSampleOptions([]);
    load();
  }, [activeOrgId, load]);

  // Client-side search + status filter over the loaded rows.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return runs.filter((r) => {
      const matchStatus = statusFilter === ALL || r.status === statusFilter;
      const matchQuery = !q ||
        (r.bottlingCode || '').toLowerCase().includes(q) ||
        (r.notes || '').toLowerCase().includes(q);
      return matchStatus && matchQuery;
    });
  }, [runs, search, statusFilter]);

  const filtersActive = search.trim() !== '' || statusFilter !== ALL;
  const clearFilters = () => { setSearch(''); setStatusFilter(ALL); };

  const handleCreate = async (values) => {
    setSaving(true);
    const { data, error: err } = await createBottlingRun(values);
    setSaving(false);
    if (err) { setError(friendlyBottlingError(err)); return; }
    setFormOpen(false);
    setToast('Bottling run created.');
    await load();
    // Open the new run's profile so the user can continue the workflow.
    if (data?.id) navigate(`/bottling-runs/${data.id}`);
  };

  const noneAtAll = !loading && runs.length === 0;
  const noMatches = !loading && runs.length > 0 && filtered.length === 0;

  return (
    <PageContainer maxWidth={1600} sx={{ px: { xs: 2, sm: 3, md: 4, lg: 5 } }}>
      <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, alignItems: { xs: 'stretch', sm: 'center' }, justifyContent: 'space-between', gap: 2, mb: 1 }}>
        <Box>
          <Typography variant="h2" component="h1" sx={{ mb: 0.5 }}>Bottling Runs</Typography>
          <Typography variant="body1" sx={{ color: 'text.secondary' }}>
            Plan and track bottling runs for your wine lots.
          </Typography>
        </Box>
        <Button variant="contained" color="primary" startIcon={<AddOutlinedIcon />} onClick={() => setFormOpen(true)} sx={{ flexShrink: 0 }}>Create Bottling Run</Button>
      </Box>

      {/* Toolbar always rendered so filters/refresh are reachable even at zero rows. */}
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ my: 3 }} alignItems={{ md: 'center' }}>
        <TextField
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by code or notes"
          fullWidth
          sx={{ maxWidth: { md: 320 } }}
          InputProps={{ startAdornment: <InputAdornment position="start"><SearchOutlinedIcon fontSize="small" /></InputAdornment> }}
        />
        <TextField select label="Status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} fullWidth sx={{ maxWidth: { md: 200 } }}>
          <MenuItem value={ALL}>All statuses</MenuItem>
          {BOTTLING_RUN_STATUSES.map((s) => <MenuItem key={s.value} value={s.value}>{s.label}</MenuItem>)}
        </TextField>
        {filtersActive && <Button onClick={clearFilters} color="inherit" sx={{ flexShrink: 0 }}>Clear filters</Button>}
        <Box sx={{ flexGrow: 1 }} />
        <Button onClick={load} color="inherit" startIcon={<RefreshOutlinedIcon />} disabled={loading} sx={{ flexShrink: 0 }}>Refresh</Button>
      </Stack>

      {error && <Alert severity="error" sx={{ mb: 2 }} action={<Button color="inherit" size="small" onClick={load}>Retry</Button>} onClose={() => setError('')}>{error}</Alert>}

      {loading ? (
        <Paper variant="outlined" sx={{ borderRadius: 3, p: 2.5 }}>
          {[0, 1, 2].map((i) => (
            <Box key={i} sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 1 }}>
              <Skeleton variant="rounded" width={34} height={34} />
              <Skeleton width="35%" height={24} />
              <Skeleton width="15%" height={24} sx={{ ml: 'auto' }} />
            </Box>
          ))}
        </Paper>
      ) : noneAtAll ? (
        <EmptyBottlingRuns onAdd={() => setFormOpen(true)} />
      ) : noMatches ? (
        <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', p: 4, textAlign: 'center' }}>
          <Typography variant="body1" sx={{ color: 'text.secondary', mb: 2 }}>No bottling runs match your filters.</Typography>
          <Button onClick={clearFilters} variant="outlined" color="primary">Clear filters</Button>
        </Paper>
      ) : (
        <BottlingRunTable
          runs={filtered}
          onOpen={(r) => navigate(`/bottling-runs/${r.id}`)}
          onEdit={(r) => navigate(`/bottling-runs/${r.id}`)}
        />
      )}

      <BottlingRunForm
        open={formOpen}
        mode="create"
        labSampleOptions={labSampleOptions}
        saving={saving}
        onSubmit={handleCreate}
        onClose={() => setFormOpen(false)}
      />
      <Snackbar open={Boolean(toast)} autoHideDuration={4000} onClose={() => setToast('')} message={toast} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }} />
    </PageContainer>
  );
}

function EmptyBottlingRuns({ onAdd }) {
  return (
    <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', px: 3, py: { xs: 5, md: 7 }, textAlign: 'center' }}>
      <Box sx={{ width: 64, height: 64, borderRadius: '50%', bgcolor: 'background.paper', display: 'flex', alignItems: 'center', justifyContent: 'center', mx: 'auto', mb: 2, color: 'secondary.main' }}>
        <LiquorOutlinedIcon sx={{ fontSize: '2rem' }} />
      </Box>
      <Typography variant="h4" component="p" sx={{ mb: 0.5 }}>No bottling runs yet</Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary', maxWidth: 460, mx: 'auto', mb: 3 }}>
        Create your first bottling run to begin planning. You can allocate source wine lots and record outputs once the run exists.
      </Typography>
      <Button variant="contained" color="primary" startIcon={<AddOutlinedIcon />} onClick={onAdd}>Create Bottling Run</Button>
    </Paper>
  );
}

export default BottlingRuns;
