import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockNavigate = vi.fn();
const mockAuth = {
  signIn: vi.fn(),
  confirmSignInStep: vi.fn(),
  requestPasswordReset: vi.fn(),
  confirmPasswordReset: vi.fn(),
};

vi.mock('react-router-dom', () => ({ useNavigate: () => mockNavigate }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => mockAuth }));
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,QR') } }));

import Login from './Login';

const totpSetupStep = {
  isSignedIn: false,
  nextStep: {
    signInStep: 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP',
    totpSetupDetails: {
      sharedSecret: 'JBSWY3DPEHPK3PXP',
      getSetupUri: (issuer, account) => new URL(`otpauth://totp/${issuer}:${account}?secret=JBSWY3DPEHPK3PXP`),
    },
  },
};

async function signInAs(user) {
  await user.type(screen.getByLabelText('Username'), 'paul');
  await user.type(screen.getByLabelText('Password'), 'pw');
  await user.click(screen.getByRole('button', { name: 'Sign In' }));
}

beforeEach(() => {
  mockNavigate.mockReset();
  Object.values(mockAuth).forEach((fn) => fn.mockReset());
});

describe('Forgot password', () => {
  const codeSent = {
    isPasswordReset: false,
    nextStep: { resetPasswordStep: 'CONFIRM_RESET_PASSWORD_WITH_CODE', codeDeliveryDetails: { destination: 'p***@g***' } },
  };

  async function requestCode(user) {
    await user.click(screen.getByRole('button', { name: 'Forgot password?' }));
    await user.type(screen.getByLabelText('Username'), ' paul ');
    await user.click(screen.getByRole('button', { name: 'Email me a code' }));
  }

  test('emails a code, then sets the new password and returns to sign in', async () => {
    const user = userEvent.setup();
    mockAuth.requestPasswordReset.mockResolvedValue(codeSent);
    mockAuth.confirmPasswordReset.mockResolvedValue(undefined);
    render(<Login />);

    await requestCode(user);
    expect(mockAuth.requestPasswordReset).toHaveBeenCalledWith('paul');
    expect(screen.getByText(/a code was sent to p\*\*\*@g\*\*\*/)).toBeInTheDocument();

    await user.type(screen.getByLabelText('Reset code'), '123456');
    await user.type(screen.getByLabelText('New Password'), 'BrandNew2026x');
    await user.click(screen.getByRole('button', { name: 'Set New Password' }));

    expect(mockAuth.confirmPasswordReset).toHaveBeenCalledWith('paul', '123456', 'BrandNew2026x');
    expect(screen.getByText('Password changed. Sign in with your new password.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign In' })).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  test('keeps the user on the code screen when the code is wrong', async () => {
    const user = userEvent.setup();
    mockAuth.requestPasswordReset.mockResolvedValue(codeSent);
    mockAuth.confirmPasswordReset.mockRejectedValue(new Error('Invalid verification code provided, please try again.'));
    render(<Login />);

    await requestCode(user);
    await user.type(screen.getByLabelText('Reset code'), '000000');
    await user.type(screen.getByLabelText('New Password'), 'BrandNew2026x');
    await user.click(screen.getByRole('button', { name: 'Set New Password' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Invalid verification code');
    expect(screen.getByLabelText('Reset code')).toBeInTheDocument();
  });

  test('shows an error when the code cannot be sent', async () => {
    const user = userEvent.setup();
    mockAuth.requestPasswordReset.mockRejectedValue(new Error('Cannot reset password for the user as there is no registered/verified email or phone_number'));
    render(<Login />);

    await requestCode(user);
    expect(screen.getByRole('alert')).toHaveTextContent('no registered/verified email');
    expect(screen.getByRole('button', { name: 'Email me a code' })).toBeInTheDocument();
  });

  test('after an admin reset, sign-in goes straight to entering the emailed code', async () => {
    const user = userEvent.setup();
    mockAuth.signIn.mockResolvedValue({ isSignedIn: false, nextStep: { signInStep: 'RESET_PASSWORD' } });
    mockAuth.confirmPasswordReset.mockResolvedValue(undefined);
    render(<Login />);
    await signInAs(user);

    expect(screen.getByText(/reset by an administrator/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Reset code'), '111222');
    await user.type(screen.getByLabelText('New Password'), 'BrandNew2026x');
    await user.click(screen.getByRole('button', { name: 'Set New Password' }));
    expect(mockAuth.confirmPasswordReset).toHaveBeenCalledWith('paul', '111222', 'BrandNew2026x');
  });

  test('"Back to sign in" returns to the sign-in form', async () => {
    const user = userEvent.setup();
    render(<Login />);
    await user.click(screen.getByRole('button', { name: 'Forgot password?' }));
    await user.click(screen.getByRole('button', { name: 'Back to sign in' }));
    expect(screen.getByRole('button', { name: 'Sign In' })).toBeInTheDocument();
  });
});

describe('Login', () => {
  test('signs straight in when no further step is needed', async () => {
    const user = userEvent.setup();
    mockAuth.signIn.mockResolvedValue({ isSignedIn: true });
    render(<Login />);
    await signInAs(user);
    expect(mockAuth.signIn).toHaveBeenCalledWith('paul', 'pw');
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  test('walks a user without an authenticator through setup', async () => {
    const user = userEvent.setup();
    mockAuth.signIn.mockResolvedValue(totpSetupStep);
    mockAuth.confirmSignInStep.mockResolvedValue({ isSignedIn: true });
    render(<Login />);
    await signInAs(user);

    expect(screen.getByTestId('totp-secret')).toHaveTextContent('JBSWY3DPEHPK3PXP');
    expect(await screen.findByAltText('Authenticator setup QR code')).toHaveAttribute('src', 'data:image/png;base64,QR');

    const verify = screen.getByRole('button', { name: 'Verify & Sign In' });
    expect(verify).toBeDisabled();
    await user.type(screen.getByLabelText('6-digit code'), '12a3456');
    expect(screen.getByLabelText('6-digit code')).toHaveValue('123456');
    await user.click(verify);

    expect(mockAuth.confirmSignInStep).toHaveBeenCalledWith('123456');
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  test('asks an enrolled user for their code', async () => {
    const user = userEvent.setup();
    mockAuth.signIn.mockResolvedValue({ isSignedIn: false, nextStep: { signInStep: 'CONFIRM_SIGN_IN_WITH_TOTP_CODE' } });
    mockAuth.confirmSignInStep.mockResolvedValue({ isSignedIn: true });
    render(<Login />);
    await signInAs(user);

    expect(screen.getByText('Enter the 6-digit code from your authenticator app.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('6-digit code'), '654321');
    await user.click(screen.getByRole('button', { name: 'Verify & Sign In' }));
    expect(mockAuth.confirmSignInStep).toHaveBeenCalledWith('654321');
  });

  test('a new user sets a password and then sets up the authenticator', async () => {
    const user = userEvent.setup();
    mockAuth.signIn.mockResolvedValue({ isSignedIn: false, nextStep: { signInStep: 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED' } });
    mockAuth.confirmSignInStep.mockResolvedValueOnce(totpSetupStep);
    render(<Login />);
    await signInAs(user);

    await user.type(screen.getByLabelText('New Password'), 'NewPassw0rd!');
    await user.click(screen.getByRole('button', { name: 'Set Password & Continue' }));
    expect(mockAuth.confirmSignInStep).toHaveBeenCalledWith('NewPassw0rd!');
    expect(screen.getByTestId('totp-secret')).toBeInTheDocument();
  });

  test('shows a wrong code error and stays on the code screen', async () => {
    const user = userEvent.setup();
    mockAuth.signIn.mockResolvedValue({ isSignedIn: false, nextStep: { signInStep: 'CONFIRM_SIGN_IN_WITH_TOTP_CODE' } });
    mockAuth.confirmSignInStep.mockRejectedValue(new Error('Invalid code received for user'));
    render(<Login />);
    await signInAs(user);
    await user.type(screen.getByLabelText('6-digit code'), '000000');
    await user.click(screen.getByRole('button', { name: 'Verify & Sign In' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid code');
    expect(screen.getByLabelText('6-digit code')).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  test('reports an unsupported step', async () => {
    const user = userEvent.setup();
    mockAuth.signIn.mockResolvedValue({ isSignedIn: false, nextStep: { signInStep: 'CONFIRM_SIGN_IN_WITH_SMS_CODE' } });
    render(<Login />);
    await signInAs(user);
    expect(screen.getByRole('alert')).toHaveTextContent('Unsupported sign-in step');
  });
});
