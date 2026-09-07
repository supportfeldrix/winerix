import { useEffect, useMemo, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Typography,
  Button,
  TextField,
  InputAdornment,
  Grid,
  Paper,
  Skeleton,
  Alert,
  Snackbar,
  useMediaQuery,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import AddOutlinedIcon from '@mui/icons-material/AddOutlined';
import SearchOutlinedIcon from '@mui/icons-material/SearchOutlined';
import TerrainOutlinedIcon from '@mui/icons-material/TerrainOutlined';
import SquareFootOutlinedIcon from '@mui/icons-material/SquareFootOutlined';
import GridViewOutlinedIcon from '@mui/icons-material/GridViewOutlined';
import PageContainer from '../components/layout/PageContainer';
import StatCard from '../components/dashboard/StatCard';
import { formatNumber } from '../components/common/formatters';
import VineyardCard from '../components/vineyards/VineyardCard';
import VineyardTable from '../components/vineyards/VineyardTable';
import VineyardForm from '../components/vineyards/VineyardForm';
import ConfirmDialog from '../components/common/ConfirmDialog';
import {
  getVineyards,
  createVineyard,
  updateVineyard,
  deleteVineyard,
  friendlyVineyardError,
} from '../services/vineyardService';

function Vineyards() {
  const navigate = useNavigate();
  const theme = useTheme();
  const isDesktop = useMediaQuery(theme.breakpoints.up('md'));

  const [vineyards, setVineyards] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');

  // Form (add / edit)
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const [toast, setToast] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    const { data, error: err } = await getVineyards();
    if (err) {
      // Missing table before migration is run → treat as empty, not an error.
      const friendly = friendlyVineyardError(err);
      const isMissingTable = /not set up yet/i.test(friendly);
      if (isMissingTable) {
        setVineyards([]);
      } else {
        setError(friendly);
      }
    } else {
      setVineyards(data || []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return vineyards;
    return vineyards.filter(
      (v) =>
        (v.name || '').toLowerCase().includes(q) ||
        (v.location || '').toLowerCase().includes(q)
    );
  }, [vineyards, search]);

  // Real aggregates computed from the already-loaded list (no extra query,
  // no fabricated values).
  const summary = useMemo(() => {
    const totalHectares = vineyards.reduce((sum, v) => sum + (Number(v.areaHectares) || 0), 0);
    const totalBlocks = vineyards.reduce((sum, v) => sum + (Number(v.blockCount) || 0), 0);
    return { totalVineyards: vineyards.length, totalHectares, totalBlocks };
  }, [vineyards]);

  // ── Handlers ──────────────────────────────────────────────────────────────
  const openAdd = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const openEdit = (vineyard) => {
    setEditing(vineyard);
    setFormOpen(true);
  };

  const handleView = (vineyard) => navigate(`/vineyards/${vineyard.id}`);

  const handleSubmit = async (values) => {
    setSaving(true);
    const isEdit = Boolean(editing);
    const { error: err } = isEdit
      ? await updateVineyard(editing.id, values)
      : await createVineyard(values);
    setSaving(false);

    if (err) {
      setError(friendlyVineyardError(err));
      return;
    }

    setFormOpen(false);
    setEditing(null);
    setToast(isEdit ? 'Vineyard updated.' : 'Vineyard added.');
    await load();
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    const { error: err } = await deleteVineyard(deleteTarget.id);
    setDeleting(false);
    setDeleteTarget(null);

    if (err) {
      setError(friendlyVineyardError(err));
      return;
    }
    setToast('Vineyard deleted.');
    await load();
  };

  // ── Render helpers ──────────────────────────────────────────────────────────
  const hasVineyards = filtered.length > 0;
  const noneAtAll = !loading && vineyards.length === 0;
  const noSearchMatches = !loading && vineyards.length > 0 && filtered.length === 0;

  return (
    <PageContainer maxWidth={1600} sx={{ px: { xs: 2, sm: 3, md: 4, lg: 5 } }}>
      {/* Heading + Add */}
      <Box
        sx={{
          display: 'flex',
          flexDirection: { xs: 'column', sm: 'row' },
          alignItems: { xs: 'stretch', sm: 'center' },
          justifyContent: 'space-between',
          gap: 2,
          mb: 1,
        }}
      >
        <Box>
          <Typography variant="h2" component="h1" sx={{ mb: 0.5 }}>
            Vineyards
          </Typography>
          <Typography variant="body1" sx={{ color: 'text.secondary' }}>
            Manage your vineyards, their locations, area and status.
          </Typography>
        </Box>
        <Button
          variant="contained"
          color="primary"
          startIcon={<AddOutlinedIcon />}
          onClick={openAdd}
          sx={{ flexShrink: 0 }}
        >
          Add Vineyard
        </Button>
      </Box>

      {/* Real-data summary strip */}
      {!noneAtAll && (
        <Grid container spacing={{ xs: 2, md: 3 }} sx={{ mt: 1, mb: 1 }}>
          <Grid item xs={12} sm={4}>
            {loading ? (
              <Paper sx={{ p: 2.5 }}><Skeleton width="50%" height={24} /><Skeleton width="35%" height={44} sx={{ mt: 1 }} /></Paper>
            ) : (
              <StatCard icon={TerrainOutlinedIcon} label="Total Vineyards" value={summary.totalVineyards} hint="Under management" tone="primary" />
            )}
          </Grid>
          <Grid item xs={12} sm={4}>
            {loading ? (
              <Paper sx={{ p: 2.5 }}><Skeleton width="50%" height={24} /><Skeleton width="35%" height={44} sx={{ mt: 1 }} /></Paper>
            ) : (
              <StatCard icon={SquareFootOutlinedIcon} label="Total Hectares" value={formatNumber(summary.totalHectares)} hint="Planted area" tone="accent" />
            )}
          </Grid>
          <Grid item xs={12} sm={4}>
            {loading ? (
              <Paper sx={{ p: 2.5 }}><Skeleton width="50%" height={24} /><Skeleton width="35%" height={44} sx={{ mt: 1 }} /></Paper>
            ) : (
              <StatCard icon={GridViewOutlinedIcon} label="Total Blocks" value={summary.totalBlocks} hint="Across your vineyards" tone="secondary" />
            )}
          </Grid>
        </Grid>
      )}

      {/* Search */}
      {!noneAtAll && (
        <TextField
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name or location"
          fullWidth
          sx={{ maxWidth: { sm: 360 }, my: 3 }}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchOutlinedIcon fontSize="small" />
              </InputAdornment>
            ),
          }}
        />
      )}

      {/* Error */}
      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      {/* Content states */}
      {loading ? (
        <Grid container spacing={{ xs: 2, md: 3 }} sx={{ mt: 0 }}>
          {[0, 1, 2].map((i) => (
            <Grid item xs={12} md={6} lg={4} key={i}>
              <Paper sx={{ p: 2.5 }}>
                <Skeleton width="60%" height={28} />
                <Skeleton width="40%" height={20} sx={{ mt: 1 }} />
                <Skeleton width="80%" height={20} sx={{ mt: 2 }} />
              </Paper>
            </Grid>
          ))}
        </Grid>
      ) : noneAtAll ? (
        <EmptyVineyards onAdd={openAdd} />
      ) : noSearchMatches ? (
        <Paper
          variant="outlined"
          sx={{
            borderStyle: 'dashed',
            borderColor: 'divider',
            bgcolor: 'background.subtle',
            p: 4,
            textAlign: 'center',
          }}
        >
          <Typography variant="body1" sx={{ color: 'text.secondary' }}>
            No vineyards match &ldquo;{search.trim()}&rdquo;.
          </Typography>
        </Paper>
      ) : hasVineyards && isDesktop ? (
        <VineyardTable
          vineyards={filtered}
          onView={handleView}
          onEdit={openEdit}
          onDelete={setDeleteTarget}
        />
      ) : (
        <Grid container spacing={{ xs: 2, md: 3 }}>
          {filtered.map((v) => (
            <Grid item xs={12} sm={6} key={v.id}>
              <VineyardCard
                vineyard={v}
                onView={handleView}
                onViewBlocks={(vin) => navigate(`/blocks?vineyard=${vin.id}`)}
                onEdit={openEdit}
                onDelete={setDeleteTarget}
              />
            </Grid>
          ))}
        </Grid>
      )}

      {/* Add / Edit dialog */}
      <VineyardForm
        open={formOpen}
        vineyard={editing}
        saving={saving}
        onSubmit={handleSubmit}
        onClose={() => {
          setFormOpen(false);
          setEditing(null);
        }}
      />

      {/* Delete confirmation */}
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Delete Vineyard"
        message={
          deleteTarget
            ? `Are you sure you want to delete "${deleteTarget.name}"? This cannot be undone.`
            : ''
        }
        confirmLabel="Delete"
        confirmColor="error"
        loading={deleting}
        onConfirm={handleDelete}
        onClose={() => setDeleteTarget(null)}
      />

      <Snackbar
        open={Boolean(toast)}
        autoHideDuration={4000}
        onClose={() => setToast('')}
        message={toast}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />
    </PageContainer>
  );
}

function EmptyVineyards({ onAdd }) {
  return (
    <Paper
      variant="outlined"
      sx={{
        borderStyle: 'dashed',
        borderColor: 'divider',
        bgcolor: 'background.subtle',
        px: 3,
        py: { xs: 5, md: 7 },
        textAlign: 'center',
        mt: 3,
      }}
    >
      <Box
        sx={{
          width: 64,
          height: 64,
          borderRadius: '50%',
          bgcolor: 'background.paper',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          mx: 'auto',
          mb: 2,
          color: 'primary.main',
        }}
      >
        <TerrainOutlinedIcon sx={{ fontSize: '2rem' }} />
      </Box>
      <Typography variant="h4" component="p" sx={{ mb: 0.5 }}>
        No vineyards yet
      </Typography>
      <Typography
        variant="body2"
        sx={{ color: 'text.secondary', maxWidth: 420, mx: 'auto', mb: 3 }}
      >
        Add your first vineyard to start managing your vineyard intelligence.
      </Typography>
      <Button
        variant="contained"
        color="primary"
        startIcon={<AddOutlinedIcon />}
        onClick={onAdd}
      >
        Add Vineyard
      </Button>
    </Paper>
  );
}

export default Vineyards;
