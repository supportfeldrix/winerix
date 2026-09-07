import {
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Paper, Chip,
  IconButton, Tooltip, Link, Box, Typography,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined';
import HandymanOutlinedIcon from '@mui/icons-material/HandymanOutlined';
import TerrainOutlinedIcon from '@mui/icons-material/TerrainOutlined';
import { formatDate, activityStatusColor } from '../common/formatters';

/**
 * Premium operation table for the desktop layout — matches the Vineyards/Blocks
 * tables: rounded outlined surface, cream header, generous row spacing, refined
 * status badges, consistent view/edit/delete actions. Columns unchanged.
 *
 * @param {Array} operations - Normalised operations (incl. vineyardName/blockName).
 */
function OperationTable({ operations, onView, onEdit, onDelete }) {
  return (
    <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 3, overflow: 'hidden' }}>
      <Table sx={{ minWidth: 720 }} aria-label="Operations">
        <TableHead>
          <TableRow>
            <TableCell>Operation</TableCell>
            <TableCell>Vineyard</TableCell>
            <TableCell>Block</TableCell>
            <TableCell>Status</TableCell>
            <TableCell>Created</TableCell>
            <TableCell align="right">Actions</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {operations.map((o) => (
            <TableRow key={o.id} hover sx={{ '& .MuiTableCell-root': { py: 1.75 } }}>
              <TableCell>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
                  <Box
                    sx={{
                      width: 34, height: 34, borderRadius: 1.5, flexShrink: 0,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: 'primary.main', bgcolor: (t) => alpha(t.palette.primary.main, 0.1),
                    }}
                  >
                    <HandymanOutlinedIcon sx={{ fontSize: '1.1rem' }} />
                  </Box>
                  <Link component="button" type="button" underline="hover" onClick={() => onView?.(o)}
                    sx={{ color: 'primary.main', fontWeight: 600, textAlign: 'left' }}>
                    {o.title}
                  </Link>
                </Box>
              </TableCell>
              <TableCell>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, color: 'text.secondary' }}>
                  <TerrainOutlinedIcon sx={{ fontSize: '1rem' }} />
                  <Typography variant="body2" noWrap>{o.vineyardName || '—'}</Typography>
                </Box>
              </TableCell>
              <TableCell sx={{ color: 'text.secondary' }}>{o.blockName || '—'}</TableCell>
              <TableCell>
                {o.status ? (
                  <Chip label={o.status} size="small" color={activityStatusColor(o.status)}
                    sx={{ textTransform: 'capitalize', fontWeight: 600 }} />
                ) : '—'}
              </TableCell>
              <TableCell sx={{ color: 'text.secondary' }}>{formatDate(o.createdAt)}</TableCell>
              <TableCell align="right">
                <Box sx={{ display: 'inline-flex' }}>
                  <Tooltip title="View"><IconButton size="small" aria-label={`View ${o.title}`} onClick={() => onView?.(o)}><VisibilityOutlinedIcon fontSize="small" /></IconButton></Tooltip>
                  <Tooltip title="Edit"><IconButton size="small" aria-label={`Edit ${o.title}`} onClick={() => onEdit?.(o)}><EditOutlinedIcon fontSize="small" /></IconButton></Tooltip>
                  <Tooltip title="Delete"><IconButton size="small" color="error" aria-label={`Delete ${o.title}`} onClick={() => onDelete?.(o)}><DeleteOutlineOutlinedIcon fontSize="small" /></IconButton></Tooltip>
                </Box>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

export default OperationTable;
