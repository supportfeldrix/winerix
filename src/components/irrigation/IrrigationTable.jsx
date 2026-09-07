import {
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Paper, Chip,
  IconButton, Tooltip, Link, Box, Typography,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined';
import WaterDropOutlinedIcon from '@mui/icons-material/WaterDropOutlined';
import TerrainOutlinedIcon from '@mui/icons-material/TerrainOutlined';
import { formatDate, activityStatusColor } from '../common/formatters';

/**
 * Premium irrigation table for the desktop layout. Columns unchanged.
 * @param {Array} records - Normalised irrigation records (incl. vineyardName/blockName).
 */
function IrrigationTable({ records, onView, onEdit, onDelete }) {
  return (
    <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 3, overflow: 'hidden' }}>
      <Table sx={{ minWidth: 720 }} aria-label="Irrigation">
        <TableHead>
          <TableRow>
            <TableCell>Irrigation Activity</TableCell>
            <TableCell>Vineyard</TableCell>
            <TableCell>Block</TableCell>
            <TableCell>Status</TableCell>
            <TableCell>Created</TableCell>
            <TableCell align="right">Actions</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {records.map((r) => (
            <TableRow key={r.id} hover sx={{ '& .MuiTableCell-root': { py: 1.75 } }}>
              <TableCell>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
                  <Box
                    sx={{
                      width: 34, height: 34, borderRadius: 1.5, flexShrink: 0,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: 'info.main', bgcolor: (t) => alpha(t.palette.info.main, 0.1),
                    }}
                  >
                    <WaterDropOutlinedIcon sx={{ fontSize: '1.1rem' }} />
                  </Box>
                  <Link component="button" type="button" underline="hover" onClick={() => onView?.(r)}
                    sx={{ color: 'primary.main', fontWeight: 600, textAlign: 'left' }}>
                    {r.title}
                  </Link>
                </Box>
              </TableCell>
              <TableCell>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, color: 'text.secondary' }}>
                  <TerrainOutlinedIcon sx={{ fontSize: '1rem' }} />
                  <Typography variant="body2" noWrap>{r.vineyardName || '—'}</Typography>
                </Box>
              </TableCell>
              <TableCell sx={{ color: 'text.secondary' }}>{r.blockName || '—'}</TableCell>
              <TableCell>
                {r.status ? (
                  <Chip label={r.status} size="small" color={activityStatusColor(r.status)}
                    sx={{ textTransform: 'capitalize', fontWeight: 600 }} />
                ) : '—'}
              </TableCell>
              <TableCell sx={{ color: 'text.secondary' }}>{formatDate(r.createdAt)}</TableCell>
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

export default IrrigationTable;
