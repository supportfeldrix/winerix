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
import LocationOnOutlinedIcon from '@mui/icons-material/LocationOnOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined';
import GridViewOutlinedIcon from '@mui/icons-material/GridViewOutlined';
import TerrainOutlinedIcon from '@mui/icons-material/TerrainOutlined';

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
 * Premium vineyard workspace card with View / Blocks / Edit / Delete actions.
 * Shares the Dashboard's card language: branded gradient header, rounded
 * surface, hover lift, clear stat hierarchy. Used for the responsive card
 * layout (primary on tablet/mobile).
 *
 * @param {object} vineyard - Normalised vineyard.
 * @param {function} onView
 * @param {function} onViewBlocks
 * @param {function} onEdit
 * @param {function} onDelete
 */
function VineyardCard({ vineyard, onView, onViewBlocks, onEdit, onDelete }) {
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
      {/* Branded visual header (no fake imagery) */}
      <Box
        sx={{
          height: 64,
          position: 'relative',
          overflow: 'hidden',
          display: 'flex',
          alignItems: 'center',
          px: 2.5,
          background: (t) =>
            `linear-gradient(120deg, ${alpha(t.palette.primary.main, 0.92)}, ${alpha(t.palette.primary.light, 0.72)})`,
        }}
      >
        <Box
          aria-hidden
          sx={{ position: 'absolute', top: -18, right: -8, width: 84, height: 84, borderRadius: '50%', bgcolor: (t) => alpha(t.palette.accent.main, 0.25) }}
        />
        <TerrainOutlinedIcon sx={{ color: 'common.white', fontSize: '1.6rem', position: 'relative' }} />
      </Box>

      <CardContent sx={{ flexGrow: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 1 }}>
          <Typography variant="h5" component="h3" sx={{ minWidth: 0 }}>
            {vineyard.name}
          </Typography>
          {vineyard.status && (
            <Chip
              label={vineyard.status}
              size="small"
              color={statusChipColor(vineyard.status)}
              sx={{ textTransform: 'capitalize', flexShrink: 0 }}
            />
          )}
        </Box>

        {vineyard.location && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.75, color: 'text.secondary' }}>
            <LocationOnOutlinedIcon sx={{ fontSize: '1rem' }} />
            <Typography variant="body2" noWrap>
              {vineyard.location}
            </Typography>
          </Box>
        )}

        <Divider sx={{ my: 1.5 }} />

        <Box sx={{ display: 'flex', gap: 4 }}>
          <Box>
            <Typography variant="overline" sx={{ display: 'block' }}>
              Area
            </Typography>
            <Typography variant="subtitle1" sx={{ color: 'text.primary', fontWeight: 600 }}>
              {vineyard.areaHectares != null ? `${formatHectares(vineyard.areaHectares)} ha` : '—'}
            </Typography>
          </Box>
          {vineyard.blockCount != null && (
            <Box>
              <Typography variant="overline" sx={{ display: 'block' }}>
                Blocks
              </Typography>
              <Typography variant="subtitle1" sx={{ color: 'text.primary', fontWeight: 600 }}>
                {vineyard.blockCount}
              </Typography>
            </Box>
          )}
        </Box>
      </CardContent>

      <CardActions sx={{ px: 2, pb: 1.5, pt: 0, justifyContent: 'space-between' }}>
        <Box sx={{ display: 'flex', gap: 0.5 }}>
          <Button size="small" onClick={() => onView?.(vineyard)}>
            View
          </Button>
          {onViewBlocks && (
            <Button
              size="small"
              startIcon={<GridViewOutlinedIcon fontSize="small" />}
              onClick={() => onViewBlocks(vineyard)}
            >
              Blocks
            </Button>
          )}
        </Box>
        <Box>
          <Tooltip title="Edit">
            <IconButton size="small" aria-label={`Edit ${vineyard.name}`} onClick={() => onEdit?.(vineyard)}>
              <EditOutlinedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Delete">
            <IconButton size="small" color="error" aria-label={`Delete ${vineyard.name}`} onClick={() => onDelete?.(vineyard)}>
              <DeleteOutlineOutlinedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>
      </CardActions>
    </Card>
  );
}

export default VineyardCard;
