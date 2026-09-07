import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Paper,
  Typography,
  TextField,
  Button,
  InputAdornment,
  IconButton,
  Alert,
  Link,
  Divider,
  CircularProgress,
} from '@mui/material';
import { Visibility, VisibilityOff } from '@mui/icons-material';
import { signIn } from '../services/authService';
import winerixLogo from '../assets/logo/WineRix main logo.png';
import vineyardBg from '../assets/images/Background_farm.png';

function Login() {
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const validateEmail = (value) => {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  };

  const getErrorMessage = (supabaseError) => {
    if (!supabaseError) return 'An unexpected error occurred. Please try again.';

    const msg = supabaseError.message?.toLowerCase() || '';

    if (msg.includes('invalid login credentials')) {
      return 'Invalid email or password. Please try again.';
    }
    if (msg.includes('email not confirmed')) {
      return 'Your email has not been confirmed. Please check your inbox.';
    }
    if (msg.includes('too many requests') || msg.includes('rate limit')) {
      return 'Too many login attempts. Please wait a moment and try again.';
    }
    if (msg.includes('network') || msg.includes('fetch')) {
      return 'Network error. Please check your connection and try again.';
    }

    return supabaseError.message || 'An unexpected error occurred. Please try again.';
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (!email.trim()) {
      setError('Please enter your email address.');
      return;
    }

    if (!validateEmail(email.trim())) {
      setError('Please enter a valid email address.');
      return;
    }

    if (!password) {
      setError('Please enter your password.');
      return;
    }

    setLoading(true);

    const { error: authError } = await signIn(email.trim(), password);

    if (authError) {
      setError(getErrorMessage(authError));
      setLoading(false);
      return;
    }

    navigate('/dashboard', { replace: true });
  };

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        px: 2,
        py: 4,
        position: 'relative',
        backgroundImage: `url(${vineyardBg})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundRepeat: 'no-repeat',
      }}
    >
      {/* Subtle overlay */}
      <Box
        sx={{
          position: 'absolute',
          inset: 0,
          backgroundColor: 'rgba(248, 246, 241, 0.3)',
          pointerEvents: 'none',
        }}
      />

      {/* Login Card */}
      <Paper
        elevation={0}
        component="form"
        onSubmit={handleSubmit}
        noValidate
        sx={{
          position: 'relative',
          width: '100%',
          maxWidth: 420,
          px: { xs: 3, sm: 4 },
          py: { xs: 4, sm: 5 },
          textAlign: 'center',
          borderTop: '4px solid',
          borderTopColor: 'primary.main',
          backgroundColor: 'rgba(255, 255, 255, 0.88)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          border: '1px solid rgba(255, 255, 255, 0.5)',
          borderTopWidth: '4px',
          borderTopStyle: 'solid',
          boxShadow: '0 8px 40px rgba(44, 44, 44, 0.12), 0 2px 12px rgba(44, 44, 44, 0.06)',
        }}
      >
        {/* Logo */}
        <Box
          component="img"
          src={winerixLogo}
          alt="Winerix"
          sx={{
            width: '100%',
            maxWidth: 220,
            height: 'auto',
            mx: 'auto',
            mb: 3,
            display: 'block',
          }}
        />

        {/* Heading */}
        <Typography
          variant="h4"
          component="h1"
          sx={{ color: 'primary.main', mb: 0.5 }}
        >
          Welcome back
        </Typography>

        <Typography
          variant="body2"
          sx={{ color: 'text.secondary', mb: 3 }}
        >
          Sign in to your vineyard intelligence workspace.
        </Typography>

        {/* Gold Divider */}
        <Divider
          sx={{
            mb: 3,
            mx: 'auto',
            width: 50,
            borderColor: 'accent.main',
            borderBottomWidth: 2,
          }}
        />

        {/* Error Alert */}
        {error && (
          <Alert
            severity="error"
            sx={{ mb: 2, textAlign: 'left' }}
            onClose={() => setError('')}
          >
            {error}
          </Alert>
        )}

        {/* Email Field */}
        <TextField
          fullWidth
          label="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          autoFocus
          disabled={loading}
          sx={{ mb: 2 }}
        />

        {/* Password Field */}
        <TextField
          fullWidth
          label="Password"
          type={showPassword ? 'text' : 'password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          disabled={loading}
          InputProps={{
            endAdornment: (
              <InputAdornment position="end">
                <IconButton
                  onClick={() => setShowPassword(!showPassword)}
                  edge="end"
                  size="small"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  disabled={loading}
                >
                  {showPassword ? <VisibilityOff /> : <Visibility />}
                </IconButton>
              </InputAdornment>
            ),
          }}
          sx={{ mb: 3 }}
        />

        {/* Sign In Button */}
        <Button
          type="submit"
          fullWidth
          variant="contained"
          color="primary"
          size="large"
          disabled={loading}
          sx={{ mb: 2 }}
        >
          {loading ? (
            <CircularProgress size={22} color="inherit" />
          ) : (
            'Sign In'
          )}
        </Button>

        {/* Register Link */}
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          Don&apos;t have an account?{' '}
          <Link
            href="/register"
            underline="hover"
            sx={{ color: 'secondary.main', fontWeight: 600 }}
          >
            Create one
          </Link>
        </Typography>
      </Paper>

      {/* Footer */}
      <Typography
        variant="caption"
        sx={{
          mt: 3,
          color: 'rgba(255, 255, 255, 0.85)',
          letterSpacing: '0.02em',
          position: 'relative',
          textShadow: '0 1px 3px rgba(0, 0, 0, 0.3)',
        }}
      >
        winerix.feldrix.com
      </Typography>
    </Box>
  );
}

export default Login;
