import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import QRCode from 'qrcode';
import { Box, Paper, TextField, Button, Typography, Alert } from '@mui/material';
import { useAuth } from '../context/AuthContext';

const TOTP_ISSUER = 'APOHCO Dashboard';

// Which form to show for each Cognito sign-in step we support.
const STEP_VIEWS = {
  CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED: 'newPassword',
  CONTINUE_SIGN_IN_WITH_TOTP_SETUP: 'totpSetup',
  CONFIRM_SIGN_IN_WITH_TOTP_CODE: 'totpCode',
};

function TotpSetup({ setupUri, sharedSecret }) {
  const [qrDataUrl, setQrDataUrl] = useState(null);

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(setupUri, { margin: 1, width: 200 })
      .then((url) => !cancelled && setQrDataUrl(url))
      .catch(() => !cancelled && setQrDataUrl(null));
    return () => {
      cancelled = true;
    };
  }, [setupUri]);

  return (
    <Box sx={{ mb: 2 }}>
      <Typography variant="body2" sx={{ mb: 2 }}>
        Your account needs an authenticator app (for example Google Authenticator, Microsoft
        Authenticator or 1Password). Scan this code with the app, then enter the 6-digit code it shows.
      </Typography>
      {qrDataUrl && (
        <Box sx={{ display: 'flex', justifyContent: 'center', mb: 2 }}>
          <img src={qrDataUrl} alt="Authenticator setup QR code" width={200} height={200} />
        </Box>
      )}
      <Typography variant="caption" color="text.secondary" component="div">
        Can&apos;t scan? Enter this key in the app instead:
      </Typography>
      <Typography
        variant="body2"
        data-testid="totp-secret"
        sx={{ fontFamily: 'monospace', wordBreak: 'break-all', mb: 1 }}
      >
        {sharedSecret}
      </Typography>
    </Box>
  );
}

export default function Login() {
  const { signIn, confirmSignInStep } = useAuth();
  const navigate = useNavigate();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [code, setCode] = useState('');
  const [view, setView] = useState('credentials');
  const [totpSetup, setTotpSetup] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const handleResult = (result) => {
    if (result.isSignedIn) {
      navigate('/');
      return;
    }
    const step = result.nextStep?.signInStep;
    const nextView = STEP_VIEWS[step];
    if (!nextView) {
      setError(new Error(`Unsupported sign-in step: ${step}`));
      return;
    }
    if (nextView === 'totpSetup') {
      const details = result.nextStep.totpSetupDetails;
      setTotpSetup({
        sharedSecret: details.sharedSecret,
        setupUri: details.getSetupUri(TOTP_ISSUER, username).toString(),
      });
    }
    setCode('');
    setView(nextView);
  };

  const run = (action) => async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      handleResult(await action());
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };

  const codeField = (
    <TextField
      fullWidth
      size="small"
      label="6-digit code"
      autoFocus
      autoComplete="one-time-code"
      inputProps={{ inputMode: 'numeric', pattern: '[0-9]{6}', maxLength: 6 }}
      value={code}
      onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
      sx={{ mb: 3 }}
    />
  );

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
      <Paper variant="outlined" sx={{ p: 4, width: 380 }}>
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

        {view === 'credentials' && (
          <Box component="form" onSubmit={run(() => signIn(username, password))}>
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
        )}

        {view === 'newPassword' && (
          <Box component="form" onSubmit={run(() => confirmSignInStep(newPassword))}>
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
              {submitting ? 'Setting password...' : 'Set Password & Continue'}
            </Button>
          </Box>
        )}

        {view === 'totpSetup' && totpSetup && (
          <Box component="form" onSubmit={run(() => confirmSignInStep(code))}>
            <TotpSetup setupUri={totpSetup.setupUri} sharedSecret={totpSetup.sharedSecret} />
            {codeField}
            <Button fullWidth variant="contained" type="submit" disabled={submitting || code.length !== 6}>
              {submitting ? 'Verifying...' : 'Verify & Sign In'}
            </Button>
          </Box>
        )}

        {view === 'totpCode' && (
          <Box component="form" onSubmit={run(() => confirmSignInStep(code))}>
            <Typography variant="body2" sx={{ mb: 2 }}>
              Enter the 6-digit code from your authenticator app.
            </Typography>
            {codeField}
            <Button fullWidth variant="contained" type="submit" disabled={submitting || code.length !== 6}>
              {submitting ? 'Verifying...' : 'Verify & Sign In'}
            </Button>
          </Box>
        )}
      </Paper>
    </Box>
  );
}
