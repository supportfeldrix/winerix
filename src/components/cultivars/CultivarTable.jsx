import {
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Paper, Chip,
  IconButton, Tooltip, Box, Typography,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import BlockOutlinedIcon from '@mui/icons-material/BlockOutlined';
import RestartAltOutlinedIcon from '@mui/icons-material/RestartAltOutlined';
import LocalBarOutlinedIcon from '@mui/icons-material/LocalBarOutlined';

// Map a cultivar colour to a MUI chip colour for a subtle visual cue.
function colourChip(colour) {
  const c = (colour || '').toLowerCase();
  if (c === 'red') return 'secondary';
  if (c === 'white') return 'primary';
  if (c === 'rosé') return 'accent';
  return 'default';
}

/**
 * Premium cultivars table for the desktop layout.
 * Columns: Cultivar / Colour / Status / Actions. Reference data — actions are
 * Edit and Deactivate/Reactivate (no physical delete).
 * @param {Array} cultivars - normalised cultivar records
 */
function CultivarTable({ cultivars, onEdit, onDeactivate, onReactivate }) {
  return (
    <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 3, overflow: 'hidden' }}>
      <Table sx={{ minWidth: 560 }} aria-label="Cultivars">
        <TableHead>
          <TableRow>
            <TableCell>Cultivar</TableCell>
            <TableCell>Colour</TableCell>
            <TableCell>Status</TableCell>
            <TableCell align="right">Actions</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {cultivars.map((c) => {
            const tone = colourChip(c.colour);
            return (
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
                      <LocalBarOutlinedIcon sx={{ fontSize: '1.1rem' }} />
                    </Box>
                    <Typography variant="body2" sx={{ fontWeight: 600, color: 'text.primary' }}>{c.name}</Typography>
                  </Box>
                </TableCell>
                <TableCell>
                  {c.colour
                    ? <Chip label={c.colour} size="small" color={colourChip(c.colour)} sx={{ textTransform: 'capitalize', fontWeight: 600 }} />
                    : <Typography variant="body2" sx={{ color: 'text.secondary' }}>—</Typography>}
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
                    <Tooltip title="Edit"><IconButton size="small" aria-label={`Edit ${c.name}`} onClick={() => onEdit?.(c)}><EditOutlinedIcon fontSize="small" /></IconButton></Tooltip>
                    {c.isActive ? (
                      <Tooltip title="Deactivate">
                        <IconButton size="small" color="error" aria-label={`Deactivate ${c.name}`} onClick={() => onDeactivate?.(c)}>
                          <BlockOutlinedIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    ) : (
                      <Tooltip title="Reactivate">
                        <IconButton size="small" color="primary" aria-label={`Reactivate ${c.name}`} onClick={() => onReactivate?.(c)}>
                          <RestartAltOutlinedIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    )}
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

export default CultivarTable;
