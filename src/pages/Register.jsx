import { useState } from 'react';
import { useNavigate, Link as RouterLink } from 'react-router-dom';
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
import { signUp } from '../services/authService';
import winerixLogo from '../assets/logo/WineRix main logo.png';
import vineyardBg from '../assets/images/Background_farm.png';

function Register() {
  const navigate = useNavigate();

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const validateEmail = (value) => {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  };

  const getErrorMessage = (supabaseError) => {
    if (!supabaseError) return 'An unexpected error occurred. Please try again.';

    const msg = supabaseError.message?.toLowerCase() || '';

    if (msg.includes('already registered') || msg.includes('already been registered')) {
      return 'This email is already registered. Please sign in instead.';
    }
    if (msg.includes('password') && msg.includes('at least')) {
      return 'Password must be at least 6 characters long.';
    }
    if (msg.includes('valid email')) {
      return 'Please enter a valid email address.';
    }
    if (msg.includes('rate limit') || msg.includes('too many requests')) {
      return 'Too many attempts. Please wait a moment and try again.';
    }
    if (msg.includes('network') || msg.includes('fetch')) {
      return 'Network error. Please check your connection and try again.';
    }

    return supabaseError.message || 'An unexpected error occurred. Please try again.';
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    // Validation
    if (!fullName.trim()) {
      setError('Please enter your full name.');
      return;
    }

    if (!email.trim()) {
      setError('Please enter your email address.');
      return;
    }

    if (!validateEmail(email.trim())) {
      setError('Please enter a valid email address.');
      return;
    }

    if (!password) {
      setError('Please enter a password.');
      return;
    }

    if (password.length < 6) {
      setError('Password must be at least 6 characters long.');
      return;
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);

    const { data, error: authError } = await signUp(email.trim(), password, {
      full_name: fullName.trim(),
    });

    if (authError) {
      setError(getErrorMessage(authError));
      setLoading(false);
      return;
    }

    // Check if email confirmation is required
    if (data?.user?.identities?.length === 0) {
      setError('This email is already registered. Please sign in instead.');
      setLoading(false);
      return;
    }

    if (data?.session) {
      // Auto-confirmed — navigate to dashboard
      navigate('/dashboard', { replace: true });
    } else {
      // Email confirmation required
      setSuccess(true);
      setLoading(false);
    }
  };

  // Success state — email confirmation needed
  if (success) {
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
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            backgroundColor: 'rgba(248, 246, 241, 0.3)',
            pointerEvents: 'none',
          }}
        />
        <Paper
          elevation={0}
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
          <Box
            component="img"
            src={winerixLogo}
            alt="Winerix"
            sx={{
              width: '100%',
              maxWidth: 180,
              height: 'auto',
              mx: 'auto',
              mb: 3,
              display: 'block',
            }}
          />
          <Typography variant="h4" sx={{ color: 'primary.main', mb: 1 }}>
            Check your email
          </Typography>
          <Typography variant="body2" sx={{ color: 'text.secondary', mb: 3 }}>
            We&apos;ve sent a confirmation link to <strong>{email}</strong>.
            Please confirm your email to complete registration.
          </Typography>
          <Button
            component={RouterLink}
            to="/login"
            variant="outlined"
            color="primary"
            fullWidth
          >
            Back to Sign In
          </Button>
        </Paper>
      </Box>
    );
  }

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

      {/* Register Card */}
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
            maxWidth: 200,
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
          Create your account
        </Typography>

        <Typography
          variant="body2"
          sx={{ color: 'text.secondary', mb: 3 }}
        >
          Start managing your vineyard intelligently.
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

        {/* Full Name Field */}
        <TextField
          fullWidth
          label="Full Name"
          type="text"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          autoComplete="name"
          autoFocus
          disabled={loading}
          sx={{ mb: 2 }}
        />

        {/* Email Field */}
        <TextField
          fullWidth
          label="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
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
          autoComplete="new-password"
          disabled={loading}
          helperText="At least 6 characters"
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
          sx={{ mb: 2 }}
        />

        {/* Confirm Password Field */}
        <TextField
          fullWidth
          label="Confirm Password"
          type={showPassword ? 'text' : 'password'}
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          autoComplete="new-password"
          disabled={loading}
          sx={{ mb: 3 }}
        />

        {/* Register Button */}
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
            'Create Account'
          )}
        </Button>

        {/* Login Link */}
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          Already have an account?{' '}
          <Link
            component={RouterLink}
            to="/login"
            underline="hover"
            sx={{ color: 'secondary.main', fontWeight: 600 }}
          >
            Sign in
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

export default Register;
