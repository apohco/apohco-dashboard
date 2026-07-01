import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import {
  signIn as amplifySignIn,
  confirmSignIn as amplifyConfirmSignIn,
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
  };
}

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

  // Returns { nextStep } for the Login page to react to (e.g. a temporary
  // password that must be replaced, per AllowAdminCreateUserOnly).
  const signIn = useCallback(
    async (username, password) => {
      const result = await amplifySignIn({ username, password });
      if (result.isSignedIn) {
        await loadSession();
      }
      return result;
    },
    [loadSession]
  );

  const confirmNewPassword = useCallback(
    async (newPassword) => {
      const result = await amplifyConfirmSignIn({ challengeResponse: newPassword });
      if (result.isSignedIn) {
        await loadSession();
      }
      return result;
    },
    [loadSession]
  );

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
    signIn,
    confirmNewPassword,
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
