import { useEffect, useMemo, useState, useCallback } from 'react';
import {
  Box, Typography, Button, TextField, InputAdornment, MenuItem, Paper,
  Skeleton, Alert, Snackbar, Stack,
} from '@mui/material';
import AddOutlinedIcon from '@mui/icons-material/AddOutlined';
import SearchOutlinedIcon from '@mui/icons-material/SearchOutlined';
import ScienceOutlinedIcon from '@mui/icons-material/ScienceOutlined';
import PageContainer from '../components/layout/PageContainer';
import { useOrganisation } from '../context/OrganisationContext';
import LabAnalyteTable from '../components/lab/LabAnalyteTable';
import LabAnalyteForm from '../components/lab/LabAnalyteForm';
import ConfirmDialog from '../components/common/ConfirmDialog';
import {
  getLabAnalytes, createLabAnalyte, updateLabAnalyte,
  deactivateLabAnalyte, reactivateLabAnalyte, friendlyLabAnalyteError,
} from '../services/labAnalyteService';

// Status scope: Active analytes only (default) vs All (active + inactive).
const SCOPE_ACTIVE = 'active';
const SCOPE_ALL = 'all';

function LabAnalytes() {
  const { activeOrgId } = useOrganisation();

  const [analytes, setAnalytes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [scope, setScope] = useState(SCOPE_ACTIVE);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  const [deactivateTarget, setDeactivateTarget] = useState(null);
  const [deactivating, setDeactivating] = useState(false);
  const [toast, setToast] = useState('');

  // Load analytes for the active organisation. includeInactive follows the scope
  // filter so inactive analytes are never permanently hidden (switch to "All").
  const load = useCallback(async (currentScope) => {
    setLoading(true); setError('');
    const { data, error: err } = await getLabAnalytes({
      includeInactive: currentScope === SCOPE_ALL,
    });
    if (err) {
      const friendly = friendlyLabAnalyteError(err);
      if (/not set up yet/i.test(friendly)) setAnalytes([]); else setError(friendly);
    } else {
      setAnalytes(data || []);
    }
    setLoading(false);
  }, []);

  // Refetch on active-organisation change AND on scope change. Clearing the list
  // first guarantees no stale previous-organisation rows are shown mid-switch.
  useEffect(() => {
    if (!activeOrgId) { setAnalytes([]); return; }
    setAnalytes([]);
    load(scope);
  }, [activeOrgId, scope, load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return analytes;
    return analytes.filter((a) => {
      const code = (a.code || '').toLowerCase();
      const name = (a.displayName || '').toLowerCase();
      const unit = (a.canonicalUnit || '').toLowerCase();
      return code.includes(q) || name.includes(q) || unit.includes(q);
    });
  }, [analytes, search]);

  const openAdd = () => { setEditing(null); setFormOpen(true); };
  const openEdit = (a) => { setEditing(a); setFormOpen(true); };

  const handleSubmit = async (values) => {
    setSaving(true);
    const isEdit = Boolean(editing);
    const { error: err } = isEdit
      ? await updateLabAnalyte(editing.id, values)
      : await createLabAnalyte(values);
    setSaving(false);
    if (err) { setError(friendlyLabAnalyteError(err)); return; }
    setFormOpen(false); setEditing(null);
    setToast(isEdit ? 'Analyte updated.' : 'Analyte added.');
    await load(scope);
  };

  const handleDeactivate = async () => {
    if (!deactivateTarget) return;
    setDeactivating(true);
    const { error: err } = await deactivateLabAnalyte(deactivateTarget.id);
    setDeactivating(false); setDeactivateTarget(null);
    if (err) { setError(friendlyLabAnalyteError(err)); return; }
    setToast('Analyte deactivated.'); await load(scope);
  };

  const handleReactivate = async (a) => {
    const { error: err } = await reactivateLabAnalyte(a.id);
    if (err) { setError(friendlyLabAnalyteError(err)); return; }
    setToast('Analyte reactivated.'); await load(scope);
  };

  const noneAtAll = !loading && analytes.length === 0;
  const noMatches = !loading && analytes.length > 0 && filtered.length === 0;

  return (
    <PageContainer maxWidth={1600} sx={{ px: { xs: 2, sm: 3, md: 4, lg: 5 } }}>
      <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, alignItems: { xs: 'stretch', sm: 'center' }, justifyContent: 'space-between', gap: 2, mb: 1 }}>
        <Box>
          <Typography variant="h2" component="h1" sx={{ mb: 0.5 }}>Lab Analytes</Typography>
          <Typography variant="body1" sx={{ color: 'text.secondary' }}>
            Analytes define the laboratory measurements WineRix can record for your wine lots, such as pH, titratable acidity or free SO₂.
          </Typography>
        </Box>
        <Button variant="contained" color="primary" startIcon={<AddOutlinedIcon />} onClick={openAdd} sx={{ flexShrink: 0 }}>Add Analyte</Button>
      </Box>

      {/* Toolbar is ALWAYS rendered — even with zero active analytes — so the
          user can always switch the Status filter from Active to All (e.g. to
          reach and reactivate a deactivated analyte) and always search. */}
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ my: 3 }}>
        <TextField
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by code, name or unit"
          fullWidth
          sx={{ maxWidth: { md: 360 } }}
          InputProps={{ startAdornment: <InputAdornment position="start"><SearchOutlinedIcon fontSize="small" /></InputAdornment> }}
        />
        <TextField select label="Status" value={scope} onChange={(e) => setScope(e.target.value)} fullWidth sx={{ maxWidth: { md: 190 } }}>
          <MenuItem value={SCOPE_ACTIVE}>Active</MenuItem>
          <MenuItem value={SCOPE_ALL}>All</MenuItem>
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
        <EmptyAnalytes onAdd={openAdd} scope={scope} />
      ) : noMatches ? (
        <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', p: 4, textAlign: 'center' }}>
          <Typography variant="body1" sx={{ color: 'text.secondary' }}>No analytes match your search.</Typography>
        </Paper>
      ) : (
        <LabAnalyteTable
          analytes={filtered}
          onEdit={openEdit}
          onDeactivate={setDeactivateTarget}
          onReactivate={handleReactivate}
        />
      )}

      <LabAnalyteForm
        open={formOpen}
        analyte={editing}
        saving={saving}
        onSubmit={handleSubmit}
        onClose={() => { setFormOpen(false); setEditing(null); }}
      />
      <ConfirmDialog
        open={Boolean(deactivateTarget)}
        title="Deactivate Analyte?"
        message="This analyte will no longer be available for new laboratory measurements. Existing historical measurements will remain intact."
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

function EmptyAnalytes({ onAdd, scope }) {
  // Active scope with zero rows may simply mean every analyte is deactivated —
  // the toolbar above lets the user switch to "All" to reach them. "All" with
  // zero rows is the genuine first-run empty state.
  const activeOnly = scope === SCOPE_ACTIVE;
  const heading = activeOnly ? 'No active lab analytes' : 'No lab analytes yet';
  const body = activeOnly
    ? 'There are no active analytes. Switch the Status filter to “All” to view and reactivate any deactivated analytes, or add a new one.'
    : 'Create your first laboratory analyte to begin recording wine quality measurements.';

  return (
    <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', px: 3, py: { xs: 5, md: 7 }, textAlign: 'center' }}>
      <Box sx={{ width: 64, height: 64, borderRadius: '50%', bgcolor: 'background.paper', display: 'flex', alignItems: 'center', justifyContent: 'center', mx: 'auto', mb: 2, color: 'secondary.main' }}>
        <ScienceOutlinedIcon sx={{ fontSize: '2rem' }} />
      </Box>
      <Typography variant="h4" component="p" sx={{ mb: 0.5 }}>{heading}</Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary', maxWidth: 440, mx: 'auto', mb: 3 }}>
        {body}
      </Typography>
      <Button variant="contained" color="primary" startIcon={<AddOutlinedIcon />} onClick={onAdd}>Add Analyte</Button>
    </Paper>
  );
}

export default LabAnalytes;
