import {
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Paper, Chip,
  IconButton, Tooltip, Box, Typography, Link,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined';
import WaterOutlinedIcon from '@mui/icons-material/WaterOutlined';
import { formatNumber } from '../common/formatters';

// Wine-lot status → MUI chip colour.
export function lotStatusColor(status) {
  const s = (status || '').toLowerCase();
  if (s === 'active') return 'primary';
  if (s === 'in_production') return 'secondary';
  if (s === 'bottled') return 'success';
  return 'default'; // depleted / archived
}

// Human label for a lot status value.
export function lotStatusLabel(status) {
  const s = (status || '').toLowerCase();
  if (s === 'in_production') return 'In Production';
  if (!s) return '—';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Wine lots table for the desktop layout.
 * Columns: Lot / Batch / Volume / Status / Actions. Lot code links to the
 * lot profile. Actions are Edit and Delete.
 * @param {Array} lots - normalised wine lot records
 */
function WineLotTable({ lots, onOpen, onEdit, onDelete }) {
  return (
    <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 3, overflow: 'hidden' }}>
      <Table sx={{ minWidth: 720 }} aria-label="Wine lots">
        <TableHead>
          <TableRow>
            <TableCell>Lot</TableCell>
            <TableCell>Batch</TableCell>
            <TableCell align="right">Volume</TableCell>
            <TableCell>Status</TableCell>
            <TableCell align="right">Actions</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {lots.map((l) => (
            <TableRow key={l.id} hover sx={{ '& .MuiTableCell-root': { py: 1.75 }, opacity: ['depleted', 'archived'].includes(l.status) ? 0.6 : 1 }}>
              <TableCell>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
                  <Box
                    sx={{
                      width: 34, height: 34, borderRadius: 1.5, flexShrink: 0,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: 'secondary.main', bgcolor: (t) => alpha(t.palette.secondary.main, 0.12),
                    }}
                  >
                    <WaterOutlinedIcon sx={{ fontSize: '1.1rem' }} />
                  </Box>
                  <Link
                    component="button"
                    type="button"
                    underline="hover"
                    onClick={() => onOpen?.(l)}
                    sx={{ color: 'primary.main', fontWeight: 700, textAlign: 'left' }}
                  >
                    {l.lotCode}
                  </Link>
                </Box>
              </TableCell>
              <TableCell sx={{ color: 'text.secondary' }}>
                {l.batchCode || '—'}
                {l.batchVintage != null ? `  ·  ${l.batchVintage}` : ''}
              </TableCell>
              <TableCell align="right" sx={{ fontWeight: 600 }}>
                {l.volumeLitres != null ? `${formatNumber(l.volumeLitres)} L` : '—'}
              </TableCell>
              <TableCell>
                <Chip
                  label={lotStatusLabel(l.status)}
                  size="small"
                  color={lotStatusColor(l.status)}
                  sx={{ fontWeight: 600 }}
                />
              </TableCell>
              <TableCell align="right">
                <Box sx={{ display: 'inline-flex' }}>
                  <Tooltip title="Edit"><IconButton size="small" aria-label={`Edit ${l.lotCode}`} onClick={() => onEdit?.(l)}><EditOutlinedIcon fontSize="small" /></IconButton></Tooltip>
                  <Tooltip title="Delete"><IconButton size="small" color="error" aria-label={`Delete ${l.lotCode}`} onClick={() => onDelete?.(l)}><DeleteOutlineOutlinedIcon fontSize="small" /></IconButton></Tooltip>
                </Box>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

export default WineLotTable;
