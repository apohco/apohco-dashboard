import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Paper, TextField, Button, Typography, Alert } from '@mui/material';
import { useAuth } from '../context/AuthContext';

export default function Login() {
  const { signIn, confirmNewPassword } = useAuth();
  const navigate = useNavigate();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [needsNewPassword, setNeedsNewPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const handleSignIn = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const result = await signIn(username, password);
      if (result.isSignedIn) {
        navigate('/');
      } else if (result.nextStep?.signInStep === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED') {
        setNeedsNewPassword(true);
      } else {
        setError(new Error(`Unsupported sign-in step: ${result.nextStep?.signInStep}`));
      }
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSetNewPassword = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const result = await confirmNewPassword(newPassword);
      if (result.isSignedIn) {
        navigate('/');
      } else {
        setError(new Error(`Unsupported sign-in step: ${result.nextStep?.signInStep}`));
      }
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };

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
      <Paper variant="outlined" sx={{ p: 4, width: 360 }}>
        <Typography variant="h5" sx={{ mb: 1, color: 'primary.main', fontWeight: 700 }}>
          APOHCO
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
          Financial Dashboard
        </Typography>

        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error.message}
          </Alert>
        )}

        {!needsNewPassword ? (
          <Box component="form" onSubmit={handleSignIn}>
            <TextField
              fullWidth
              size="small"
              label="Username"
              autoFocus
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              sx={{ mb: 2 }}
            />
            <TextField
              fullWidth
              size="small"
              type="password"
              label="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              sx={{ mb: 3 }}
            />
            <Button fullWidth variant="contained" type="submit" disabled={submitting}>
              {submitting ? 'Signing in...' : 'Sign In'}
            </Button>
          </Box>
        ) : (
          <Box component="form" onSubmit={handleSetNewPassword}>
            <Typography variant="body2" sx={{ mb: 2 }}>
              This is your first sign-in. Choose a new password.
            </Typography>
            <TextField
              fullWidth
              size="small"
              type="password"
              label="New Password"
              autoFocus
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              sx={{ mb: 3 }}
            />
            <Button fullWidth variant="contained" type="submit" disabled={submitting}>
              {submitting ? 'Setting password...' : 'Set Password & Sign In'}
            </Button>
          </Box>
        )}
      </Paper>
    </Box>
  );
}
