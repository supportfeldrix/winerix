import {
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Paper, Chip,
  IconButton, Tooltip, Box, Typography,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import OpenInNewOutlinedIcon from '@mui/icons-material/OpenInNewOutlined';
import BiotechOutlinedIcon from '@mui/icons-material/BiotechOutlined';
import { formatDate } from '../common/formatters';
import { labSampleTypeLabel, labSampleStatusLabel } from '../../services/labSampleService';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Lab Samples table (desktop/tablet layout)
// Columns: Sample Code / Wine Lot / Sample Type / Sampled At / Status /
// Reviewed / Actions. Samples are historical laboratory events — there is NO
// delete action (Open opens the sample profile). Mirrors the existing table
// conventions (CultivarTable / WineLotTable).
// ─────────────────────────────────────────────────────────────────────────────

// Map a sample quality/review status to a MUI chip colour.
export function sampleStatusColor(status) {
  switch (status) {
    case 'within_spec': return 'success';
    case 'released': return 'primary';
    case 'attention': return 'warning';
    case 'hold': return 'error';
    case 'pending': return 'secondary';
    default: return 'default';
  }
}

function LabSampleTable({ samples, onOpen }) {
  return (
    <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 3, overflowX: 'auto' }}>
      <Table sx={{ minWidth: 860 }} aria-label="Lab samples">
        <TableHead>
          <TableRow>
            <TableCell>Sample Code</TableCell>
            <TableCell>Wine Lot</TableCell>
            <TableCell>Sample Type</TableCell>
            <TableCell>Sampled At</TableCell>
            <TableCell>Status</TableCell>
            <TableCell>Reviewed</TableCell>
            <TableCell align="right">Actions</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {samples.map((s) => (
            <TableRow key={s.id} hover sx={{ '& .MuiTableCell-root': { py: 1.75 }, cursor: 'pointer' }} onClick={() => onOpen?.(s)}>
              <TableCell>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
                  <Box
                    sx={{
                      width: 34, height: 34, borderRadius: 1.5, flexShrink: 0,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: 'secondary.main', bgcolor: (t) => alpha(t.palette.secondary.main, 0.12),
                    }}
                  >
                    <BiotechOutlinedIcon sx={{ fontSize: '1.1rem' }} />
                  </Box>
                  <Typography variant="body2" sx={{ fontWeight: 600, color: 'text.primary' }}>
                    {s.sampleCode || '—'}
                  </Typography>
                </Box>
              </TableCell>
              <TableCell>
                <Typography variant="body2" sx={{ color: 'text.primary' }}>{s.lotCode || '—'}</Typography>
              </TableCell>
              <TableCell>
                <Typography variant="body2" sx={{ color: 'text.secondary' }}>{labSampleTypeLabel(s.sampleType)}</Typography>
              </TableCell>
              <TableCell>
                <Typography variant="body2" sx={{ color: 'text.secondary' }}>{formatDate(s.sampledAt)}</Typography>
              </TableCell>
              <TableCell>
                <Chip
                  label={labSampleStatusLabel(s.status)}
                  size="small"
                  color={sampleStatusColor(s.status)}
                  sx={{ fontWeight: 600 }}
                />
              </TableCell>
              <TableCell>
                {s.reviewedAt
                  ? <Typography variant="body2" sx={{ color: 'text.secondary' }}>{formatDate(s.reviewedAt)}</Typography>
                  : <Typography variant="body2" sx={{ color: 'text.disabled' }}>Not reviewed</Typography>}
              </TableCell>
              <TableCell align="right">
                <Tooltip title="Open">
                  <IconButton
                    size="small"
                    aria-label={`Open sample ${s.sampleCode || ''}`.trim()}
                    onClick={(e) => { e.stopPropagation(); onOpen?.(s); }}
                  >
                    <OpenInNewOutlinedIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

export default LabSampleTable;
