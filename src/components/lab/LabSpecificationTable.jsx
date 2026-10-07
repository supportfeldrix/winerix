import {
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Paper, Chip,
  IconButton, Tooltip, Box, Typography,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import BlockOutlinedIcon from '@mui/icons-material/BlockOutlined';
import RestartAltOutlinedIcon from '@mui/icons-material/RestartAltOutlined';
import HistoryOutlinedIcon from '@mui/icons-material/HistoryOutlined';
import RuleOutlinedIcon from '@mui/icons-material/RuleOutlined';
import { formatDate } from '../common/formatters';
import { labSampleTypeLabel } from '../../services/labSpecificationService';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Lab Specifications table (desktop/tablet layout)
// Columns: Specification / Analyte / Sample Type / Range / Target / Unit /
// Effective From / Effective To / Status / Actions. Specifications are retained
// reference data — actions are Edit, Retire/Reactivate and Create New Version
// (never a physical delete). Mirrors the existing lab table conventions.
// ─────────────────────────────────────────────────────────────────────────────

// Format the stored min/max into a human range string. Pure display of stored
// values — no mathematical interpretation beyond presence/absence.
export function formatSpecRange(spec) {
  const hasMin = spec.minValue !== null && spec.minValue !== undefined;
  const hasMax = spec.maxValue !== null && spec.maxValue !== undefined;
  if (hasMin && hasMax) return `${spec.minValue} – ${spec.maxValue}`;
  if (hasMin) return `≥ ${spec.minValue}`;
  if (hasMax) return `≤ ${spec.maxValue}`;
  return '—';
}

// Format the target separately (shown in its own column).
export function formatSpecTarget(spec) {
  if (spec.targetValue !== null && spec.targetValue !== undefined) return `Target ${spec.targetValue}`;
  return '—';
}

function LabSpecificationTable({ specifications, onEdit, onRetire, onReactivate, onNewVersion }) {
  return (
    <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 3, overflowX: 'auto' }}>
      <Table sx={{ minWidth: 1040 }} aria-label="Lab specifications">
        <TableHead>
          <TableRow>
            <TableCell>Specification</TableCell>
            <TableCell>Analyte</TableCell>
            <TableCell>Sample Type</TableCell>
            <TableCell>Range</TableCell>
            <TableCell>Target</TableCell>
            <TableCell>Unit</TableCell>
            <TableCell>Effective From</TableCell>
            <TableCell>Effective To</TableCell>
            <TableCell>Status</TableCell>
            <TableCell align="right">Actions</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {specifications.map((s) => (
            <TableRow key={s.id} hover sx={{ '& .MuiTableCell-root': { py: 1.75 }, opacity: s.isActive ? 1 : 0.6 }}>
              <TableCell>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
                  <Box
                    sx={{
                      width: 34, height: 34, borderRadius: 1.5, flexShrink: 0,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: 'secondary.main', bgcolor: (t) => alpha(t.palette.secondary.main, 0.12),
                    }}
                  >
                    <RuleOutlinedIcon sx={{ fontSize: '1.1rem' }} />
                  </Box>
                  <Typography variant="body2" sx={{ fontWeight: 600, color: 'text.primary' }}>{s.name}</Typography>
                </Box>
              </TableCell>
              <TableCell>
                <Typography variant="body2" sx={{ color: 'text.primary' }}>{s.analyteDisplayName || s.analyteCode || '—'}</Typography>
                {s.analyteCode && s.analyteDisplayName && s.analyteCode !== s.analyteDisplayName && (
                  <Typography variant="caption" sx={{ color: 'text.secondary' }}>{s.analyteCode}</Typography>
                )}
              </TableCell>
              <TableCell>
                <Typography variant="body2" sx={{ color: 'text.secondary' }}>{labSampleTypeLabel(s.sampleType)}</Typography>
              </TableCell>
              <TableCell>
                <Typography variant="body2" sx={{ color: 'text.primary' }}>{formatSpecRange(s)}</Typography>
              </TableCell>
              <TableCell>
                <Typography variant="body2" sx={{ color: 'text.secondary' }}>{formatSpecTarget(s)}</Typography>
              </TableCell>
              <TableCell>
                <Typography variant="body2" sx={{ color: 'text.secondary' }}>{s.unit || '—'}</Typography>
              </TableCell>
              <TableCell>
                <Typography variant="body2" sx={{ color: 'text.secondary' }}>{formatDate(s.effectiveFrom)}</Typography>
              </TableCell>
              <TableCell>
                {s.effectiveTo
                  ? <Typography variant="body2" sx={{ color: 'text.secondary' }}>{formatDate(s.effectiveTo)}</Typography>
                  : <Typography variant="body2" sx={{ color: 'text.disabled' }}>—</Typography>}
              </TableCell>
              <TableCell>
                <Chip
                  label={s.isActive ? 'Active' : 'Retired'}
                  size="small"
                  color={s.isActive ? 'success' : 'default'}
                  sx={{ fontWeight: 600 }}
                />
              </TableCell>
              <TableCell align="right">
                <Box sx={{ display: 'inline-flex' }}>
                  <Tooltip title="Edit">
                    <IconButton size="small" aria-label={`Edit ${s.name}`} onClick={() => onEdit?.(s)}>
                      <EditOutlinedIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Create new version">
                    <IconButton size="small" color="primary" aria-label={`Create new version of ${s.name}`} onClick={() => onNewVersion?.(s)}>
                      <HistoryOutlinedIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  {s.isActive ? (
                    <Tooltip title="Retire">
                      <IconButton size="small" color="error" aria-label={`Retire ${s.name}`} onClick={() => onRetire?.(s)}>
                        <BlockOutlinedIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  ) : (
                    <Tooltip title="Reactivate">
                      <IconButton size="small" color="primary" aria-label={`Reactivate ${s.name}`} onClick={() => onReactivate?.(s)}>
                        <RestartAltOutlinedIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  )}
                </Box>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

export default LabSpecificationTable;
