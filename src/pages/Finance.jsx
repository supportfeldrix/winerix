import { useEffect, useMemo, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Typography, Button, TextField, InputAdornment, MenuItem, Grid, Card, CardContent,
  Paper, Skeleton, Alert, Snackbar, Stack, useMediaQuery,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import AddOutlinedIcon from '@mui/icons-material/AddOutlined';
import SearchOutlinedIcon from '@mui/icons-material/SearchOutlined';
import PaymentsOutlinedIcon from '@mui/icons-material/PaymentsOutlined';
import TrendingUpOutlinedIcon from '@mui/icons-material/TrendingUpOutlined';
import TrendingDownOutlinedIcon from '@mui/icons-material/TrendingDownOutlined';
import AccountBalanceOutlinedIcon from '@mui/icons-material/AccountBalanceOutlined';
import PageContainer from '../components/layout/PageContainer';
import FinanceCard from '../components/finance/FinanceCard';
import FinanceTable from '../components/finance/FinanceTable';
import FinanceForm from '../components/finance/FinanceForm';
import ConfirmDialog from '../components/common/ConfirmDialog';
import { formatCurrency } from '../components/common/formatters';
import {
  getFinanceRecords, createFinanceRecord, updateFinanceRecord, deleteFinanceRecord,
  getVineyardOptions, getBlockOptions, friendlyFinanceError, computeTotals,
  FINANCE_TYPES, FINANCE_CATEGORIES,
} from '../services/financeService';

const ALL_TYPES = 'all';
const ALL_CATEGORIES = 'all';

function SummaryCard({ label, value, icon: Icon, color }) {
  return (
    <Card sx={{ height: '100%' }}>
      <CardContent sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <Box sx={{ width: 48, height: 48, borderRadius: 2, display: 'flex', alignItems: 'center', justifyContent: 'center', bgcolor: 'background.subtle', color, flexShrink: 0 }}>
          <Icon />
        </Box>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="overline" sx={{ display: 'block' }}>{label}</Typography>
          <Typography variant="h5" component="p" sx={{ lineHeight: 1.2, color, fontWeight: 700 }}>{value}</Typography>
        </Box>
      </CardContent>
    </Card>
  );
}

function Finance() {
  const navigate = useNavigate();
  const theme = useTheme();
  const isDesktop = useMediaQuery(theme.breakpoints.up('md'));

  const [records, setRecords] = useState([]);
  const [vineyardOptions, setVineyardOptions] = useState([]);
  const [blockOptions, setBlockOptions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState(ALL_TYPES);
  const [categoryFilter, setCategoryFilter] = useState(ALL_CATEGORIES);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [toast, setToast] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    const [recRes, vRes, bRes] = await Promise.all([getFinanceRecords(), getVineyardOptions(), getBlockOptions()]);
    if (!vRes.error) setVineyardOptions(vRes.data || []);
    if (!bRes.error) setBlockOptions(bRes.data || []);
    if (recRes.error) {
      const friendly = friendlyFinanceError(recRes.error);
      if (/not set up yet/i.test(friendly)) setRecords([]); else setError(friendly);
    } else setRecords(recRes.data || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return records.filter((r) => {
      const mt = typeFilter === ALL_TYPES || (r.type || '').toLowerCase() === typeFilter;
      const mc = categoryFilter === ALL_CATEGORIES || (r.category || '') === categoryFilter;
      const mq = !q || (r.title || '').toLowerCase().includes(q);
      return mt && mc && mq;
    });
  }, [records, search, typeFilter, categoryFilter]);

  // Totals reflect the current filtered view so summary + list stay in sync.
  const totals = useMemo(() => computeTotals(filtered), [filtered]);

  const openAdd = () => { setEditing(null); setFormOpen(true); };
  const openEdit = (r) => { setEditing(r); setFormOpen(true); };
  const handleView = (r) => navigate(`/finance/${r.id}`);

  const handleSubmit = async (values) => {
    setSaving(true);
    const isEdit = Boolean(editing);
    const { error: err } = isEdit ? await updateFinanceRecord(editing.id, values) : await createFinanceRecord(values);
    setSaving(false);
    if (err) { setError(friendlyFinanceError(err)); return; }
    setFormOpen(false); setEditing(null); setToast(isEdit ? 'Record updated.' : 'Record added.'); await load();
  };
  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    const { error: err } = await deleteFinanceRecord(deleteTarget.id);
    setDeleting(false); setDeleteTarget(null);
    if (err) { setError(friendlyFinanceError(err)); return; }
    setToast('Record deleted.'); await load();
  };

  const noneAtAll = !loading && records.length === 0;
  const noMatches = !loading && records.length > 0 && filtered.length === 0;

  return (
    <PageContainer>
      <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, alignItems: { xs: 'stretch', sm: 'center' }, justifyContent: 'space-between', gap: 2, mb: 1 }}>
        <Box>
          <Typography variant="h2" component="h1" sx={{ mb: 0.5 }}>Finance</Typography>
          <Typography variant="body1" sx={{ color: 'text.secondary' }}>Track income and expenses across your operation.</Typography>
        </Box>
        <Button variant="contained" color="primary" startIcon={<AddOutlinedIcon />} onClick={openAdd} sx={{ flexShrink: 0 }}>Add Record</Button>
      </Box>

      {/* Summary cards */}
      <Grid container spacing={{ xs: 2, md: 3 }} sx={{ mt: 1, mb: 1 }}>
        <Grid item xs={12} sm={4}>
          {loading ? <Card><CardContent><Skeleton height={56} /></CardContent></Card> : <SummaryCard label="Income" value={formatCurrency(totals.income)} icon={TrendingUpOutlinedIcon} color="success.main" />}
        </Grid>
        <Grid item xs={12} sm={4}>
          {loading ? <Card><CardContent><Skeleton height={56} /></CardContent></Card> : <SummaryCard label="Expenses" value={formatCurrency(totals.expense)} icon={TrendingDownOutlinedIcon} color="secondary.main" />}
        </Grid>
        <Grid item xs={12} sm={4}>
          {loading ? <Card><CardContent><Skeleton height={56} /></CardContent></Card> : <SummaryCard label="Net" value={formatCurrency(totals.net)} icon={AccountBalanceOutlinedIcon} color={totals.net >= 0 ? 'success.main' : 'error.main'} />}
        </Grid>
      </Grid>

      {!noneAtAll && (
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ my: 3 }}>
          <TextField value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by title" fullWidth sx={{ maxWidth: { md: 320 } }}
            InputProps={{ startAdornment: <InputAdornment position="start"><SearchOutlinedIcon fontSize="small" /></InputAdornment> }} />
          <TextField select label="Type" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} fullWidth sx={{ maxWidth: { md: 170 } }}>
            <MenuItem value={ALL_TYPES}>All types</MenuItem>
            {FINANCE_TYPES.map((t) => <MenuItem key={t.value} value={t.value}>{t.label}</MenuItem>)}
          </TextField>
          <TextField select label="Category" value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} fullWidth sx={{ maxWidth: { md: 190 } }}>
            <MenuItem value={ALL_CATEGORIES}>All categories</MenuItem>
            {FINANCE_CATEGORIES.map((c) => <MenuItem key={c.value} value={c.value}>{c.label}</MenuItem>)}
          </TextField>
        </Stack>
      )}

      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}

      {loading ? (
        <Grid container spacing={{ xs: 2, md: 3 }}>
          {[0, 1, 2].map((i) => <Grid item xs={12} sm={6} lg={4} key={i}><Paper sx={{ p: 2.5 }}><Skeleton width="60%" height={28} /><Skeleton width="40%" height={20} sx={{ mt: 1 }} /><Skeleton width="80%" height={20} sx={{ mt: 2 }} /></Paper></Grid>)}
        </Grid>
      ) : noneAtAll ? (
        <EmptyFinance onAdd={openAdd} />
      ) : noMatches ? (
        <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', p: 4, textAlign: 'center' }}>
          <Typography variant="body1" sx={{ color: 'text.secondary' }}>No records match your filters.</Typography>
        </Paper>
      ) : isDesktop ? (
        <FinanceTable records={filtered} onView={handleView} onEdit={openEdit} onDelete={setDeleteTarget} />
      ) : (
        <Grid container spacing={{ xs: 2, md: 3 }}>
          {filtered.map((r) => <Grid item xs={12} sm={6} key={r.id}><FinanceCard record={r} onView={handleView} onEdit={openEdit} onDelete={setDeleteTarget} /></Grid>)}
        </Grid>
      )}

      <FinanceForm open={formOpen} record={editing} vineyardOptions={vineyardOptions} blockOptions={blockOptions} saving={saving} onSubmit={handleSubmit}
        onClose={() => { setFormOpen(false); setEditing(null); }} />
      <ConfirmDialog open={Boolean(deleteTarget)} title="Delete Financial Record"
        message={deleteTarget ? `Are you sure you want to delete "${deleteTarget.title}"? This cannot be undone.` : ''}
        confirmLabel="Delete" confirmColor="error" loading={deleting} onConfirm={handleDelete} onClose={() => setDeleteTarget(null)} />
      <Snackbar open={Boolean(toast)} autoHideDuration={4000} onClose={() => setToast('')} message={toast} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }} />
    </PageContainer>
  );
}

function EmptyFinance({ onAdd }) {
  return (
    <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', px: 3, py: { xs: 5, md: 7 }, textAlign: 'center', mt: 3 }}>
      <Box sx={{ width: 64, height: 64, borderRadius: '50%', bgcolor: 'background.paper', display: 'flex', alignItems: 'center', justifyContent: 'center', mx: 'auto', mb: 2, color: 'primary.main' }}>
        <PaymentsOutlinedIcon sx={{ fontSize: '2rem' }} />
      </Box>
      <Typography variant="h4" component="p" sx={{ mb: 0.5 }}>No financial records yet</Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary', maxWidth: 440, mx: 'auto', mb: 3 }}>Add your first income or expense record to start tracking your farm finances.</Typography>
      <Button variant="contained" color="primary" startIcon={<AddOutlinedIcon />} onClick={onAdd}>Add Record</Button>
    </Paper>
  );
}

export default Finance;
