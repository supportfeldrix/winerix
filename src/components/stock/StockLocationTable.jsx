import {
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Paper, Chip,
  IconButton, Tooltip, Box, Typography,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import BlockOutlinedIcon from '@mui/icons-material/BlockOutlined';
import RestartAltOutlinedIcon from '@mui/icons-material/RestartAltOutlined';
import WarehouseOutlinedIcon from '@mui/icons-material/WarehouseOutlined';
import { stockLocationTypeLabel } from '../../services/stockLocationService';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Stock Locations table (P2K-3, desktop/tablet layout)
// Columns: Code / Name / Type / Status / Actions. Locations are reference data —
// actions are Edit and Deactivate/Reactivate (never a physical delete). No stock
// quantities, bottles or litres. Pure display; the page owns data access.
// ─────────────────────────────────────────────────────────────────────────────

function StockLocationTable({ locations, onEdit, onDeactivate, onReactivate }) {
  return (
    <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 3, overflowX: 'auto' }}>
      <Table sx={{ minWidth: 760 }} aria-label="Stock locations">
        <TableHead>
          <TableRow>
            <TableCell>Code</TableCell>
            <TableCell>Name</TableCell>
            <TableCell>Type</TableCell>
            <TableCell>Status</TableCell>
            <TableCell align="right">Actions</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {locations.map((l) => (
            <TableRow key={l.id} hover sx={{ '& .MuiTableCell-root': { py: 1.75 }, opacity: l.isActive ? 1 : 0.6 }}>
              <TableCell>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
                  <Box
                    sx={{
                      width: 34, height: 34, borderRadius: 1.5, flexShrink: 0,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: 'secondary.main', bgcolor: (t) => alpha(t.palette.secondary.main, 0.12),
                    }}
                  >
                    <WarehouseOutlinedIcon sx={{ fontSize: '1.1rem' }} />
                  </Box>
                  <Typography variant="body2" sx={{ fontWeight: 600, color: 'text.primary' }}>{l.locationCode}</Typography>
                </Box>
              </TableCell>
              <TableCell>
                <Typography variant="body2" sx={{ color: 'text.primary' }}>{l.name}</Typography>
              </TableCell>
              <TableCell>
                <Typography variant="body2" sx={{ color: 'text.secondary' }}>{stockLocationTypeLabel(l.locationType)}</Typography>
              </TableCell>
              <TableCell>
                <Chip
                  label={l.isActive ? 'Active' : 'Inactive'}
                  size="small"
                  color={l.isActive ? 'success' : 'default'}
                  sx={{ fontWeight: 600 }}
                />
              </TableCell>
              <TableCell align="right">
                <Box sx={{ display: 'inline-flex' }}>
                  <Tooltip title="Edit">
                    <IconButton size="small" aria-label={`Edit ${l.locationCode}`} onClick={() => onEdit?.(l)}>
                      <EditOutlinedIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  {l.isActive ? (
                    <Tooltip title="Deactivate">
                      <IconButton size="small" color="error" aria-label={`Deactivate ${l.locationCode}`} onClick={() => onDeactivate?.(l)}>
                        <BlockOutlinedIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  ) : (
                    <Tooltip title="Reactivate">
                      <IconButton size="small" color="primary" aria-label={`Reactivate ${l.locationCode}`} onClick={() => onReactivate?.(l)}>
                        <RestartAltOutlinedIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  )}
                </Box>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

export default StockLocationTable;
