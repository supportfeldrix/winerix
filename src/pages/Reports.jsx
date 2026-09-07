import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Grid, Card, CardContent, Typography, Paper, Skeleton, Alert, Divider, Button,
} from '@mui/material';
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
import { formatNumber, formatCurrency } from '../components/common/formatters';
import { getReportSnapshot } from '../services/reportsService';

function MetricCard({ icon: Icon, title, primary, secondary, onClick }) {
  return (
    <Card sx={{ height: '100%', cursor: onClick ? 'pointer' : 'default' }} onClick={onClick}>
      <CardContent>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 1.5 }}>
          <Box sx={{ width: 40, height: 40, borderRadius: 2, display: 'flex', alignItems: 'center', justifyContent: 'center', bgcolor: 'background.subtle', color: 'primary.main', flexShrink: 0 }}>
            <Icon fontSize="small" />
          </Box>
          <Typography variant="h6" component="h3">{title}</Typography>
        </Box>
        <Typography variant="h3" component="p" sx={{ lineHeight: 1.1 }}>{primary}</Typography>
        {secondary && <Typography variant="body2" sx={{ color: 'text.secondary', mt: 0.5 }}>{secondary}</Typography>}
      </CardContent>
    </Card>
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
    { icon: TerrainOutlinedIcon, title: 'Vineyards', primary: snapshot.vineyards.total, secondary: `${formatNumber(snapshot.vineyards.totalHectares)} ha total`, path: '/vineyards' },
    { icon: GridViewOutlinedIcon, title: 'Blocks', primary: snapshot.blocks.total, secondary: 'Total blocks', path: '/blocks' },
    { icon: HandymanOutlinedIcon, title: 'Operations', primary: snapshot.operations.total, secondary: `${snapshot.operations.active} active`, path: '/operations' },
    { icon: WaterDropOutlinedIcon, title: 'Irrigation', primary: snapshot.irrigation.total, secondary: `${snapshot.irrigation.active} active`, path: '/irrigation' },
    { icon: SanitizerOutlinedIcon, title: 'Spray Programme', primary: snapshot.spray.total, secondary: `${snapshot.spray.active} active`, path: '/spray-programme' },
    { icon: AgricultureOutlinedIcon, title: 'Harvest', primary: snapshot.harvest.total, secondary: `${formatNumber(snapshot.harvest.totalYield)} t total yield`, path: '/harvest' },
    { icon: PrecisionManufacturingOutlinedIcon, title: 'Machinery', primary: snapshot.machinery.total, secondary: `${snapshot.machinery.operational} operational · ${snapshot.machinery.needsAttention} need attention`, path: '/machinery' },
    { icon: EventNoteOutlinedIcon, title: 'Planner', primary: snapshot.planner.total, secondary: `${snapshot.planner.open} open tasks`, path: '/planner' },
  ] : [];

  return (
    <PageContainer>
      <Typography variant="h2" component="h1" sx={{ mb: 0.5 }}>Reports</Typography>
      <Typography variant="body1" sx={{ color: 'text.secondary', mb: 4 }}>
        A real-time summary of activity across your vineyard operation.
      </Typography>

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
          <Grid container spacing={{ xs: 2, md: 3 }}>
            {cards.map((c) => (
              <Grid item xs={12} sm={6} lg={3} key={c.title}>
                <MetricCard icon={c.icon} title={c.title} primary={c.primary} secondary={c.secondary} onClick={() => navigate(c.path)} />
              </Grid>
            ))}
          </Grid>

          {/* Finance summary */}
          <Typography variant="h4" component="h2" sx={{ mt: 5, mb: 2 }}>Finance Summary</Typography>
          <Paper sx={{ p: { xs: 2.5, md: 3 } }}>
            <Grid container spacing={3}>
              <Grid item xs={12} sm={4}>
                <Typography variant="overline" sx={{ display: 'block' }}>Income</Typography>
                <Typography variant="h4" component="p" sx={{ color: 'success.main', fontWeight: 700 }}>{formatCurrency(snapshot.finance.income)}</Typography>
              </Grid>
              <Grid item xs={12} sm={4}>
                <Typography variant="overline" sx={{ display: 'block' }}>Expenses</Typography>
                <Typography variant="h4" component="p" sx={{ color: 'secondary.main', fontWeight: 700 }}>{formatCurrency(snapshot.finance.expense)}</Typography>
              </Grid>
              <Grid item xs={12} sm={4}>
                <Typography variant="overline" sx={{ display: 'block' }}>Net</Typography>
                <Typography variant="h4" component="p" sx={{ color: snapshot.finance.net >= 0 ? 'success.main' : 'error.main', fontWeight: 700 }}>{formatCurrency(snapshot.finance.net)}</Typography>
              </Grid>
            </Grid>
            <Divider sx={{ my: 2 }} />
            <Button size="small" onClick={() => navigate('/finance')}>Open Finance</Button>
          </Paper>
        </>
      )}
    </PageContainer>
  );
}

export default Reports;
