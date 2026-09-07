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
  Typography,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined';
import GridViewOutlinedIcon from '@mui/icons-material/GridViewOutlined';
import TerrainOutlinedIcon from '@mui/icons-material/TerrainOutlined';

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
 * Premium block table for the desktop layout — matches the Vineyards table:
 * rounded outlined surface, cream header (from theme), generous row spacing,
 * refined status badge, and consistent view/edit/delete actions.
 *
 * @param {Array} blocks - Normalised blocks (incl. vineyardName).
 * @param {function} onView
 * @param {function} onEdit
 * @param {function} onDelete
 */
function BlockTable({ blocks, onView, onEdit, onDelete }) {
  return (
    <TableContainer
      component={Paper}
      variant="outlined"
      sx={{ borderRadius: 3, overflow: 'hidden' }}
    >
      <Table sx={{ minWidth: 680 }} aria-label="Blocks">
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
            <TableRow
              key={b.id}
              hover
              sx={{ '& .MuiTableCell-root': { py: 1.75 } }}
            >
              <TableCell>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
                  <Box
                    sx={{
                      width: 34, height: 34, borderRadius: 1.5, flexShrink: 0,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: 'secondary.main',
                      bgcolor: (t) => alpha(t.palette.secondary.main, 0.1),
                    }}
                  >
                    <GridViewOutlinedIcon sx={{ fontSize: '1.1rem' }} />
                  </Box>
                  <Link
                    component="button"
                    type="button"
                    underline="hover"
                    onClick={() => onView?.(b)}
                    sx={{ color: 'primary.main', fontWeight: 600, textAlign: 'left' }}
                  >
                    {b.name}
                  </Link>
                </Box>
              </TableCell>
              <TableCell>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, color: 'text.secondary' }}>
                  <TerrainOutlinedIcon sx={{ fontSize: '1rem' }} />
                  <Typography variant="body2" noWrap>{b.vineyardName || '—'}</Typography>
                </Box>
              </TableCell>
              <TableCell align="right" sx={{ fontWeight: 600 }}>
                {formatHectares(b.areaHectares)}
              </TableCell>
              <TableCell>
                {b.status ? (
                  <Chip
                    label={b.status}
                    size="small"
                    color={statusChipColor(b.status)}
                    sx={{ textTransform: 'capitalize', fontWeight: 600 }}
                  />
                ) : (
                  '—'
                )}
              </TableCell>
              <TableCell align="right">
                <Box sx={{ display: 'inline-flex' }}>
                  <Tooltip title="View">
                    <IconButton size="small" aria-label={`View ${b.name}`} onClick={() => onView?.(b)}>
                      <VisibilityOutlinedIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Edit">
                    <IconButton size="small" aria-label={`Edit ${b.name}`} onClick={() => onEdit?.(b)}>
                      <EditOutlinedIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Delete">
                    <IconButton size="small" color="error" aria-label={`Delete ${b.name}`} onClick={() => onDelete?.(b)}>
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
