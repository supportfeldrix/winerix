import {
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Paper, Chip,
  IconButton, Tooltip, Link, Box, Typography,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined';
import AgricultureOutlinedIcon from '@mui/icons-material/AgricultureOutlined';
import TerrainOutlinedIcon from '@mui/icons-material/TerrainOutlined';
import { formatDate, formatNumber, activityStatusColor } from '../common/formatters';

/**
 * Premium harvest table for the desktop layout. Columns/values unchanged
 * (Harvest / Vineyard / Block / Date / Yield / Status / Actions).
 * @param {Array} records - Normalised harvest records.
 */
function HarvestTable({ records, onView, onEdit, onDelete }) {
  return (
    <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 3, overflow: 'hidden' }}>
      <Table sx={{ minWidth: 760 }} aria-label="Harvest">
        <TableHead>
          <TableRow>
            <TableCell>Harvest</TableCell>
            <TableCell>Vineyard</TableCell>
            <TableCell>Block</TableCell>
            <TableCell>Date</TableCell>
            <TableCell align="right">Yield</TableCell>
            <TableCell>Status</TableCell>
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
                      color: 'accent.main', bgcolor: (t) => alpha(t.palette.accent.main, 0.14),
                    }}
                  >
                    <AgricultureOutlinedIcon sx={{ fontSize: '1.1rem' }} />
                  </Box>
                  <Link component="button" type="button" underline="hover" onClick={() => onView?.(r)}
                    sx={{ color: 'primary.main', fontWeight: 600, textAlign: 'left' }}>{r.title}</Link>
                </Box>
              </TableCell>
              <TableCell>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, color: 'text.secondary' }}>
                  <TerrainOutlinedIcon sx={{ fontSize: '1rem' }} />
                  <Typography variant="body2" noWrap>{r.vineyardName || '—'}</Typography>
                </Box>
              </TableCell>
              <TableCell sx={{ color: 'text.secondary' }}>{r.blockName || '—'}</TableCell>
              <TableCell sx={{ color: 'text.secondary' }}>{formatDate(r.harvestDate)}</TableCell>
              <TableCell align="right" sx={{ fontWeight: 600 }}>{r.yieldTons != null ? `${formatNumber(r.yieldTons)} t` : '—'}</TableCell>
              <TableCell>
                {r.status ? <Chip label={r.status} size="small" color={activityStatusColor(r.status)} sx={{ textTransform: 'capitalize', fontWeight: 600 }} /> : '—'}
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

export default HarvestTable;
