const {
  CognitoIdentityProviderClient,
  ListUsersCommand,
  ListUsersInGroupCommand,
  AdminGetUserCommand,
  AdminCreateUserCommand,
  AdminUpdateUserAttributesCommand,
  AdminDeleteUserAttributesCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminSetUserMFAPreferenceCommand,
  AdminResetUserPasswordCommand,
  AdminUserGlobalSignOutCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
} = require('@aws-sdk/client-cognito-identity-provider');

// Thin wrapper over the Cognito admin API for Settings > Users. Every
// call is scoped to this app's own user pool (COGNITO_USER_POOL_ID). The
// client can be swapped in tests via setClient().

let client = null;
const getClient = () => {
  if (!client) client = new CognitoIdentityProviderClient({});
  return client;
};
const setClient = (c) => {
  client = c;
};

const poolId = () => {
  const id = process.env.COGNITO_USER_POOL_ID;
  if (!id) throw new Error('COGNITO_USER_POOL_ID is not set');
  return id;
};

const send = (Command, input) => getClient().send(new Command({ UserPoolId: poolId(), ...input }));

// Cognito attribute list -> plain object.
const attrMap = (attributes = []) => Object.fromEntries(attributes.map((a) => [a.Name, a.Value]));

async function listAllUsers() {
  const users = [];
  let token;
  do {
    const res = await send(ListUsersCommand, { Limit: 60, PaginationToken: token });
    users.push(...(res.Users || []));
    token = res.PaginationToken;
  } while (token);
  return users;
}

async function listUsernamesInGroup(groupName) {
  const names = new Set();
  let token;
  do {
    const res = await send(ListUsersInGroupCommand, { GroupName: groupName, Limit: 60, NextToken: token });
    for (const u of res.Users || []) names.add(u.Username.toLowerCase());
    token = res.NextToken;
  } while (token);
  return names;
}

const getUser = (username) => send(AdminGetUserCommand, { Username: username });

const createUser = (username, attributes) =>
  send(AdminCreateUserCommand, {
    Username: username,
    UserAttributes: Object.entries(attributes).map(([Name, Value]) => ({ Name, Value })),
    DesiredDeliveryMediums: ['EMAIL'],
  });

// Re-sends the invite email with a fresh temporary password, for a user
// who never completed their first sign-in.
const resendInvite = (username) =>
  send(AdminCreateUserCommand, { Username: username, MessageAction: 'RESEND', DesiredDeliveryMediums: ['EMAIL'] });

const updateAttributes = (username, attributes) =>
  send(AdminUpdateUserAttributesCommand, {
    Username: username,
    UserAttributes: Object.entries(attributes).map(([Name, Value]) => ({ Name, Value })),
  });

const deleteAttributes = (username, names) =>
  send(AdminDeleteUserAttributesCommand, { Username: username, UserAttributeNames: names });

const disableUser = (username) => send(AdminDisableUserCommand, { Username: username });
const enableUser = (username) => send(AdminEnableUserCommand, { Username: username });

// Removes the user's authenticator app. Because MFA is required on this
// pool, they're asked to set up a new one at their next sign-in.
const resetMfa = (username) =>
  send(AdminSetUserMFAPreferenceCommand, {
    Username: username,
    SoftwareTokenMfaSettings: { Enabled: false, PreferredMfa: false },
  });

// Emails a reset code to the user's verified address and requires a new
// password at their next sign-in.
const resetPassword = (username) => send(AdminResetUserPasswordCommand, { Username: username });

// Revokes the user's refresh tokens so existing sessions end within the
// ID token lifetime (60 minutes) instead of lasting up to 30 days.
const globalSignOut = (username) => send(AdminUserGlobalSignOutCommand, { Username: username });

const addToGroup = (username, groupName) =>
  send(AdminAddUserToGroupCommand, { Username: username, GroupName: groupName });
const removeFromGroup = (username, groupName) =>
  send(AdminRemoveUserFromGroupCommand, { Username: username, GroupName: groupName });

module.exports = {
  setClient,
  attrMap,
  listAllUsers,
  listUsernamesInGroup,
  getUser,
  createUser,
  resendInvite,
  updateAttributes,
  deleteAttributes,
  disableUser,
  enableUser,
  resetMfa,
  resetPassword,
  globalSignOut,
  addToGroup,
  removeFromGroup,
};
