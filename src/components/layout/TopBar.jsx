import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AppBar,
  Toolbar,
  IconButton,
  Typography,
  Box,
  Avatar,
  Menu,
  MenuItem,
  ListItemIcon,
  Divider,
  Tooltip,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import MenuIcon from '@mui/icons-material/Menu';
import LogoutOutlinedIcon from '@mui/icons-material/LogoutOutlined';
import { signOut } from '../../services/authService';
import { SIDEBAR_WIDTH } from './navigation';

/**
 * Winerix top application bar.
 *
 * Displays the current page title, a menu button (mobile only) to open the
 * navigation drawer, and a user account area with a Sign Out action that uses
 * the existing authService. No credentials or tokens are ever displayed — only
 * the authenticated user's email.
 *
 * @param {string} title - Current page title.
 * @param {object|null} user - The authenticated Supabase user object.
 * @param {function} onMenuClick - Opens the mobile navigation drawer.
 */
function TopBar({ title, user, onMenuClick }) {
  const navigate = useNavigate();
  const [anchorEl, setAnchorEl] = useState(null);
  const menuOpen = Boolean(anchorEl);

  const email = user?.email || '';
  const fullName = user?.user_metadata?.full_name || '';
  const initial = (fullName || email || '?').trim().charAt(0).toUpperCase();

  const handleOpenMenu = (event) => setAnchorEl(event.currentTarget);
  const handleCloseMenu = () => setAnchorEl(null);

  const handleSignOut = async () => {
    handleCloseMenu();
    await signOut();
    navigate('/login', { replace: true });
  };

  return (
    <AppBar
      position="fixed"
      sx={{
        width: { md: `calc(100% - ${SIDEBAR_WIDTH}px)` },
        ml: { md: `${SIDEBAR_WIDTH}px` },
        backgroundColor: (t) => alpha(t.palette.background.paper, 0.85),
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
      }}
    >
      <Toolbar sx={{ gap: 1, px: { xs: 2, sm: 3, md: 4 } }}>
        {/* Mobile menu button */}
        <IconButton
          edge="start"
          aria-label="Open navigation menu"
          onClick={onMenuClick}
          sx={{ display: { md: 'none' }, mr: 0.5 }}
        >
          <MenuIcon />
        </IconButton>

        {/* Page context + title */}
        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          <Typography
            variant="overline"
            sx={{ display: { xs: 'none', sm: 'block' }, lineHeight: 1, color: 'text.disabled', letterSpacing: '0.1em' }}
          >
            Winerix
          </Typography>
          <Typography
            variant="h4"
            component="h1"
            noWrap
            sx={{ fontSize: { xs: '1.15rem', sm: '1.3rem' }, lineHeight: 1.2 }}
          >
            {title}
          </Typography>
        </Box>

        {/* User account area */}
        <Tooltip title="Account">
          <IconButton
            onClick={handleOpenMenu}
            size="small"
            aria-label="Account menu"
            aria-haspopup="true"
            aria-expanded={menuOpen ? 'true' : undefined}
            sx={{
              ml: 1,
              p: 0.5,
              border: '1px solid',
              borderColor: 'divider',
              transition: 'border-color 0.2s ease',
              '&:hover': { borderColor: 'primary.main' },
            }}
          >
            <Avatar sx={{ width: 34, height: 34, fontSize: '0.95rem' }}>
              {initial}
            </Avatar>
          </IconButton>
        </Tooltip>

        <Menu
          anchorEl={anchorEl}
          open={menuOpen}
          onClose={handleCloseMenu}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
          transformOrigin={{ vertical: 'top', horizontal: 'right' }}
          slotProps={{ paper: { sx: { mt: 1, minWidth: 220 } } }}
        >
          {/* Identity block — email only, no tokens */}
          <Box sx={{ px: 2, py: 1 }}>
            {fullName && (
              <Typography variant="subtitle2" sx={{ color: 'text.primary', fontWeight: 600 }} noWrap>
                {fullName}
              </Typography>
            )}
            <Typography variant="caption" sx={{ color: 'text.secondary' }} noWrap>
              {email}
            </Typography>
          </Box>

          <Divider />

          <MenuItem onClick={handleSignOut}>
            <ListItemIcon>
              <LogoutOutlinedIcon fontSize="small" />
            </ListItemIcon>
            Sign Out
          </MenuItem>
        </Menu>
      </Toolbar>
    </AppBar>
  );
}

export default TopBar;
