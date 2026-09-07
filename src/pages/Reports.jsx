import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Grid, Card, CardContent, Typography, Skeleton, Alert, Divider, Button,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import TrendingUpOutlinedIcon from '@mui/icons-material/TrendingUpOutlined';
import TrendingDownOutlinedIcon from '@mui/icons-material/TrendingDownOutlined';
import AccountBalanceOutlinedIcon from '@mui/icons-material/AccountBalanceOutlined';
import TerrainOutlinedIcon from '@mui/icons-material/TerrainOutlined';
import GridViewOutlinedIcon from '@mui/icons-material/GridViewOutlined';
import HandymanOutlinedIcon from '@mui/icons-material/HandymanOutlined';
import WaterDropOutlinedIcon from '@mui/icons-material/WaterDropOutlined';
import SanitizerOutlinedIcon from '@mui/icons-material/SanitizerOutlined';
import AgricultureOutlinedIcon from '@mui/icons-material/AgricultureOutlined';
import PrecisionManufacturingOutlinedIcon from '@mui/icons-material/PrecisionManufacturingOutlined';
import PaymentsOutlinedIcon from '@mui/icons-material/PaymentsOutlined';
import EventNoteOutlinedIcon from '@mui/icons-material/EventNoteOutlined';
import PageContainer from '../components/layout/PageContainer';
import StatCard from '../components/dashboard/StatCard';
import { formatNumber, formatCurrency } from '../components/common/formatters';
import { getReportSnapshot } from '../services/reportsService';

/**
 * A single figure inside the Finance Summary card. Purely presentational —
 * value + formatting come straight from the report snapshot (unchanged).
 */
function FinanceFigure({ icon: Icon, label, value, tone }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.75 }}>
      <Box
        sx={{
          width: 44, height: 44, borderRadius: 2, flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: `${tone}.main`, bgcolor: (t) => alpha(t.palette[tone].main, 0.12),
        }}
      >
        <Icon />
      </Box>
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="overline" sx={{ display: 'block', lineHeight: 1.4 }}>{label}</Typography>
        <Typography
          component="p"
          sx={{
            fontFamily: '"Playfair Display", Georgia, serif',
            fontWeight: 700,
            fontSize: { xs: '1.5rem', md: '1.75rem' },
            lineHeight: 1.1,
            color: `${tone}.main`,
          }}
        >
          {value}
        </Typography>
      </Box>
    </Box>
  );
}

function Reports() {
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

  const cards = snapshot ? [
    { icon: TerrainOutlinedIcon, title: 'Vineyards', primary: snapshot.vineyards.total, secondary: `${formatNumber(snapshot.vineyards.totalHectares)} ha total`, path: '/vineyards', tone: 'primary' },
    { icon: GridViewOutlinedIcon, title: 'Blocks', primary: snapshot.blocks.total, secondary: 'Total blocks', path: '/blocks', tone: 'primary' },
    { icon: HandymanOutlinedIcon, title: 'Operations', primary: snapshot.operations.total, secondary: `${snapshot.operations.active} active`, path: '/operations', tone: 'secondary' },
    { icon: WaterDropOutlinedIcon, title: 'Irrigation', primary: snapshot.irrigation.total, secondary: `${snapshot.irrigation.active} active`, path: '/irrigation', tone: 'primary' },
    { icon: SanitizerOutlinedIcon, title: 'Spray Programme', primary: snapshot.spray.total, secondary: `${snapshot.spray.active} active`, path: '/spray-programme', tone: 'secondary' },
    { icon: AgricultureOutlinedIcon, title: 'Harvest', primary: snapshot.harvest.total, secondary: `${formatNumber(snapshot.harvest.totalYield)} t total yield`, path: '/harvest', tone: 'accent' },
    { icon: PrecisionManufacturingOutlinedIcon, title: 'Machinery', primary: snapshot.machinery.total, secondary: `${snapshot.machinery.operational} operational · ${snapshot.machinery.needsAttention} need attention`, path: '/machinery', tone: 'primary' },
    { icon: EventNoteOutlinedIcon, title: 'Planner', primary: snapshot.planner.total, secondary: `${snapshot.planner.open} open tasks`, path: '/planner', tone: 'secondary' },
  ] : [];

  return (
    <PageContainer maxWidth={1600} sx={{ px: { xs: 2, sm: 3, md: 4, lg: 5 } }}>
      <Box sx={{ mb: { xs: 3, md: 4 } }}>
        <Typography variant="h2" component="h1" sx={{ mb: 0.5 }}>Reports</Typography>
        <Typography variant="body1" sx={{ color: 'text.secondary' }}>
          A real-time summary of activity across your vineyard operation.
        </Typography>
      </Box>

      {error ? (
        <Alert severity="error">{error}</Alert>
      ) : loading ? (
        <Grid container spacing={{ xs: 2, md: 3 }}>
          {Array.from({ length: 8 }).map((_, i) => (
            <Grid item xs={12} sm={6} lg={3} key={i}><Card><CardContent><Skeleton width="50%" height={28} /><Skeleton width="35%" height={44} sx={{ mt: 1 }} /></CardContent></Card></Grid>
          ))}
        </Grid>
      ) : (
        <>
          {/* Section metrics — one clickable card per workspace (real snapshot data) */}
          <Grid container spacing={{ xs: 2, md: 3 }}>
            {cards.map((c) => (
              <Grid item xs={12} sm={6} lg={3} key={c.title}>
                <StatCard
                  icon={c.icon}
                  label={c.title}
                  value={c.primary}
                  hint={c.secondary}
                  tone={c.tone}
                  onClick={() => navigate(c.path)}
                />
              </Grid>
            ))}
          </Grid>

          {/* Finance summary — figures come straight from the snapshot (unchanged) */}
          <Typography variant="h4" component="h2" sx={{ mt: { xs: 4, md: 5 }, mb: 2 }}>Finance Summary</Typography>
          <Card variant="outlined" sx={{ borderRadius: 3 }}>
            <CardContent sx={{ p: { xs: 2.5, md: 3 } }}>
              <Grid container spacing={{ xs: 3, md: 4 }}>
                <Grid item xs={12} sm={4}>
                  <FinanceFigure icon={TrendingUpOutlinedIcon} label="Income" value={formatCurrency(snapshot.finance.income)} tone="success" />
                </Grid>
                <Grid item xs={12} sm={4}>
                  <FinanceFigure icon={TrendingDownOutlinedIcon} label="Expenses" value={formatCurrency(snapshot.finance.expense)} tone="secondary" />
                </Grid>
                <Grid item xs={12} sm={4}>
                  <FinanceFigure
                    icon={AccountBalanceOutlinedIcon}
                    label="Net"
                    value={formatCurrency(snapshot.finance.net)}
                    tone={snapshot.finance.net >= 0 ? 'success' : 'error'}
                  />
                </Grid>
              </Grid>
              <Divider sx={{ my: 2.5 }} />
              <Button size="small" onClick={() => navigate('/finance')}>Open Finance</Button>
            </CardContent>
          </Card>
        </>
      )}
    </PageContainer>
  );
}

export default Reports;
