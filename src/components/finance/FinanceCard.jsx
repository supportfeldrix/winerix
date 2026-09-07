import {
  Card, CardContent, CardActions, Box, Typography, Chip, Divider, Button, IconButton, Tooltip,
} from '@mui/material';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined';
import { formatDate, formatCurrency } from '../common/formatters';

function typeColor(type) {
  return (type || '').toLowerCase() === 'income' ? 'success' : 'secondary';
}

function FinanceCard({ record, onView, onEdit, onDelete }) {
  const isIncome = (record.type || '').toLowerCase() === 'income';
  return (
    <Card sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <CardContent sx={{ flexGrow: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 1 }}>
          <Typography variant="h5" component="h3" sx={{ minWidth: 0 }}>{record.title}</Typography>
          <Chip label={record.type} size="small" color={typeColor(record.type)} sx={{ textTransform: 'capitalize', flexShrink: 0 }} />
        </Box>
        {record.category && (
          <Typography variant="body2" sx={{ color: 'text.secondary', mt: 0.75, textTransform: 'capitalize' }}>
            {record.category}
          </Typography>
        )}
        <Divider sx={{ my: 1.5 }} />
        <Box sx={{ display: 'flex', gap: 4, alignItems: 'flex-end' }}>
          <Box>
            <Typography variant="overline" sx={{ display: 'block' }}>Amount</Typography>
            <Typography variant="h5" component="p" sx={{ color: isIncome ? 'success.main' : 'text.primary', fontWeight: 700 }}>
              {formatCurrency(record.amount)}
            </Typography>
          </Box>
          <Box>
            <Typography variant="overline" sx={{ display: 'block' }}>Date</Typography>
            <Typography variant="subtitle1" sx={{ color: 'text.primary', fontWeight: 600 }}>{formatDate(record.entryDate)}</Typography>
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

export default FinanceCard;
