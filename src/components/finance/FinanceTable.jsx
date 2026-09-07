import {
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Paper, Chip,
  IconButton, Tooltip, Link, Box,
} from '@mui/material';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined';
import { formatDate, formatCurrency } from '../common/formatters';

function typeColor(type) {
  return (type || '').toLowerCase() === 'income' ? 'success' : 'secondary';
}

function FinanceTable({ records, onView, onEdit, onDelete }) {
  return (
    <TableContainer component={Paper} variant="outlined">
      <Table sx={{ minWidth: 760 }} aria-label="Finance">
        <TableHead>
          <TableRow>
            <TableCell>Record</TableCell>
            <TableCell>Type</TableCell>
            <TableCell>Category</TableCell>
            <TableCell>Date</TableCell>
            <TableCell align="right">Amount</TableCell>
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
              <TableCell>
                <Chip label={r.type} size="small" color={typeColor(r.type)} sx={{ textTransform: 'capitalize' }} />
              </TableCell>
              <TableCell sx={{ color: 'text.secondary', textTransform: 'capitalize' }}>{r.category || '—'}</TableCell>
              <TableCell sx={{ color: 'text.secondary' }}>{formatDate(r.entryDate)}</TableCell>
              <TableCell align="right" sx={{ fontWeight: 600, color: typeColor(r.type) === 'income' ? 'success.main' : 'text.primary' }}>
                {formatCurrency(r.amount)}
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

export default FinanceTable;
