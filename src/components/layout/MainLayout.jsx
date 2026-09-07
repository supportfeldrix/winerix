import { useState } from 'react';
import { useLocation, Outlet } from 'react-router-dom';
import { Box, Drawer, Toolbar } from '@mui/material';
import Sidebar from './Sidebar';
import TopBar from './TopBar';
import { SIDEBAR_WIDTH, getPageTitle } from './navigation';

/**
 * Winerix application shell.
 *
 * Composes the responsive navigation sidebar, the top application bar and the
 * main content area. On desktop the sidebar is a permanent rail; on mobile it
 * becomes a temporary drawer toggled from the TopBar. Page content is rendered
 * through the router <Outlet />.
 *
 * @param {object|null} user - The authenticated Supabase user, passed to TopBar.
 */
function MainLayout({ user }) {
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);

  const title = getPageTitle(location.pathname);

  const handleDrawerToggle = () => setMobileOpen((prev) => !prev);
  const handleDrawerClose = () => setMobileOpen(false);

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh', bgcolor: 'background.default', overflowX: 'hidden' }}>
      <TopBar title={title} user={user} onMenuClick={handleDrawerToggle} />

      {/* Navigation drawers */}
      <Box
        component="nav"
        aria-label="Winerix navigation"
        sx={{ width: { md: SIDEBAR_WIDTH }, flexShrink: { md: 0 } }}
      >
        {/* Mobile: temporary drawer */}
        <Drawer
          variant="temporary"
          open={mobileOpen}
          onClose={handleDrawerClose}
          ModalProps={{ keepMounted: true }}
          sx={{
            display: { xs: 'block', md: 'none' },
            '& .MuiDrawer-paper': {
              width: SIDEBAR_WIDTH,
              boxSizing: 'border-box',
              height: '100vh',
              overflowX: 'hidden',
              overflowY: 'hidden',
            },
          }}
        >
          <Sidebar onNavigate={handleDrawerClose} />
        </Drawer>

        {/* Desktop: permanent rail */}
        <Drawer
          variant="permanent"
          open
          sx={{
            display: { xs: 'none', md: 'block' },
            '& .MuiDrawer-paper': {
              width: SIDEBAR_WIDTH,
              boxSizing: 'border-box',
              height: '100vh',
              overflowX: 'hidden',
              overflowY: 'hidden',
            },
          }}
        >
          <Sidebar />
        </Drawer>
      </Box>

      {/* Main content area */}
      <Box
        component="main"
        sx={{
          flexGrow: 1,
          width: { md: `calc(100% - ${SIDEBAR_WIDTH}px)` },
          minWidth: 0,
          maxWidth: '100%',
          overflowX: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Spacer matching the fixed AppBar height */}
        <Toolbar />
        <Box sx={{ flexGrow: 1 }}>
          <Outlet />
        </Box>
      </Box>
    </Box>
  );
}

export default MainLayout;
