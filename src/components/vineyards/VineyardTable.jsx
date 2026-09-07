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
import TerrainOutlinedIcon from '@mui/icons-material/TerrainOutlined';
import LocationOnOutlinedIcon from '@mui/icons-material/LocationOnOutlined';

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
 * Premium vineyard table for the desktop layout: rounded outlined surface,
 * cream header (from theme), generous row spacing, refined status badge, and
 * consistent view/edit/delete actions.
 *
 * @param {Array} vineyards - Normalised vineyards.
 * @param {function} onView
 * @param {function} onEdit
 * @param {function} onDelete
 */
function VineyardTable({ vineyards, onView, onEdit, onDelete }) {
  return (
    <TableContainer
      component={Paper}
      variant="outlined"
      sx={{ borderRadius: 3, overflow: 'hidden' }}
    >
      <Table sx={{ minWidth: 680 }} aria-label="Vineyards">
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
            <TableRow
              key={v.id}
              hover
              sx={{ '& .MuiTableCell-root': { py: 1.75 } }}
            >
              <TableCell>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
                  <Box
                    sx={{
                      width: 34, height: 34, borderRadius: 1.5, flexShrink: 0,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: 'primary.main',
                      bgcolor: (t) => alpha(t.palette.primary.main, 0.1),
                    }}
                  >
                    <TerrainOutlinedIcon sx={{ fontSize: '1.1rem' }} />
                  </Box>
                  <Link
                    component="button"
                    type="button"
                    underline="hover"
                    onClick={() => onView?.(v)}
                    sx={{ color: 'primary.main', fontWeight: 600, textAlign: 'left' }}
                  >
                    {v.name}
                  </Link>
                </Box>
              </TableCell>
              <TableCell>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, color: 'text.secondary' }}>
                  <LocationOnOutlinedIcon sx={{ fontSize: '1rem' }} />
                  <Typography variant="body2" noWrap>{v.location || '—'}</Typography>
                </Box>
              </TableCell>
              <TableCell align="right" sx={{ fontWeight: 600 }}>{formatHectares(v.areaHectares)}</TableCell>
              <TableCell align="right">{v.blockCount ?? '—'}</TableCell>
              <TableCell>
                {v.status ? (
                  <Chip
                    label={v.status}
                    size="small"
                    color={statusChipColor(v.status)}
                    sx={{ textTransform: 'capitalize', fontWeight: 600 }}
                  />
                ) : (
                  '—'
                )}
              </TableCell>
              <TableCell align="right">
                <Box sx={{ display: 'inline-flex' }}>
                  <Tooltip title="View">
                    <IconButton size="small" aria-label={`View ${v.name}`} onClick={() => onView?.(v)}>
                      <VisibilityOutlinedIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Edit">
                    <IconButton size="small" aria-label={`Edit ${v.name}`} onClick={() => onEdit?.(v)}>
                      <EditOutlinedIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Delete">
                    <IconButton size="small" color="error" aria-label={`Delete ${v.name}`} onClick={() => onDelete?.(v)}>
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
