import { useEffect, useMemo, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Typography, Button, TextField, InputAdornment, MenuItem, Paper,
  Skeleton, Alert, Snackbar, Stack,
} from '@mui/material';
import AddOutlinedIcon from '@mui/icons-material/AddOutlined';
import SearchOutlinedIcon from '@mui/icons-material/SearchOutlined';
import BiotechOutlinedIcon from '@mui/icons-material/BiotechOutlined';
import PageContainer from '../components/layout/PageContainer';
import { useOrganisation } from '../context/OrganisationContext';
import LabSampleTable from '../components/lab/LabSampleTable';
import LabSampleForm from '../components/lab/LabSampleForm';
import {
  getLabSamples, createLabSample, friendlyLabSampleError,
  LAB_SAMPLE_TYPES, LAB_SAMPLE_STATUSES,
} from '../services/labSampleService';
import { getWineLots } from '../services/wineLotService';

const ALL = 'all';

function LabSamples() {
  const { activeOrgId } = useOrganisation();
  const navigate = useNavigate();

  const [samples, setSamples] = useState([]);
  const [lotOptions, setLotOptions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState(ALL);
  const [typeFilter, setTypeFilter] = useState(ALL);

  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState('');

  // Load the active organisation's samples AND wine-lot options together.
  const load = useCallback(async () => {
    setLoading(true); setError('');
    const [samplesRes, lotsRes] = await Promise.all([getLabSamples(), getWineLots()]);

    if (samplesRes.error) {
      const friendly = friendlyLabSampleError(samplesRes.error);
      if (/not set up yet/i.test(friendly)) setSamples([]); else setError(friendly);
    } else {
      setSamples(samplesRes.data || []);
    }

    if (lotsRes.error) {
      // Non-fatal: the lot dropdown simply has no options. Surface only if there
      // is no more serious samples error already shown.
      setLotOptions([]);
    } else {
      setLotOptions(lotsRes.data || []);
    }

    setLoading(false);
  }, []);

  // Refetch on active-organisation change. Clear stale samples AND lot options
  // first so nothing from the previous organisation is ever shown mid-switch.
  useEffect(() => {
    if (!activeOrgId) { setSamples([]); setLotOptions([]); return; }
    setSamples([]); setLotOptions([]);
    load();
  }, [activeOrgId, load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return samples.filter((s) => {
      const matchStatus = statusFilter === ALL || s.status === statusFilter;
      const matchType = typeFilter === ALL || s.sampleType === typeFilter;
      const code = (s.sampleCode || '').toLowerCase();
      const lot = (s.lotCode || '').toLowerCase();
      const matchQuery = !q || code.includes(q) || lot.includes(q);
      return matchStatus && matchType && matchQuery;
    });
  }, [samples, search, statusFilter, typeFilter]);

  const filtersActive = search.trim() !== '' || statusFilter !== ALL || typeFilter !== ALL;
  const clearFilters = () => { setSearch(''); setStatusFilter(ALL); setTypeFilter(ALL); };

  const openCreate = () => setFormOpen(true);

  const handleCreate = async (values) => {
    setSaving(true);
    const { data, error: err } = await createLabSample(values);
    setSaving(false);
    if (err) { setError(friendlyLabSampleError(err)); return; }
    setFormOpen(false);
    setToast('Sample created.');
    await load();
    // Jump straight to the new sample's profile for status/review next steps.
    if (data?.id) navigate(`/lab/samples/${data.id}`);
  };

  const noneAtAll = !loading && samples.length === 0;
  const noMatches = !loading && samples.length > 0 && filtered.length === 0;

  return (
    <PageContainer maxWidth={1600} sx={{ px: { xs: 2, sm: 3, md: 4, lg: 5 } }}>
      <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, alignItems: { xs: 'stretch', sm: 'center' }, justifyContent: 'space-between', gap: 2, mb: 1 }}>
        <Box>
          <Typography variant="h2" component="h1" sx={{ mb: 0.5 }}>Lab Samples</Typography>
          <Typography variant="body1" sx={{ color: 'text.secondary' }}>
            Samples are laboratory sample events drawn from your wine lots at specific points in the wine-making process.
          </Typography>
        </Box>
        <Button variant="contained" color="primary" startIcon={<AddOutlinedIcon />} onClick={openCreate} sx={{ flexShrink: 0 }}>New Sample</Button>
      </Box>

      {/* Toolbar is always rendered so filters stay reachable in every state. */}
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ my: 3 }} alignItems={{ md: 'center' }}>
        <TextField
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by sample code or wine lot"
          fullWidth
          sx={{ maxWidth: { md: 340 } }}
          InputProps={{ startAdornment: <InputAdornment position="start"><SearchOutlinedIcon fontSize="small" /></InputAdornment> }}
        />
        <TextField select label="Status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} fullWidth sx={{ maxWidth: { md: 180 } }}>
          <MenuItem value={ALL}>All statuses</MenuItem>
          {LAB_SAMPLE_STATUSES.map((s) => <MenuItem key={s.value} value={s.value}>{s.label}</MenuItem>)}
        </TextField>
        <TextField select label="Sample Type" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} fullWidth sx={{ maxWidth: { md: 190 } }}>
          <MenuItem value={ALL}>All types</MenuItem>
          {LAB_SAMPLE_TYPES.map((t) => <MenuItem key={t.value} value={t.value}>{t.label}</MenuItem>)}
        </TextField>
        {filtersActive && (
          <Button onClick={clearFilters} color="inherit" sx={{ flexShrink: 0 }}>Clear filters</Button>
        )}
      </Stack>

      {error && <Alert severity="error" sx={{ mb: 2 }} action={<Button color="inherit" size="small" onClick={load}>Retry</Button>} onClose={() => setError('')}>{error}</Alert>}

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
        <EmptySamples onAdd={openCreate} />
      ) : noMatches ? (
        <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', p: 4, textAlign: 'center' }}>
          <Typography variant="body1" sx={{ color: 'text.secondary', mb: 2 }}>No samples match your filters.</Typography>
          <Button onClick={clearFilters} variant="outlined" color="primary">Clear filters</Button>
        </Paper>
      ) : (
        <LabSampleTable samples={filtered} onOpen={(s) => navigate(`/lab/samples/${s.id}`)} />
      )}

      <LabSampleForm
        open={formOpen}
        sample={null}
        lotOptions={lotOptions}
        saving={saving}
        onSubmit={handleCreate}
        onClose={() => setFormOpen(false)}
      />
      <Snackbar open={Boolean(toast)} autoHideDuration={4000} onClose={() => setToast('')} message={toast} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }} />
    </PageContainer>
  );
}

function EmptySamples({ onAdd }) {
  return (
    <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', px: 3, py: { xs: 5, md: 7 }, textAlign: 'center' }}>
      <Box sx={{ width: 64, height: 64, borderRadius: '50%', bgcolor: 'background.paper', display: 'flex', alignItems: 'center', justifyContent: 'center', mx: 'auto', mb: 2, color: 'secondary.main' }}>
        <BiotechOutlinedIcon sx={{ fontSize: '2rem' }} />
      </Box>
      <Typography variant="h4" component="p" sx={{ mb: 0.5 }}>No lab samples yet</Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary', maxWidth: 440, mx: 'auto', mb: 3 }}>
        Create a sample from a wine lot to begin recording laboratory results.
      </Typography>
      <Button variant="contained" color="primary" startIcon={<AddOutlinedIcon />} onClick={onAdd}>New Sample</Button>
    </Paper>
  );
}

export default LabSamples;
