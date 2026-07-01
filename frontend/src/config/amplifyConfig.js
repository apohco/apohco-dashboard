import { Amplify } from 'aws-amplify';

// Values come from sam deploy's Outputs (UserPoolId, UserPoolClientId) —
// see docs/SETUP.md. Username (not email) is the sign-in identifier, per
// claude.md, since AllowAdminCreateUserOnly means accounts are provisioned
// by a Software Rep/Admin, not self-service signup.
Amplify.configure({
  Auth: {
    Cognito: {
      userPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID,
      userPoolClientId: import.meta.env.VITE_COGNITO_CLIENT_ID,
      loginWith: {
        username: true,
        email: false,
      },
    },
  },
});
