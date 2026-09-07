import { useLocation, useNavigate } from 'react-router-dom';
import {
  Box,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Typography,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import { MAIN_NAV, SECONDARY_NAV, SIDEBAR_WIDTH } from './navigation';
import winerixLogo from '../../assets/logo/WineRix main logo.png';
import GrapevineDecoration from './GrapevineDecoration';

/**
 * Winerix application sidebar.
 *
 * Renders the official logo, the primary application navigation grouped under
 * section labels, and a secondary section (Account). Highlights the active
 * destination with an elegant gold accent. Used both as a permanent desktop
 * rail and inside a temporary mobile drawer.
 *
 * @param {function} [onNavigate] - Called after a navigation item is selected
 *   (used by the mobile drawer to close itself).
 */
function Sidebar({ onNavigate }) {
  const navigate = useNavigate();
  const location = useLocation();

  const isActive = (path) =>
    location.pathname === path || location.pathname.startsWith(`${path}/`);

  const handleNavigate = (path) => {
    navigate(path);
    if (onNavigate) onNavigate();
  };

  const renderNavItem = (item) => {
    const Icon = item.icon;
    const active = isActive(item.path);
    return (
      <ListItem key={item.path} disablePadding sx={{ px: 1.25, mb: 0.25 }}>
        <ListItemButton
          selected={active}
          onClick={() => handleNavigate(item.path)}
          sx={{
            minHeight: 46,
            borderRadius: 2,
            pl: 2,
            position: 'relative',
            transition: 'background-color 0.15s ease',
            // Elegant gold accent bar on the active item.
            '&.Mui-selected::before': {
              content: '""',
              position: 'absolute',
              left: 0,
              top: '50%',
              transform: 'translateY(-50%)',
              width: 3,
              height: 22,
              borderRadius: 4,
              backgroundColor: 'accent.main',
            },
            '&.Mui-selected': {
              bgcolor: (t) => alpha(t.palette.primary.main, 0.1),
              '&:hover': { bgcolor: (t) => alpha(t.palette.primary.main, 0.14) },
            },
          }}
        >
          <ListItemIcon
            sx={{ minWidth: 36, color: active ? 'primary.main' : 'text.secondary' }}
          >
            <Icon fontSize="small" />
          </ListItemIcon>
          <ListItemText
            primary={item.label}
            primaryTypographyProps={{
              fontSize: '0.875rem',
              fontWeight: active ? 600 : 500,
              color: active ? 'primary.main' : 'text.primary',
            }}
          />
        </ListItemButton>
      </ListItem>
    );
  };

  const sectionLabel = (label) => (
    <Typography
      variant="overline"
      sx={{ display: 'block', px: 3, pt: 2, pb: 0.5, color: 'text.disabled', letterSpacing: '0.08em' }}
    >
      {label}
    </Typography>
  );

  return (
    <Box
      sx={{
        width: SIDEBAR_WIDTH,
        maxWidth: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        bgcolor: 'background.paper',
        overflowX: 'hidden',
        overflowY: 'hidden',
      }}
    >
      {/* Brand / Logo — fixed at the top, never scrolls */}
      <Box
        sx={{
          flexShrink: 0,
          px: 3,
          py: 2.5,
          display: 'flex',
          alignItems: 'center',
          minHeight: 64,
          borderBottom: '1px solid',
          borderColor: 'divider',
        }}
      >
        <Box
          component="img"
          src={winerixLogo}
          alt="Winerix — Vineyard Intelligence"
          sx={{ width: '100%', maxWidth: 172, height: 'auto', display: 'block' }}
        />
      </Box>

      {/* Primary navigation — fills the middle of the column. It may scroll if
          the viewport is genuinely too short to show every item, but the
          scrollbar itself is never painted (hidden across all browsers) so the
          sidebar always looks clean. Account + grape live in their own regions
          below, so they are never covered or pushed away by this scroll. */}
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          overflowX: 'hidden',
          pb: 1,
          // Hide the scrollbar visually while keeping the area scrollable.
          scrollbarWidth: 'none', // Firefox
          msOverflowStyle: 'none', // legacy Edge/IE
          '&::-webkit-scrollbar': { width: 0, height: 0, display: 'none' }, // Chromium/WebKit
        }}
      >
        {sectionLabel('Manage')}
        <List disablePadding>{MAIN_NAV.map(renderNavItem)}</List>
      </Box>

      {/* Account — anchored below the scroll area, always accessible */}
      <Box
        sx={{
          flexShrink: 0,
          borderTop: '1px solid',
          borderColor: 'divider',
          pb: 0.5,
        }}
      >
        {sectionLabel('Account')}
        <List disablePadding>{SECONDARY_NAV.map(renderNavItem)}</List>
      </Box>

      {/* Footer — decorative grapevine branding. Anchored at the bottom but
          allowed to shrink so it yields vertical space to the navigation
          before the nav is ever forced to scroll. */}
      <Box
        sx={{
          position: 'relative',
          height: 148,
          minHeight: 56,
          flexShrink: 1,
          overflow: 'hidden',
        }}
      >
        <GrapevineDecoration />
      </Box>
    </Box>
  );
}

export default Sidebar;
