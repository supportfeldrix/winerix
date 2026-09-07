import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Grid, Card, CardContent, CardActionArea, Typography, Paper, Chip, Button,
  Skeleton, Alert, Divider, Stack, List, ListItem, ListItemText,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import TerrainOutlinedIcon from '@mui/icons-material/TerrainOutlined';
import GridViewOutlinedIcon from '@mui/icons-material/GridViewOutlined';
import SquareFootOutlinedIcon from '@mui/icons-material/SquareFootOutlined';
import HandymanOutlinedIcon from '@mui/icons-material/HandymanOutlined';
import AgricultureOutlinedIcon from '@mui/icons-material/AgricultureOutlined';
import PaymentsOutlinedIcon from '@mui/icons-material/PaymentsOutlined';
import EventNoteOutlinedIcon from '@mui/icons-material/EventNoteOutlined';
import PrecisionManufacturingOutlinedIcon from '@mui/icons-material/PrecisionManufacturingOutlined';
import LocationOnOutlinedIcon from '@mui/icons-material/LocationOnOutlined';
import AddOutlinedIcon from '@mui/icons-material/AddOutlined';
import AutoAwesomeOutlinedIcon from '@mui/icons-material/AutoAwesomeOutlined';
import ArrowForwardOutlinedIcon from '@mui/icons-material/ArrowForwardOutlined';
import WaterDropOutlinedIcon from '@mui/icons-material/WaterDropOutlined';
import SanitizerOutlinedIcon from '@mui/icons-material/SanitizerOutlined';
import PageContainer from '../components/layout/PageContainer';
import StatCard from '../components/dashboard/StatCard';
import ProportionBar from '../components/dashboard/ProportionBar';
import PriorityList from '../components/dashboard/PriorityList';
import WeatherCard from '../components/dashboard/WeatherCard';
import { formatNumber, formatCurrency, formatDate } from '../components/common/formatters';
import { getCurrentUser } from '../services/authService';
import { getVineyards, getDashboardSummary } from '../services/vineyardService';
import { getReportSnapshot } from '../services/reportsService';
import vineyardBg from '../assets/images/Background_farm.png';

const MISSING_TABLE_CODES = ['42P01', 'PGRST205'];
function isMissingTableError(error) {
  if (!error) return false;
  if (MISSING_TABLE_CODES.includes(error.code)) return true;
  const msg = (error.message || '').toLowerCase();
  return msg.includes('does not exist') || msg.includes('could not find the table');
}

function greetingForNow(date = new Date()) {
  const hour = date.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

const QUICK_ACTIONS = [
  { label: 'Add Vineyard', path: '/vineyards', icon: TerrainOutlinedIcon },
  { label: 'Record Harvest', path: '/harvest', icon: AgricultureOutlinedIcon },
  { label: 'Create Operation', path: '/operations', icon: HandymanOutlinedIcon },
  { label: 'Plan Activity', path: '/planner', icon: EventNoteOutlinedIcon },
  { label: 'Add Finance Entry', path: '/finance', icon: PaymentsOutlinedIcon },
];

function statusChipColor(status) {
  const s = (status || '').toLowerCase();
  if (['active', 'healthy'].includes(s)) return 'primary';
  if (['inactive', 'dormant', 'archived'].includes(s)) return 'default';
  return 'secondary';
}

// Reusable section heading
function SectionHeading({ title, action, onAction }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', mb: 2, gap: 2 }}>
      <Typography variant="h4" component="h2">{title}</Typography>
      {action && (
        <Button size="small" endIcon={<ArrowForwardOutlinedIcon />} onClick={onAction}>{action}</Button>
      )}
    </Box>
  );
}

function Dashboard() {
  const navigate = useNavigate();

  const [userName, setUserName] = useState('');
  const [summary, setSummary] = useState(null);
  const [vineyards, setVineyards] = useState([]);
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      setError(false);

      const { data: userData } = await getCurrentUser();
      const user = userData?.user ?? null;
      const name =
        user?.user_metadata?.full_name?.trim() ||
        (user?.email ? user.email.split('@')[0] : '');

      const [summaryRes, vineyardsRes, snapshotRes] = await Promise.all([
        getDashboardSummary(),
        getVineyards(),
        getReportSnapshot(),
      ]);

      if (!active) return;

      setUserName(name);
      setSnapshot(snapshotRes.data || null);

      const missing =
        isMissingTableError(summaryRes.error) || isMissingTableError(vineyardsRes.error);
      if ((summaryRes.error || vineyardsRes.error) && !missing) {
        setError(true);
        setLoading(false);
        return;
      }

      setSummary(summaryRes.data || { totalVineyards: 0, totalBlocks: 0, totalHectares: 0, activeOperations: 0 });
      setVineyards(vineyardsRes.data || []);
      setLoading(false);
    }
    load();
    return () => { active = false; };
  }, []);

  const s = snapshot;

  // Metric cards — real data only; the two headline metrics are "featured".
  const metrics = useMemo(() => {
    if (!s) return [];
    return [
      { label: 'Total Vineyards', value: s.vineyards.total, hint: `${formatNumber(s.vineyards.totalHectares)} ha under management`, icon: TerrainOutlinedIcon, tone: 'primary', featured: true, path: '/vineyards' },
      { label: 'Active Operations', value: s.operations.active, hint: `${s.operations.total} total operations`, icon: HandymanOutlinedIcon, tone: 'secondary', featured: true, path: '/operations' },
      { label: 'Total Blocks', value: s.blocks.total, hint: 'Across your vineyards', icon: GridViewOutlinedIcon, tone: 'primary', path: '/blocks' },
      { label: 'Total Hectares', value: formatNumber(s.vineyards.totalHectares), hint: 'Planted area', icon: SquareFootOutlinedIcon, tone: 'accent', path: '/vineyards' },
      { label: 'Harvest Records', value: s.harvest.total, hint: `${formatNumber(s.harvest.totalYield)} t total yield`, icon: AgricultureOutlinedIcon, tone: 'primary', path: '/harvest' },
      { label: 'Machinery', value: s.machinery.total, hint: `${s.machinery.needsAttention} need attention`, icon: PrecisionManufacturingOutlinedIcon, tone: 'primary', path: '/machinery' },
      { label: 'Finance Net', value: formatCurrency(s.finance.net), hint: 'Income − expenses', icon: PaymentsOutlinedIcon, tone: s.finance.net >= 0 ? 'success' : 'secondary', path: '/finance' },
      { label: 'Open Tasks', value: s.planner.open, hint: 'In the planner', icon: EventNoteOutlinedIcon, tone: 'primary', path: '/planner' },
    ];
  }, [s]);

  const financeItems = s ? [
    { label: 'Income', value: s.finance.income, color: 'success.main', display: formatCurrency(s.finance.income) },
    { label: 'Expenses', value: s.finance.expense, color: 'secondary.main', display: formatCurrency(s.finance.expense) },
  ] : [];

  const activityItems = s ? [
    { label: 'Operations', value: s.operations.active, color: 'primary.main' },
    { label: 'Irrigation', value: s.irrigation.active, color: 'info.main' },
    { label: 'Spray', value: s.spray.active, color: 'secondary.main' },
  ] : [];

  const upcoming = s?.planner?.upcoming || [];

  // ── HERO ────────────────────────────────────────────────────────────────
  const greeting = greetingForNow();
  const hero = (
    <Paper
      elevation={0}
      sx={{
        position: 'relative',
        overflow: 'hidden',
        borderRadius: 3,
        minHeight: { xs: 300, sm: 280, md: 320, lg: 340 },
        display: 'flex',
        alignItems: 'center',
        mb: { xs: 3, md: 4 },
        color: 'common.white',
        // Base vineyard-green so the banner reads well even before the image paints.
        bgcolor: 'primary.dark',
      }}
    >
      {/* Vineyard landscape image — strongest toward the right / lower-right. */}
      <Box
        aria-hidden
        sx={{
          position: 'absolute',
          inset: 0,
          backgroundImage: `url(${vineyardBg})`,
          backgroundSize: 'cover',
          backgroundPosition: { xs: 'center', md: 'right center' },
          backgroundRepeat: 'no-repeat',
        }}
      />

      {/* Readability overlays: strong dark-green on the left fading right, plus a
          soft bottom gradient so lower-right decorative text stays legible. */}
      <Box
        aria-hidden
        sx={{
          position: 'absolute',
          inset: 0,
          background: (t) => `linear-gradient(100deg, ${alpha(t.palette.primary.dark, 0.96)} 0%, ${alpha(t.palette.primary.dark, 0.82)} 38%, ${alpha(t.palette.primary.dark, 0.35)} 66%, ${alpha(t.palette.primary.dark, 0.1)} 100%)`,
        }}
      />
      <Box
        aria-hidden
        sx={{
          position: 'absolute',
          inset: 0,
          background: (t) => `linear-gradient(0deg, ${alpha(t.palette.primary.dark, 0.5)} 0%, transparent 45%)`,
        }}
      />

      {/* Subtle gold glow, top-right */}
      <Box aria-hidden sx={{ position: 'absolute', top: -70, right: -30, width: 240, height: 240, borderRadius: '50%', bgcolor: (t) => alpha(t.palette.accent.main, 0.14), filter: 'blur(6px)' }} />

      {/* Handwritten-style vineyard phrase, lower-right (hidden on small screens) */}
      <Typography
        aria-hidden
        sx={{
          position: 'absolute',
          right: { md: 32, lg: 44 },
          bottom: { md: 22, lg: 28 },
          display: { xs: 'none', md: 'block' },
          fontFamily: '"Playfair Display", Georgia, serif',
          fontStyle: 'italic',
          fontSize: { md: '1.05rem', lg: '1.2rem' },
          lineHeight: 1.3,
          textAlign: 'right',
          color: (t) => alpha(t.palette.common.white, 0.92),
          textShadow: '0 1px 6px rgba(0,0,0,0.35)',
        }}
      >
        Great wine
        <br />
        starts in the vineyard
      </Typography>

      {/* Content */}
      <Box sx={{ position: 'relative', px: { xs: 3, md: 6, lg: 7 }, py: { xs: 3.5, md: 4 }, maxWidth: { xs: '100%', md: 640 } }}>
        <Typography variant="overline" sx={{ color: (t) => alpha(t.palette.common.white, 0.8), letterSpacing: '0.14em' }}>
          Winerix · Vineyard Intelligence
        </Typography>
        <Typography
          variant="h1"
          component="h1"
          sx={{ mt: 0.5, mb: 1.25, fontSize: { xs: '1.85rem', sm: '2.2rem', md: '2.6rem' }, lineHeight: 1.12, textShadow: '0 2px 12px rgba(0,0,0,0.3)' }}
        >
          <Box component="span" sx={{ display: 'block', color: 'accent.light' }}>{greeting},</Box>
          <Box component="span" sx={{ display: 'block', color: 'common.white' }}>{userName || 'Winemaker'}</Box>
        </Typography>
        <Typography variant="body1" sx={{ color: (t) => alpha(t.palette.common.white, 0.88), maxWidth: 480, textShadow: '0 1px 8px rgba(0,0,0,0.3)' }}>
          Here&apos;s what&apos;s happening across your vineyard today. Manage blocks,
          operations, harvest and finances — all in one calm workspace.
        </Typography>

        <Stack direction="row" spacing={1.5} sx={{ mt: 3, flexWrap: 'wrap', gap: 1.5 }}>
          <Button variant="contained" color="secondary" startIcon={<AddOutlinedIcon />} onClick={() => navigate('/operations')}
            sx={{ fontWeight: 700 }}>
            Add Operation
          </Button>
          <Button variant="outlined" startIcon={<AgricultureOutlinedIcon />} onClick={() => navigate('/harvest')}
            sx={{ color: 'common.white', borderColor: (t) => alpha(t.palette.common.white, 0.55), '&:hover': { borderColor: 'common.white', bgcolor: (t) => alpha(t.palette.common.white, 0.1) } }}>
            Record Harvest
          </Button>
        </Stack>
      </Box>
    </Paper>
  );

  return (
    <PageContainer maxWidth={1600} sx={{ px: { xs: 2, sm: 3, md: 4, lg: 5 } }}>
      {hero}

      {error ? (
        <Alert severity="error" sx={{ mb: 2 }}>
          We couldn&apos;t load your dashboard right now. Please refresh the page or try again in a moment.
        </Alert>
      ) : (
        <>
          {/* ── Quick actions ─────────────────────────────────────── */}
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5, mb: { xs: 3, md: 4 } }}>
            {QUICK_ACTIONS.map((a) => {
              const Icon = a.icon;
              return (
                <Button key={a.label} variant="outlined" color="primary" startIcon={<Icon />} onClick={() => navigate(a.path)}
                  sx={{ bgcolor: 'background.paper' }}>
                  {a.label}
                </Button>
              );
            })}
          </Box>

          {/* ── Today's priorities ────────────────────────────────── */}
          <Card sx={{ mb: { xs: 3, md: 4 } }}>
            <CardContent sx={{ p: { xs: 2.5, md: 3 } }}>
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
                <Typography variant="h5" component="h2">Today&apos;s Priorities</Typography>
                <Chip label="Live" size="small" color="primary" />
              </Box>
              <Divider sx={{ mb: 1 }} />
              {loading ? (
                <Box sx={{ py: 1 }}><Skeleton height={40} /><Skeleton height={40} /></Box>
              ) : (
                <PriorityList snapshot={s} />
              )}
            </CardContent>
          </Card>

          {/* ── Key metrics ───────────────────────────────────────── */}
          <SectionHeading title="Key Metrics" />
          <Grid container spacing={{ xs: 2, md: 3 }} sx={{ mb: { xs: 3, md: 5 } }}>
            {loading || !s ? (
              Array.from({ length: 8 }).map((_, i) => (
                <Grid item xs={12} sm={6} lg={3} key={i}>
                  <Card sx={{ height: '100%' }}><CardContent><Skeleton width="55%" height={24} /><Skeleton width="40%" height={48} sx={{ mt: 1 }} /></CardContent></Card>
                </Grid>
              ))
            ) : (
              metrics.map((m) => (
                <Grid item xs={12} sm={6} lg={3} key={m.label}>
                  <StatCard icon={m.icon} label={m.label} value={m.value} hint={m.hint} tone={m.tone} featured={m.featured} onClick={() => navigate(m.path)} />
                </Grid>
              ))
            )}
          </Grid>

          {/* ── Main content grid ─────────────────────────────────── */}
          <Grid container spacing={{ xs: 2, md: 3 }}>
            {/* Vineyard workspace (wider) */}
            <Grid item xs={12} lg={8}>
              <SectionHeading title="Your Vineyards" action="View all" onAction={() => navigate('/vineyards')} />
              {loading ? (
                <Grid container spacing={{ xs: 2, md: 3 }}>
                  {[0, 1].map((i) => (
                    <Grid item xs={12} sm={6} key={i}><Card><CardContent><Skeleton width="60%" height={28} /><Skeleton width="80%" height={20} sx={{ mt: 2 }} /></CardContent></Card></Grid>
                  ))}
                </Grid>
              ) : vineyards.length === 0 ? (
                <EmptyState
                  icon={TerrainOutlinedIcon}
                  title="No vineyards yet"
                  body="Add your first vineyard to start managing blocks, operations and harvests."
                  action="Add Vineyard"
                  onAction={() => navigate('/vineyards')}
                />
              ) : (
                <Grid container spacing={{ xs: 2, md: 3 }}>
                  {vineyards.slice(0, 4).map((v) => (
                    <Grid item xs={12} sm={6} key={v.id}>
                      <VineyardWorkspaceCard vineyard={v} onView={() => navigate(`/vineyards/${v.id}`)} />
                    </Grid>
                  ))}
                </Grid>
              )}
            </Grid>

            {/* Right rail */}
            <Grid item xs={12} lg={4}>
              <Stack spacing={{ xs: 2, md: 3 }}>
                {/* Weather */}
                <WeatherCard />

                {/* Finance snapshot */}
                <Card>
                  <CardContent sx={{ p: { xs: 2.5, md: 3 } }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1.5 }}>
                      <Typography variant="h6" component="h3">Finance Snapshot</Typography>
                      <PaymentsOutlinedIcon sx={{ color: 'text.disabled' }} fontSize="small" />
                    </Box>
                    {loading || !s ? (
                      <Skeleton height={80} />
                    ) : s.finance.income === 0 && s.finance.expense === 0 ? (
                      <EmptyInline text="Add your first income or expense" onClick={() => navigate('/finance')} />
                    ) : (
                      <>
                        <Typography variant="h4" component="p" sx={{ color: s.finance.net >= 0 ? 'success.main' : 'error.main', fontWeight: 700, mb: 1.5 }}>
                          {formatCurrency(s.finance.net)}
                        </Typography>
                        <ProportionBar items={financeItems} />
                        <Button size="small" sx={{ mt: 2 }} endIcon={<ArrowForwardOutlinedIcon />} onClick={() => navigate('/finance')}>Open Finance</Button>
                      </>
                    )}
                  </CardContent>
                </Card>

                {/* Active work distribution */}
                <Card>
                  <CardContent sx={{ p: { xs: 2.5, md: 3 } }}>
                    <Typography variant="h6" component="h3" sx={{ mb: 1.5 }}>Active Work</Typography>
                    {loading || !s ? (
                      <Skeleton height={60} />
                    ) : (s.operations.active + s.irrigation.active + s.spray.active) === 0 ? (
                      <EmptyInline text="No active operations, irrigation or spray work" onClick={() => navigate('/operations')} />
                    ) : (
                      <ProportionBar items={activityItems} />
                    )}
                  </CardContent>
                </Card>

                {/* Upcoming tasks */}
                <Card>
                  <CardContent sx={{ p: { xs: 2.5, md: 3 } }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
                      <Typography variant="h6" component="h3">Upcoming Tasks</Typography>
                      <EventNoteOutlinedIcon sx={{ color: 'text.disabled' }} fontSize="small" />
                    </Box>
                    <Divider sx={{ mb: 1 }} />
                    {loading ? (
                      <Skeleton height={60} />
                    ) : upcoming.length === 0 ? (
                      <EmptyInline text="Plan your next vineyard activity" onClick={() => navigate('/planner')} />
                    ) : (
                      <List dense disablePadding>
                        {upcoming.map((t, idx) => (
                          <ListItem key={idx} disableGutters
                            secondaryAction={<Typography variant="caption" sx={{ color: 'text.secondary' }}>{formatDate(t.dueDate)}</Typography>}>
                            <ListItemText primary={t.title} primaryTypographyProps={{ variant: 'body2', noWrap: true, sx: { pr: 6 } }} />
                          </ListItem>
                        ))}
                      </List>
                    )}
                  </CardContent>
                </Card>

                {/* Intelligence link */}
                <Card sx={{ bgcolor: (t) => alpha(t.palette.accent.main, 0.06), borderColor: (t) => alpha(t.palette.accent.main, 0.25) }}>
                  <CardActionArea onClick={() => navigate('/ai-intelligence')}>
                    <CardContent sx={{ p: { xs: 2.5, md: 3 }, display: 'flex', alignItems: 'center', gap: 2 }}>
                      <Box sx={{ width: 44, height: 44, borderRadius: 2.5, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'accent.dark', bgcolor: (t) => alpha(t.palette.accent.main, 0.18) }}>
                        <AutoAwesomeOutlinedIcon />
                      </Box>
                      <Box sx={{ minWidth: 0 }}>
                        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>Vineyard Insights</Typography>
                        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                          Real-data insights &amp; guidance for your vineyard.
                        </Typography>
                      </Box>
                    </CardContent>
                  </CardActionArea>
                </Card>
              </Stack>
            </Grid>
          </Grid>
        </>
      )}
    </PageContainer>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function VineyardWorkspaceCard({ vineyard, onView }) {
  return (
    <Card sx={{ height: '100%', transition: 'box-shadow 0.2s ease, transform 0.2s ease', '&:hover': { boxShadow: 4, transform: 'translateY(-2px)' } }}>
      {/* Branded visual header (no fake imagery) */}
      <Box
        sx={{
          height: 72,
          position: 'relative',
          background: (t) => `linear-gradient(120deg, ${alpha(t.palette.primary.main, 0.9)}, ${alpha(t.palette.primary.light, 0.75)})`,
          display: 'flex', alignItems: 'center', px: 2.5,
        }}
      >
        <Box aria-hidden sx={{ position: 'absolute', top: -20, right: -10, width: 90, height: 90, borderRadius: '50%', bgcolor: (t) => alpha(t.palette.accent.main, 0.25) }} />
        <TerrainOutlinedIcon sx={{ color: 'common.white', fontSize: '1.75rem', position: 'relative' }} />
      </Box>
      <CardContent sx={{ p: { xs: 2.5, md: 3 } }}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 1 }}>
          <Typography variant="h5" component="h3" sx={{ minWidth: 0 }}>{vineyard.name}</Typography>
          {vineyard.status && (
            <Chip label={vineyard.status} size="small" color={statusChipColor(vineyard.status)} sx={{ textTransform: 'capitalize', flexShrink: 0 }} />
          )}
        </Box>
        {vineyard.location && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.75, color: 'text.secondary' }}>
            <LocationOnOutlinedIcon sx={{ fontSize: '1rem' }} />
            <Typography variant="body2" noWrap>{vineyard.location}</Typography>
          </Box>
        )}
        <Divider sx={{ my: 1.5 }} />
        <Box sx={{ display: 'flex', gap: 4 }}>
          <Box>
            <Typography variant="overline" sx={{ display: 'block' }}>Area</Typography>
            <Typography variant="subtitle1" sx={{ color: 'text.primary', fontWeight: 600 }}>
              {vineyard.areaHectares != null ? `${formatNumber(vineyard.areaHectares)} ha` : '—'}
            </Typography>
          </Box>
          <Box>
            <Typography variant="overline" sx={{ display: 'block' }}>Blocks</Typography>
            <Typography variant="subtitle1" sx={{ color: 'text.primary', fontWeight: 600 }}>{vineyard.blockCount ?? 0}</Typography>
          </Box>
        </Box>
        <Button size="small" sx={{ mt: 1.5 }} endIcon={<ArrowForwardOutlinedIcon />} onClick={onView}>View vineyard</Button>
      </CardContent>
    </Card>
  );
}

function EmptyState({ icon: Icon, title, body, action, onAction }) {
  return (
    <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', px: 3, py: { xs: 4, md: 6 }, textAlign: 'center' }}>
      <Box sx={{ width: 60, height: 60, borderRadius: '50%', bgcolor: 'background.paper', display: 'flex', alignItems: 'center', justifyContent: 'center', mx: 'auto', mb: 2, color: 'primary.main' }}>
        <Icon sx={{ fontSize: '1.9rem' }} />
      </Box>
      <Typography variant="h5" component="p" sx={{ mb: 0.5 }}>{title}</Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary', maxWidth: 420, mx: 'auto', mb: 3 }}>{body}</Typography>
      <Button variant="contained" color="primary" startIcon={<AddOutlinedIcon />} onClick={onAction}>{action}</Button>
    </Paper>
  );
}

function EmptyInline({ text, onClick }) {
  return (
    <Box>
      <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1 }}>{text}</Typography>
      <Button size="small" endIcon={<ArrowForwardOutlinedIcon />} onClick={onClick}>Get started</Button>
    </Box>
  );
}

export default Dashboard;
