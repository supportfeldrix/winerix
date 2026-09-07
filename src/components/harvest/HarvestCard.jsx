import {
  Card, CardContent, CardActions, Box, Typography, Chip, Divider, Button, IconButton, Tooltip,
} from '@mui/material';
import TerrainOutlinedIcon from '@mui/icons-material/TerrainOutlined';
import GridViewOutlinedIcon from '@mui/icons-material/GridViewOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined';
import { formatDate, formatNumber, activityStatusColor } from '../common/formatters';

function HarvestCard({ record, onView, onEdit, onDelete }) {
  return (
    <Card sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <CardContent sx={{ flexGrow: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 1 }}>
          <Typography variant="h5" component="h3" sx={{ minWidth: 0 }}>{record.title}</Typography>
          {record.status && (
            <Chip label={record.status} size="small" color={activityStatusColor(record.status)}
              sx={{ textTransform: 'capitalize', flexShrink: 0 }} />
          )}
        </Box>
        {record.vineyardName && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.75, color: 'text.secondary' }}>
            <TerrainOutlinedIcon sx={{ fontSize: '1rem' }} />
            <Typography variant="body2" noWrap>{record.vineyardName}</Typography>
          </Box>
        )}
        {record.blockName && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.5, color: 'text.secondary' }}>
            <GridViewOutlinedIcon sx={{ fontSize: '1rem' }} />
            <Typography variant="body2" noWrap>{record.blockName}</Typography>
          </Box>
        )}
        <Divider sx={{ my: 1.5 }} />
        <Box sx={{ display: 'flex', gap: 4 }}>
          <Box>
            <Typography variant="overline" sx={{ display: 'block' }}>Date</Typography>
            <Typography variant="subtitle1" sx={{ color: 'text.primary', fontWeight: 600 }}>
              {formatDate(record.harvestDate)}
            </Typography>
          </Box>
          <Box>
            <Typography variant="overline" sx={{ display: 'block' }}>Yield</Typography>
            <Typography variant="subtitle1" sx={{ color: 'text.primary', fontWeight: 600 }}>
              {record.yieldTons != null ? `${formatNumber(record.yieldTons)} t` : '—'}
            </Typography>
          </Box>
        </Box>
      </CardContent>
      <CardActions sx={{ px: 2, pb: 1.5, pt: 0, justifyContent: 'space-between' }}>
        <Button size="small" onClick={() => onView?.(record)}>View</Button>
        <Box>
          <Tooltip title="Edit"><IconButton size="small" aria-label={`Edit ${record.title}`} onClick={() => onEdit?.(record)}><EditOutlinedIcon fontSize="small" /></IconButton></Tooltip>
          <Tooltip title="Delete"><IconButton size="small" color="error" aria-label={`Delete ${record.title}`} onClick={() => onDelete?.(record)}><DeleteOutlineOutlinedIcon fontSize="small" /></IconButton></Tooltip>
        </Box>
      </CardActions>
    </Card>
  );
}

export default HarvestCard;
