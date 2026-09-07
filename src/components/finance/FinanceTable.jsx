import {
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Paper, Chip,
  IconButton, Tooltip, Link, Box,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined';
import TrendingUpOutlinedIcon from '@mui/icons-material/TrendingUpOutlined';
import TrendingDownOutlinedIcon from '@mui/icons-material/TrendingDownOutlined';
import { formatDate, formatCurrency } from '../common/formatters';

function isIncome(type) {
  return (type || '').toLowerCase() === 'income';
}

function typeColor(type) {
  return isIncome(type) ? 'success' : 'secondary';
}

/**
 * Premium finance table for the desktop layout. Columns/values unchanged
 * (Record / Type / Category / Date / Amount / Actions). Income vs expense is
 * distinguished by a tinted directional icon chip and the amount colour.
 * @param {Array} records - Normalised finance records.
 */
function FinanceTable({ records, onView, onEdit, onDelete }) {
  return (
    <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 3, overflow: 'hidden' }}>
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
          {records.map((r) => {
            const income = isIncome(r.type);
            const tone = income ? 'success' : 'secondary';
            const DirIcon = income ? TrendingUpOutlinedIcon : TrendingDownOutlinedIcon;
            return (
              <TableRow key={r.id} hover sx={{ '& .MuiTableCell-root': { py: 1.75 } }}>
                <TableCell>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
                    <Box
                      sx={{
                        width: 34, height: 34, borderRadius: 1.5, flexShrink: 0,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        color: `${tone}.main`, bgcolor: (t) => alpha(t.palette[tone].main, 0.12),
                      }}
                    >
                      <DirIcon sx={{ fontSize: '1.1rem' }} />
                    </Box>
                    <Link component="button" type="button" underline="hover" onClick={() => onView?.(r)}
                      sx={{ color: 'primary.main', fontWeight: 600, textAlign: 'left' }}>{r.title}</Link>
                  </Box>
                </TableCell>
                <TableCell>
                  <Chip label={r.type} size="small" color={typeColor(r.type)} sx={{ textTransform: 'capitalize', fontWeight: 600 }} />
                </TableCell>
                <TableCell sx={{ color: 'text.secondary', textTransform: 'capitalize' }}>{r.category || '—'}</TableCell>
                <TableCell sx={{ color: 'text.secondary' }}>{formatDate(r.entryDate)}</TableCell>
                <TableCell align="right" sx={{ fontWeight: 700, color: income ? 'success.main' : 'text.primary' }}>
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
            );
          })}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

export default FinanceTable;
