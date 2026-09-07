import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Grid, Card, CardContent, Typography, Chip, Skeleton, Alert, Divider, Button, Stack,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import AutoAwesomeOutlinedIcon from '@mui/icons-material/AutoAwesomeOutlined';
import InsightsOutlinedIcon from '@mui/icons-material/InsightsOutlined';
import TipsAndUpdatesOutlinedIcon from '@mui/icons-material/TipsAndUpdatesOutlined';
import LightbulbOutlinedIcon from '@mui/icons-material/LightbulbOutlined';
import CheckCircleOutlineOutlinedIcon from '@mui/icons-material/CheckCircleOutlineOutlined';
import WarningAmberOutlinedIcon from '@mui/icons-material/WarningAmberOutlined';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import EventNoteOutlinedIcon from '@mui/icons-material/EventNoteOutlined';
import CalendarTodayOutlinedIcon from '@mui/icons-material/CalendarTodayOutlined';
import ArrowForwardOutlinedIcon from '@mui/icons-material/ArrowForwardOutlined';
import PageContainer from '../components/layout/PageContainer';
import { formatDate, formatCurrency, formatNumber } from '../components/common/formatters';
import { getReportSnapshot } from '../services/reportsService';

// Build deterministic, rule-based insights from the REAL data snapshot.
// These are calculated facts — not AI-generated text.
function buildInsights(s) {
  const insights = [];
  if (!s) return insights;

  if (s.vineyards.total === 0) {
    insights.push({ tone: 'info', text: 'You have no vineyards yet. Add a vineyard to begin tracking blocks, operations and harvests.' });
    return insights;
  }

  insights.push({ tone: 'neutral', text: `You are managing ${s.vineyards.total} vineyard${s.vineyards.total === 1 ? '' : 's'} covering ${formatNumber(s.vineyards.totalHectares)} ha across ${s.blocks.total} block${s.blocks.total === 1 ? '' : 's'}.` });

  const activeWork = s.operations.active + s.irrigation.active + s.spray.active;
  if (activeWork > 0) {
    insights.push({ tone: 'neutral', text: `There are ${activeWork} active item${activeWork === 1 ? '' : 's'} in progress across operations, irrigation and spray programmes.` });
  }

  if (s.machinery.needsAttention > 0) {
    insights.push({ tone: 'warning', text: `${s.machinery.needsAttention} machinery item${s.machinery.needsAttention === 1 ? '' : 's'} need attention (in maintenance or out of service).` });
  }

  if (s.harvest.total > 0 && s.harvest.totalYield > 0) {
    insights.push({ tone: 'success', text: `Recorded harvest yield totals ${formatNumber(s.harvest.totalYield)} tons across ${s.harvest.total} record${s.harvest.total === 1 ? '' : 's'}.` });
  }

  if (s.finance.income > 0 || s.finance.expense > 0) {
    const net = s.finance.net;
    insights.push({ tone: net >= 0 ? 'success' : 'warning', text: `Finance net position is ${formatCurrency(net)} (income ${formatCurrency(s.finance.income)}, expenses ${formatCurrency(s.finance.expense)}).` });
  }

  if (s.planner.open > 0) {
    insights.push({ tone: 'neutral', text: `You have ${s.planner.open} open planner task${s.planner.open === 1 ? '' : 's'}.` });
  }

  return insights;
}

const GUIDANCE = [
  'Keep block records up to date so operations, irrigation and spray programmes stay accurate.',
  'Log harvest yields as they happen to build a reliable season-over-season record.',
  'Record income and expenses regularly to keep the finance net position meaningful.',
  'Use the Planner for upcoming tasks so nothing is missed during busy periods.',
];

// Map an insight tone to its palette key, chip label and icon. The tones come
// straight from buildInsights() — this only controls presentation.
const TONE_META = {
  success: { palette: 'success', label: 'Positive', icon: CheckCircleOutlineOutlinedIcon },
  warning: { palette: 'warning', label: 'Attention', icon: WarningAmberOutlinedIcon },
  info: { palette: 'info', label: 'Getting started', icon: InfoOutlinedIcon },
  neutral: { palette: 'primary', label: 'Overview', icon: InsightsOutlinedIcon },
};

function toneMeta(tone) {
  return TONE_META[tone] || TONE_META.neutral;
}

/**
 * A single calculated insight row: tone-tinted icon, wrapping body text and a
 * subtle severity chip. Text comes from the deterministic rule engine.
 */
function InsightRow({ tone, text }) {
  const meta = toneMeta(tone);
  const Icon = meta.icon;
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 1.5,
        p: 1.5,
        borderRadius: 2,
        bgcolor: (t) => alpha(t.palette[meta.palette].main, 0.05),
        border: '1px solid',
        borderColor: (t) => alpha(t.palette[meta.palette].main, 0.16),
      }}
    >
      <Box
        sx={{
          width: 30, height: 30, borderRadius: 1.5, flexShrink: 0, mt: 0.25,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: `${meta.palette}.main`, bgcolor: (t) => alpha(t.palette[meta.palette].main, 0.12),
        }}
      >
        <Icon sx={{ fontSize: '1rem' }} />
      </Box>
      <Box sx={{ minWidth: 0, flexGrow: 1 }}>
        <Typography variant="body2" sx={{ lineHeight: 1.55, color: 'text.primary' }}>{text}</Typography>
      </Box>
      <Chip
        size="small"
        label={meta.label}
        sx={{
          flexShrink: 0,
          fontWeight: 600,
          color: `${meta.palette}.main`,
          bgcolor: (t) => alpha(t.palette[meta.palette].main, 0.12),
          display: { xs: 'none', sm: 'inline-flex' },
        }}
      />
    </Box>
  );
}

function AIIntelligence() {
  const navigate = useNavigate();
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true); setError('');
      const { data, error: err } = await getReportSnapshot();
      if (!active) return;
      if (err) setError(err); else setSnapshot(data);
      setLoading(false);
    })();
    return () => { active = false; };
  }, []);

  const insights = useMemo(() => buildInsights(snapshot), [snapshot]);
  const upcoming = snapshot?.planner?.upcoming || [];

  return (
    <PageContainer maxWidth={1600} sx={{ px: { xs: 2, sm: 3, md: 4, lg: 5 } }}>
      <Box sx={{ mb: { xs: 3, md: 4 } }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 0.5 }}>
          <Box
            sx={{
              width: 40, height: 40, borderRadius: 2, flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'accent.main', bgcolor: (t) => alpha(t.palette.accent.main, 0.14),
            }}
          >
            <AutoAwesomeOutlinedIcon fontSize="small" />
          </Box>
          <Typography variant="h2" component="h1">AI Intelligence</Typography>
        </Box>
        <Typography variant="body1" sx={{ color: 'text.secondary', maxWidth: 720 }}>
          Insights calculated from your real vineyard data, plus practical guidance.
          Predictive AI features will build on this foundation in a future phase.
        </Typography>
      </Box>

      {error ? (
        <Alert severity="error" variant="outlined" sx={{ borderRadius: 3 }}>{error}</Alert>
      ) : loading ? (
        <Grid container spacing={{ xs: 2, md: 3 }}>
          {[0, 1].map((i) => (
            <Grid item xs={12} md={6} key={i}>
              <Card variant="outlined" sx={{ borderRadius: 3, height: '100%' }}>
                <CardContent>
                  <Skeleton width="40%" height={28} />
                  <Skeleton height={64} sx={{ mt: 1.5 }} />
                  <Skeleton height={64} sx={{ mt: 1 }} />
                </CardContent>
              </Card>
            </Grid>
          ))}
        </Grid>
      ) : (
        <Grid container spacing={{ xs: 2, md: 3 }}>
          {/* Calculated insights — real data */}
          <Grid item xs={12} md={6}>
            <Card variant="outlined" sx={{ borderRadius: 3, height: '100%' }}>
              <CardContent sx={{ p: { xs: 2.5, md: 3 } }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
                  <InsightsOutlinedIcon color="primary" fontSize="small" />
                  <Typography variant="h6" component="h2">Your Insights</Typography>
                  <Chip label="Real data" size="small" color="primary" sx={{ ml: 'auto', fontWeight: 600 }} />
                </Box>
                {insights.length === 0 ? (
                  <Typography variant="body2" sx={{ color: 'text.secondary' }}>No insights available yet.</Typography>
                ) : (
                  <Stack spacing={1.5}>
                    {insights.map((ins, idx) => (
                      <InsightRow key={idx} tone={ins.tone} text={ins.text} />
                    ))}
                  </Stack>
                )}
              </CardContent>
            </Card>
          </Grid>

          {/* Upcoming tasks — real data from the planner */}
          <Grid item xs={12} md={6}>
            <Card variant="outlined" sx={{ borderRadius: 3, height: '100%', display: 'flex', flexDirection: 'column' }}>
              <CardContent sx={{ p: { xs: 2.5, md: 3 }, flexGrow: 1 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
                  <TipsAndUpdatesOutlinedIcon color="primary" fontSize="small" />
                  <Typography variant="h6" component="h2">Upcoming Tasks</Typography>
                  <Chip label="Real data" size="small" color="primary" sx={{ ml: 'auto', fontWeight: 600 }} />
                </Box>
                {upcoming.length === 0 ? (
                  <Box sx={{ py: 3, textAlign: 'center' }}>
                    <Box
                      sx={{
                        width: 48, height: 48, borderRadius: '50%', mx: 'auto', mb: 1.5,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        color: 'text.disabled', bgcolor: 'background.subtle',
                      }}
                    >
                      <EventNoteOutlinedIcon />
                    </Box>
                    <Typography variant="body2" sx={{ color: 'text.secondary', maxWidth: 320, mx: 'auto' }}>
                      No upcoming tasks scheduled. Use the Planner to add tasks with due dates.
                    </Typography>
                  </Box>
                ) : (
                  <Stack spacing={1}>
                    {upcoming.map((t, idx) => (
                      <Box
                        key={idx}
                        sx={{
                          display: 'flex', alignItems: 'center', gap: 1.5, py: 1.25, px: 1.5,
                          borderRadius: 2, border: '1px solid', borderColor: 'divider',
                          transition: 'background-color 0.15s ease',
                          '&:hover': { bgcolor: 'background.subtle' },
                        }}
                      >
                        <Box
                          sx={{
                            width: 30, height: 30, borderRadius: 1.5, flexShrink: 0,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            color: 'primary.main', bgcolor: (th) => alpha(th.palette.primary.main, 0.1),
                          }}
                        >
                          <EventNoteOutlinedIcon sx={{ fontSize: '1rem' }} />
                        </Box>
                        <Typography variant="body2" sx={{ flexGrow: 1, minWidth: 0, fontWeight: 500 }} noWrap>
                          {t.title}
                        </Typography>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexShrink: 0, color: 'text.secondary' }}>
                          <CalendarTodayOutlinedIcon sx={{ fontSize: '0.85rem' }} />
                          <Typography variant="caption">{formatDate(t.dueDate)}</Typography>
                        </Box>
                      </Box>
                    ))}
                  </Stack>
                )}
              </CardContent>
              <Box sx={{ px: { xs: 2.5, md: 3 }, pb: 2 }}>
                <Button
                  size="small"
                  endIcon={<ArrowForwardOutlinedIcon />}
                  onClick={() => navigate('/planner')}
                >
                  Open Planner
                </Button>
              </Box>
            </Card>
          </Grid>

          {/* Static guidance — clearly labelled as general guidance */}
          <Grid item xs={12}>
            <Card variant="outlined" sx={{ borderRadius: 3 }}>
              <CardContent sx={{ p: { xs: 2.5, md: 3 } }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
                  <LightbulbOutlinedIcon sx={{ color: 'accent.main' }} fontSize="small" />
                  <Typography variant="h6" component="h2">Guidance</Typography>
                  <Chip label="General guidance" size="small" sx={{ ml: 'auto', fontWeight: 600 }} />
                </Box>
                <Divider sx={{ mb: 2 }} />
                <Grid container spacing={{ xs: 1.5, md: 2 }}>
                  {GUIDANCE.map((g, idx) => (
                    <Grid item xs={12} md={6} key={idx}>
                      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.25 }}>
                        <LightbulbOutlinedIcon sx={{ fontSize: '1rem', color: 'accent.main', mt: 0.35, flexShrink: 0 }} />
                        <Typography variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.55 }}>{g}</Typography>
                      </Box>
                    </Grid>
                  ))}
                </Grid>
              </CardContent>
            </Card>
          </Grid>
        </Grid>
      )}
    </PageContainer>
  );
}

export default AIIntelligence;
