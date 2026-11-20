import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';

const amplify = vi.hoisted(() => ({
  signIn: vi.fn(),
  confirmSignIn: vi.fn(),
  signOut: vi.fn(),
  fetchAuthSession: vi.fn(),
}));
vi.mock('aws-amplify/auth', () => amplify);
vi.mock('../api/client', () => ({ attachAuthInterceptor: vi.fn() }));

import { AuthProvider, useAuth } from './AuthContext';

const session = (payload) => ({ tokens: { idToken: { payload, toString: () => 'jwt' } } });

let auth;
function Probe() {
  auth = useAuth();
  return <div data-testid="role">{auth.role || 'none'}</div>;
}

async function renderProvider() {
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>
  );
  await waitFor(() => expect(auth.initializing).toBe(false));
}

beforeEach(() => {
  Object.values(amplify).forEach((fn) => fn.mockReset());
  amplify.fetchAuthSession.mockResolvedValue({ tokens: null });
});

describe('AuthContext', () => {
  test('ControllerOwner needs both the SoftwareAdmin role and the Cognito group', async () => {
    amplify.fetchAuthSession.mockResolvedValue(
      session({ sub: 'u1', 'custom:role': 'SoftwareAdmin', 'cognito:groups': ['SoftwareAdmin', 'ControllerOwner'] })
    );
    await renderProvider();
    expect(auth.groups).toEqual(['SoftwareAdmin', 'ControllerOwner']);
    expect(auth.isControllerOwner).toBe(true);
  });

  test.each([
    [{ 'custom:role': 'SoftwareAdmin', 'cognito:groups': ['SoftwareAdmin'] }],
    [{ 'custom:role': 'Owner', 'cognito:groups': ['ControllerOwner'] }],
    [{ 'custom:role': 'SoftwareAdmin' }],
  ])('not a ControllerOwner: %j', async (claims) => {
    amplify.fetchAuthSession.mockResolvedValue(session({ sub: 'u1', ...claims }));
    await renderProvider();
    expect(auth.isControllerOwner).toBe(false);
  });

  test('answers an MFA type question with TOTP automatically', async () => {
    await renderProvider();
    amplify.signIn.mockResolvedValue({ isSignedIn: false, nextStep: { signInStep: 'CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION' } });
    amplify.confirmSignIn.mockResolvedValue({ isSignedIn: false, nextStep: { signInStep: 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP' } });

    let result;
    await act(async () => {
      result = await auth.signIn('paul', 'pw');
    });
    expect(amplify.confirmSignIn).toHaveBeenCalledWith({ challengeResponse: 'TOTP' });
    expect(result.nextStep.signInStep).toBe('CONTINUE_SIGN_IN_WITH_TOTP_SETUP');
  });

  test('loads the session once a code completes sign-in', async () => {
    await renderProvider();
    amplify.confirmSignIn.mockResolvedValue({ isSignedIn: true });
    amplify.fetchAuthSession.mockResolvedValue(session({ sub: 'u1', 'custom:role': 'Owner' }));
    await act(async () => {
      await auth.confirmSignInStep('123456');
    });
    expect(amplify.confirmSignIn).toHaveBeenCalledWith({ challengeResponse: '123456' });
    expect(screen.getByTestId('role')).toHaveTextContent('Owner');
  });
});
