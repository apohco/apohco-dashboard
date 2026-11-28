// Controller Phase 5b: who can use the accountant AJE portal. Controller owner only.
//
// GET  /api/controller/accountants?groupId=                 accountants, their access to this Group, the Group's files, email settings
// POST /api/controller/accountants                          invite { groupId, fullName, email, username, firm?, qboIds?: null|[...], notifyByEmail? }
// PUT  /api/controller/accountants/{accountantId}           { groupId, fullName?, email?, firm?, notifyByEmail?, qboIds?, access?: false }
// POST /api/controller/accountants/{accountantId}/{action}  deactivate | reactivate | resend-invite | reset-password | reset-mfa
// PUT  /api/controller/accountant-settings                  { groupId, emailEnabled, controllerEmail? }
// POST /api/controller/accountant-settings/test             { groupId } -- queue a test email to the controller
//
// An accountant is a Cognito user with custom:role = Accountant and no
// custom:groupId (so no other dashboard route accepts them). Their reach is
// CtrlAccountantAccess: per Group, every file (qboIds null) or a list.
// Accountants are deactivated, never deleted, so their history keeps a name.
const { query, withTransaction } = require('../../../shared/db');
const { json, withErrorHandling } = require('../../../shared/response');
const { authorizeController } = require('../../../shared/controllerAuth');
const { requireGroupAccess } = require('../../../shared/authorize');
const { recordAudit } = require('../../../shared/audit');
const { badRequest, isUuid } = require('../../../shared/ctrlReviewData');
const cognito = require('../../../shared/cognitoAdmin');
const { loadNotifySettings, queue, EMAIL_RE } = require('../../../shared/ctrlNotify');
const { ACCOUNTANT_ROLE } = require('../../../shared/portalData');

const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;
const ACTIONS = ['deactivate', 'reactivate', 'resend-invite', 'reset-password', 'reset-mfa'];
const MAX_NAME = 200;

function mapCognitoError(err) {
  if (err.statusCode) return err;
  const byName = {
    UserNotFoundException: [404, 'That login no longer exists in Cognito'],
    UsernameExistsException: [409, 'That username is already taken; choose another'],
    InvalidParameterException: [400, err.message],
    TooManyRequestsException: [429, 'Too many requests to Cognito; try again in a minute'],
    LimitExceededException: [429, 'Cognito limit reached; try again later'],
  };
  const mapped = byName[err.name];
  return mapped ? badRequest(mapped[1], mapped[0]) : err;
}

const text = (v, max, label, { required = false } = {}) => {
  const s = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
  if (required && !s) throw badRequest(`${label} is required`);
  if (s.length > max) throw badRequest(`${label} can be at most ${max} characters`);
  return s || null;
};
const email = (v) => {
  const s = String(v || '').trim();
  if (!EMAIL_RE.test(s) || s.length > 255) throw badRequest('A valid email is required');
  return s;
};

// qboIds: null/undefined = every file; otherwise a non-empty list of this Group's files.
async function validateFiles(groupId, qboIds, db = { query }) {
  if (qboIds === null || qboIds === undefined) return null;
  if (!Array.isArray(qboIds) || !qboIds.length) throw badRequest('Choose at least one file, or all files');
  const ids = [...new Set(qboIds)];
  if (!ids.every(isUuid)) throw badRequest('A file id is not valid');
  const { rows } = await db.query(`SELECT QBOId FROM QBOs WHERE GroupId = $1 AND QBOId = ANY($2::uuid[])`, [groupId, ids]);
  if (rows.length !== ids.length) throw badRequest('A file is not in this Group', 404);
  return ids;
}

async function loadAccountant(accountantId, db = { query }) {
  if (!isUuid(accountantId)) throw badRequest('Accountant not found', 404);
  const { rows } = await db.query(`SELECT * FROM CtrlAccountants WHERE AccountantId = $1`, [accountantId]);
  if (!rows.length) throw badRequest('Accountant not found', 404);
  return rows[0];
}

const auditUserAdmin = (claims, action, username, details, db) =>
  db.query(
    `INSERT INTO UserAdminAuditLog (ActorUserId, ActorUsername, Action, TargetUsername, Details) VALUES ($1, $2, $3, $4, $5)`,
    [claims.userId, claims.username, action, username, JSON.stringify(details)]
  );

async function handleList(groupId) {
  const [{ rows }, { rows: files }, settings] = await Promise.all([
    query(
      `SELECT a.AccountantId, a.Username, a.FullName, a.Email, a.Firm, a.Active, a.NotifyByEmail, a.CreatedAt,
              x.GroupId AS AccessGroupId, x.QBOIds,
              (SELECT COUNT(*) FROM CtrlAccountantAccess o WHERE o.AccountantId = a.AccountantId AND o.GroupId <> $1) AS OtherGroups,
              (SELECT MAX(l.CreatedDate) FROM CtrlAuditLog l WHERE l.UserId = a.UserId AND l.Action LIKE 'portal.%') AS LastActiveAt
       FROM CtrlAccountants a
       LEFT JOIN CtrlAccountantAccess x ON x.AccountantId = a.AccountantId AND x.GroupId = $1
       ORDER BY a.Active DESC, a.FullName`,
      [groupId]
    ),
    query(`SELECT QBOId, QBOName FROM QBOs WHERE GroupId = $1 ORDER BY QBOName`, [groupId]),
    loadNotifySettings(groupId),
  ]);
  // Cognito login state (invite pending / enabled) per accountant.
  const logins = await Promise.all(rows.map((r) => cognito.getUser(r.username).catch(() => null)));
  return json(200, {
    accountants: rows.map((r, i) => ({
      accountantId: r.accountantid,
      username: r.username,
      fullName: r.fullname,
      email: r.email,
      firm: r.firm || null,
      active: r.active,
      notifyByEmail: r.notifybyemail,
      createdAt: r.createdat,
      lastActiveAt: r.lastactiveat || null,
      hasAccess: Boolean(r.accessgroupid),
      qboIds: r.accessgroupid ? r.qboids || null : null,
      otherGroups: Number(r.othergroups || 0),
      loginStatus: logins[i] ? (logins[i].Enabled === false ? 'Disabled' : logins[i].UserStatus === 'FORCE_CHANGE_PASSWORD' ? 'InvitePending' : 'Active') : 'Missing',
    })),
    files: files.map((f) => ({ qboId: f.qboid, qboName: f.qboname })),
    notify: settings,
  });
}

async function handleInvite(claims, body) {
  const { groupId } = body;
  const fullName = text(body.fullName, MAX_NAME, 'Name', { required: true });
  const address = email(body.email);
  const firm = text(body.firm, MAX_NAME, 'Firm');
  const username = String(body.username || '').trim();
  if (!USERNAME_RE.test(username)) throw badRequest('Username must be 3-64 characters: letters, numbers, dot, dash or underscore');
  const qboIds = await validateFiles(groupId, body.qboIds);
  const { rows: dupe } = await query(`SELECT FullName FROM CtrlAccountants WHERE lower(Email) = lower($1)`, [address]);
  if (dupe.length) throw badRequest(`${dupe[0].fullname} already has a portal login with that email; give them access from their row instead`, 409);

  const created = await cognito
    .createUser(username, { email: address, email_verified: 'true', 'custom:role': ACCOUNTANT_ROLE })
    .catch((err) => {
      throw mapCognitoError(err);
    });
  const sub = cognito.attrMap(created?.User?.Attributes).sub;
  if (!isUuid(sub)) throw new Error('Cognito did not return the new user id');

  try {
    const accountantId = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO CtrlAccountants (Username, UserId, FullName, Email, Firm, NotifyByEmail, CreatedBy, UpdatedBy)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING AccountantId`,
        [username, sub, fullName, address, firm, body.notifyByEmail !== false, claims.userId]
      );
      const id = rows[0].accountantid;
      await client.query(`INSERT INTO CtrlAccountantAccess (AccountantId, GroupId, QBOIds, UpdatedBy) VALUES ($1, $2, $3, $4)`, [id, groupId, qboIds, claims.userId]);
      await auditUserAdmin(claims, 'user.invited', username, { email: address, role: ACCOUNTANT_ROLE, via: 'Controller > Accountants' }, client);
      await recordAudit({ groupId, userId: claims.userId, action: 'ctrl.accountant.invite', targetType: 'CtrlAccountant', targetId: id, details: { username, fullName, firm, files: qboIds || 'all' } }, client);
      return id;
    });
    return json(201, { accountantId, username, loginStatus: 'InvitePending' });
  } catch (err) {
    // Don't leave a working login with no portal record behind.
    await cognito.disableUser(username).catch(() => {});
    throw err;
  }
}

async function handleUpdate(claims, accountantId, body) {
  const { groupId } = body;
  const a = await loadAccountant(accountantId);
  const next = {
    fullName: body.fullName !== undefined ? text(body.fullName, MAX_NAME, 'Name', { required: true }) : a.fullname,
    email: body.email !== undefined ? email(body.email) : a.email,
    firm: body.firm !== undefined ? text(body.firm, MAX_NAME, 'Firm') : a.firm,
    notifyByEmail: body.notifyByEmail !== undefined ? Boolean(body.notifyByEmail) : a.notifybyemail,
  };
  const removeAccess = body.access === false;
  const qboIds = !removeAccess && body.qboIds !== undefined ? await validateFiles(groupId, body.qboIds) : undefined;
  const emailChanged = next.email.toLowerCase() !== String(a.email).toLowerCase();
  if (emailChanged) {
    const { rows: dupe } = await query(`SELECT 1 FROM CtrlAccountants WHERE lower(Email) = lower($1) AND AccountantId <> $2`, [next.email, accountantId]);
    if (dupe.length) throw badRequest('Another accountant already uses that email', 409);
  }

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE CtrlAccountants SET FullName = $2, Email = $3, Firm = $4, NotifyByEmail = $5, UpdatedBy = $6, UpdatedAt = now() WHERE AccountantId = $1`,
      [accountantId, next.fullName, next.email, next.firm, next.notifyByEmail, claims.userId]
    );
    if (removeAccess) {
      await client.query(`DELETE FROM CtrlAccountantAccess WHERE AccountantId = $1 AND GroupId = $2`, [accountantId, groupId]);
    } else if (qboIds !== undefined) {
      await client.query(
        `INSERT INTO CtrlAccountantAccess (AccountantId, GroupId, QBOIds, UpdatedBy) VALUES ($1, $2, $3, $4)
         ON CONFLICT (AccountantId, GroupId) DO UPDATE SET QBOIds = EXCLUDED.QBOIds, UpdatedBy = EXCLUDED.UpdatedBy, UpdatedAt = now()`,
        [accountantId, groupId, qboIds, claims.userId]
      );
    }
    await recordAudit({
      groupId, userId: claims.userId, action: 'ctrl.accountant.update', targetType: 'CtrlAccountant', targetId: accountantId,
      details: {
        before: { fullName: a.fullname, email: a.email, firm: a.firm, notifyByEmail: a.notifybyemail },
        after: next,
        ...(removeAccess ? { access: 'removed' } : qboIds !== undefined ? { files: qboIds || 'all' } : {}),
      },
    }, client);
    if (emailChanged) {
      await auditUserAdmin(claims, 'user.updated', a.username, { before: { email: a.email }, after: { email: next.email }, via: 'Controller > Accountants' }, client);
      // Cognito last, inside the transaction: if it fails, nothing is saved.
      try {
        await cognito.updateAttributes(a.username, { email: next.email, email_verified: 'true' });
      } catch (err) {
        throw mapCognitoError(err);
      }
    }
  });
  return handleList(groupId);
}

async function handleAction(claims, accountantId, action, groupId) {
  if (!ACTIONS.includes(action)) throw badRequest('Unknown action', 404);
  const a = await loadAccountant(accountantId);
  try {
    switch (action) {
      case 'deactivate':
        await query(`UPDATE CtrlAccountants SET Active = false, UpdatedBy = $2, UpdatedAt = now() WHERE AccountantId = $1`, [accountantId, claims.userId]);
        await cognito.disableUser(a.username);
        await cognito.globalSignOut(a.username);
        break;
      case 'reactivate':
        await cognito.enableUser(a.username);
        await query(`UPDATE CtrlAccountants SET Active = true, UpdatedBy = $2, UpdatedAt = now() WHERE AccountantId = $1`, [accountantId, claims.userId]);
        break;
      case 'resend-invite': {
        const user = await cognito.getUser(a.username);
        if (user.UserStatus !== 'FORCE_CHANGE_PASSWORD') throw badRequest('They have already signed in; use Reset password instead');
        await cognito.resendInvite(a.username);
        break;
      }
      case 'reset-password':
        await cognito.resetPassword(a.username);
        await cognito.globalSignOut(a.username);
        break;
      case 'reset-mfa':
        await cognito.resetMfa(a.username);
        await cognito.globalSignOut(a.username);
        break;
      default:
        break;
    }
  } catch (err) {
    throw mapCognitoError(err);
  }
  await auditUserAdmin(claims, `user.${action}`, a.username, { via: 'Controller > Accountants' }, { query });
  await recordAudit({ groupId, userId: claims.userId, action: `ctrl.accountant.${action}`, targetType: 'CtrlAccountant', targetId: accountantId });
  return handleList(groupId);
}

async function handleNotifySettings(claims, body) {
  const { groupId } = body;
  if (typeof body.emailEnabled !== 'boolean') throw badRequest('emailEnabled must be true or false');
  const controllerEmail = body.controllerEmail ? email(body.controllerEmail) : null;
  const current = await loadNotifySettings(groupId);
  if (body.emailEnabled && !current.senderEmail) throw badRequest('Connect Google Workspace first; emails are sent from its admin mailbox', 409);
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO CtrlNotifySettings (GroupId, EmailEnabled, ControllerEmail, UpdatedBy) VALUES ($1, $2, $3, $4)
       ON CONFLICT (GroupId) DO UPDATE SET EmailEnabled = EXCLUDED.EmailEnabled, ControllerEmail = EXCLUDED.ControllerEmail, UpdatedBy = EXCLUDED.UpdatedBy, LastUpdated = now()`,
      [groupId, body.emailEnabled, controllerEmail, claims.userId]
    );
    await recordAudit({ groupId, userId: claims.userId, action: 'ctrl.accountant.notifySettings', targetType: 'CtrlNotifySettings', targetId: groupId, details: { emailEnabled: body.emailEnabled, controllerEmail } }, client);
  });
  return json(200, await loadNotifySettings(groupId));
}

async function handleNotifyTest(claims, groupId) {
  const settings = await loadNotifySettings(groupId);
  if (!settings.emailEnabled || !settings.senderEmail) throw badRequest('Turn on email notifications first', 409);
  const to = settings.controllerEmail || settings.senderEmail;
  await queue({ query }, {
    groupId, kind: 'Test', to, subject: 'Test: AJE portal notifications',
    body: 'This is a test of the AJE portal notification emails. If you received it, notifications are working.',
  });
  await recordAudit({ groupId, userId: claims.userId, action: 'ctrl.accountant.notifyTest', targetType: 'CtrlNotifySettings', targetId: groupId, details: { to } });
  return json(202, { queued: true, to, note: 'Sent within about 5 minutes' });
}

exports.handler = withErrorHandling(async (event) => {
  const claims = await authorizeController(event);
  const method = event.httpMethod;
  const resource = event.resource || '';
  const qs = event.queryStringParameters || {};
  let body = {};
  if (method !== 'GET') {
    try {
      body = event.body ? JSON.parse(event.body) : {};
    } catch {
      throw badRequest('Request body must be JSON');
    }
  }
  const groupId = method === 'GET' ? qs.groupId : body.groupId;
  if (!isUuid(groupId)) throw badRequest('groupId is required');
  requireGroupAccess(claims, groupId);
  const { accountantId, action } = event.pathParameters || {};

  if (method === 'GET' && resource === '/api/controller/accountants') return handleList(groupId);
  if (method === 'POST' && resource === '/api/controller/accountants') return handleInvite(claims, body);
  if (method === 'PUT' && resource === '/api/controller/accountants/{accountantId}') return handleUpdate(claims, accountantId, body);
  if (method === 'POST' && resource === '/api/controller/accountants/{accountantId}/{action}') return handleAction(claims, accountantId, action, groupId);
  if (method === 'PUT' && resource === '/api/controller/accountant-settings') return handleNotifySettings(claims, body);
  if (method === 'POST' && resource === '/api/controller/accountant-settings/test') return handleNotifyTest(claims, groupId);
  throw badRequest('Unknown accountants route', 404);
});

exports.mapCognitoError = mapCognitoError;
