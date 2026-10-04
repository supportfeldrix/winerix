import { useEffect, useMemo, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Typography, TextField, InputAdornment, MenuItem, Paper,
  Skeleton, Alert, Stack,
} from '@mui/material';
import SearchOutlinedIcon from '@mui/icons-material/SearchOutlined';
import ReportProblemOutlinedIcon from '@mui/icons-material/ReportProblemOutlined';
import PageContainer from '../components/layout/PageContainer';
import { useOrganisation } from '../context/OrganisationContext';
import LabAlertTable from '../components/lab/LabAlertTable';
import {
  getLaboratoryAlerts, friendlyLabAlertError,
  LAB_ALERT_STATUSES, LAB_ALERT_TYPES, LAB_ALERT_CLASSES,
} from '../services/labAlertService';
import { alertTypeLabel, alertClassLabel } from '../components/lab/labAlertDisplay';

const ALL = 'all';

function LabAlerts() {
  const { activeOrgId } = useOrganisation();
  const navigate = useNavigate();

  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState(ALL);
  const [typeFilter, setTypeFilter] = useState(ALL);
  const [classFilter, setClassFilter] = useState(ALL);

  // Status/type/class filters are applied service-side; search is client-side
  // over the already-loaded rows (sample code / analyte / alert + spec name).
  const load = useCallback(async () => {
    setLoading(true); setError('');
    const options = {};
    if (statusFilter !== ALL) options.status = statusFilter;
    if (typeFilter !== ALL) options.alertType = typeFilter;
    if (classFilter !== ALL) options.alertClass = classFilter;

    const { data, error: err } = await getLaboratoryAlerts(options);
    if (err) {
      const friendly = friendlyLabAlertError(err);
      if (/not set up yet/i.test(friendly)) setAlerts([]); else setError(friendly);
    } else {
      setAlerts(data || []);
    }
    setLoading(false);
  }, [statusFilter, typeFilter, classFilter]);

  // Refetch on active-organisation change AND filter change. Clear first so no
  // previous-organisation alerts are shown mid-switch.
  useEffect(() => {
    if (!activeOrgId) { setAlerts([]); return; }
    setAlerts([]);
    load();
  }, [activeOrgId, load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return alerts;
    return alerts.filter((a) =>
      (a.sampleCode || '').toLowerCase().includes(q) ||
      (a.analyteCode || '').toLowerCase().includes(q) ||
      (a.analyteDisplayName || '').toLowerCase().includes(q) ||
      (a.specificationName || '').toLowerCase().includes(q) ||
      alertTypeLabel(a.alertType).toLowerCase().includes(q)
    );
  }, [alerts, search]);

  const filtersActive = search.trim() !== '' || statusFilter !== ALL || typeFilter !== ALL || classFilter !== ALL;
  const clearFilters = () => { setSearch(''); setStatusFilter(ALL); setTypeFilter(ALL); setClassFilter(ALL); };

  const noneAtAll = !loading && alerts.length === 0;
  const noMatches = !loading && alerts.length > 0 && filtered.length === 0;

  return (
    <PageContainer maxWidth={1600} sx={{ px: { xs: 2, sm: 3, md: 4, lg: 5 } }}>
      <Box sx={{ mb: 1 }}>
        <Typography variant="h2" component="h1" sx={{ mb: 0.5 }}>Lab Alerts</Typography>
        <Typography variant="body1" sx={{ color: 'text.secondary' }}>
          Operational laboratory exceptions that may need attention — out-of-range readings and data-quality issues. These are not quality or compliance judgements.
        </Typography>
      </Box>

      {/* Toolbar — always visible so filters stay reachable in every state. */}
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ my: 3 }} alignItems={{ md: 'center' }}>
        <TextField
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by sample, analyte or name"
          fullWidth
          sx={{ maxWidth: { md: 300 } }}
          InputProps={{ startAdornment: <InputAdornment position="start"><SearchOutlinedIcon fontSize="small" /></InputAdornment> }}
        />
        <TextField select label="Status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} fullWidth sx={{ maxWidth: { md: 170 } }}>
          <MenuItem value={ALL}>All statuses</MenuItem>
          {LAB_ALERT_STATUSES.map((s) => <MenuItem key={s} value={s} sx={{ textTransform: 'capitalize' }}>{s}</MenuItem>)}
        </TextField>
        <TextField select label="Alert Type" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} fullWidth sx={{ maxWidth: { md: 180 } }}>
          <MenuItem value={ALL}>All types</MenuItem>
          {LAB_ALERT_TYPES.map((t) => <MenuItem key={t} value={t}>{alertTypeLabel(t)}</MenuItem>)}
        </TextField>
        <TextField select label="Alert Class" value={classFilter} onChange={(e) => setClassFilter(e.target.value)} fullWidth sx={{ maxWidth: { md: 180 } }}>
          <MenuItem value={ALL}>All classes</MenuItem>
          {LAB_ALERT_CLASSES.map((c) => <MenuItem key={c} value={c}>{alertClassLabel(c)}</MenuItem>)}
        </TextField>
      </Stack>

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
        <EmptyAlerts filtered={statusFilter !== ALL || typeFilter !== ALL || classFilter !== ALL} onClear={clearFilters} />
      ) : noMatches ? (
        <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', p: 4, textAlign: 'center' }}>
          <Typography variant="body1" sx={{ color: 'text.secondary' }}>No alerts match your search.</Typography>
        </Paper>
      ) : (
        <LabAlertTable alerts={filtered} onOpen={(a) => navigate(`/lab/alerts/${a.id}`)} />
      )}
    </PageContainer>
  );
}

function EmptyAlerts({ filtered, onClear }) {
  return (
    <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', px: 3, py: { xs: 5, md: 7 }, textAlign: 'center' }}>
      <Box sx={{ width: 64, height: 64, borderRadius: '50%', bgcolor: 'background.paper', display: 'flex', alignItems: 'center', justifyContent: 'center', mx: 'auto', mb: 2, color: 'secondary.main' }}>
        <ReportProblemOutlinedIcon sx={{ fontSize: '2rem' }} />
      </Box>
      <Typography variant="h4" component="p" sx={{ mb: 0.5 }}>
        {filtered ? 'No alerts for this filter' : 'No laboratory alerts'}
      </Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary', maxWidth: 440, mx: 'auto', mb: filtered ? 3 : 0 }}>
        {filtered
          ? 'No alerts match the selected filters. Try widening the status, type or class filter.'
          : 'There are currently no laboratory alerts for this organisation. Alerts appear here when a measurement falls outside its specification or has a data-quality issue.'}
      </Typography>
      {filtered && (
        <Typography component="button" onClick={onClear} variant="body2"
          sx={{ border: 'none', background: 'none', color: 'primary.main', cursor: 'pointer', textDecoration: 'underline' }}>
          Clear filters
        </Typography>
      )}
    </Paper>
  );
}

export default LabAlerts;
