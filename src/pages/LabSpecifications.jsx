import { useEffect, useMemo, useState, useCallback } from 'react';
import {
  Box, Typography, Button, TextField, InputAdornment, MenuItem, Paper,
  Skeleton, Alert, Snackbar, Stack,
} from '@mui/material';
import AddOutlinedIcon from '@mui/icons-material/AddOutlined';
import SearchOutlinedIcon from '@mui/icons-material/SearchOutlined';
import RuleOutlinedIcon from '@mui/icons-material/RuleOutlined';
import PageContainer from '../components/layout/PageContainer';
import { useOrganisation } from '../context/OrganisationContext';
import LabSpecificationTable from '../components/lab/LabSpecificationTable';
import LabSpecificationForm from '../components/lab/LabSpecificationForm';
import ConfirmDialog from '../components/common/ConfirmDialog';
import {
  getLabSpecifications, createLabSpecification, updateLabSpecification,
  retireLabSpecification, reactivateLabSpecification, createSupersedingLabSpecification,
  labSpecificationError, LAB_SAMPLE_TYPES,
} from '../services/labSpecificationService';
import { getLabAnalyteOptions } from '../services/labAnalyteService';

const ALL = 'all';
const SCOPE_ACTIVE = 'active';
const SCOPE_ALL = 'all';

function LabSpecifications() {
  const { activeOrgId } = useOrganisation();

  const [specifications, setSpecifications] = useState([]);
  const [analyteOptions, setAnalyteOptions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [search, setSearch] = useState('');
  const [analyteFilter, setAnalyteFilter] = useState(ALL);
  const [typeFilter, setTypeFilter] = useState(ALL);
  const [scope, setScope] = useState(SCOPE_ACTIVE);

  // Dialog state: mode is 'create' | 'edit' | 'version'; target is the row.
  const [formOpen, setFormOpen] = useState(false);
  const [formMode, setFormMode] = useState('create');
  const [formTarget, setFormTarget] = useState(null);
  const [saving, setSaving] = useState(false);

  const [retireTarget, setRetireTarget] = useState(null);
  const [retiring, setRetiring] = useState(false);
  const [toast, setToast] = useState('');

  // Load specs (scoped to the current filters) + active analyte options.
  const load = useCallback(async (currentScope) => {
    setLoading(true); setError('');
    const specOpts = currentScope === SCOPE_ALL
      ? { includeExpired: true }
      : { activeOnly: true, includeExpired: false };

    const [specRes, analyteRes] = await Promise.all([
      getLabSpecifications(specOpts),
      getLabAnalyteOptions(), // active analytes for creation + filtering
    ]);

    if (specRes.error) {
      const friendly = labSpecificationError(specRes.error);
      if (/not set up yet/i.test(friendly)) setSpecifications([]); else setError(friendly);
    } else {
      setSpecifications(specRes.data || []);
    }

    if (analyteRes.error) setAnalyteOptions([]);
    else setAnalyteOptions(analyteRes.data || []);

    setLoading(false);
  }, []);

  // Refetch on active-organisation change AND scope change. Clear first so no
  // previous-organisation rows or options are shown mid-switch.
  useEffect(() => {
    if (!activeOrgId) { setSpecifications([]); setAnalyteOptions([]); return; }
    setSpecifications([]); setAnalyteOptions([]);
    load(scope);
  }, [activeOrgId, scope, load]);

  // Client-side search + analyte/type filters over the loaded rows.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return specifications.filter((s) => {
      const matchAnalyte = analyteFilter === ALL || s.labAnalyteId === analyteFilter;
      const matchType = typeFilter === ALL || s.sampleType === typeFilter;
      const matchQuery = !q ||
        (s.name || '').toLowerCase().includes(q) ||
        (s.analyteCode || '').toLowerCase().includes(q) ||
        (s.analyteDisplayName || '').toLowerCase().includes(q);
      return matchAnalyte && matchType && matchQuery;
    });
  }, [specifications, search, analyteFilter, typeFilter]);

  const filtersActive = search.trim() !== '' || analyteFilter !== ALL || typeFilter !== ALL;
  const clearFilters = () => { setSearch(''); setAnalyteFilter(ALL); setTypeFilter(ALL); };

  const openCreate = () => { setFormMode('create'); setFormTarget(null); setFormOpen(true); };
  const openEdit = (s) => { setFormMode('edit'); setFormTarget(s); setFormOpen(true); };
  const openVersion = (s) => { setFormMode('version'); setFormTarget(s); setFormOpen(true); };

  const handleSubmit = async (values) => {
    setSaving(true);
    let res;
    if (formMode === 'edit') res = await updateLabSpecification(formTarget.id, values);
    else if (formMode === 'version') res = await createSupersedingLabSpecification(formTarget.id, values);
    else res = await createLabSpecification(values);
    setSaving(false);
    if (res.error) { setError(labSpecificationError(res.error)); return; }
    setFormOpen(false); setFormTarget(null);
    setToast(
      formMode === 'edit' ? 'Specification updated.'
      : formMode === 'version' ? 'New specification version created.'
      : 'Specification created.'
    );
    await load(scope);
  };

  const handleRetire = async () => {
    if (!retireTarget) return;
    setRetiring(true);
    const { error: err } = await retireLabSpecification(retireTarget.id);
    setRetiring(false); setRetireTarget(null);
    if (err) { setError(labSpecificationError(err)); return; }
    setToast('Specification retired.'); await load(scope);
  };

  const handleReactivate = async (s) => {
    const { error: err } = await reactivateLabSpecification(s.id);
    if (err) { setError(labSpecificationError(err)); return; }
    setToast('Specification reactivated.'); await load(scope);
  };

  const noneAtAll = !loading && specifications.length === 0;
  const noMatches = !loading && specifications.length > 0 && filtered.length === 0;

  return (
    <PageContainer maxWidth={1600} sx={{ px: { xs: 2, sm: 3, md: 4, lg: 5 } }}>
      <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, alignItems: { xs: 'stretch', sm: 'center' }, justifyContent: 'space-between', gap: 2, mb: 1 }}>
        <Box>
          <Typography variant="h2" component="h1" sx={{ mb: 0.5 }}>Laboratory Specifications</Typography>
          <Typography variant="body1" sx={{ color: 'text.secondary' }}>
            Define quality ranges and targets for laboratory analytes.
          </Typography>
        </Box>
        <Button variant="contained" color="primary" startIcon={<AddOutlinedIcon />} onClick={openCreate} sx={{ flexShrink: 0 }}>Create Specification</Button>
      </Box>

      {/* Toolbar is ALWAYS rendered — even with zero active specifications — so
          the user can always switch scope to "All" and adjust filters. */}
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ my: 3 }} alignItems={{ md: 'center' }}>
        <TextField
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name or analyte"
          fullWidth
          sx={{ maxWidth: { md: 300 } }}
          InputProps={{ startAdornment: <InputAdornment position="start"><SearchOutlinedIcon fontSize="small" /></InputAdornment> }}
        />
        <TextField select label="Analyte" value={analyteFilter} onChange={(e) => setAnalyteFilter(e.target.value)} fullWidth sx={{ maxWidth: { md: 220 } }}>
          <MenuItem value={ALL}>All analytes</MenuItem>
          {analyteOptions.map((a) => (
            <MenuItem key={a.id} value={a.id}>{a.code}{a.displayName && a.displayName !== a.code ? ` — ${a.displayName}` : ''}</MenuItem>
          ))}
        </TextField>
        <TextField select label="Sample Type" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} fullWidth sx={{ maxWidth: { md: 180 } }}>
          <MenuItem value={ALL}>All types</MenuItem>
          {LAB_SAMPLE_TYPES.map((t) => <MenuItem key={t.value} value={t.value}>{t.label}</MenuItem>)}
        </TextField>
        <TextField select label="Status" value={scope} onChange={(e) => setScope(e.target.value)} fullWidth sx={{ maxWidth: { md: 150 } }}>
          <MenuItem value={SCOPE_ACTIVE}>Active</MenuItem>
          <MenuItem value={SCOPE_ALL}>All</MenuItem>
        </TextField>
        {filtersActive && <Button onClick={clearFilters} color="inherit" sx={{ flexShrink: 0 }}>Clear filters</Button>}
      </Stack>

      {error && <Alert severity="error" sx={{ mb: 2 }} action={<Button color="inherit" size="small" onClick={() => load(scope)}>Retry</Button>} onClose={() => setError('')}>{error}</Alert>}

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
        <EmptySpecifications onAdd={openCreate} scope={scope} />
      ) : noMatches ? (
        <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', p: 4, textAlign: 'center' }}>
          <Typography variant="body1" sx={{ color: 'text.secondary', mb: 2 }}>No specifications match your filters.</Typography>
          <Button onClick={clearFilters} variant="outlined" color="primary">Clear filters</Button>
        </Paper>
      ) : (
        <LabSpecificationTable
          specifications={filtered}
          onEdit={openEdit}
          onRetire={setRetireTarget}
          onReactivate={handleReactivate}
          onNewVersion={openVersion}
        />
      )}

      <LabSpecificationForm
        open={formOpen}
        mode={formMode}
        spec={formTarget}
        analyteOptions={analyteOptions}
        saving={saving}
        onSubmit={handleSubmit}
        onClose={() => { setFormOpen(false); setFormTarget(null); }}
      />
      <ConfirmDialog
        open={Boolean(retireTarget)}
        title="Retire Specification?"
        message="This specification will be retained for historical records but will no longer be the current active specification."
        confirmLabel="Retire"
        confirmColor="error"
        loading={retiring}
        onConfirm={handleRetire}
        onClose={() => setRetireTarget(null)}
      />
      <Snackbar open={Boolean(toast)} autoHideDuration={4000} onClose={() => setToast('')} message={toast} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }} />
    </PageContainer>
  );
}

function EmptySpecifications({ onAdd, scope }) {
  const activeOnly = scope === SCOPE_ACTIVE;
  const heading = activeOnly ? 'No active laboratory specifications' : 'No laboratory specifications yet';
  const body = activeOnly
    ? 'There are no active specifications. Switch the Status filter to “All” to view retired or historical specifications, or create a new one.'
    : 'Create your first laboratory specification to define quality ranges and targets for an analyte.';

  return (
    <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', px: 3, py: { xs: 5, md: 7 }, textAlign: 'center' }}>
      <Box sx={{ width: 64, height: 64, borderRadius: '50%', bgcolor: 'background.paper', display: 'flex', alignItems: 'center', justifyContent: 'center', mx: 'auto', mb: 2, color: 'secondary.main' }}>
        <RuleOutlinedIcon sx={{ fontSize: '2rem' }} />
      </Box>
      <Typography variant="h4" component="p" sx={{ mb: 0.5 }}>{heading}</Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary', maxWidth: 460, mx: 'auto', mb: 3 }}>{body}</Typography>
      <Button variant="contained" color="primary" startIcon={<AddOutlinedIcon />} onClick={onAdd}>Create Specification</Button>
    </Paper>
  );
}

export default LabSpecifications;
