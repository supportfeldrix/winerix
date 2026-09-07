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
import GridViewOutlinedIcon from '@mui/icons-material/GridViewOutlined';
import PageContainer from '../components/layout/PageContainer';
import BlockCard from '../components/blocks/BlockCard';
import BlockTable from '../components/blocks/BlockTable';
import BlockForm from '../components/blocks/BlockForm';
import ConfirmDialog from '../components/common/ConfirmDialog';
import {
  getBlocks,
  createBlock,
  updateBlock,
  deleteBlock,
  getVineyardOptions,
  friendlyBlockError,
  BLOCK_STATUSES,
} from '../services/blockService';

const ALL_VINEYARDS = 'all';
const ALL_STATUSES = 'all';

function Blocks() {
  const navigate = useNavigate();
  const theme = useTheme();
  const isDesktop = useMediaQuery(theme.breakpoints.up('md'));
  const [searchParams, setSearchParams] = useSearchParams();

  const [blocks, setBlocks] = useState([]);
  const [vineyardOptions, setVineyardOptions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [search, setSearch] = useState('');
  // Pre-filter by vineyard when arriving via /blocks?vineyard=<id>.
  const [vineyardFilter, setVineyardFilter] = useState(
    searchParams.get('vineyard') || ALL_VINEYARDS
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
    const [blocksRes, vineyardsRes] = await Promise.all([
      getBlocks(),
      getVineyardOptions(),
    ]);

    // Vineyard options (for filter + form). Ignore missing-table here; the
    // blocks result drives the primary state.
    if (!vineyardsRes.error) {
      setVineyardOptions(vineyardsRes.data || []);
    }

    if (blocksRes.error) {
      const friendly = friendlyBlockError(blocksRes.error);
      const isMissingTable = /not set up yet/i.test(friendly);
      if (isMissingTable) {
        setBlocks([]);
      } else {
        setError(friendly);
      }
    } else {
      setBlocks(blocksRes.data || []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Sync the vineyard filter when the ?vineyard= URL param changes (e.g. when
  // arriving from a vineyard's "View Blocks" action while already mounted).
  useEffect(() => {
    const param = searchParams.get('vineyard') || ALL_VINEYARDS;
    setVineyardFilter((prev) => (prev === param ? prev : param));
  }, [searchParams]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return blocks.filter((b) => {
      const matchesVineyard =
        vineyardFilter === ALL_VINEYARDS || b.vineyardId === vineyardFilter;
      const matchesStatus =
        statusFilter === ALL_STATUSES ||
        (b.status || '').toLowerCase() === statusFilter;
      const matchesSearch = !q || (b.name || '').toLowerCase().includes(q);
      return matchesVineyard && matchesStatus && matchesSearch;
    });
  }, [blocks, search, vineyardFilter, statusFilter]);

  // Keep the vineyard filter reflected in the URL so the view is shareable and
  // the "View Blocks" deep-link stays in sync.
  const handleVineyardFilterChange = (value) => {
    setVineyardFilter(value);
    const next = new URLSearchParams(searchParams);
    if (value === ALL_VINEYARDS) {
      next.delete('vineyard');
    } else {
      next.set('vineyard', value);
    }
    setSearchParams(next, { replace: true });
  };

  // ── Handlers ──────────────────────────────────────────────────────────────
  const openAdd = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const openEdit = (block) => {
    setEditing(block);
    setFormOpen(true);
  };

  const handleView = (block) => navigate(`/blocks/${block.id}`);

  const handleSubmit = async (values) => {
    setSaving(true);
    const isEdit = Boolean(editing);
    const { error: err } = isEdit
      ? await updateBlock(editing.id, values)
      : await createBlock(values);
    setSaving(false);

    if (err) {
      setError(friendlyBlockError(err));
      return;
    }

    setFormOpen(false);
    setEditing(null);
    setToast(isEdit ? 'Block updated.' : 'Block added.');
    await load();
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    const { error: err } = await deleteBlock(deleteTarget.id);
    setDeleting(false);
    setDeleteTarget(null);

    if (err) {
      setError(friendlyBlockError(err));
      return;
    }
    setToast('Block deleted.');
    await load();
  };

  // ── Render helpers ──────────────────────────────────────────────────────────
  const hasBlocks = filtered.length > 0;
  const noneAtAll = !loading && blocks.length === 0;
  const noMatches = !loading && blocks.length > 0 && filtered.length === 0;

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
            Blocks
          </Typography>
          <Typography variant="body1" sx={{ color: 'text.secondary' }}>
            Manage the blocks within your vineyards, their area and status.
          </Typography>
        </Box>
        <Button
          variant="contained"
          color="primary"
          startIcon={<AddOutlinedIcon />}
          onClick={openAdd}
          sx={{ flexShrink: 0 }}
        >
          Add Block
        </Button>
      </Box>

      {/* Search + vineyard filter */}
      {!noneAtAll && (
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={2}
          sx={{ my: 3, maxWidth: { sm: 820 } }}
        >
          <TextField
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by block name"
            fullWidth
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
            sx={{ minWidth: { sm: 200 } }}
            fullWidth
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
            label="Status"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            sx={{ minWidth: { sm: 170 } }}
            fullWidth
          >
            <MenuItem value={ALL_STATUSES}>All statuses</MenuItem>
            {BLOCK_STATUSES.map((s) => (
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
        <EmptyBlocks onAdd={openAdd} />
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
            No blocks match your filters.
          </Typography>
        </Paper>
      ) : hasBlocks && isDesktop ? (
        <BlockTable
          blocks={filtered}
          onView={handleView}
          onEdit={openEdit}
          onDelete={setDeleteTarget}
        />
      ) : (
        <Grid container spacing={{ xs: 2, md: 3 }}>
          {filtered.map((b) => (
            <Grid item xs={12} sm={6} key={b.id}>
              <BlockCard
                block={b}
                onView={handleView}
                onEdit={openEdit}
                onDelete={setDeleteTarget}
              />
            </Grid>
          ))}
        </Grid>
      )}

      {/* Add / Edit dialog */}
      <BlockForm
        open={formOpen}
        block={editing}
        vineyardOptions={vineyardOptions}
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
        title="Delete Block"
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

function EmptyBlocks({ onAdd }) {
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
        <GridViewOutlinedIcon sx={{ fontSize: '2rem' }} />
      </Box>
      <Typography variant="h4" component="p" sx={{ mb: 0.5 }}>
        No blocks yet
      </Typography>
      <Typography
        variant="body2"
        sx={{ color: 'text.secondary', maxWidth: 420, mx: 'auto', mb: 3 }}
      >
        Add your first block to start organising your vineyard into manageable
        parcels.
      </Typography>
      <Button
        variant="contained"
        color="primary"
        startIcon={<AddOutlinedIcon />}
        onClick={onAdd}
      >
        Add Block
      </Button>
    </Paper>
  );
}

export default Blocks;
