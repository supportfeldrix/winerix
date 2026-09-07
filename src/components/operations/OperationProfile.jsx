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
import PageContainer from '../layout/PageContainer';
import OperationForm from './OperationForm';
import ConfirmDialog from '../common/ConfirmDialog';
import {
  getOperation,
  updateOperation,
  deleteOperation,
  friendlyOperationError,
} from '../../services/operationsService';

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
  if (s === 'planned') return 'secondary';
  return 'default';
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
 * Operation detail / profile page (route: /operations/:id).
 * Loads a single operation with its vineyard and (optional) block, supports
 * edit and delete, and links to the parent vineyard / block.
 */
function OperationProfile() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [operation, setOperation] = useState(null);
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
    const { data, error: err } = await getOperation(id);
    if (err) {
      setError(friendlyOperationError(err));
      setOperation(null);
    } else {
      setOperation(data);
    }
    setLoading(false);
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const handleEditSubmit = async (values) => {
    setSaving(true);
    const { data, error: err } = await updateOperation(id, values);
    setSaving(false);
    if (err) {
      setError(friendlyOperationError(err));
      return;
    }
    setOperation(data);
    setEditOpen(false);
    setToast('Operation updated.');
  };

  const handleDelete = async () => {
    setDeleting(true);
    const { error: err } = await deleteOperation(id);
    setDeleting(false);
    setConfirmOpen(false);
    if (err) {
      setError(friendlyOperationError(err));
      return;
    }
    navigate('/operations', { replace: true });
  };

  return (
    <PageContainer>
      {/* Back link */}
      <Link
        component="button"
        type="button"
        underline="hover"
        onClick={() => navigate('/operations')}
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.5,
          color: 'text.secondary',
          mb: 2,
        }}
      >
        <ArrowBackOutlinedIcon sx={{ fontSize: '1.1rem' }} />
        Back to Operations
      </Link>

      {loading ? (
        <Paper sx={{ p: { xs: 2.5, md: 4 } }}>
          <Skeleton width="40%" height={40} />
          <Skeleton width="25%" height={24} sx={{ mt: 1 }} />
          <Divider sx={{ my: 3 }} />
          <Skeleton width="80%" height={24} />
          <Skeleton width="60%" height={24} sx={{ mt: 1 }} />
        </Paper>
      ) : error && !operation ? (
        <Alert severity="error">{error}</Alert>
      ) : operation ? (
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
                    {operation.title}
                  </Typography>
                  {operation.status && (
                    <Chip
                      label={operation.status}
                      color={statusChipColor(operation.status)}
                      sx={{ textTransform: 'capitalize' }}
                    />
                  )}
                </Box>

                {/* Parent vineyard link */}
                {operation.vineyardId && (
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
                      onClick={() => navigate(`/vineyards/${operation.vineyardId}`)}
                      sx={{ color: 'primary.main', fontWeight: 600 }}
                    >
                      {operation.vineyardName || 'View vineyard'}
                    </Link>
                  </Box>
                )}
              </Box>

              <Box sx={{ display: 'flex', gap: 1, flexShrink: 0 }}>
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
                <DetailItem label="Vineyard">
                  {operation.vineyardName || '—'}
                </DetailItem>
              </Grid>
              <Grid item xs={6} sm={3}>
                <DetailItem label="Block">
                  {operation.blockId ? (
                    <Link
                      component="button"
                      type="button"
                      underline="hover"
                      onClick={() => navigate(`/blocks/${operation.blockId}`)}
                      sx={{ color: 'primary.main', fontWeight: 600 }}
                    >
                      {operation.blockName || 'View block'}
                    </Link>
                  ) : (
                    '—'
                  )}
                </DetailItem>
              </Grid>
              <Grid item xs={6} sm={3}>
                <DetailItem label="Created">{formatDate(operation.createdAt)}</DetailItem>
              </Grid>
              <Grid item xs={6} sm={3}>
                <DetailItem label="Last Updated">{formatDate(operation.updatedAt)}</DetailItem>
              </Grid>
            </Grid>
          </Paper>
        </>
      ) : null}

      {/* Edit dialog */}
      <OperationForm
        open={editOpen}
        operation={operation}
        saving={saving}
        onSubmit={handleEditSubmit}
        onClose={() => setEditOpen(false)}
      />

      {/* Delete confirmation */}
      <ConfirmDialog
        open={confirmOpen}
        title="Delete Operation"
        message={
          operation
            ? `Are you sure you want to delete "${operation.title}"? This cannot be undone.`
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

export default OperationProfile;
