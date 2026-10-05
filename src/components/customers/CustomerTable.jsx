import {
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Paper, Chip,
  IconButton, Tooltip, Box, Typography, Link,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import BlockOutlinedIcon from '@mui/icons-material/BlockOutlined';
import RestartAltOutlinedIcon from '@mui/icons-material/RestartAltOutlined';
import OpenInNewOutlinedIcon from '@mui/icons-material/OpenInNewOutlined';
import StorefrontOutlinedIcon from '@mui/icons-material/StorefrontOutlined';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Customers table (P2L-2, desktop/tablet layout)
// Columns: Legal Name / Trading Name / Type / VAT Number / Email / Phone /
// Status / Actions. Customers are commercial master data — actions are Edit and
// Deactivate/Reactivate (never a physical delete). Pure display; the page owns
// all data access through customerService.
// ─────────────────────────────────────────────────────────────────────────────

function CustomerTable({ customers, onOpen, onEdit, onDeactivate, onReactivate }) {
  return (
    <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 3, overflowX: 'auto' }}>
      <Table sx={{ minWidth: 1040 }} aria-label="Customers">
        <TableHead>
          <TableRow>
            <TableCell>Legal Name</TableCell>
            <TableCell>Trading Name</TableCell>
            <TableCell>Type</TableCell>
            <TableCell>VAT Number</TableCell>
            <TableCell>Email</TableCell>
            <TableCell>Phone</TableCell>
            <TableCell>Status</TableCell>
            <TableCell align="right">Actions</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {customers.map((c) => (
            <TableRow key={c.id} hover sx={{ '& .MuiTableCell-root': { py: 1.75 }, opacity: c.isActive ? 1 : 0.6 }}>
              <TableCell>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
                  <Box
                    sx={{
                      width: 34, height: 34, borderRadius: 1.5, flexShrink: 0,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: 'secondary.main', bgcolor: (t) => alpha(t.palette.secondary.main, 0.12),
                    }}
                  >
                    <StorefrontOutlinedIcon sx={{ fontSize: '1.1rem' }} />
                  </Box>
                  <Link
                    component="button"
                    type="button"
                    underline="hover"
                    onClick={() => onOpen?.(c)}
                    sx={{ fontWeight: 600, color: 'text.primary', textAlign: 'left' }}
                  >
                    {c.legalName}
                  </Link>
                </Box>
              </TableCell>
              <TableCell>
                <Typography variant="body2" sx={{ color: c.tradingName ? 'text.secondary' : 'text.disabled' }}>{c.tradingName || '—'}</Typography>
              </TableCell>
              <TableCell>
                <Typography variant="body2" sx={{ color: 'text.secondary' }}>{c.customerType || '—'}</Typography>
              </TableCell>
              <TableCell>
                <Typography variant="body2" sx={{ color: c.vatNumber ? 'text.secondary' : 'text.disabled' }}>{c.vatNumber || '—'}</Typography>
              </TableCell>
              <TableCell>
                {c.email
                  ? <Link href={`mailto:${c.email}`} underline="hover" variant="body2">{c.email}</Link>
                  : <Typography variant="body2" sx={{ color: 'text.disabled' }}>—</Typography>}
              </TableCell>
              <TableCell>
                <Typography variant="body2" sx={{ color: c.phone ? 'text.secondary' : 'text.disabled' }}>{c.phone || '—'}</Typography>
              </TableCell>
              <TableCell>
                <Chip
                  label={c.isActive ? 'Active' : 'Inactive'}
                  size="small"
                  color={c.isActive ? 'success' : 'default'}
                  sx={{ fontWeight: 600 }}
                />
              </TableCell>
              <TableCell align="right">
                <Box sx={{ display: 'inline-flex' }}>
                  <Tooltip title="Open">
                    <IconButton size="small" color="primary" aria-label={`Open ${c.legalName}`} onClick={() => onOpen?.(c)}>
                      <OpenInNewOutlinedIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Edit">
                    <IconButton size="small" aria-label={`Edit ${c.legalName}`} onClick={() => onEdit?.(c)}>
                      <EditOutlinedIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  {c.isActive ? (
                    <Tooltip title="Deactivate">
                      <IconButton size="small" color="error" aria-label={`Deactivate ${c.legalName}`} onClick={() => onDeactivate?.(c)}>
                        <BlockOutlinedIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  ) : (
                    <Tooltip title="Reactivate">
                      <IconButton size="small" color="primary" aria-label={`Reactivate ${c.legalName}`} onClick={() => onReactivate?.(c)}>
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

export default CustomerTable;
