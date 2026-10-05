import {
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Paper, Chip,
  IconButton, Tooltip, Box, Typography,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import BlockOutlinedIcon from '@mui/icons-material/BlockOutlined';
import RestartAltOutlinedIcon from '@mui/icons-material/RestartAltOutlined';
import LiquorOutlinedIcon from '@mui/icons-material/LiquorOutlined';
import { formatNumber } from '../common/formatters';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Finished Products table (P2K-2, desktop/tablet layout)
// Columns: SKU / Product / Vintage / Bottle Size / Packaging / Style /
// Bottles per Case / Status / Actions. Products are catalogue reference data —
// actions are Edit and Deactivate/Reactivate (never a physical delete). Pure
// display; the page owns all data access through finishedProductService.
// ─────────────────────────────────────────────────────────────────────────────

function FinishedProductTable({ products, onEdit, onDeactivate, onReactivate }) {
  return (
    <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 3, overflowX: 'auto' }}>
      <Table sx={{ minWidth: 1000 }} aria-label="Finished products">
        <TableHead>
          <TableRow>
            <TableCell>SKU</TableCell>
            <TableCell>Product</TableCell>
            <TableCell align="right">Vintage</TableCell>
            <TableCell align="right">Bottle Size</TableCell>
            <TableCell>Packaging</TableCell>
            <TableCell>Style</TableCell>
            <TableCell align="right">Bottles / Case</TableCell>
            <TableCell>Status</TableCell>
            <TableCell align="right">Actions</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {products.map((p) => (
            <TableRow key={p.id} hover sx={{ '& .MuiTableCell-root': { py: 1.75 }, opacity: p.isActive ? 1 : 0.6 }}>
              <TableCell>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
                  <Box
                    sx={{
                      width: 34, height: 34, borderRadius: 1.5, flexShrink: 0,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: 'secondary.main', bgcolor: (t) => alpha(t.palette.secondary.main, 0.12),
                    }}
                  >
                    <LiquorOutlinedIcon sx={{ fontSize: '1.1rem' }} />
                  </Box>
                  <Typography variant="body2" sx={{ fontWeight: 600, color: 'text.primary' }}>{p.skuCode}</Typography>
                </Box>
              </TableCell>
              <TableCell>
                <Typography variant="body2" sx={{ color: 'text.primary' }}>{p.name}</Typography>
              </TableCell>
              <TableCell align="right">
                <Typography variant="body2" sx={{ color: p.vintage ? 'text.secondary' : 'text.disabled' }}>{p.vintage || '—'}</Typography>
              </TableCell>
              <TableCell align="right">
                <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                  {p.bottleVolumeMl != null ? `${formatNumber(p.bottleVolumeMl, { maximumFractionDigits: 0 })} ml` : '—'}
                </Typography>
              </TableCell>
              <TableCell>
                <Typography variant="body2" sx={{ color: 'text.secondary' }}>{p.packagingFormat || '—'}</Typography>
              </TableCell>
              <TableCell>
                <Typography variant="body2" sx={{ color: p.wineStyle ? 'text.secondary' : 'text.disabled' }}>{p.wineStyle || '—'}</Typography>
              </TableCell>
              <TableCell align="right">
                <Typography variant="body2" sx={{ color: p.bottlesPerCase ? 'text.secondary' : 'text.disabled' }}>
                  {p.bottlesPerCase ? formatNumber(p.bottlesPerCase, { maximumFractionDigits: 0 }) : '—'}
                </Typography>
              </TableCell>
              <TableCell>
                <Chip
                  label={p.isActive ? 'Active' : 'Inactive'}
                  size="small"
                  color={p.isActive ? 'success' : 'default'}
                  sx={{ fontWeight: 600 }}
                />
              </TableCell>
              <TableCell align="right">
                <Box sx={{ display: 'inline-flex' }}>
                  <Tooltip title="Edit">
                    <IconButton size="small" aria-label={`Edit ${p.skuCode}`} onClick={() => onEdit?.(p)}>
                      <EditOutlinedIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  {p.isActive ? (
                    <Tooltip title="Deactivate">
                      <IconButton size="small" color="error" aria-label={`Deactivate ${p.skuCode}`} onClick={() => onDeactivate?.(p)}>
                        <BlockOutlinedIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  ) : (
                    <Tooltip title="Reactivate">
                      <IconButton size="small" color="primary" aria-label={`Reactivate ${p.skuCode}`} onClick={() => onReactivate?.(p)}>
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

export default FinishedProductTable;
