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
import LocationOnOutlinedIcon from '@mui/icons-material/LocationOnOutlined';
import GridViewOutlinedIcon from '@mui/icons-material/GridViewOutlined';
import HandymanOutlinedIcon from '@mui/icons-material/HandymanOutlined';
import WaterDropOutlinedIcon from '@mui/icons-material/WaterDropOutlined';
import SanitizerOutlinedIcon from '@mui/icons-material/SanitizerOutlined';
import PageContainer from '../layout/PageContainer';
import VineyardForm from './VineyardForm';
import ConfirmDialog from '../common/ConfirmDialog';
import {
  getVineyard,
  updateVineyard,
  deleteVineyard,
  friendlyVineyardError,
} from '../../services/vineyardService';

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
 * Vineyard detail / profile page (route: /vineyards/:id).
 * Loads a single vineyard, supports edit and delete, with loading and error
 * states. Blocks are shown as a read-only count only (Blocks module not built).
 */
function VineyardProfile() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [vineyard, setVineyard] = useState(null);
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
    const { data, error: err } = await getVineyard(id);
    if (err) {
      setError(friendlyVineyardError(err));
      setVineyard(null);
    } else {
      setVineyard(data);
    }
    setLoading(false);
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const handleEditSubmit = async (values) => {
    setSaving(true);
    const { data, error: err } = await updateVineyard(id, values);
    setSaving(false);
    if (err) {
      setError(friendlyVineyardError(err));
      return;
    }
    setVineyard(data);
    setEditOpen(false);
    setToast('Vineyard updated.');
  };

  const handleDelete = async () => {
    setDeleting(true);
    const { error: err } = await deleteVineyard(id);
    setDeleting(false);
    setConfirmOpen(false);
    if (err) {
      setError(friendlyVineyardError(err));
      return;
    }
    navigate('/vineyards', { replace: true });
  };

  return (
    <PageContainer>
      {/* Back link */}
      <Link
        component="button"
        type="button"
        underline="hover"
        onClick={() => navigate('/vineyards')}
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.5,
          color: 'text.secondary',
          mb: 2,
        }}
      >
        <ArrowBackOutlinedIcon sx={{ fontSize: '1.1rem' }} />
        Back to Vineyards
      </Link>

      {loading ? (
        <Paper sx={{ p: { xs: 2.5, md: 4 } }}>
          <Skeleton width="40%" height={40} />
          <Skeleton width="25%" height={24} sx={{ mt: 1 }} />
          <Divider sx={{ my: 3 }} />
          <Skeleton width="80%" height={24} />
          <Skeleton width="60%" height={24} sx={{ mt: 1 }} />
        </Paper>
      ) : error && !vineyard ? (
        <Alert severity="error">{error}</Alert>
      ) : vineyard ? (
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
                    {vineyard.name}
                  </Typography>
                  {vineyard.status && (
                    <Chip
                      label={vineyard.status}
                      color={statusChipColor(vineyard.status)}
                      sx={{ textTransform: 'capitalize' }}
                    />
                  )}
                </Box>
                {vineyard.location && (
                  <Box
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 0.5,
                      mt: 1,
                      color: 'text.secondary',
                    }}
                  >
                    <LocationOnOutlinedIcon sx={{ fontSize: '1.1rem' }} />
                    <Typography variant="body1">{vineyard.location}</Typography>
                  </Box>
                )}
              </Box>

              <Box sx={{ display: 'flex', gap: 1, flexShrink: 0, flexWrap: 'wrap' }}>
                <Button
                  variant="contained"
                  color="primary"
                  startIcon={<GridViewOutlinedIcon />}
                  onClick={() => navigate(`/blocks?vineyard=${vineyard.id}`)}
                >
                  View Blocks
                </Button>
                <Button
                  variant="outlined"
                  color="primary"
                  startIcon={<HandymanOutlinedIcon />}
                  onClick={() => navigate(`/operations?vineyard=${vineyard.id}`)}
                >
                  View Operations
                </Button>
                <Button
                  variant="outlined"
                  color="primary"
                  startIcon={<WaterDropOutlinedIcon />}
                  onClick={() => navigate(`/irrigation?vineyard=${vineyard.id}`)}
                >
                  View Irrigation
                </Button>
                <Button
                  variant="outlined"
                  color="primary"
                  startIcon={<SanitizerOutlinedIcon />}
                  onClick={() => navigate(`/spray-programme?vineyard=${vineyard.id}`)}
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
                <DetailItem label="Area">{formatHectares(vineyard.areaHectares)}</DetailItem>
              </Grid>
              <Grid item xs={6} sm={3}>
                <DetailItem label="Blocks">
                  {vineyard.blockCount != null ? vineyard.blockCount : '—'}
                </DetailItem>
              </Grid>
              <Grid item xs={6} sm={3}>
                <DetailItem label="Created">{formatDate(vineyard.createdAt)}</DetailItem>
              </Grid>
              <Grid item xs={6} sm={3}>
                <DetailItem label="Last Updated">{formatDate(vineyard.updatedAt)}</DetailItem>
              </Grid>
            </Grid>
          </Paper>
        </>
      ) : null}

      {/* Edit dialog */}
      <VineyardForm
        open={editOpen}
        vineyard={vineyard}
        saving={saving}
        onSubmit={handleEditSubmit}
        onClose={() => setEditOpen(false)}
      />

      {/* Delete confirmation */}
      <ConfirmDialog
        open={confirmOpen}
        title="Delete Vineyard"
        message={
          vineyard
            ? `Are you sure you want to delete "${vineyard.name}"? This cannot be undone.`
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

export default VineyardProfile;
