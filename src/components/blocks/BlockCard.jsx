import {
  Card,
  CardContent,
  CardActions,
  Box,
  Typography,
  Chip,
  Divider,
  Button,
  IconButton,
  Tooltip,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import TerrainOutlinedIcon from '@mui/icons-material/TerrainOutlined';
import GridViewOutlinedIcon from '@mui/icons-material/GridViewOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined';

function formatHectares(value) {
  const n = Number(value) || 0;
  return n.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

function statusChipColor(status) {
  const s = (status || '').toLowerCase();
  if (s === 'active') return 'primary';
  if (s === 'archived' || s === 'dormant') return 'default';
  return 'secondary';
}

/**
 * Premium block workspace card with View / Edit / Delete actions.
 * Shares the Vineyards/Dashboard card language: branded gradient header,
 * rounded surface, hover lift, clear stat hierarchy, and the parent-vineyard
 * relationship shown prominently.
 *
 * @param {object} block - Normalised block (incl. vineyardName).
 * @param {function} onView
 * @param {function} onEdit
 * @param {function} onDelete
 */
function BlockCard({ block, onView, onEdit, onDelete }) {
  return (
    <Card
      sx={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        transition: 'box-shadow 0.2s ease, transform 0.2s ease',
        '&:hover': { boxShadow: 4, transform: 'translateY(-2px)' },
      }}
    >
      {/* Branded visual header */}
      <Box
        sx={{
          height: 64,
          position: 'relative',
          overflow: 'hidden',
          display: 'flex',
          alignItems: 'center',
          px: 2.5,
          background: (t) =>
            `linear-gradient(120deg, ${alpha(t.palette.secondary.main, 0.88)}, ${alpha(t.palette.secondary.light, 0.68)})`,
        }}
      >
        <Box
          aria-hidden
          sx={{ position: 'absolute', top: -18, right: -8, width: 84, height: 84, borderRadius: '50%', bgcolor: (t) => alpha(t.palette.accent.main, 0.22) }}
        />
        <GridViewOutlinedIcon sx={{ color: 'common.white', fontSize: '1.6rem', position: 'relative' }} />
      </Box>

      <CardContent sx={{ flexGrow: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 1 }}>
          <Typography variant="h5" component="h3" sx={{ minWidth: 0 }}>
            {block.name}
          </Typography>
          {block.status && (
            <Chip
              label={block.status}
              size="small"
              color={statusChipColor(block.status)}
              sx={{ textTransform: 'capitalize', flexShrink: 0 }}
            />
          )}
        </Box>

        {block.vineyardName && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.75, color: 'text.secondary' }}>
            <TerrainOutlinedIcon sx={{ fontSize: '1rem' }} />
            <Typography variant="body2" noWrap>
              {block.vineyardName}
            </Typography>
          </Box>
        )}

        <Divider sx={{ my: 1.5 }} />

        <Box>
          <Typography variant="overline" sx={{ display: 'block' }}>
            Area
          </Typography>
          <Typography variant="subtitle1" sx={{ color: 'text.primary', fontWeight: 600 }}>
            {block.areaHectares != null ? `${formatHectares(block.areaHectares)} ha` : '—'}
          </Typography>
        </Box>
      </CardContent>

      <CardActions sx={{ px: 2, pb: 1.5, pt: 0, justifyContent: 'space-between' }}>
        <Button size="small" onClick={() => onView?.(block)}>
          View
        </Button>
        <Box>
          <Tooltip title="Edit">
            <IconButton size="small" aria-label={`Edit ${block.name}`} onClick={() => onEdit?.(block)}>
              <EditOutlinedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Delete">
            <IconButton size="small" color="error" aria-label={`Delete ${block.name}`} onClick={() => onDelete?.(block)}>
              <DeleteOutlineOutlinedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>
      </CardActions>
    </Card>
  );
}

export default BlockCard;
