import { useEffect, useState, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Box,
  Paper,
  Typography,
  Chip,
  Button,
  Divider,
  Grid,
  Skeleton,
  Alert,
  Link,
  Snackbar,
} from '@mui/material';
import ArrowBackOutlinedIcon from '@mui/icons-material/ArrowBackOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined';
import TerrainOutlinedIcon from '@mui/icons-material/TerrainOutlined';
import HandymanOutlinedIcon from '@mui/icons-material/HandymanOutlined';
import WaterDropOutlinedIcon from '@mui/icons-material/WaterDropOutlined';
import SanitizerOutlinedIcon from '@mui/icons-material/SanitizerOutlined';
import PageContainer from '../layout/PageContainer';
import BlockForm from './BlockForm';
import ConfirmDialog from '../common/ConfirmDialog';
import {
  getBlock,
  updateBlock,
  deleteBlock,
  friendlyBlockError,
} from '../../services/blockService';

function formatHectares(value) {
  if (value == null) return '—';
  const n = Number(value) || 0;
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 1 })} ha`;
}

function formatDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function statusChipColor(status) {
  const s = (status || '').toLowerCase();
  if (s === 'active') return 'primary';
  if (s === 'archived' || s === 'dormant') return 'default';
  return 'secondary';
}

function DetailItem({ label, children }) {
  return (
    <Box>
      <Typography variant="overline" sx={{ display: 'block' }}>
        {label}
      </Typography>
      <Typography variant="subtitle1" sx={{ color: 'text.primary', fontWeight: 600 }}>
        {children}
      </Typography>
    </Box>
  );
}

/**
 * Block detail / profile page (route: /blocks/:id).
 * Loads a single block with its parent vineyard, supports edit and delete, and
 * links back to the parent Vineyard Profile.
 */
function BlockProfile() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [block, setBlock] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [editOpen, setEditOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [toast, setToast] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    const { data, error: err } = await getBlock(id);
    if (err) {
      setError(friendlyBlockError(err));
      setBlock(null);
    } else {
      setBlock(data);
    }
    setLoading(false);
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const handleEditSubmit = async (values) => {
    setSaving(true);
    const { data, error: err } = await updateBlock(id, values);
    setSaving(false);
    if (err) {
      setError(friendlyBlockError(err));
      return;
    }
    setBlock(data);
    setEditOpen(false);
    setToast('Block updated.');
  };

  const handleDelete = async () => {
    setDeleting(true);
    const { error: err } = await deleteBlock(id);
    setDeleting(false);
    setConfirmOpen(false);
    if (err) {
      setError(friendlyBlockError(err));
      return;
    }
    navigate('/blocks', { replace: true });
  };

  return (
    <PageContainer>
      {/* Back link */}
      <Link
        component="button"
        type="button"
        underline="hover"
        onClick={() => navigate('/blocks')}
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.5,
          color: 'text.secondary',
          mb: 2,
        }}
      >
        <ArrowBackOutlinedIcon sx={{ fontSize: '1.1rem' }} />
        Back to Blocks
      </Link>

      {loading ? (
        <Paper sx={{ p: { xs: 2.5, md: 4 } }}>
          <Skeleton width="40%" height={40} />
          <Skeleton width="25%" height={24} sx={{ mt: 1 }} />
          <Divider sx={{ my: 3 }} />
          <Skeleton width="80%" height={24} />
          <Skeleton width="60%" height={24} sx={{ mt: 1 }} />
        </Paper>
      ) : error && !block ? (
        <Alert severity="error">{error}</Alert>
      ) : block ? (
        <>
          {error && (
            <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
              {error}
            </Alert>
          )}

          <Paper sx={{ p: { xs: 2.5, md: 4 } }}>
            {/* Header */}
            <Box
              sx={{
                display: 'flex',
                flexDirection: { xs: 'column', sm: 'row' },
                alignItems: { xs: 'flex-start', sm: 'center' },
                justifyContent: 'space-between',
                gap: 2,
              }}
            >
              <Box sx={{ minWidth: 0 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
                  <Typography variant="h2" component="h1" sx={{ minWidth: 0 }}>
                    {block.name}
                  </Typography>
                  {block.status && (
                    <Chip
                      label={block.status}
                      color={statusChipColor(block.status)}
                      sx={{ textTransform: 'capitalize' }}
                    />
                  )}
                </Box>

                {/* Parent vineyard link */}
                {block.vineyardId && (
                  <Box
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 0.5,
                      mt: 1,
                      color: 'text.secondary',
                    }}
                  >
                    <TerrainOutlinedIcon sx={{ fontSize: '1.1rem' }} />
                    <Link
                      component="button"
                      type="button"
                      underline="hover"
                      onClick={() => navigate(`/vineyards/${block.vineyardId}`)}
                      sx={{ color: 'primary.main', fontWeight: 600 }}
                    >
                      {block.vineyardName || 'View vineyard'}
                    </Link>
                  </Box>
                )}
              </Box>

              <Box sx={{ display: 'flex', gap: 1, flexShrink: 0, flexWrap: 'wrap' }}>
                <Button
                  variant="contained"
                  color="primary"
                  startIcon={<HandymanOutlinedIcon />}
                  onClick={() => navigate(`/operations?block=${block.id}`)}
                >
                  View Operations
                </Button>
                <Button
                  variant="outlined"
                  color="primary"
                  startIcon={<WaterDropOutlinedIcon />}
                  onClick={() => navigate(`/irrigation?block=${block.id}`)}
                >
                  View Irrigation
                </Button>
                <Button
                  variant="outlined"
                  color="primary"
                  startIcon={<SanitizerOutlinedIcon />}
                  onClick={() => navigate(`/spray-programme?block=${block.id}`)}
                >
                  View Spray Programme
                </Button>
                <Button
                  variant="outlined"
                  color="primary"
                  startIcon={<EditOutlinedIcon />}
                  onClick={() => setEditOpen(true)}
                >
                  Edit
                </Button>
                <Button
                  variant="outlined"
                  color="secondary"
                  startIcon={<DeleteOutlineOutlinedIcon />}
                  onClick={() => setConfirmOpen(true)}
                >
                  Delete
                </Button>
              </Box>
            </Box>

            <Divider sx={{ my: 3 }} />

            {/* Details */}
            <Grid container spacing={3}>
              <Grid item xs={6} sm={3}>
                <DetailItem label="Vineyard">{block.vineyardName || '—'}</DetailItem>
              </Grid>
              <Grid item xs={6} sm={3}>
                <DetailItem label="Area">{formatHectares(block.areaHectares)}</DetailItem>
              </Grid>
              <Grid item xs={6} sm={3}>
                <DetailItem label="Created">{formatDate(block.createdAt)}</DetailItem>
              </Grid>
              <Grid item xs={6} sm={3}>
                <DetailItem label="Last Updated">{formatDate(block.updatedAt)}</DetailItem>
              </Grid>
            </Grid>
          </Paper>
        </>
      ) : null}

      {/* Edit dialog */}
      <BlockForm
        open={editOpen}
        block={block}
        saving={saving}
        onSubmit={handleEditSubmit}
        onClose={() => setEditOpen(false)}
      />

      {/* Delete confirmation */}
      <ConfirmDialog
        open={confirmOpen}
        title="Delete Block"
        message={
          block
            ? `Are you sure you want to delete "${block.name}"? This cannot be undone.`
            : ''
        }
        confirmLabel="Delete"
        confirmColor="error"
        loading={deleting}
        onConfirm={handleDelete}
        onClose={() => setConfirmOpen(false)}
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

export default BlockProfile;
