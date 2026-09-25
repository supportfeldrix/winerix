import {
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Paper, Chip,
  IconButton, Tooltip, Box, Typography, Link,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined';
import ScienceOutlinedIcon from '@mui/icons-material/ScienceOutlined';

// Wine-batch status → MUI chip colour.
export function batchStatusColor(status) {
  const s = (status || '').toLowerCase();
  if (s === 'active') return 'primary';
  if (s === 'planned') return 'secondary';
  if (s === 'closed') return 'success';
  return 'default'; // discarded
}

/**
 * Wine batches table for the desktop layout.
 * Columns: Batch / Vintage / Status / Actions. Row and code link to the
 * batch profile. Actions are Edit and Delete.
 * @param {Array} batches - normalised wine batch records
 */
function WineBatchTable({ batches, onOpen, onEdit, onDelete }) {
  return (
    <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 3, overflow: 'hidden' }}>
      <Table sx={{ minWidth: 640 }} aria-label="Wine batches">
        <TableHead>
          <TableRow>
            <TableCell>Batch</TableCell>
            <TableCell>Vintage</TableCell>
            <TableCell>Status</TableCell>
            <TableCell align="right">Actions</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {batches.map((b) => (
            <TableRow key={b.id} hover sx={{ '& .MuiTableCell-root': { py: 1.75 }, opacity: b.status === 'discarded' ? 0.6 : 1 }}>
              <TableCell>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
                  <Box
                    sx={{
                      width: 34, height: 34, borderRadius: 1.5, flexShrink: 0,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: 'primary.main', bgcolor: (t) => alpha(t.palette.primary.main, 0.12),
                    }}
                  >
                    <ScienceOutlinedIcon sx={{ fontSize: '1.1rem' }} />
                  </Box>
                  <Box sx={{ minWidth: 0 }}>
                    <Link
                      component="button"
                      type="button"
                      underline="hover"
                      onClick={() => onOpen?.(b)}
                      sx={{ color: 'primary.main', fontWeight: 700, textAlign: 'left' }}
                    >
                      {b.batchCode}
                    </Link>
                    {b.name && (
                      <Typography variant="body2" noWrap sx={{ color: 'text.secondary' }}>{b.name}</Typography>
                    )}
                  </Box>
                </Box>
              </TableCell>
              <TableCell sx={{ color: 'text.secondary' }}>{b.vintage != null ? b.vintage : '—'}</TableCell>
              <TableCell>
                <Chip
                  label={b.status}
                  size="small"
                  color={batchStatusColor(b.status)}
                  sx={{ textTransform: 'capitalize', fontWeight: 600 }}
                />
              </TableCell>
              <TableCell align="right">
                <Box sx={{ display: 'inline-flex' }}>
                  <Tooltip title="Edit"><IconButton size="small" aria-label={`Edit ${b.batchCode}`} onClick={() => onEdit?.(b)}><EditOutlinedIcon fontSize="small" /></IconButton></Tooltip>
                  <Tooltip title="Delete"><IconButton size="small" color="error" aria-label={`Delete ${b.batchCode}`} onClick={() => onDelete?.(b)}><DeleteOutlineOutlinedIcon fontSize="small" /></IconButton></Tooltip>
                </Box>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

export default WineBatchTable;
