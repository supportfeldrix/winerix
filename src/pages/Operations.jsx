import { useEffect, useMemo, useState, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Box,
  Typography,
  Button,
  TextField,
  InputAdornment,
  MenuItem,
  Grid,
  Paper,
  Skeleton,
  Alert,
  Snackbar,
  Stack,
  useMediaQuery,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import AddOutlinedIcon from '@mui/icons-material/AddOutlined';
import SearchOutlinedIcon from '@mui/icons-material/SearchOutlined';
import HandymanOutlinedIcon from '@mui/icons-material/HandymanOutlined';
import PageContainer from '../components/layout/PageContainer';
import OperationCard from '../components/operations/OperationCard';
import OperationTable from '../components/operations/OperationTable';
import OperationForm from '../components/operations/OperationForm';
import ConfirmDialog from '../components/common/ConfirmDialog';
import {
  getOperations,
  createOperation,
  updateOperation,
  deleteOperation,
  getVineyardOptions,
  getBlockOptions,
  friendlyOperationError,
  OPERATION_STATUSES,
} from '../services/operationsService';

const ALL_VINEYARDS = 'all';
const ALL_BLOCKS = 'all';
const ALL_STATUSES = 'all';

function Operations() {
  const navigate = useNavigate();
  const theme = useTheme();
  const isDesktop = useMediaQuery(theme.breakpoints.up('md'));
  const [searchParams, setSearchParams] = useSearchParams();

  const [operations, setOperations] = useState([]);
  const [vineyardOptions, setVineyardOptions] = useState([]);
  const [blockOptions, setBlockOptions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [search, setSearch] = useState('');
  const [vineyardFilter, setVineyardFilter] = useState(
    searchParams.get('vineyard') || ALL_VINEYARDS
  );
  const [blockFilter, setBlockFilter] = useState(
    searchParams.get('block') || ALL_BLOCKS
  );
  const [statusFilter, setStatusFilter] = useState(ALL_STATUSES);

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
    const [opsRes, vRes, bRes] = await Promise.all([
      getOperations(),
      getVineyardOptions(),
      getBlockOptions(),
    ]);

    if (!vRes.error) setVineyardOptions(vRes.data || []);
    if (!bRes.error) setBlockOptions(bRes.data || []);

    if (opsRes.error) {
      const friendly = friendlyOperationError(opsRes.error);
      const isMissingTable = /not set up yet/i.test(friendly);
      if (isMissingTable) {
        setOperations([]);
      } else {
        setError(friendly);
      }
    } else {
      setOperations(opsRes.data || []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Sync vineyard/block filters from URL params when they change.
  useEffect(() => {
    const vParam = searchParams.get('vineyard') || ALL_VINEYARDS;
    const bParam = searchParams.get('block') || ALL_BLOCKS;
    setVineyardFilter((prev) => (prev === vParam ? prev : vParam));
    setBlockFilter((prev) => (prev === bParam ? prev : bParam));
  }, [searchParams]);

  // Blocks available in the block filter (respect the vineyard filter).
  const filterBlocks = useMemo(() => {
    if (vineyardFilter === ALL_VINEYARDS) return blockOptions;
    return blockOptions.filter((b) => b.vineyardId === vineyardFilter);
  }, [blockOptions, vineyardFilter]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return operations.filter((o) => {
      const matchesVineyard =
        vineyardFilter === ALL_VINEYARDS || o.vineyardId === vineyardFilter;
      const matchesBlock =
        blockFilter === ALL_BLOCKS || o.blockId === blockFilter;
      const matchesStatus =
        statusFilter === ALL_STATUSES ||
        (o.status || '').toLowerCase() === statusFilter;
      const matchesSearch = !q || (o.title || '').toLowerCase().includes(q);
      return matchesVineyard && matchesBlock && matchesStatus && matchesSearch;
    });
  }, [operations, search, vineyardFilter, blockFilter, statusFilter]);

  const updateParams = (updates) => {
    const next = new URLSearchParams(searchParams);
    Object.entries(updates).forEach(([key, value]) => {
      if (!value) next.delete(key);
      else next.set(key, value);
    });
    setSearchParams(next, { replace: true });
  };

  const handleVineyardFilterChange = (value) => {
    setVineyardFilter(value);
    // Reset block filter if it no longer belongs to the chosen vineyard.
    setBlockFilter(ALL_BLOCKS);
    updateParams({
      vineyard: value === ALL_VINEYARDS ? '' : value,
      block: '',
    });
  };

  const handleBlockFilterChange = (value) => {
    setBlockFilter(value);
    updateParams({ block: value === ALL_BLOCKS ? '' : value });
  };

  // ── CRUD handlers ─────────────────────────────────────────────────────────
  const openAdd = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const openEdit = (operation) => {
    setEditing(operation);
    setFormOpen(true);
  };

  const handleView = (operation) => navigate(`/operations/${operation.id}`);

  const handleSubmit = async (values) => {
    setSaving(true);
    const isEdit = Boolean(editing);
    const { error: err } = isEdit
      ? await updateOperation(editing.id, values)
      : await createOperation(values);
    setSaving(false);

    if (err) {
      setError(friendlyOperationError(err));
      return;
    }

    setFormOpen(false);
    setEditing(null);
    setToast(isEdit ? 'Operation updated.' : 'Operation added.');
    await load();
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    const { error: err } = await deleteOperation(deleteTarget.id);
    setDeleting(false);
    setDeleteTarget(null);

    if (err) {
      setError(friendlyOperationError(err));
      return;
    }
    setToast('Operation deleted.');
    await load();
  };

  // ── Render state helpers ────────────────────────────────────────────────────
  const hasOperations = filtered.length > 0;
  const noneAtAll = !loading && operations.length === 0;
  const noMatches = !loading && operations.length > 0 && filtered.length === 0;
  const defaultFormVineyard =
    vineyardFilter !== ALL_VINEYARDS ? vineyardFilter : '';

  return (
    <PageContainer>
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
            Operations
          </Typography>
          <Typography variant="body1" sx={{ color: 'text.secondary' }}>
            Track the tasks performed across your vineyards and blocks.
          </Typography>
        </Box>
        <Button
          variant="contained"
          color="primary"
          startIcon={<AddOutlinedIcon />}
          onClick={openAdd}
          sx={{ flexShrink: 0 }}
        >
          Add Operation
        </Button>
      </Box>

      {/* Filters */}
      {!noneAtAll && (
        <Stack
          direction={{ xs: 'column', md: 'row' }}
          spacing={2}
          sx={{ my: 3 }}
        >
          <TextField
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by operation title"
            fullWidth
            sx={{ maxWidth: { md: 320 } }}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchOutlinedIcon fontSize="small" />
                </InputAdornment>
              ),
            }}
          />
          <TextField
            select
            label="Vineyard"
            value={vineyardFilter}
            onChange={(e) => handleVineyardFilterChange(e.target.value)}
            fullWidth
            sx={{ maxWidth: { md: 200 } }}
          >
            <MenuItem value={ALL_VINEYARDS}>All vineyards</MenuItem>
            {vineyardOptions.map((v) => (
              <MenuItem key={v.id} value={v.id}>
                {v.name}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            select
            label="Block"
            value={blockFilter}
            onChange={(e) => handleBlockFilterChange(e.target.value)}
            fullWidth
            sx={{ maxWidth: { md: 180 } }}
          >
            <MenuItem value={ALL_BLOCKS}>All blocks</MenuItem>
            {filterBlocks.map((b) => (
              <MenuItem key={b.id} value={b.id}>
                {b.name}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            select
            label="Status"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            fullWidth
            sx={{ maxWidth: { md: 170 } }}
          >
            <MenuItem value={ALL_STATUSES}>All statuses</MenuItem>
            {OPERATION_STATUSES.map((s) => (
              <MenuItem key={s.value} value={s.value}>
                {s.label}
              </MenuItem>
            ))}
          </TextField>
        </Stack>
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
            <Grid item xs={12} sm={6} lg={4} key={i}>
              <Paper sx={{ p: 2.5 }}>
                <Skeleton width="60%" height={28} />
                <Skeleton width="40%" height={20} sx={{ mt: 1 }} />
                <Skeleton width="80%" height={20} sx={{ mt: 2 }} />
              </Paper>
            </Grid>
          ))}
        </Grid>
      ) : noneAtAll ? (
        <EmptyOperations onAdd={openAdd} />
      ) : noMatches ? (
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
            No operations match your filters.
          </Typography>
        </Paper>
      ) : hasOperations && isDesktop ? (
        <OperationTable
          operations={filtered}
          onView={handleView}
          onEdit={openEdit}
          onDelete={setDeleteTarget}
        />
      ) : (
        <Grid container spacing={{ xs: 2, md: 3 }}>
          {filtered.map((o) => (
            <Grid item xs={12} sm={6} key={o.id}>
              <OperationCard
                operation={o}
                onView={handleView}
                onEdit={openEdit}
                onDelete={setDeleteTarget}
              />
            </Grid>
          ))}
        </Grid>
      )}

      {/* Add / Edit dialog */}
      <OperationForm
        open={formOpen}
        operation={editing}
        vineyardOptions={vineyardOptions}
        blockOptions={blockOptions}
        defaultVineyardId={editing ? '' : defaultFormVineyard}
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
        title="Delete Operation"
        message={
          deleteTarget
            ? `Are you sure you want to delete "${deleteTarget.title}"? This cannot be undone.`
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

function EmptyOperations({ onAdd }) {
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
        <HandymanOutlinedIcon sx={{ fontSize: '2rem' }} />
      </Box>
      <Typography variant="h4" component="p" sx={{ mb: 0.5 }}>
        No operations yet
      </Typography>
      <Typography
        variant="body2"
        sx={{ color: 'text.secondary', maxWidth: 440, mx: 'auto', mb: 3 }}
      >
        Add your first operation to start tracking the tasks carried out across
        your vineyards and blocks.
      </Typography>
      <Button
        variant="contained"
        color="primary"
        startIcon={<AddOutlinedIcon />}
        onClick={onAdd}
      >
        Add Operation
      </Button>
    </Paper>
  );
}

export default Operations;
