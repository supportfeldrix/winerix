import {
  Card, CardContent, CardActions, Box, Typography, Chip, Divider, Button, IconButton, Tooltip,
} from '@mui/material';
import CategoryOutlinedIcon from '@mui/icons-material/CategoryOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined';
import { formatDate, activityStatusColor } from '../common/formatters';

function MachineryCard({ record, onView, onEdit, onDelete }) {
  return (
    <Card sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <CardContent sx={{ flexGrow: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 1 }}>
          <Typography variant="h5" component="h3" sx={{ minWidth: 0 }}>{record.name}</Typography>
          {record.status && (
            <Chip label={record.status.replace(/_/g, ' ')} size="small" color={activityStatusColor(record.status)}
              sx={{ textTransform: 'capitalize', flexShrink: 0 }} />
          )}
        </Box>
        {record.category && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.75, color: 'text.secondary' }}>
            <CategoryOutlinedIcon sx={{ fontSize: '1rem' }} />
            <Typography variant="body2" noWrap sx={{ textTransform: 'capitalize' }}>{record.category}</Typography>
          </Box>
        )}
        <Divider sx={{ my: 1.5 }} />
        <Box sx={{ display: 'flex', gap: 4 }}>
          <Box>
            <Typography variant="overline" sx={{ display: 'block' }}>Registration</Typography>
            <Typography variant="subtitle1" sx={{ color: 'text.primary', fontWeight: 600 }}>{record.registration || '—'}</Typography>
          </Box>
          <Box>
            <Typography variant="overline" sx={{ display: 'block' }}>Last Service</Typography>
            <Typography variant="subtitle1" sx={{ color: 'text.primary', fontWeight: 600 }}>{formatDate(record.lastServiceDate)}</Typography>
          </Box>
        </Box>
      </CardContent>
      <CardActions sx={{ px: 2, pb: 1.5, pt: 0, justifyContent: 'space-between' }}>
        <Button size="small" onClick={() => onView?.(record)}>View</Button>
        <Box>
          <Tooltip title="Edit"><IconButton size="small" aria-label={`Edit ${record.name}`} onClick={() => onEdit?.(record)}><EditOutlinedIcon fontSize="small" /></IconButton></Tooltip>
          <Tooltip title="Delete"><IconButton size="small" color="error" aria-label={`Delete ${record.name}`} onClick={() => onDelete?.(record)}><DeleteOutlineOutlinedIcon fontSize="small" /></IconButton></Tooltip>
        </Box>
      </CardActions>
    </Card>
  );
}

export default MachineryCard;
