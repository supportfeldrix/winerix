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

function formatHectares(value) {
  if (value == null) return '—';
  const n = Number(value) || 0;
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 1 })} ha`;
}

function statusChipColor(status) {
  const s = (status || '').toLowerCase();
  if (s === 'active') return 'primary';
  if (s === 'archived' || s === 'dormant') return 'default';
  return 'secondary';
}

/**
 * Block table for the desktop layout.
 *
 * @param {Array} blocks - Normalised blocks (incl. vineyardName).
 * @param {function} onView
 * @param {function} onEdit
 * @param {function} onDelete
 */
function BlockTable({ blocks, onView, onEdit, onDelete }) {
  return (
    <TableContainer component={Paper} variant="outlined">
      <Table sx={{ minWidth: 640 }} aria-label="Blocks">
        <TableHead>
          <TableRow>
            <TableCell>Block Name</TableCell>
            <TableCell>Vineyard</TableCell>
            <TableCell align="right">Area</TableCell>
            <TableCell>Status</TableCell>
            <TableCell align="right">Actions</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {blocks.map((b) => (
            <TableRow key={b.id} hover>
              <TableCell>
                <Link
                  component="button"
                  type="button"
                  underline="hover"
                  onClick={() => onView?.(b)}
                  sx={{ color: 'primary.main', fontWeight: 600, textAlign: 'left' }}
                >
                  {b.name}
                </Link>
              </TableCell>
              <TableCell sx={{ color: 'text.secondary' }}>
                {b.vineyardName || '—'}
              </TableCell>
              <TableCell align="right">{formatHectares(b.areaHectares)}</TableCell>
              <TableCell>
                {b.status ? (
                  <Chip
                    label={b.status}
                    size="small"
                    color={statusChipColor(b.status)}
                    sx={{ textTransform: 'capitalize' }}
                  />
                ) : (
                  '—'
                )}
              </TableCell>
              <TableCell align="right">
                <Box sx={{ display: 'inline-flex' }}>
                  <Tooltip title="View">
                    <IconButton
                      size="small"
                      aria-label={`View ${b.name}`}
                      onClick={() => onView?.(b)}
                    >
                      <VisibilityOutlinedIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Edit">
                    <IconButton
                      size="small"
                      aria-label={`Edit ${b.name}`}
                      onClick={() => onEdit?.(b)}
                    >
                      <EditOutlinedIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Delete">
                    <IconButton
                      size="small"
                      color="error"
                      aria-label={`Delete ${b.name}`}
                      onClick={() => onDelete?.(b)}
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

export default BlockTable;
