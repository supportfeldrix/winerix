import {
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Paper, Chip,
  IconButton, Tooltip, Box, Typography, Link,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import OpenInNewOutlinedIcon from '@mui/icons-material/OpenInNewOutlined';
import ReceiptLongOutlinedIcon from '@mui/icons-material/ReceiptLongOutlined';
import { formatDate, formatNumber } from '../common/formatters';
import { salesOrderStatusLabel } from '../../services/salesOrderService';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Sales Orders table (P2L-4). Pure display; the page owns data access.
// Columns: Order Number / Date / Customer / Requested Delivery / Currency /
// Total / Status / Actions. Edit is offered for draft orders only.
// ─────────────────────────────────────────────────────────────────────────────

export function salesOrderStatusColor(status) {
  switch (status) {
    case 'draft': return 'secondary';
    case 'confirmed': return 'info';
    case 'allocated': return 'primary';
    case 'partially_allocated': return 'warning';
    case 'ready_to_dispatch': return 'success';
    case 'cancelled': return 'default';
    default: return 'default';
  }
}

function SalesOrderTable({ orders, onOpen, onEdit }) {
  return (
    <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 3, overflowX: 'auto' }}>
      <Table sx={{ minWidth: 960 }} aria-label="Sales orders">
        <TableHead>
          <TableRow>
            <TableCell>Order Number</TableCell>
            <TableCell>Order Date</TableCell>
            <TableCell>Customer</TableCell>
            <TableCell>Requested Delivery</TableCell>
            <TableCell>Currency</TableCell>
            <TableCell align="right">Total</TableCell>
            <TableCell>Status</TableCell>
            <TableCell align="right">Actions</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {orders.map((o) => {
            const editable = o.status === 'draft';
            return (
              <TableRow key={o.id} hover sx={{ '& .MuiTableCell-root': { py: 1.75 } }}>
                <TableCell>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
                    <Box
                      sx={{
                        width: 34, height: 34, borderRadius: 1.5, flexShrink: 0,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        color: 'secondary.main', bgcolor: (t) => alpha(t.palette.secondary.main, 0.12),
                      }}
                    >
                      <ReceiptLongOutlinedIcon sx={{ fontSize: '1.1rem' }} />
                    </Box>
                    <Link component="button" type="button" underline="hover" onClick={() => onOpen?.(o)} sx={{ fontWeight: 600, color: 'text.primary', textAlign: 'left' }}>
                      {o.orderNumber}
                    </Link>
                  </Box>
                </TableCell>
                <TableCell><Typography variant="body2" sx={{ color: 'text.secondary' }}>{formatDate(o.orderDate)}</Typography></TableCell>
                <TableCell>
                  <Typography variant="body2" sx={{ color: 'text.primary' }}>{o.customerLegalName || '—'}</Typography>
                  {o.customerTradingName && <Typography variant="caption" sx={{ color: 'text.secondary' }}>{o.customerTradingName}</Typography>}
                </TableCell>
                <TableCell><Typography variant="body2" sx={{ color: o.requestedDeliveryDate ? 'text.secondary' : 'text.disabled' }}>{o.requestedDeliveryDate ? formatDate(o.requestedDeliveryDate) : '—'}</Typography></TableCell>
                <TableCell><Typography variant="body2" sx={{ color: 'text.secondary' }}>{o.currency || '—'}</Typography></TableCell>
                <TableCell align="right"><Typography variant="body2" sx={{ color: 'text.primary', fontWeight: 600 }}>{formatNumber(o.total, { maximumFractionDigits: 2 })}</Typography></TableCell>
                <TableCell><Chip label={salesOrderStatusLabel(o.status)} size="small" color={salesOrderStatusColor(o.status)} sx={{ fontWeight: 600 }} /></TableCell>
                <TableCell align="right">
                  <Box sx={{ display: 'inline-flex' }}>
                    <Tooltip title="Open">
                      <IconButton size="small" color="primary" aria-label={`Open ${o.orderNumber}`} onClick={() => onOpen?.(o)}>
                        <OpenInNewOutlinedIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title={editable ? 'Edit draft' : 'Only draft orders can be edited'}>
                      <span>
                        <IconButton size="small" aria-label={`Edit ${o.orderNumber}`} onClick={() => onEdit?.(o)} disabled={!editable}>
                          <EditOutlinedIcon fontSize="small" />
                        </IconButton>
                      </span>
                    </Tooltip>
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

export default SalesOrderTable;
