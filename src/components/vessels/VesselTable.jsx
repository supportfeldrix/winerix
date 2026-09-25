import {
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Paper, Chip,
  IconButton, Tooltip, Box, Typography, Link,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined';
import WarningAmberOutlinedIcon from '@mui/icons-material/WarningAmberOutlined';
import PropaneTankOutlinedIcon from '@mui/icons-material/PropaneTankOutlined';
import { formatNumber } from '../common/formatters';
import { VESSEL_TYPES } from '../../services/vesselService';

// Vessel status → MUI chip colour.
export function vesselStatusColor(status) {
  const s = (status || '').toLowerCase();
  if (s === 'active') return 'success';
  if (s === 'maintenance') return 'secondary';
  if (s === 'inactive') return 'default';
  return 'default'; // retired
}

export function vesselTypeLabel(type) {
  const found = VESSEL_TYPES.find((t) => t.value === type);
  return found ? found.label : type || '—';
}

/**
 * Vessels table for the desktop layout.
 * Columns: Vessel / Type / Capacity / Location / Status / Current Volume / Actions.
 * Current volume is derived from open placements (passed in via `volumeByVessel`).
 * @param {Array} vessels - normalised vessel records
 * @param {Record<string, number>} volumeByVessel - vesselId -> occupied litres
 */
function VesselTable({ vessels, volumeByVessel = {}, onOpen, onEdit, onDelete }) {
  return (
    <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 3, overflow: 'hidden' }}>
      <Table sx={{ minWidth: 900 }} aria-label="Vessels">
        <TableHead>
          <TableRow>
            <TableCell>Vessel</TableCell>
            <TableCell>Type</TableCell>
            <TableCell align="right">Capacity</TableCell>
            <TableCell>Location</TableCell>
            <TableCell>Status</TableCell>
            <TableCell align="right">Current Volume</TableCell>
            <TableCell align="right">Actions</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {vessels.map((v) => {
            const current = Number(volumeByVessel[v.id] || 0);
            const overCapacity = v.capacityLitres != null && current > Number(v.capacityLitres);
            return (
              <TableRow key={v.id} hover sx={{ '& .MuiTableCell-root': { py: 1.75 }, opacity: v.status === 'retired' ? 0.6 : 1 }}>
                <TableCell>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
                    <Box
                      sx={{
                        width: 34, height: 34, borderRadius: 1.5, flexShrink: 0,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        color: 'primary.main', bgcolor: (t) => alpha(t.palette.primary.main, 0.12),
                      }}
                    >
                      <PropaneTankOutlinedIcon sx={{ fontSize: '1.1rem' }} />
                    </Box>
                    <Box sx={{ minWidth: 0 }}>
                      <Link component="button" type="button" underline="hover" onClick={() => onOpen?.(v)} sx={{ color: 'primary.main', fontWeight: 700, textAlign: 'left' }}>
                        {v.vesselCode}
                      </Link>
                      {v.name && <Typography variant="body2" noWrap sx={{ color: 'text.secondary' }}>{v.name}</Typography>}
                    </Box>
                  </Box>
                </TableCell>
                <TableCell sx={{ color: 'text.secondary' }}>{vesselTypeLabel(v.vesselType)}</TableCell>
                <TableCell align="right" sx={{ color: 'text.secondary' }}>
                  {v.capacityLitres != null ? `${formatNumber(v.capacityLitres)} L` : '—'}
                </TableCell>
                <TableCell sx={{ color: 'text.secondary' }}>{v.location || '—'}</TableCell>
                <TableCell>
                  <Chip label={v.status} size="small" color={vesselStatusColor(v.status)} sx={{ textTransform: 'capitalize', fontWeight: 600 }} />
                </TableCell>
                <TableCell align="right">
                  <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, justifyContent: 'flex-end' }}>
                    {overCapacity && (
                      <Tooltip title="Exceeds capacity">
                        <WarningAmberOutlinedIcon sx={{ fontSize: '1.05rem', color: 'warning.main' }} />
                      </Tooltip>
                    )}
                    <Typography variant="body2" sx={{ fontWeight: 600, color: overCapacity ? 'warning.main' : 'text.primary' }}>
                      {formatNumber(current)} L
                    </Typography>
                  </Box>
                </TableCell>
                <TableCell align="right">
                  <Box sx={{ display: 'inline-flex' }}>
                    <Tooltip title="Edit"><IconButton size="small" aria-label={`Edit ${v.vesselCode}`} onClick={() => onEdit?.(v)}><EditOutlinedIcon fontSize="small" /></IconButton></Tooltip>
                    <Tooltip title="Delete"><IconButton size="small" color="error" aria-label={`Delete ${v.vesselCode}`} onClick={() => onDelete?.(v)}><DeleteOutlineOutlinedIcon fontSize="small" /></IconButton></Tooltip>
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

export default VesselTable;
