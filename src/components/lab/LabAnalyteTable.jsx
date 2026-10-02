import {
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Paper, Chip,
  IconButton, Tooltip, Box, Typography,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import BlockOutlinedIcon from '@mui/icons-material/BlockOutlined';
import RestartAltOutlinedIcon from '@mui/icons-material/RestartAltOutlined';
import ScienceOutlinedIcon from '@mui/icons-material/ScienceOutlined';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Lab Analytes table (desktop/tablet layout)
// Columns: Code / Display Name / Canonical Unit / Status / Notes / Actions.
// Analytes are controlled reference data — actions are Edit and
// Deactivate/Reactivate (never a physical delete). Mirrors CultivarTable.
// ─────────────────────────────────────────────────────────────────────────────

function LabAnalyteTable({ analytes, onEdit, onDeactivate, onReactivate }) {
  return (
    <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 3, overflowX: 'auto' }}>
      <Table sx={{ minWidth: 720 }} aria-label="Lab analytes">
        <TableHead>
          <TableRow>
            <TableCell>Code</TableCell>
            <TableCell>Display Name</TableCell>
            <TableCell>Canonical Unit</TableCell>
            <TableCell>Status</TableCell>
            <TableCell>Notes</TableCell>
            <TableCell align="right">Actions</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {analytes.map((a) => (
            <TableRow key={a.id} hover sx={{ '& .MuiTableCell-root': { py: 1.75 }, opacity: a.isActive ? 1 : 0.6 }}>
              <TableCell>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
                  <Box
                    sx={{
                      width: 34, height: 34, borderRadius: 1.5, flexShrink: 0,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: 'secondary.main', bgcolor: (t) => alpha(t.palette.secondary.main, 0.12),
                    }}
                  >
                    <ScienceOutlinedIcon sx={{ fontSize: '1.1rem' }} />
                  </Box>
                  <Typography variant="body2" sx={{ fontWeight: 600, color: 'text.primary' }}>{a.code}</Typography>
                </Box>
              </TableCell>
              <TableCell>
                <Typography variant="body2" sx={{ color: 'text.primary' }}>{a.displayName}</Typography>
              </TableCell>
              <TableCell>
                <Typography variant="body2" sx={{ color: 'text.secondary' }}>{a.canonicalUnit}</Typography>
              </TableCell>
              <TableCell>
                <Chip
                  label={a.isActive ? 'Active' : 'Inactive'}
                  size="small"
                  color={a.isActive ? 'success' : 'default'}
                  sx={{ fontWeight: 600 }}
                />
              </TableCell>
              <TableCell sx={{ maxWidth: 280 }}>
                {a.notes
                  ? <Typography variant="body2" sx={{ color: 'text.secondary' }}>{a.notes}</Typography>
                  : <Typography variant="body2" sx={{ color: 'text.disabled' }}>—</Typography>}
              </TableCell>
              <TableCell align="right">
                <Box sx={{ display: 'inline-flex' }}>
                  <Tooltip title="Edit">
                    <IconButton size="small" aria-label={`Edit ${a.code}`} onClick={() => onEdit?.(a)}>
                      <EditOutlinedIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  {a.isActive ? (
                    <Tooltip title="Deactivate">
                      <IconButton size="small" color="error" aria-label={`Deactivate ${a.code}`} onClick={() => onDeactivate?.(a)}>
                        <BlockOutlinedIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  ) : (
                    <Tooltip title="Reactivate">
                      <IconButton size="small" color="primary" aria-label={`Reactivate ${a.code}`} onClick={() => onReactivate?.(a)}>
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

export default LabAnalyteTable;
