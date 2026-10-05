import {
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Paper, Chip,
  IconButton, Tooltip, Box, Typography, Link,
} from '@mui/material';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import BlockOutlinedIcon from '@mui/icons-material/BlockOutlined';
import RestartAltOutlinedIcon from '@mui/icons-material/RestartAltOutlined';
import StarOutlineOutlinedIcon from '@mui/icons-material/StarOutlineOutlined';
import StarIcon from '@mui/icons-material/Star';

// ─────────────────────────────────────────────────────────────────────────────
// WINERIX — Customer Contacts table (P2L-3). Pure display; the profile owns data
// access. Actions: Set primary, Edit, Deactivate/Reactivate (no hard delete).
// ─────────────────────────────────────────────────────────────────────────────

function CustomerContactTable({ contacts, onSetPrimary, onEdit, onDeactivate, onReactivate }) {
  return (
    <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 2, overflowX: 'auto' }}>
      <Table sx={{ minWidth: 860 }} aria-label="Customer contacts">
        <TableHead>
          <TableRow>
            <TableCell>Name</TableCell>
            <TableCell>Job Title</TableCell>
            <TableCell>Email</TableCell>
            <TableCell>Phone</TableCell>
            <TableCell>Mobile</TableCell>
            <TableCell>Primary</TableCell>
            <TableCell>Status</TableCell>
            <TableCell align="right">Actions</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {contacts.map((c) => (
            <TableRow key={c.id} hover sx={{ '& .MuiTableCell-root': { py: 1.5 }, opacity: c.isActive ? 1 : 0.6 }}>
              <TableCell>
                <Typography variant="body2" sx={{ fontWeight: 600, color: 'text.primary' }}>{c.firstName} {c.lastName}</Typography>
              </TableCell>
              <TableCell><Typography variant="body2" sx={{ color: c.jobTitle ? 'text.secondary' : 'text.disabled' }}>{c.jobTitle || '—'}</Typography></TableCell>
              <TableCell>{c.email ? <Link href={`mailto:${c.email}`} underline="hover" variant="body2">{c.email}</Link> : <Typography variant="body2" sx={{ color: 'text.disabled' }}>—</Typography>}</TableCell>
              <TableCell><Typography variant="body2" sx={{ color: c.phone ? 'text.secondary' : 'text.disabled' }}>{c.phone || '—'}</Typography></TableCell>
              <TableCell><Typography variant="body2" sx={{ color: c.mobile ? 'text.secondary' : 'text.disabled' }}>{c.mobile || '—'}</Typography></TableCell>
              <TableCell>{c.isPrimary ? <Chip icon={<StarIcon />} label="Primary" size="small" color="primary" sx={{ fontWeight: 600 }} /> : <Typography variant="body2" sx={{ color: 'text.disabled' }}>—</Typography>}</TableCell>
              <TableCell><Chip label={c.isActive ? 'Active' : 'Inactive'} size="small" color={c.isActive ? 'success' : 'default'} sx={{ fontWeight: 600 }} /></TableCell>
              <TableCell align="right">
                <Box sx={{ display: 'inline-flex' }}>
                  {c.isActive && !c.isPrimary && (
                    <Tooltip title="Set as primary">
                      <IconButton size="small" aria-label={`Set ${c.firstName} ${c.lastName} as primary`} onClick={() => onSetPrimary?.(c)}>
                        <StarOutlineOutlinedIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  )}
                  <Tooltip title="Edit">
                    <IconButton size="small" aria-label={`Edit ${c.firstName} ${c.lastName}`} onClick={() => onEdit?.(c)}>
                      <EditOutlinedIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  {c.isActive ? (
                    <Tooltip title="Deactivate">
                      <IconButton size="small" color="error" aria-label={`Deactivate ${c.firstName} ${c.lastName}`} onClick={() => onDeactivate?.(c)}>
                        <BlockOutlinedIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  ) : (
                    <Tooltip title="Reactivate">
                      <IconButton size="small" color="primary" aria-label={`Reactivate ${c.firstName} ${c.lastName}`} onClick={() => onReactivate?.(c)}>
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

export default CustomerContactTable;
