import {
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Paper, Chip,
  IconButton, Tooltip, Box, Typography,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import OpenInNewOutlinedIcon from '@mui/icons-material/OpenInNewOutlined';
import ReportProblemOutlinedIcon from '@mui/icons-material/ReportProblemOutlined';
import { formatDate } from '../common/formatters';
import { alertStatusDisplay, alertTypeLabel, alertClassLabel } from './labAlertDisplay';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Laboratory Alerts table (desktop/tablet layout)
// Columns: Alert / Measurement / Sample / Analyte / Status / Triggered / Actions.
// Context comes from the alert service's joined response (sample code, analyte,
// measurement) — no extra queries. Open opens the alert profile. Lifecycle
// actions live on the profile, not inline. No colour-only indicators.
// ─────────────────────────────────────────────────────────────────────────────

function LabAlertTable({ alerts, onOpen }) {
  return (
    <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 3, overflowX: 'auto' }}>
      <Table sx={{ minWidth: 920 }} aria-label="Laboratory alerts">
        <TableHead>
          <TableRow>
            <TableCell>Alert</TableCell>
            <TableCell>Measurement</TableCell>
            <TableCell>Sample</TableCell>
            <TableCell>Analyte</TableCell>
            <TableCell>Status</TableCell>
            <TableCell>Triggered</TableCell>
            <TableCell align="right">Actions</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {alerts.map((a) => {
            const status = alertStatusDisplay(a.status);
            const measured = a.measurementValue !== null && a.measurementValue !== undefined
              ? `${a.measurementValue}${a.measurementUnit ? ` ${a.measurementUnit}` : ''}`
              : '—';
            return (
              <TableRow key={a.id} hover sx={{ '& .MuiTableCell-root': { py: 1.75 }, cursor: 'pointer' }} onClick={() => onOpen?.(a)}>
                <TableCell>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
                    <Box
                      sx={{
                        width: 34, height: 34, borderRadius: 1.5, flexShrink: 0,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        color: 'secondary.main', bgcolor: (t) => alpha(t.palette.secondary.main, 0.12),
                      }}
                    >
                      <ReportProblemOutlinedIcon sx={{ fontSize: '1.1rem' }} />
                    </Box>
                    <Box>
                      <Typography variant="body2" sx={{ fontWeight: 600, color: 'text.primary' }}>{alertTypeLabel(a.alertType)}</Typography>
                      <Typography variant="caption" sx={{ color: 'text.secondary' }}>{alertClassLabel(a.alertClass)}</Typography>
                    </Box>
                  </Box>
                </TableCell>
                <TableCell>
                  <Typography variant="body2" sx={{ color: 'text.primary' }}>{measured}</Typography>
                </TableCell>
                <TableCell>
                  <Typography variant="body2" sx={{ color: 'text.secondary' }}>{a.sampleCode || '—'}</Typography>
                </TableCell>
                <TableCell>
                  <Typography variant="body2" sx={{ color: 'text.secondary' }}>{a.analyteDisplayName || a.analyteCode || '—'}</Typography>
                </TableCell>
                <TableCell>
                  <Chip label={status.label} size="small" color={status.color} sx={{ fontWeight: 600 }} />
                </TableCell>
                <TableCell>
                  <Typography variant="body2" sx={{ color: 'text.secondary' }}>{formatDate(a.triggeredAt)}</Typography>
                </TableCell>
                <TableCell align="right">
                  <Tooltip title="Open">
                    <IconButton size="small" aria-label={`Open alert ${alertTypeLabel(a.alertType)}`} onClick={(e) => { e.stopPropagation(); onOpen?.(a); }}>
                      <OpenInNewOutlinedIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

export default LabAlertTable;
