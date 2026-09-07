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
 * Vineyard table for the desktop layout.
 *
 * @param {Array} vineyards - Normalised vineyards.
 * @param {function} onView
 * @param {function} onEdit
 * @param {function} onDelete
 */
function VineyardTable({ vineyards, onView, onEdit, onDelete }) {
  return (
    <TableContainer component={Paper} variant="outlined">
      <Table sx={{ minWidth: 640 }} aria-label="Vineyards">
        <TableHead>
          <TableRow>
            <TableCell>Name</TableCell>
            <TableCell>Location</TableCell>
            <TableCell align="right">Area</TableCell>
            <TableCell align="right">Blocks</TableCell>
            <TableCell>Status</TableCell>
            <TableCell align="right">Actions</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {vineyards.map((v) => (
            <TableRow key={v.id} hover>
              <TableCell>
                <Link
                  component="button"
                  type="button"
                  underline="hover"
                  onClick={() => onView?.(v)}
                  sx={{
                    color: 'primary.main',
                    fontWeight: 600,
                    textAlign: 'left',
                  }}
                >
                  {v.name}
                </Link>
              </TableCell>
              <TableCell sx={{ color: 'text.secondary' }}>
                {v.location || '—'}
              </TableCell>
              <TableCell align="right">{formatHectares(v.areaHectares)}</TableCell>
              <TableCell align="right">{v.blockCount ?? '—'}</TableCell>
              <TableCell>
                {v.status ? (
                  <Chip
                    label={v.status}
                    size="small"
                    color={statusChipColor(v.status)}
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
                      aria-label={`View ${v.name}`}
                      onClick={() => onView?.(v)}
                    >
                      <VisibilityOutlinedIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Edit">
                    <IconButton
                      size="small"
                      aria-label={`Edit ${v.name}`}
                      onClick={() => onEdit?.(v)}
                    >
                      <EditOutlinedIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Delete">
                    <IconButton
                      size="small"
                      color="error"
                      aria-label={`Delete ${v.name}`}
                      onClick={() => onDelete?.(v)}
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

export default VineyardTable;
