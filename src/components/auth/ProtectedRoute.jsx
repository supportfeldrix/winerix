import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { Box, CircularProgress } from '@mui/material';
import { getSession, onAuthStateChange } from '../../services/authService';
import MainLayout from '../layout/MainLayout';

/**
 * Route guard for the authenticated Winerix application shell.
 *
 * Resolves the current Supabase session using the existing authService and
 * subscribes to auth state changes. While the session is being resolved a
 * loading indicator is shown. Unauthenticated users are redirected to /login.
 * Authenticated users are rendered inside the MainLayout shell, with the
 * resolved user passed down to the TopBar.
 */
function ProtectedRoute() {
  const [status, setStatus] = useState('loading'); // 'loading' | 'authed' | 'unauthed'
  const [user, setUser] = useState(null);

  useEffect(() => {
    let active = true;

    // Initial session check
    getSession().then(({ data }) => {
      if (!active) return;
      const session = data?.session ?? null;
      setUser(session?.user ?? null);
      setStatus(session ? 'authed' : 'unauthed');
    });

    // Keep in sync with future auth changes (sign in / sign out / token refresh)
    const { subscription } = onAuthStateChange((_event, session) => {
      if (!active) return;
      setUser(session?.user ?? null);
      setStatus(session ? 'authed' : 'unauthed');
    });

    return () => {
      active = false;
      subscription?.unsubscribe();
    };
  }, []);

  if (status === 'loading') {
    return (
      <Box
        sx={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          bgcolor: 'background.default',
        }}
      >
        <CircularProgress color="primary" />
      </Box>
    );
  }

  if (status === 'unauthed') {
    return <Navigate to="/login" replace />;
  }

  return <MainLayout user={user} />;
}

export default ProtectedRoute;
