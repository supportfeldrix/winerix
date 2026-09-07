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
import TerrainOutlinedIcon from '@mui/icons-material/TerrainOutlined';
import GridViewOutlinedIcon from '@mui/icons-material/GridViewOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined';

function formatDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function statusChipColor(status) {
  const s = (status || '').toLowerCase();
  if (s === 'active') return 'primary';
  if (s === 'planned') return 'secondary';
  return 'default'; // completed / cancelled / other
}

/**
 * Operation summary card with View / Edit / Delete actions.
 * Used for the responsive card layout (primary on tablet/mobile).
 *
 * @param {object} operation - Normalised operation (incl. vineyardName/blockName).
 * @param {function} onView
 * @param {function} onEdit
 * @param {function} onDelete
 */
function OperationCard({ operation, onView, onEdit, onDelete }) {
  return (
    <Card sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <CardContent sx={{ flexGrow: 1 }}>
        <Box
          sx={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 1,
          }}
        >
          <Typography variant="h5" component="h3" sx={{ minWidth: 0 }}>
            {operation.title}
          </Typography>
          {operation.status && (
            <Chip
              label={operation.status}
              size="small"
              color={statusChipColor(operation.status)}
              sx={{ textTransform: 'capitalize', flexShrink: 0 }}
            />
          )}
        </Box>

        {operation.vineyardName && (
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.5,
              mt: 0.75,
              color: 'text.secondary',
            }}
          >
            <TerrainOutlinedIcon sx={{ fontSize: '1rem' }} />
            <Typography variant="body2" noWrap>
              {operation.vineyardName}
            </Typography>
          </Box>
        )}

        {operation.blockName && (
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.5,
              mt: 0.5,
              color: 'text.secondary',
            }}
          >
            <GridViewOutlinedIcon sx={{ fontSize: '1rem' }} />
            <Typography variant="body2" noWrap>
              {operation.blockName}
            </Typography>
          </Box>
        )}

        <Divider sx={{ my: 1.5 }} />

        <Box>
          <Typography variant="overline" sx={{ display: 'block' }}>
            Created
          </Typography>
          <Typography variant="subtitle1" sx={{ color: 'text.primary', fontWeight: 600 }}>
            {formatDate(operation.createdAt)}
          </Typography>
        </Box>
      </CardContent>

      <CardActions sx={{ px: 2, pb: 1.5, pt: 0, justifyContent: 'space-between' }}>
        <Button size="small" onClick={() => onView?.(operation)}>
          View
        </Button>
        <Box>
          <Tooltip title="Edit">
            <IconButton
              size="small"
              aria-label={`Edit ${operation.title}`}
              onClick={() => onEdit?.(operation)}
            >
              <EditOutlinedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Delete">
            <IconButton
              size="small"
              color="error"
              aria-label={`Delete ${operation.title}`}
              onClick={() => onDelete?.(operation)}
            >
              <DeleteOutlineOutlinedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>
      </CardActions>
    </Card>
  );
}

export default OperationCard;
