import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Paper, Typography, Divider, Grid, Avatar, Button, Skeleton, Alert,
} from '@mui/material';
import LogoutOutlinedIcon from '@mui/icons-material/LogoutOutlined';
import PageContainer from '../components/layout/PageContainer';
import ConfirmDialog from '../components/common/ConfirmDialog';
import { formatDate } from '../components/common/formatters';
import { getCurrentUser, signOut } from '../services/authService';

function DetailItem({ label, children }) {
  return (
    <Box>
      <Typography variant="overline" sx={{ display: 'block' }}>{label}</Typography>
      <Typography variant="subtitle1" sx={{ color: 'text.primary', fontWeight: 600, wordBreak: 'break-word' }}>{children}</Typography>
    </Box>
  );
}

function Account() {
  const navigate = useNavigate();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true); setError('');
      const { data, error: err } = await getCurrentUser();
      if (!active) return;
      if (err) setError('We couldn\u2019t load your account details right now.');
      else setUser(data?.user ?? null);
      setLoading(false);
    })();
    return () => { active = false; };
  }, []);

  const handleSignOut = async () => {
    setSigningOut(true);
    await signOut();
    setSigningOut(false);
    setConfirmOpen(false);
    navigate('/login', { replace: true });
  };

  const fullName = user?.user_metadata?.full_name || '';
  const email = user?.email || '';
  const initial = (fullName || email || '?').trim().charAt(0).toUpperCase();

  return (
    <PageContainer>
      <Typography variant="h2" component="h1" sx={{ mb: 0.5 }}>Account</Typography>
      <Typography variant="body1" sx={{ color: 'text.secondary', mb: 4 }}>Your Winerix profile and session.</Typography>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      <Paper sx={{ p: { xs: 2.5, md: 4 } }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <Avatar sx={{ width: 64, height: 64, fontSize: '1.6rem' }}>{loading ? '' : initial}</Avatar>
          <Box sx={{ minWidth: 0 }}>
            {loading ? (
              <>
                <Skeleton width={180} height={30} />
                <Skeleton width={220} height={20} sx={{ mt: 0.5 }} />
              </>
            ) : (
              <>
                <Typography variant="h4" component="p">{fullName || 'Winerix User'}</Typography>
                <Typography variant="body2" sx={{ color: 'text.secondary' }}>{email}</Typography>
              </>
            )}
          </Box>
        </Box>

        <Divider sx={{ my: 3 }} />

        {loading ? (
          <Skeleton width="60%" height={24} />
        ) : (
          <Grid container spacing={3}>
            <Grid item xs={12} sm={6}><DetailItem label="Full Name">{fullName || '—'}</DetailItem></Grid>
            <Grid item xs={12} sm={6}><DetailItem label="Email">{email || '—'}</DetailItem></Grid>
            <Grid item xs={12} sm={6}><DetailItem label="Member Since">{formatDate(user?.created_at)}</DetailItem></Grid>
          </Grid>
        )}

        <Divider sx={{ my: 3 }} />

        <Button variant="outlined" color="secondary" startIcon={<LogoutOutlinedIcon />} onClick={() => setConfirmOpen(true)}>
          Sign Out
        </Button>
      </Paper>

      <ConfirmDialog
        open={confirmOpen}
        title="Sign Out"
        message="Are you sure you want to sign out of Winerix?"
        confirmLabel="Sign Out"
        confirmColor="secondary"
        loading={signingOut}
        onConfirm={handleSignOut}
        onClose={() => setConfirmOpen(false)}
      />
    </PageContainer>
  );
}

export default Account;
