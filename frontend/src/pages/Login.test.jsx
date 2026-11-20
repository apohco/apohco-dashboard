import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockNavigate = vi.fn();
const mockAuth = { signIn: vi.fn(), confirmSignInStep: vi.fn() };

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
  mockAuth.signIn.mockReset();
  mockAuth.confirmSignInStep.mockReset();
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
