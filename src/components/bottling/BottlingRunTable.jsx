import {
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Paper, Chip,
  IconButton, Tooltip, Box, Typography, Link,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import OpenInNewOutlinedIcon from '@mui/icons-material/OpenInNewOutlined';
import LiquorOutlinedIcon from '@mui/icons-material/LiquorOutlined';
import { formatDate } from '../common/formatters';
import { bottlingRunStatusLabel } from '../../services/bottlingService';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Bottling Runs table (P2J-B5-1, desktop/tablet layout)
// Columns: Bottling Code / Bottling Date / Status / Notes / Updated / Actions.
// Actions: Open (profile) and Edit. Edit is only offered for ACTIVE runs
// (planned / in_progress); completed/cancelled runs are terminal and the DB
// also rejects updates (036 lifecycle hardening). Pure display — the page owns
// all data access through bottlingService.
// ─────────────────────────────────────────────────────────────────────────────

// Map a bottling-run status to an MUI chip colour. Mirrors the lab table
// status-colour convention (dedicated helper, exported for reuse by the profile).
export function bottlingRunStatusColor(status) {
  switch (status) {
    case 'planned': return 'secondary';
    case 'in_progress': return 'primary';
    case 'completed': return 'success';
    case 'cancelled': return 'default';
    default: return 'default';
  }
}

// A run is editable only while it is active (not terminal).
export function isBottlingRunEditable(status) {
  return status === 'planned' || status === 'in_progress';
}

function BottlingRunTable({ runs, onOpen, onEdit }) {
  return (
    <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 3, overflowX: 'auto' }}>
      <Table sx={{ minWidth: 880 }} aria-label="Bottling runs">
        <TableHead>
          <TableRow>
            <TableCell>Bottling Code</TableCell>
            <TableCell>Bottling Date</TableCell>
            <TableCell>Status</TableCell>
            <TableCell>Notes</TableCell>
            <TableCell>Updated</TableCell>
            <TableCell align="right">Actions</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {runs.map((r) => {
            const editable = isBottlingRunEditable(r.status);
            return (
              <TableRow key={r.id} hover sx={{ '& .MuiTableCell-root': { py: 1.75 } }}>
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
                    <Link
                      component="button"
                      type="button"
                      underline="hover"
                      onClick={() => onOpen?.(r)}
                      sx={{ fontWeight: 600, color: 'text.primary', textAlign: 'left' }}
                    >
                      {r.bottlingCode || '—'}
                    </Link>
                  </Box>
                </TableCell>
                <TableCell>
                  <Typography variant="body2" sx={{ color: 'text.secondary' }}>{formatDate(r.bottlingDate)}</Typography>
                </TableCell>
                <TableCell>
                  <Chip
                    label={bottlingRunStatusLabel(r.status)}
                    size="small"
                    color={bottlingRunStatusColor(r.status)}
                    sx={{ fontWeight: 600 }}
                  />
                </TableCell>
                <TableCell sx={{ maxWidth: 280 }}>
                  <Typography
                    variant="body2"
                    sx={{ color: r.notes ? 'text.secondary' : 'text.disabled', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    title={r.notes || ''}
                  >
                    {r.notes || '—'}
                  </Typography>
                </TableCell>
                <TableCell>
                  <Typography variant="body2" sx={{ color: 'text.secondary' }}>{formatDate(r.updatedAt)}</Typography>
                </TableCell>
                <TableCell align="right">
                  <Box sx={{ display: 'inline-flex' }}>
                    <Tooltip title="Open">
                      <IconButton size="small" color="primary" aria-label={`Open ${r.bottlingCode}`} onClick={() => onOpen?.(r)}>
                        <OpenInNewOutlinedIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title={editable ? 'Edit' : 'Completed and cancelled runs cannot be edited'}>
                      {/* span wrapper keeps the tooltip working while the button is disabled */}
                      <span>
                        <IconButton
                          size="small"
                          aria-label={`Edit ${r.bottlingCode}`}
                          onClick={() => onEdit?.(r)}
                          disabled={!editable}
                        >
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

export default BottlingRunTable;
