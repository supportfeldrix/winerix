import {
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Paper, Chip,
  IconButton, Tooltip, Link, Box,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined';
import PrecisionManufacturingOutlinedIcon from '@mui/icons-material/PrecisionManufacturingOutlined';
import { formatDate, activityStatusColor } from '../common/formatters';

/**
 * Premium machinery table for the desktop layout. Columns/values unchanged
 * (Machinery / Category / Registration / Last Service / Status / Actions).
 * @param {Array} records - Normalised machinery.
 */
function MachineryTable({ records, onView, onEdit, onDelete }) {
  return (
    <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 3, overflow: 'hidden' }}>
      <Table sx={{ minWidth: 760 }} aria-label="Machinery">
        <TableHead>
          <TableRow>
            <TableCell>Machinery</TableCell>
            <TableCell>Category</TableCell>
            <TableCell>Registration</TableCell>
            <TableCell>Last Service</TableCell>
            <TableCell>Status</TableCell>
            <TableCell align="right">Actions</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {records.map((r) => (
            <TableRow key={r.id} hover sx={{ '& .MuiTableCell-root': { py: 1.75 } }}>
              <TableCell>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
                  <Box
                    sx={{
                      width: 34, height: 34, borderRadius: 1.5, flexShrink: 0,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: 'primary.main', bgcolor: (t) => alpha(t.palette.primary.main, 0.1),
                    }}
                  >
                    <PrecisionManufacturingOutlinedIcon sx={{ fontSize: '1.1rem' }} />
                  </Box>
                  <Link component="button" type="button" underline="hover" onClick={() => onView?.(r)}
                    sx={{ color: 'primary.main', fontWeight: 600, textAlign: 'left' }}>{r.name}</Link>
                </Box>
              </TableCell>
              <TableCell sx={{ color: 'text.secondary', textTransform: 'capitalize' }}>{r.category || '—'}</TableCell>
              <TableCell sx={{ color: 'text.secondary' }}>{r.registration || '—'}</TableCell>
              <TableCell sx={{ color: 'text.secondary' }}>{formatDate(r.lastServiceDate)}</TableCell>
              <TableCell>
                {r.status ? <Chip label={r.status.replace(/_/g, ' ')} size="small" color={activityStatusColor(r.status)} sx={{ textTransform: 'capitalize', fontWeight: 600 }} /> : '—'}
              </TableCell>
              <TableCell align="right">
                <Box sx={{ display: 'inline-flex' }}>
                  <Tooltip title="View"><IconButton size="small" aria-label={`View ${r.name}`} onClick={() => onView?.(r)}><VisibilityOutlinedIcon fontSize="small" /></IconButton></Tooltip>
                  <Tooltip title="Edit"><IconButton size="small" aria-label={`Edit ${r.name}`} onClick={() => onEdit?.(r)}><EditOutlinedIcon fontSize="small" /></IconButton></Tooltip>
                  <Tooltip title="Delete"><IconButton size="small" color="error" aria-label={`Delete ${r.name}`} onClick={() => onDelete?.(r)}><DeleteOutlineOutlinedIcon fontSize="small" /></IconButton></Tooltip>
                </Box>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

export default MachineryTable;
