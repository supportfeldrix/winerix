import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Paper, Typography, Chip, Button, Skeleton, Alert, Link, Stack,
  Table, TableHead, TableBody, TableRow, TableCell, TableContainer,
} from '@mui/material';
import ReportProblemOutlinedIcon from '@mui/icons-material/ReportProblemOutlined';
import { formatDate } from '../common/formatters';
import { getAlertsForWineLot, friendlyLabAlertError } from '../../services/labAlertService';
import { alertStatusDisplay, alertTypeLabel } from './labAlertDisplay';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Laboratory Alerts section on the Wine Lot Profile (compact, read-only)
// Loads lot-scoped alerts in a SINGLE service query (getAlertsForWineLot) — no
// per-sample fan-out. Shows open/acknowledged counts + recent alerts, each
// linking to the alert profile. Lifecycle actions live on the alert profile;
// this section never duplicates lifecycle logic. Self-contained loading/error/
// empty so a failed alert query never breaks the rest of WineLotProfile.
// Reloads when the lot id changes (and thus on org switch, as the parent
// profile re-mounts/reloads on organisation change).
// ─────────────────────────────────────────────────────────────────────────────

const RECENT_LIMIT = 5;

function WineLotAlertsSection({ wineLotId }) {
  const navigate = useNavigate();
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!wineLotId) return;
    setLoading(true); setError('');
    const { data, error: err } = await getAlertsForWineLot(wineLotId);
    if (err) {
      const friendly = friendlyLabAlertError(err);
      if (/not set up yet/i.test(friendly)) setAlerts([]); else setError(friendly);
    } else {
      setAlerts(data || []);
    }
    setLoading(false);
  }, [wineLotId]);

  useEffect(() => { setAlerts([]); load(); }, [load]);

  const openCount = alerts.filter((a) => a.status === 'open').length;
  const acknowledgedCount = alerts.filter((a) => a.status === 'acknowledged').length;
  const recent = alerts.slice(0, RECENT_LIMIT);

  return (
    <Paper variant="outlined" sx={{ borderRadius: 3, p: { xs: 2.5, md: 3.5 }, mt: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2, flexWrap: 'wrap' }}>
        <ReportProblemOutlinedIcon sx={{ color: 'secondary.main' }} />
        <Typography variant="h5" component="h2">Laboratory Alerts</Typography>
        {!loading && !error && (
          <Stack direction="row" spacing={1} sx={{ ml: 'auto' }}>
            <Chip label={`${openCount} open`} size="small" color={openCount > 0 ? 'error' : 'default'} sx={{ fontWeight: 600 }} />
            <Chip label={`${acknowledgedCount} acknowledged`} size="small" color={acknowledgedCount > 0 ? 'warning' : 'default'} sx={{ fontWeight: 600 }} />
          </Stack>
        )}
      </Box>

      {error && <Alert severity="error" sx={{ mb: 2 }} action={<Button color="inherit" size="small" onClick={load}>Retry</Button>} onClose={() => setError('')}>{error}</Alert>}

      {loading ? (
        <Box>
          {[0, 1].map((i) => (
            <Box key={i} sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 1 }}>
              <Skeleton width="30%" height={22} /><Skeleton width="15%" height={22} /><Skeleton width="20%" height={22} sx={{ ml: 'auto' }} />
            </Box>
          ))}
        </Box>
      ) : alerts.length === 0 ? (
        <Paper variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'background.subtle', px: 3, py: 3, textAlign: 'center' }}>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>No laboratory alerts</Typography>
        </Paper>
      ) : (
        <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 2, overflowX: 'auto' }}>
          <Table sx={{ minWidth: 640 }} aria-label="Wine lot laboratory alerts">
            <TableHead>
              <TableRow>
                <TableCell>Alert</TableCell>
                <TableCell>Measurement</TableCell>
                <TableCell>Specification</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Triggered</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {recent.map((a) => {
                const status = alertStatusDisplay(a.status);
                const measured = a.measurementValue !== null && a.measurementValue !== undefined
                  ? `${a.measurementValue}${a.measurementUnit ? ` ${a.measurementUnit}` : ''}` : '—';
                return (
                  <TableRow key={a.id} hover sx={{ '& .MuiTableCell-root': { py: 1.5 } }}>
                    <TableCell><Typography variant="body2" sx={{ fontWeight: 600 }}>{alertTypeLabel(a.alertType)}</Typography></TableCell>
                    <TableCell><Typography variant="body2" sx={{ color: 'text.secondary' }}>{measured}</Typography></TableCell>
                    <TableCell><Typography variant="body2" sx={{ color: 'text.secondary' }}>{a.specificationName || '—'}</Typography></TableCell>
                    <TableCell><Chip label={status.label} size="small" color={status.color} sx={{ fontWeight: 600 }} /></TableCell>
                    <TableCell><Typography variant="body2" sx={{ color: 'text.secondary' }}>{formatDate(a.triggeredAt)}</Typography></TableCell>
                    <TableCell align="right">
                      <Link component="button" type="button" variant="body2" underline="hover" onClick={() => navigate(`/lab/alerts/${a.id}`)}>Open</Link>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {!loading && !error && alerts.length > recent.length && (
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 1 }}>
          Showing the {recent.length} most recent of {alerts.length} alerts.
        </Typography>
      )}
    </Paper>
  );
}

export default WineLotAlertsSection;
