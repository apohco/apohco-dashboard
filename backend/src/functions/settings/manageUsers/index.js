const { requireAuth } = require('../../../shared/verifyToken');
const { requireRole } = require('../../../shared/authorize');
const { query, withTransaction } = require('../../../shared/db');
const { json, withErrorHandling } = require('../../../shared/response');
const cognito = require('../../../shared/cognitoAdmin');
const { CONTROLLER_COGNITO_GROUP } = require('../../../shared/controllerAuth');

const ROLES = ['SoftwareAdmin', 'SoftwareRep', 'Owner', 'Manager', 'TeamMember'];
const PLATFORM_ROLES = ['SoftwareAdmin', 'SoftwareRep'];
const PRACTICE_ROLES = ['Owner', 'Manager', 'TeamMember'];
const ACTIONS = ['disable', 'enable', 'reset-mfa', 'reset-password', 'resend-invite'];
const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DETAIL_CONCURRENCY = 5;

function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

// Cognito exceptions -> API errors with a status the UI can show.
function mapCognitoError(err) {
  if (err.statusCode) return err;
  const byName = {
    UserNotFoundException: [404, 'User not found'],
    UsernameExistsException: [409, 'That username is already taken'],
    InvalidParameterException: [400, err.message],
    TooManyRequestsException: [429, 'Too many requests to Cognito; try again in a minute'],
    LimitExceededException: [429, 'Cognito limit reached; try again later'],
  };
  const mapped = byName[err.name];
  return mapped ? httpError(mapped[0], mapped[1]) : err;
}

const sameUser = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

function shapeUser(cognitoUser, { mfaEnabled, controllerOwners, groupNames, claims }) {
  const attrs = cognito.attrMap(cognitoUser.Attributes || cognitoUser.UserAttributes);
  const isControllerOwner = controllerOwners.has(cognitoUser.Username.toLowerCase());
  return {
    username: cognitoUser.Username,
    userId: attrs.sub,
    email: attrs.email || null,
    emailVerified: attrs.email_verified === 'true',
    role: attrs['custom:role'] || null,
    groupId: attrs['custom:groupId'] || null,
    groupName: groupNames.get(attrs['custom:groupId']) || null,
    status: cognitoUser.UserStatus,
    enabled: cognitoUser.Enabled,
    mfaEnabled,
    createdDate: cognitoUser.UserCreateDate,
    isSelf: sameUser(cognitoUser.Username, claims.username),
    // The Controller owner's account can only be changed from the AWS CLI,
    // never from this screen: an admin who could change its email and send
    // a reset could take over the account with access to company email.
    isProtected: isControllerOwner,
    // Managed in Controller > Accountants, not here.
    isAccountant: attrs['custom:role'] === 'Accountant',
  };
}

async function loadGroupNames() {
  const { rows } = await query(`SELECT GroupId, GroupName FROM Groups ORDER BY GroupName`);
  return { list: rows.map((r) => ({ groupId: r.groupid, groupName: r.groupname })), map: new Map(rows.map((r) => [r.groupid, r.groupname])) };
}

const hasTotp = (cognitoUser) => (cognitoUser.UserMFASettingList || []).includes('SOFTWARE_TOKEN_MFA');

async function recordAudit(claims, action, targetUsername, details = {}, db = { query }) {
  await db.query(
    `INSERT INTO UserAdminAuditLog (ActorUserId, ActorUsername, Action, TargetUsername, Details)
     VALUES ($1, $2, $3, $4, $5)`,
    [claims.userId, claims.username, action, targetUsername, JSON.stringify(details)]
  );
}

// Validates a role + practice combination. Practice roles need a Group that
// exists; platform roles must not have one.
async function validateRoleAndGroup(role, groupId) {
  if (!ROLES.includes(role)) throw httpError(400, `role must be one of ${ROLES.join(', ')}`);
  if (PLATFORM_ROLES.includes(role)) {
    if (groupId) throw httpError(400, `${role} is a platform role and can't belong to a practice`);
    return;
  }
  if (!groupId) throw httpError(400, `${role} must belong to a practice (groupId)`);
  const { rows } = await query(`SELECT 1 FROM Groups WHERE GroupId = $1`, [groupId]);
  if (!rows.length) throw httpError(400, 'That practice (Group) does not exist');
}

function validateEmail(email) {
  if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) throw httpError(400, 'A valid email is required');
  return email.trim();
}

// Loads the target user and applies the rules every change must pass.
async function loadTarget(username, claims, { allowSelf = true } = {}) {
  const user = await cognito.getUser(username).catch((err) => {
    throw mapCognitoError(err);
  });
  const controllerOwners = await cognito.listUsernamesInGroup(CONTROLLER_COGNITO_GROUP);
  if (controllerOwners.has(user.Username.toLowerCase())) {
    throw httpError(403, 'This account is protected and can only be changed from the AWS CLI');
  }
  // Accountant logins carry portal access that lives in CtrlAccountants;
  // changing them here (e.g. promoting one to Owner) would bypass that.
  if (cognito.attrMap(user.UserAttributes)['custom:role'] === 'Accountant') {
    throw httpError(409, 'This is an accountant portal login; manage it in Controller > Accountants');
  }
  if (!allowSelf && sameUser(user.Username, claims.username)) {
    throw httpError(400, "You can't do that to your own account");
  }
  return { user, attrs: cognito.attrMap(user.UserAttributes) };
}

// Refuses to disable or demote the last enabled SoftwareAdmin.
async function assertNotLastAdmin(targetUsername) {
  const users = await cognito.listAllUsers();
  const otherAdmins = users.filter(
    (u) => u.Enabled && !sameUser(u.Username, targetUsername) && cognito.attrMap(u.Attributes)['custom:role'] === 'SoftwareAdmin'
  );
  if (!otherAdmins.length) throw httpError(409, "This is the last active SoftwareAdmin, so it can't be disabled or demoted");
}

// Keeps the dashboard's Users/GroupUsers rows in step with Cognito. Users
// who haven't completed their first sign-in have no Users row yet; their
// row is created from the Cognito attributes by postConfirmation later.
async function syncDatabase(userId, { role, email, groupId }) {
  if (!userId) return;
  await withTransaction(async (client) => {
    await client.query(`UPDATE Users SET Role = $2, Email = $3 WHERE UserId = $1`, [userId, role, email]);
    await client.query(`DELETE FROM GroupUsers WHERE UserId = $1`, [userId]);
    if (PRACTICE_ROLES.includes(role)) {
      await client.query(
        `INSERT INTO GroupUsers (GroupId, UserId, Role)
         SELECT $1, $2, $3 WHERE EXISTS (SELECT 1 FROM Users WHERE UserId = $2)
         ON CONFLICT (GroupId, UserId) DO UPDATE SET Role = EXCLUDED.Role`,
        [groupId, userId, role]
      );
    }
  });
}

async function handleList(claims) {
  const [users, controllerOwners, groups] = await Promise.all([
    cognito.listAllUsers(),
    cognito.listUsernamesInGroup(CONTROLLER_COGNITO_GROUP),
    loadGroupNames(),
  ]);
  // ListUsers doesn't include MFA settings, so fetch them per user.
  const details = await mapLimit(users, DETAIL_CONCURRENCY, (u) => cognito.getUser(u.Username).catch(() => null));

  const shaped = users
    .map((u, i) =>
      shapeUser(u, { mfaEnabled: details[i] ? hasTotp(details[i]) : null, controllerOwners, groupNames: groups.map, claims })
    )
    .sort((a, b) => a.username.localeCompare(b.username));

  return json(200, { users: shaped, groups: groups.list, roles: ROLES });
}

async function handleInvite(body, claims) {
  const username = String(body.username || '').trim();
  if (!USERNAME_RE.test(username)) {
    throw httpError(400, 'Username must be 3-64 characters: letters, numbers, dot, dash or underscore');
  }
  const email = validateEmail(body.email);
  const role = body.role;
  const groupId = body.groupId || null;
  await validateRoleAndGroup(role, groupId);

  const attributes = { email, email_verified: 'true', 'custom:role': role };
  if (groupId) attributes['custom:groupId'] = groupId;

  await cognito.createUser(username, attributes).catch((err) => {
    throw mapCognitoError(err);
  });
  if (PLATFORM_ROLES.includes(role)) await cognito.addToGroup(username, role);

  await recordAudit(claims, 'user.invited', username, { email, role, groupId });
  return json(201, { username, email, role, groupId, status: 'FORCE_CHANGE_PASSWORD' });
}

async function handleUpdate(username, body, claims) {
  const { user, attrs } = await loadTarget(username, claims);
  const current = { role: attrs['custom:role'], groupId: attrs['custom:groupId'] || null, email: attrs.email };

  const next = {
    role: body.role ?? current.role,
    groupId: body.role !== undefined || body.groupId !== undefined ? body.groupId || null : current.groupId,
    email: body.email !== undefined ? validateEmail(body.email) : current.email,
  };
  if (PLATFORM_ROLES.includes(next.role)) next.groupId = null;
  await validateRoleAndGroup(next.role, next.groupId);

  const roleChanged = next.role !== current.role;
  const groupChanged = next.groupId !== current.groupId;
  const emailChanged = next.email !== current.email;

  if (roleChanged && sameUser(user.Username, claims.username)) throw httpError(400, "You can't change your own role");
  if (roleChanged && current.role === 'SoftwareAdmin') await assertNotLastAdmin(user.Username);

  const updates = {};
  if (roleChanged) updates['custom:role'] = next.role;
  if (groupChanged && next.groupId) updates['custom:groupId'] = next.groupId;
  // Saving an email (changed or not) marks it verified, so password reset
  // emails can reach it.
  if (body.email !== undefined && (emailChanged || attrs.email_verified !== 'true')) {
    updates.email = next.email;
    updates.email_verified = 'true';
  }

  try {
    if (Object.keys(updates).length) await cognito.updateAttributes(user.Username, updates);
    if (groupChanged && !next.groupId) await cognito.deleteAttributes(user.Username, ['custom:groupId']);
    if (roleChanged) {
      if (PLATFORM_ROLES.includes(current.role)) await cognito.removeFromGroup(user.Username, current.role);
      if (PLATFORM_ROLES.includes(next.role)) await cognito.addToGroup(user.Username, next.role);
    }
    // A changed role or practice only takes effect in a new ID token, so
    // end existing sessions now rather than when their refresh token expires.
    if (roleChanged || groupChanged) await cognito.globalSignOut(user.Username);
  } catch (err) {
    throw mapCognitoError(err);
  }

  await syncDatabase(attrs.sub, next);
  await recordAudit(claims, 'user.updated', user.Username, {
    before: current,
    after: next,
    signedOut: roleChanged || groupChanged,
  });

  return json(200, { username: user.Username, ...next, emailVerified: Boolean(updates.email_verified) || attrs.email_verified === 'true' });
}

async function handleAction(username, action, claims) {
  if (!ACTIONS.includes(action)) throw httpError(404, 'Unknown user action');
  // None of these apply to your own account (use My Profile instead).
  const { user, attrs } = await loadTarget(username, claims, { allowSelf: false });

  try {
    switch (action) {
      case 'disable':
        if (attrs['custom:role'] === 'SoftwareAdmin') await assertNotLastAdmin(user.Username);
        await cognito.disableUser(user.Username);
        await cognito.globalSignOut(user.Username);
        break;
      case 'enable':
        await cognito.enableUser(user.Username);
        break;
      case 'reset-mfa':
        await cognito.resetMfa(user.Username);
        await cognito.globalSignOut(user.Username);
        break;
      case 'reset-password':
        if (attrs.email_verified !== 'true') {
          throw httpError(400, "This user's email isn't verified, so a reset code can't be sent. Edit the user and save their email first.");
        }
        await cognito.resetPassword(user.Username);
        await cognito.globalSignOut(user.Username);
        break;
      case 'resend-invite':
        if (user.UserStatus !== 'FORCE_CHANGE_PASSWORD') {
          throw httpError(400, 'This user has already completed their first sign-in');
        }
        await cognito.resendInvite(user.Username);
        break;
      default:
        break;
    }
  } catch (err) {
    throw mapCognitoError(err);
  }

  await recordAudit(claims, `user.${action}`, user.Username);
  return json(200, { username: user.Username, action, done: true });
}

// /api/settings/users                      GET (list), POST (invite)
// /api/settings/users/{username}           PUT (email, role, practice)
// /api/settings/users/{username}/{action}  POST: disable | enable | reset-mfa | reset-password | resend-invite
// SoftwareAdmin only. Users are disabled, never deleted, from the app.
exports.handler = withErrorHandling(async (event) => {
  const claims = await requireAuth(event);
  requireRole(claims, ['SoftwareAdmin']);

  const username = event.pathParameters?.username ? decodeURIComponent(event.pathParameters.username) : null;
  const action = event.pathParameters?.action;
  const method = event.httpMethod;
  const body = method === 'POST' || method === 'PUT' ? JSON.parse(event.body || '{}') : {};

  if (!username && method === 'GET') return handleList(claims);
  if (!username && method === 'POST') return handleInvite(body, claims);
  if (username && !action && method === 'PUT') return handleUpdate(username, body, claims);
  if (username && action && method === 'POST') return handleAction(username, action, claims);
  throw httpError(405, `${method} is not supported on this route`);
});

exports.mapCognitoError = mapCognitoError;
exports.shapeUser = shapeUser;
