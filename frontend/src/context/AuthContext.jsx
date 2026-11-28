import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import {
  signIn as amplifySignIn,
  confirmSignIn as amplifyConfirmSignIn,
  resetPassword as amplifyResetPassword,
  confirmResetPassword as amplifyConfirmResetPassword,
  updatePassword as amplifyUpdatePassword,
  fetchMFAPreference as amplifyFetchMFAPreference,
  signOut as amplifySignOut,
  fetchAuthSession,
} from 'aws-amplify/auth';
import { attachAuthInterceptor } from '../api/client';

const AuthContext = createContext(null);

function claimsFromIdToken(idToken) {
  const payload = idToken.payload;
  return {
    userId: payload.sub,
    username: payload['cognito:username'] || payload.username,
    email: payload.email,
    role: payload['custom:role'],
    groupId: payload['custom:groupId'] || null,
    groups: Array.isArray(payload['cognito:groups']) ? payload['cognito:groups'] : [],
  };
}

// Only TOTP (authenticator app) MFA is enabled on the user pool, so when
// Cognito asks which MFA type to use or set up, the answer is always TOTP.
const AUTO_ANSWER_STEPS = ['CONTINUE_SIGN_IN_WITH_MFA_SELECTION', 'CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION'];

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [initializing, setInitializing] = useState(true);

  const loadSession = useCallback(async () => {
    try {
      const session = await fetchAuthSession();
      if (session.tokens?.idToken) {
        setUser(claimsFromIdToken(session.tokens.idToken));
      } else {
        setUser(null);
      }
    } catch {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    loadSession().finally(() => setInitializing(false));
  }, [loadSession]);

  const finishStep = useCallback(
    async (result) => {
      let current = result;
      while (!current.isSignedIn && AUTO_ANSWER_STEPS.includes(current.nextStep?.signInStep)) {
        current = await amplifyConfirmSignIn({ challengeResponse: 'TOTP' });
      }
      if (current.isSignedIn) {
        await loadSession();
      }
      return current;
    },
    [loadSession]
  );

  // Returns { nextStep } for the Login page to react to: a temporary
  // password that must be replaced (per AllowAdminCreateUserOnly), first-
  // time authenticator app setup, or an authenticator code.
  const signIn = useCallback(
    async (username, password) => finishStep(await amplifySignIn({ username, password })),
    [finishStep]
  );

  // Answers the current sign-in challenge: a new password, or a 6-digit
  // authenticator code (both setup verification and regular sign-in).
  const confirmSignInStep = useCallback(
    async (challengeResponse) => finishStep(await amplifyConfirmSignIn({ challengeResponse })),
    [finishStep]
  );

  // Forgot password: Cognito emails a code to the user's verified address.
  // The user pool hides whether a username exists (PreventUserExistenceErrors),
  // so this "succeeds" for unknown usernames too.
  const requestPasswordReset = useCallback(
    (username) => amplifyResetPassword({ username }),
    []
  );

  const confirmPasswordReset = useCallback(
    (username, confirmationCode, newPassword) =>
      amplifyConfirmResetPassword({ username, confirmationCode, newPassword }),
    []
  );

  // My Profile: change your own password while signed in.
  const changePassword = useCallback(
    (oldPassword, newPassword) => amplifyUpdatePassword({ oldPassword, newPassword }),
    []
  );

  // My Profile: whether an authenticator app is set up for this account.
  const getMfaStatus = useCallback(async () => {
    const pref = await amplifyFetchMFAPreference();
    return { totpEnabled: (pref?.enabled || []).includes('TOTP') };
  }, []);

  const signOut = useCallback(async () => {
    await amplifySignOut();
    setUser(null);
  }, []);

  const getIdToken = useCallback(async () => {
    const session = await fetchAuthSession();
    return session.tokens?.idToken?.toString() || null;
  }, []);

  useEffect(() => {
    attachAuthInterceptor(getIdToken);
  }, [getIdToken]);

  const value = {
    user,
    initializing,
    isAuthenticated: Boolean(user),
    role: user?.role ?? null,
    groupId: user?.groupId ?? null,
    groups: user?.groups ?? [],
    isControllerOwner: user?.role === 'SoftwareAdmin' && (user?.groups ?? []).includes('ControllerOwner'),
    // Accountant logins see only the AJE portal (the API enforces the same).
    isAccountant: user?.role === 'Accountant',
    signIn,
    confirmSignInStep,
    // Kept for existing callers: a new password is just a sign-in challenge answer.
    confirmNewPassword: confirmSignInStep,
    requestPasswordReset,
    confirmPasswordReset,
    changePassword,
    getMfaStatus,
    signOut,
    getIdToken,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
