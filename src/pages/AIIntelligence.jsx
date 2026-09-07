import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Grid, Card, CardContent, Typography, Paper, Chip, Skeleton, Alert, Divider, Button, List, ListItem, ListItemText,
} from '@mui/material';
import AutoAwesomeOutlinedIcon from '@mui/icons-material/AutoAwesomeOutlined';
import InsightsOutlinedIcon from '@mui/icons-material/InsightsOutlined';
import TipsAndUpdatesOutlinedIcon from '@mui/icons-material/TipsAndUpdatesOutlined';
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

function toneColor(tone) {
  if (tone === 'warning') return 'warning';
  if (tone === 'success') return 'success';
  if (tone === 'info') return 'info';
  return 'default';
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
    <PageContainer>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 0.5 }}>
        <AutoAwesomeOutlinedIcon sx={{ color: 'accent.main' }} />
        <Typography variant="h2" component="h1">AI Intelligence</Typography>
      </Box>
      <Typography variant="body1" sx={{ color: 'text.secondary', mb: 3 }}>
        Insights calculated from your real vineyard data, plus practical guidance.
        Predictive AI features will build on this foundation in a future phase.
      </Typography>

      {error ? (
        <Alert severity="error">{error}</Alert>
      ) : loading ? (
        <Grid container spacing={{ xs: 2, md: 3 }}>
          {[0, 1].map((i) => <Grid item xs={12} md={6} key={i}><Card><CardContent><Skeleton width="40%" height={28} /><Skeleton height={90} sx={{ mt: 1 }} /></CardContent></Card></Grid>)}
        </Grid>
      ) : (
        <Grid container spacing={{ xs: 2, md: 3 }}>
          {/* Calculated insights */}
          <Grid item xs={12} md={6}>
            <Card sx={{ height: '100%' }}>
              <CardContent>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                  <InsightsOutlinedIcon color="primary" fontSize="small" />
                  <Typography variant="h6" component="h2">Your Insights</Typography>
                  <Chip label="Real data" size="small" color="primary" sx={{ ml: 'auto' }} />
                </Box>
                <Divider sx={{ mb: 1.5 }} />
                {insights.length === 0 ? (
                  <Typography variant="body2" sx={{ color: 'text.secondary' }}>No insights available yet.</Typography>
                ) : (
                  <List dense disablePadding>
                    {insights.map((ins, idx) => (
                      <ListItem key={idx} disableGutters sx={{ alignItems: 'flex-start' }}>
                        <Box sx={{ mt: 0.5, mr: 1.5, flexShrink: 0 }}>
                          <Chip size="small" label={ins.tone === 'neutral' ? 'info' : ins.tone} color={toneColor(ins.tone)}
                            sx={{ textTransform: 'capitalize' }} />
                        </Box>
                        <ListItemText primary={ins.text} primaryTypographyProps={{ variant: 'body2' }} />
                      </ListItem>
                    ))}
                  </List>
                )}
              </CardContent>
            </Card>
          </Grid>

          {/* Upcoming tasks (real, from planner) */}
          <Grid item xs={12} md={6}>
            <Card sx={{ height: '100%' }}>
              <CardContent>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                  <TipsAndUpdatesOutlinedIcon color="primary" fontSize="small" />
                  <Typography variant="h6" component="h2">Upcoming Tasks</Typography>
                  <Chip label="Real data" size="small" color="primary" sx={{ ml: 'auto' }} />
                </Box>
                <Divider sx={{ mb: 1.5 }} />
                {upcoming.length === 0 ? (
                  <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                    No upcoming tasks scheduled. Use the Planner to add tasks with due dates.
                  </Typography>
                ) : (
                  <List dense disablePadding>
                    {upcoming.map((t, idx) => (
                      <ListItem key={idx} disableGutters
                        secondaryAction={<Typography variant="caption" sx={{ color: 'text.secondary' }}>{formatDate(t.dueDate)}</Typography>}>
                        <ListItemText primary={t.title} primaryTypographyProps={{ variant: 'body2' }} />
                      </ListItem>
                    ))}
                  </List>
                )}
                <Button size="small" sx={{ mt: 1 }} onClick={() => navigate('/planner')}>Open Planner</Button>
              </CardContent>
            </Card>
          </Grid>

          {/* Static guidance — clearly labelled */}
          <Grid item xs={12}>
            <Paper sx={{ p: { xs: 2.5, md: 3 } }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                <Typography variant="h6" component="h2">Guidance</Typography>
                <Chip label="General guidance" size="small" sx={{ ml: 'auto' }} />
              </Box>
              <Divider sx={{ mb: 1.5 }} />
              <List dense disablePadding>
                {GUIDANCE.map((g, idx) => (
                  <ListItem key={idx} disableGutters>
                    <ListItemText primary={g} primaryTypographyProps={{ variant: 'body2', color: 'text.secondary' }} />
                  </ListItem>
                ))}
              </List>
            </Paper>
          </Grid>
        </Grid>
      )}
    </PageContainer>
  );
}

export default AIIntelligence;
