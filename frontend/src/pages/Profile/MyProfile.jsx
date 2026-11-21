import { useEffect, useState } from 'react';
import { Alert, Box, Button, Paper, TextField, Typography } from '@mui/material';
import { useAuth } from '../../context/AuthContext';

const ROLE_LABELS = {
  SoftwareAdmin: 'Software Admin',
  SoftwareRep: 'Software Rep',
  Owner: 'Owner',
  Manager: 'Manager',
  TeamMember: 'Team Member',
};

const MIN_LENGTH = 10;

// Mirrors the user pool password policy, so most mistakes are caught
// before the request.
export function passwordProblems(password) {
  const problems = [];
  if (password.length < MIN_LENGTH) problems.push(`at least ${MIN_LENGTH} characters`);
  if (!/[a-z]/.test(password)) problems.push('a lowercase letter');
  if (!/[A-Z]/.test(password)) problems.push('an uppercase letter');
  if (!/[0-9]/.test(password)) problems.push('a number');
  return problems;
}

function Detail({ label, children }) {
  return (
    <Box sx={{ display: 'flex', py: 0.75 }}>
      <Typography variant="body2" color="text.secondary" sx={{ width: 160, flexShrink: 0 }}>
        {label}
      </Typography>
      <Typography variant="body2">{children}</Typography>
    </Box>
  );
}

export default function MyProfile() {
  const { user, changePassword, getMfaStatus } = useAuth();
  const [mfa, setMfa] = useState(null);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    getMfaStatus().then(setMfa).catch(() => setMfa(null));
  }, [getMfaStatus]);

  const problems = next ? passwordProblems(next) : [];
  const mismatch = confirm && next !== confirm;
  const canSave = current && next && confirm && !problems.length && !mismatch;

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setDone(false);
    try {
      await changePassword(current, next);
      setDone(true);
      setCurrent('');
      setNext('');
      setConfirm('');
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Box sx={{ maxWidth: 560 }}>
      <Typography variant="h1" sx={{ mb: 2 }}>
        My Profile
      </Typography>

      <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
        <Detail label="Username">{user?.username}</Detail>
        <Detail label="Email">{user?.email || '—'}</Detail>
        <Detail label="Role">{ROLE_LABELS[user?.role] || user?.role || '—'}</Detail>
        <Detail label="Authenticator app">{mfa === null ? '—' : mfa.totpEnabled ? 'Set up' : 'Not set up'}</Detail>
        <Typography variant="caption" color="text.secondary">
          To change your email or role, ask a Software Admin.
        </Typography>
      </Paper>

      <Paper variant="outlined" sx={{ p: 2 }} component="form" onSubmit={submit}>
        <Typography variant="h6" sx={{ mb: 2 }}>
          Change password
        </Typography>
        {done && <Alert severity="success" sx={{ mb: 2 }}>Password changed.</Alert>}
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error.message}</Alert>}
        <TextField fullWidth size="small" type="password" label="Current password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} sx={{ mb: 2 }} />
        <TextField
          fullWidth
          size="small"
          type="password"
          label="New password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          error={problems.length > 0}
          helperText={problems.length ? `Needs ${problems.join(', ')}.` : `At least ${MIN_LENGTH} characters, with upper and lower case letters and a number.`}
          sx={{ mb: 2 }}
        />
        <TextField
          fullWidth
          size="small"
          type="password"
          label="Confirm new password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          error={Boolean(mismatch)}
          helperText={mismatch ? "Passwords don't match." : ' '}
          sx={{ mb: 2 }}
        />
        <Button type="submit" variant="contained" disabled={!canSave || saving}>
          {saving ? 'Saving...' : 'Change password'}
        </Button>
      </Paper>
    </Box>
  );
}
