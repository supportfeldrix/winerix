import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  Chip,
  IconButton,
  Tooltip,
  Link,
  Box,
} from '@mui/material';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined';

function formatDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function statusChipColor(status) {
  const s = (status || '').toLowerCase();
  if (s === 'active') return 'primary';
  if (s === 'planned') return 'secondary';
  return 'default';
}

/**
 * Operation table for the desktop layout.
 *
 * @param {Array} operations - Normalised operations (incl. vineyardName/blockName).
 * @param {function} onView
 * @param {function} onEdit
 * @param {function} onDelete
 */
function OperationTable({ operations, onView, onEdit, onDelete }) {
  return (
    <TableContainer component={Paper} variant="outlined">
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
            <TableRow key={o.id} hover>
              <TableCell>
                <Link
                  component="button"
                  type="button"
                  underline="hover"
                  onClick={() => onView?.(o)}
                  sx={{ color: 'primary.main', fontWeight: 600, textAlign: 'left' }}
                >
                  {o.title}
                </Link>
              </TableCell>
              <TableCell sx={{ color: 'text.secondary' }}>
                {o.vineyardName || '—'}
              </TableCell>
              <TableCell sx={{ color: 'text.secondary' }}>
                {o.blockName || '—'}
              </TableCell>
              <TableCell>
                {o.status ? (
                  <Chip
                    label={o.status}
                    size="small"
                    color={statusChipColor(o.status)}
                    sx={{ textTransform: 'capitalize' }}
                  />
                ) : (
                  '—'
                )}
              </TableCell>
              <TableCell sx={{ color: 'text.secondary' }}>
                {formatDate(o.createdAt)}
              </TableCell>
              <TableCell align="right">
                <Box sx={{ display: 'inline-flex' }}>
                  <Tooltip title="View">
                    <IconButton
                      size="small"
                      aria-label={`View ${o.title}`}
                      onClick={() => onView?.(o)}
                    >
                      <VisibilityOutlinedIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Edit">
                    <IconButton
                      size="small"
                      aria-label={`Edit ${o.title}`}
                      onClick={() => onEdit?.(o)}
                    >
                      <EditOutlinedIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Delete">
                    <IconButton
                      size="small"
                      color="error"
                      aria-label={`Delete ${o.title}`}
                      onClick={() => onDelete?.(o)}
                    >
                      <DeleteOutlineOutlinedIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
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
