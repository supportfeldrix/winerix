import { useEffect, useState, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Box, Paper, Typography, Chip, Button, Divider, Grid, Skeleton, Alert, Link, Snackbar,
} from '@mui/material';
import ArrowBackOutlinedIcon from '@mui/icons-material/ArrowBackOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined';
import PageContainer from '../layout/PageContainer';
import PlannerForm from './PlannerForm';
import ConfirmDialog from '../common/ConfirmDialog';
import { formatDate, activityStatusColor } from '../common/formatters';
import {
  getPlannerTask, updatePlannerTask, deletePlannerTask, friendlyPlannerError,
} from '../../services/plannerService';

function DetailItem({ label, children }) {
  return (
    <Box>
      <Typography variant="overline" sx={{ display: 'block' }}>{label}</Typography>
      <Typography variant="subtitle1" sx={{ color: 'text.primary', fontWeight: 600 }}>{children}</Typography>
    </Box>
  );
}

function PlannerProfile() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [record, setRecord] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editOpen, setEditOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [toast, setToast] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    const { data, error: err } = await getPlannerTask(id);
    if (err) { setError(friendlyPlannerError(err)); setRecord(null); } else setRecord(data);
    setLoading(false);
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const handleEditSubmit = async (values) => {
    setSaving(true);
    const { data, error: err } = await updatePlannerTask(id, values);
    setSaving(false);
    if (err) { setError(friendlyPlannerError(err)); return; }
    setRecord(data); setEditOpen(false); setToast('Task updated.');
  };

  const handleDelete = async () => {
    setDeleting(true);
    const { error: err } = await deletePlannerTask(id);
    setDeleting(false); setConfirmOpen(false);
    if (err) { setError(friendlyPlannerError(err)); return; }
    navigate('/planner', { replace: true });
  };

  return (
    <PageContainer>
      <Link component="button" type="button" underline="hover" onClick={() => navigate('/planner')}
        sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, color: 'text.secondary', mb: 2 }}>
        <ArrowBackOutlinedIcon sx={{ fontSize: '1.1rem' }} /> Back to Planner
      </Link>

      {loading ? (
        <Paper sx={{ p: { xs: 2.5, md: 4 } }}><Skeleton width="40%" height={40} /><Divider sx={{ my: 3 }} /><Skeleton width="80%" height={24} /></Paper>
      ) : error && !record ? (
        <Alert severity="error">{error}</Alert>
      ) : record ? (
        <>
          {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}
          <Paper sx={{ p: { xs: 2.5, md: 4 } }}>
            <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, alignItems: { xs: 'flex-start', sm: 'center' }, justifyContent: 'space-between', gap: 2 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap', minWidth: 0 }}>
                <Typography variant="h2" component="h1" sx={{ minWidth: 0 }}>{record.title}</Typography>
                {record.status && <Chip label={record.status.replace(/_/g, ' ')} color={activityStatusColor(record.status)} sx={{ textTransform: 'capitalize' }} />}
              </Box>
              <Box sx={{ display: 'flex', gap: 1, flexShrink: 0 }}>
                <Button variant="outlined" color="primary" startIcon={<EditOutlinedIcon />} onClick={() => setEditOpen(true)}>Edit</Button>
                <Button variant="outlined" color="secondary" startIcon={<DeleteOutlineOutlinedIcon />} onClick={() => setConfirmOpen(true)}>Delete</Button>
              </Box>
            </Box>
            <Divider sx={{ my: 3 }} />
            <Grid container spacing={3}>
              <Grid item xs={6} sm={3}><DetailItem label="Due Date">{formatDate(record.dueDate)}</DetailItem></Grid>
              <Grid item xs={6} sm={3}>
                <DetailItem label="Vineyard">
                  {record.vineyardId ? (
                    <Link component="button" type="button" underline="hover" onClick={() => navigate(`/vineyards/${record.vineyardId}`)} sx={{ color: 'primary.main', fontWeight: 600 }}>
                      {record.vineyardName || 'View vineyard'}
                    </Link>
                  ) : '—'}
                </DetailItem>
              </Grid>
              <Grid item xs={6} sm={3}><DetailItem label="Block">{record.blockName || '—'}</DetailItem></Grid>
              <Grid item xs={6} sm={3}><DetailItem label="Created">{formatDate(record.createdAt)}</DetailItem></Grid>
              <Grid item xs={6} sm={3}><DetailItem label="Last Updated">{formatDate(record.updatedAt)}</DetailItem></Grid>
            </Grid>
          </Paper>
        </>
      ) : null}

      <PlannerForm open={editOpen} record={record} saving={saving} onSubmit={handleEditSubmit} onClose={() => setEditOpen(false)} />
      <ConfirmDialog open={confirmOpen} title="Delete Task"
        message={record ? `Are you sure you want to delete "${record.title}"? This cannot be undone.` : ''}
        confirmLabel="Delete" confirmColor="error" loading={deleting} onConfirm={handleDelete} onClose={() => setConfirmOpen(false)} />
      <Snackbar open={Boolean(toast)} autoHideDuration={4000} onClose={() => setToast('')} message={toast} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }} />
    </PageContainer>
  );
}

export default PlannerProfile;
