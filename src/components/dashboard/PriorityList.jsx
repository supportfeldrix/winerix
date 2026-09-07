import { useNavigate } from 'react-router-dom';
import { Box, Typography, List, ListItem, ListItemButton, ListItemIcon, ListItemText, Chip } from '@mui/material';
import { alpha } from '@mui/material/styles';
import HandymanOutlinedIcon from '@mui/icons-material/HandymanOutlined';
import WaterDropOutlinedIcon from '@mui/icons-material/WaterDropOutlined';
import SanitizerOutlinedIcon from '@mui/icons-material/SanitizerOutlined';
import EventNoteOutlinedIcon from '@mui/icons-material/EventNoteOutlined';
import PrecisionManufacturingOutlinedIcon from '@mui/icons-material/PrecisionManufacturingOutlined';
import CheckCircleOutlineOutlinedIcon from '@mui/icons-material/CheckCircleOutlineOutlined';

// Build a prioritised list of real, actionable items from the report snapshot.
function buildPriorities(s) {
  if (!s) return [];
  const items = [];

  if (s.machinery.needsAttention > 0) {
    items.push({
      icon: PrecisionManufacturingOutlinedIcon, tone: 'warning', path: '/machinery',
      label: `${s.machinery.needsAttention} machinery item${s.machinery.needsAttention === 1 ? '' : 's'} need attention`,
      chip: 'Maintenance',
    });
  }
  if (s.planner.open > 0) {
    items.push({
      icon: EventNoteOutlinedIcon, tone: 'primary', path: '/planner',
      label: `${s.planner.open} open planner task${s.planner.open === 1 ? '' : 's'}`,
      chip: 'Planner',
    });
  }
  if (s.operations.active > 0) {
    items.push({
      icon: HandymanOutlinedIcon, tone: 'primary', path: '/operations',
      label: `${s.operations.active} active operation${s.operations.active === 1 ? '' : 's'} in progress`,
      chip: 'Operations',
    });
  }
  if (s.spray.active > 0) {
    items.push({
      icon: SanitizerOutlinedIcon, tone: 'secondary', path: '/spray-programme',
      label: `${s.spray.active} spray programme activit${s.spray.active === 1 ? 'y' : 'ies'} underway`,
      chip: 'Spray',
    });
  }
  if (s.irrigation.active > 0) {
    items.push({
      icon: WaterDropOutlinedIcon, tone: 'primary', path: '/irrigation',
      label: `${s.irrigation.active} irrigation activit${s.irrigation.active === 1 ? 'y' : 'ies'} in progress`,
      chip: 'Irrigation',
    });
  }
  return items;
}

function toneColor(tone) {
  if (tone === 'warning') return 'warning.main';
  if (tone === 'secondary') return 'secondary.main';
  return 'primary.main';
}

/**
 * "Today's priorities" — real actionable items, or a reassuring empty state.
 */
function PriorityList({ snapshot }) {
  const navigate = useNavigate();
  const items = buildPriorities(snapshot);

  if (items.length === 0) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 2 }}>
        <Box
          sx={{
            width: 48, height: 48, borderRadius: '50%', flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'success.main',
            bgcolor: (t) => alpha(t.palette.success.main, 0.12),
          }}
        >
          <CheckCircleOutlineOutlinedIcon />
        </Box>
        <Box>
          <Typography variant="subtitle1" sx={{ color: 'text.primary', fontWeight: 600 }}>
            Your vineyard is up to date
          </Typography>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            No urgent activities right now. Plan ahead from the Planner.
          </Typography>
        </Box>
      </Box>
    );
  }

  return (
    <List disablePadding>
      {items.map((item, idx) => {
        const Icon = item.icon;
        return (
          <ListItem key={idx} disablePadding sx={{ mb: 0.5 }}>
            <ListItemButton onClick={() => navigate(item.path)} sx={{ borderRadius: 2, py: 1.25 }}>
              <ListItemIcon sx={{ minWidth: 44 }}>
                <Box
                  sx={{
                    width: 36, height: 36, borderRadius: 2,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: toneColor(item.tone),
                    bgcolor: (t) => alpha(
                      item.tone === 'warning' ? t.palette.warning.main
                        : item.tone === 'secondary' ? t.palette.secondary.main
                        : t.palette.primary.main, 0.12),
                  }}
                >
                  <Icon fontSize="small" />
                </Box>
              </ListItemIcon>
              <ListItemText primary={item.label} primaryTypographyProps={{ variant: 'body2', fontWeight: 500 }} />
              <Chip label={item.chip} size="small" sx={{ ml: 1, flexShrink: 0 }} />
            </ListItemButton>
          </ListItem>
        );
      })}
    </List>
  );
}

export default PriorityList;
