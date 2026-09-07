import {
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Paper, Chip,
  IconButton, Tooltip, Link, Box,
} from '@mui/material';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined';
import { formatDate, activityStatusColor } from '../common/formatters';

function PlannerTable({ records, onView, onEdit, onDelete }) {
  return (
    <TableContainer component={Paper} variant="outlined">
      <Table sx={{ minWidth: 720 }} aria-label="Planner">
        <TableHead>
          <TableRow>
            <TableCell>Task</TableCell>
            <TableCell>Due Date</TableCell>
            <TableCell>Vineyard</TableCell>
            <TableCell>Block</TableCell>
            <TableCell>Status</TableCell>
            <TableCell align="right">Actions</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {records.map((r) => (
            <TableRow key={r.id} hover>
              <TableCell>
                <Link component="button" type="button" underline="hover" onClick={() => onView?.(r)}
                  sx={{ color: 'primary.main', fontWeight: 600, textAlign: 'left' }}>{r.title}</Link>
              </TableCell>
              <TableCell sx={{ color: 'text.secondary' }}>{formatDate(r.dueDate)}</TableCell>
              <TableCell sx={{ color: 'text.secondary' }}>{r.vineyardName || '—'}</TableCell>
              <TableCell sx={{ color: 'text.secondary' }}>{r.blockName || '—'}</TableCell>
              <TableCell>
                {r.status ? <Chip label={r.status.replace(/_/g, ' ')} size="small" color={activityStatusColor(r.status)} sx={{ textTransform: 'capitalize' }} /> : '—'}
              </TableCell>
              <TableCell align="right">
                <Box sx={{ display: 'inline-flex' }}>
                  <Tooltip title="View"><IconButton size="small" aria-label={`View ${r.title}`} onClick={() => onView?.(r)}><VisibilityOutlinedIcon fontSize="small" /></IconButton></Tooltip>
                  <Tooltip title="Edit"><IconButton size="small" aria-label={`Edit ${r.title}`} onClick={() => onEdit?.(r)}><EditOutlinedIcon fontSize="small" /></IconButton></Tooltip>
                  <Tooltip title="Delete"><IconButton size="small" color="error" aria-label={`Delete ${r.title}`} onClick={() => onDelete?.(r)}><DeleteOutlineOutlinedIcon fontSize="small" /></IconButton></Tooltip>
                </Box>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

export default PlannerTable;
