import {
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Paper, Chip,
  IconButton, Tooltip, Box, Typography,
} from '@mui/material';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import BlockOutlinedIcon from '@mui/icons-material/BlockOutlined';
import RestartAltOutlinedIcon from '@mui/icons-material/RestartAltOutlined';
import StarOutlineOutlinedIcon from '@mui/icons-material/StarOutlineOutlined';
import StarIcon from '@mui/icons-material/Star';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Customer Addresses table (P2L-3). Pure display; profile owns data
// access. Actions: Set primary, Edit, Deactivate/Reactivate (no hard delete).
// ─────────────────────────────────────────────────────────────────────────────

function formatStreet(a) {
  return [a.addressLine1, a.addressLine2].filter(Boolean).join(', ') || '—';
}

function CustomerAddressTable({ addresses, onSetPrimary, onEdit, onDeactivate, onReactivate }) {
  return (
    <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 2, overflowX: 'auto' }}>
      <Table sx={{ minWidth: 980 }} aria-label="Customer addresses">
        <TableHead>
          <TableRow>
            <TableCell>Type</TableCell>
            <TableCell>Label</TableCell>
            <TableCell>Address</TableCell>
            <TableCell>City</TableCell>
            <TableCell>Province</TableCell>
            <TableCell>Postal Code</TableCell>
            <TableCell>Country</TableCell>
            <TableCell>Primary</TableCell>
            <TableCell>Status</TableCell>
            <TableCell align="right">Actions</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {addresses.map((a) => (
            <TableRow key={a.id} hover sx={{ '& .MuiTableCell-root': { py: 1.5 }, opacity: a.isActive ? 1 : 0.6 }}>
              <TableCell><Typography variant="body2" sx={{ fontWeight: 600, color: 'text.primary' }}>{a.addressType}</Typography></TableCell>
              <TableCell><Typography variant="body2" sx={{ color: a.label ? 'text.secondary' : 'text.disabled' }}>{a.label || '—'}</Typography></TableCell>
              <TableCell sx={{ maxWidth: 260 }}>
                <Typography variant="body2" sx={{ color: 'text.secondary', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={formatStreet(a)}>{formatStreet(a)}</Typography>
                {a.companyName && <Typography variant="caption" sx={{ color: 'text.disabled' }}>{a.companyName}</Typography>}
              </TableCell>
              <TableCell><Typography variant="body2" sx={{ color: 'text.secondary' }}>{a.city || '—'}</Typography></TableCell>
              <TableCell><Typography variant="body2" sx={{ color: a.province ? 'text.secondary' : 'text.disabled' }}>{a.province || '—'}</Typography></TableCell>
              <TableCell><Typography variant="body2" sx={{ color: a.postalCode ? 'text.secondary' : 'text.disabled' }}>{a.postalCode || '—'}</Typography></TableCell>
              <TableCell><Typography variant="body2" sx={{ color: 'text.secondary' }}>{a.country || '—'}</Typography></TableCell>
              <TableCell>{a.isPrimary ? <Chip icon={<StarIcon />} label="Primary" size="small" color="primary" sx={{ fontWeight: 600 }} /> : <Typography variant="body2" sx={{ color: 'text.disabled' }}>—</Typography>}</TableCell>
              <TableCell><Chip label={a.isActive ? 'Active' : 'Inactive'} size="small" color={a.isActive ? 'success' : 'default'} sx={{ fontWeight: 600 }} /></TableCell>
              <TableCell align="right">
                <Box sx={{ display: 'inline-flex' }}>
                  {a.isActive && !a.isPrimary && (
                    <Tooltip title="Set as primary">
                      <IconButton size="small" aria-label={`Set ${a.addressType} address as primary`} onClick={() => onSetPrimary?.(a)}>
                        <StarOutlineOutlinedIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  )}
                  <Tooltip title="Edit">
                    <IconButton size="small" aria-label="Edit address" onClick={() => onEdit?.(a)}>
                      <EditOutlinedIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  {a.isActive ? (
                    <Tooltip title="Deactivate">
                      <IconButton size="small" color="error" aria-label="Deactivate address" onClick={() => onDeactivate?.(a)}>
                        <BlockOutlinedIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  ) : (
                    <Tooltip title="Reactivate">
                      <IconButton size="small" color="primary" aria-label="Reactivate address" onClick={() => onReactivate?.(a)}>
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

export default CustomerAddressTable;
