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
 * Spray programme table for the desktop layout.
 *
 * @param {Array} records - Normalised spray programmes (incl. vineyardName/blockName).
 * @param {function} onView
 * @param {function} onEdit
 * @param {function} onDelete
 */
function SprayProgrammeTable({ records, onView, onEdit, onDelete }) {
  return (
    <TableContainer component={Paper} variant="outlined">
      <Table sx={{ minWidth: 720 }} aria-label="Spray Programme">
        <TableHead>
          <TableRow>
            <TableCell>Spray Programme</TableCell>
            <TableCell>Vineyard</TableCell>
            <TableCell>Block</TableCell>
            <TableCell>Status</TableCell>
            <TableCell>Created</TableCell>
            <TableCell align="right">Actions</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {records.map((r) => (
            <TableRow key={r.id} hover>
              <TableCell>
                <Link
                  component="button"
                  type="button"
                  underline="hover"
                  onClick={() => onView?.(r)}
                  sx={{ color: 'primary.main', fontWeight: 600, textAlign: 'left' }}
                >
                  {r.title}
                </Link>
              </TableCell>
              <TableCell sx={{ color: 'text.secondary' }}>
                {r.vineyardName || '—'}
              </TableCell>
              <TableCell sx={{ color: 'text.secondary' }}>
                {r.blockName || '—'}
              </TableCell>
              <TableCell>
                {r.status ? (
                  <Chip
                    label={r.status}
                    size="small"
                    color={statusChipColor(r.status)}
                    sx={{ textTransform: 'capitalize' }}
                  />
                ) : (
                  '—'
                )}
              </TableCell>
              <TableCell sx={{ color: 'text.secondary' }}>
                {formatDate(r.createdAt)}
              </TableCell>
              <TableCell align="right">
                <Box sx={{ display: 'inline-flex' }}>
                  <Tooltip title="View">
                    <IconButton
                      size="small"
                      aria-label={`View ${r.title}`}
                      onClick={() => onView?.(r)}
                    >
                      <VisibilityOutlinedIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Edit">
                    <IconButton
                      size="small"
                      aria-label={`Edit ${r.title}`}
                      onClick={() => onEdit?.(r)}
                    >
                      <EditOutlinedIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Delete">
                    <IconButton
                      size="small"
                      color="error"
                      aria-label={`Delete ${r.title}`}
                      onClick={() => onDelete?.(r)}
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

export default SprayProgrammeTable;
