jest.mock('../../src/shared/verifyToken', () => ({ requireAuth: jest.fn() }));
jest.mock('../../src/shared/db', () => ({ query: jest.fn(), withTransaction: jest.fn() }));
jest.mock('../../src/shared/cognitoAdmin', () => {
  const actual = jest.requireActual('../../src/shared/cognitoAdmin');
  const fns = {};
  for (const name of Object.keys(actual)) fns[name] = jest.fn();
  fns.attrMap = actual.attrMap;
  return fns;
});

const { requireAuth } = require('../../src/shared/verifyToken');
const { query, withTransaction } = require('../../src/shared/db');
const cognito = require('../../src/shared/cognitoAdmin');
const { handler, mapCognitoError } = require('../../src/functions/settings/manageUsers');
const { CONTROLLER_ADMIN, OWNER, sqlRouter, apiEvent, parseBody } = require('../helpers');

const GROUP = 'group-1';
const attrs = (o) => Object.entries(o).map(([Name, Value]) => ({ Name, Value }));
const cUser = (username, a, extra = {}) => ({
  Username: username,
  Enabled: true,
  UserStatus: 'CONFIRMED',
  Attributes: attrs(a),
  UserAttributes: attrs(a),
  ...extra,
});

const paul = cUser('paul', { sub: 's-paul', email: 'p@x.com', email_verified: 'true', 'custom:role': 'SoftwareAdmin' });
const otherAdmin = cUser('ana', { sub: 's-ana', email: 'a@x.com', email_verified: 'true', 'custom:role': 'SoftwareAdmin' });
const owner = cUser('drv', { sub: 's-drv', email: 'd@x.com', 'custom:role': 'Owner', 'custom:groupId': GROUP });

let client;

function setup({ users = [paul, owner], controllerOwners = ['paul'] } = {}) {
  requireAuth.mockResolvedValue({ ...CONTROLLER_ADMIN, username: 'paul' });
  query.mockImplementation(
    sqlRouter([
      [/FROM Groups ORDER BY/, { rows: [{ groupid: GROUP, groupname: 'APOHCO' }] }],
      [/SELECT 1 FROM Groups WHERE GroupId/, (sql, [id]) => ({ rows: id === GROUP ? [{}] : [] })],
    ])
  );
  client = { query: sqlRouter([]) };
  withTransaction.mockImplementation((fn) => fn(client));
  cognito.listAllUsers.mockResolvedValue(users);
  cognito.listUsernamesInGroup.mockResolvedValue(new Set(controllerOwners));
  cognito.getUser.mockImplementation(async (name) => {
    const u = users.find((x) => x.Username.toLowerCase() === name.toLowerCase());
    if (!u) throw Object.assign(new Error('User does not exist.'), { name: 'UserNotFoundException' });
    return { ...u, UserMFASettingList: u.Username === 'paul' ? ['SOFTWARE_TOKEN_MFA'] : [] };
  });
  for (const fn of ['createUser', 'updateAttributes', 'deleteAttributes', 'disableUser', 'enableUser', 'resetMfa',
    'resetPassword', 'resendInvite', 'globalSignOut', 'addToGroup', 'removeFromGroup']) {
    cognito[fn].mockResolvedValue({});
  }
}

const audits = () => query.mock.calls.filter(([sql]) => /INSERT INTO UserAdminAuditLog/.test(sql)).map(([, p]) => p[2]);

describe('access', () => {
  test.each(['Owner', 'Manager', 'SoftwareRep'])('403 for %s', async (role) => {
    setup();
    requireAuth.mockResolvedValue({ ...OWNER, role });
    expect((await handler(apiEvent({ method: 'GET' }))).statusCode).toBe(403);
    expect(cognito.listAllUsers).not.toHaveBeenCalled();
  });
});

describe('GET list', () => {
  test('returns users with practice name, MFA status and protection flag', async () => {
    setup();
    const data = parseBody(await handler(apiEvent({ method: 'GET' })));
    expect(data.users.map((u) => u.username)).toEqual(['drv', 'paul']);
    expect(data.users[0]).toMatchObject({ role: 'Owner', groupName: 'APOHCO', mfaEnabled: false, emailVerified: false, isProtected: false, isSelf: false });
    expect(data.users[1]).toMatchObject({ mfaEnabled: true, isProtected: true, isSelf: true });
    expect(data.groups).toEqual([{ groupId: GROUP, groupName: 'APOHCO' }]);
  });
});

describe('POST invite', () => {
  const invite = (body) => handler(apiEvent({ method: 'POST', body }));

  test('creates a practice user with a verified email and audits it', async () => {
    setup();
    const res = await invite({ username: 'newmgr', email: ' m@x.com ', role: 'Manager', groupId: GROUP });
    expect(res.statusCode).toBe(201);
    expect(cognito.createUser).toHaveBeenCalledWith('newmgr', {
      email: 'm@x.com', email_verified: 'true', 'custom:role': 'Manager', 'custom:groupId': GROUP,
    });
    expect(cognito.addToGroup).not.toHaveBeenCalled();
    expect(audits()).toEqual(['user.invited']);
  });

  test('a platform role is added to its Cognito group and has no practice', async () => {
    setup();
    await invite({ username: 'rep1', email: 'r@x.com', role: 'SoftwareRep' });
    expect(cognito.createUser.mock.calls[0][1]).not.toHaveProperty('custom:groupId');
    expect(cognito.addToGroup).toHaveBeenCalledWith('rep1', 'SoftwareRep');
  });

  test('never grants ControllerOwner', async () => {
    setup();
    await invite({ username: 'rep1', email: 'r@x.com', role: 'SoftwareAdmin' });
    expect(cognito.addToGroup.mock.calls).toEqual([['rep1', 'SoftwareAdmin']]);
  });

  test.each([
    [{ username: 'x', email: 'a@b.co', role: 'Owner', groupId: GROUP }, /Username/],
    [{ username: 'okname', email: 'nope', role: 'Owner', groupId: GROUP }, /email/],
    [{ username: 'okname', email: 'a@b.co', role: 'Boss', groupId: GROUP }, /role/],
    [{ username: 'okname', email: 'a@b.co', role: 'Owner' }, /practice/],
    [{ username: 'okname', email: 'a@b.co', role: 'Owner', groupId: 'missing' }, /does not exist/],
    [{ username: 'okname', email: 'a@b.co', role: 'SoftwareRep', groupId: GROUP }, /platform role/],
  ])('rejects %j', async (body, msg) => {
    setup();
    const res = await invite(body);
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).message).toMatch(msg);
    expect(cognito.createUser).not.toHaveBeenCalled();
  });

  test('409 when the username is taken', async () => {
    setup();
    cognito.createUser.mockRejectedValue(Object.assign(new Error('exists'), { name: 'UsernameExistsException' }));
    expect((await invite({ username: 'drv', email: 'a@b.co', role: 'Owner', groupId: GROUP })).statusCode).toBe(409);
  });
});

describe('PUT update', () => {
  const update = (username, body) => handler(apiEvent({ method: 'PUT', path: { username }, body }));

  test('changing role to a platform role clears the practice, syncs groups and DB, and signs the user out', async () => {
    setup();
    const res = await update('drv', { role: 'SoftwareRep' });
    expect(res.statusCode).toBe(200);
    expect(cognito.updateAttributes).toHaveBeenCalledWith('drv', { 'custom:role': 'SoftwareRep' });
    expect(cognito.deleteAttributes).toHaveBeenCalledWith('drv', ['custom:groupId']);
    expect(cognito.addToGroup).toHaveBeenCalledWith('drv', 'SoftwareRep');
    expect(cognito.globalSignOut).toHaveBeenCalledWith('drv');
    const sqls = client.query.mock.calls.map(([sql]) => sql);
    expect(sqls[0]).toMatch(/UPDATE Users SET Role/);
    expect(sqls[1]).toMatch(/DELETE FROM GroupUsers/);
    expect(sqls).toHaveLength(2); // no GroupUsers insert for a platform role
    expect(audits()).toEqual(['user.updated']);
  });

  test('saving an email marks it verified without signing the user out', async () => {
    setup();
    await update('drv', { email: 'd@x.com' });
    expect(cognito.updateAttributes).toHaveBeenCalledWith('drv', { email: 'd@x.com', email_verified: 'true' });
    expect(cognito.globalSignOut).not.toHaveBeenCalled();
  });

  test('the ControllerOwner account is protected', async () => {
    setup({ users: [paul, otherAdmin, owner] });
    requireAuth.mockResolvedValue({ ...CONTROLLER_ADMIN, userId: 's-ana', username: 'ana' });
    const res = await update('paul', { email: 'attacker@evil.com' });
    expect(res.statusCode).toBe(403);
    expect(cognito.updateAttributes).not.toHaveBeenCalled();
  });

  test('accountant portal logins are managed in Controller > Accountants, not here', async () => {
    const cpa = cUser('casey.cpa', { sub: 's-cpa', email: 'c@firm.com', email_verified: 'true', 'custom:role': 'Accountant' });
    setup({ users: [paul, cpa], controllerOwners: [] });
    const res = await update('casey.cpa', { role: 'Owner', groupId: GROUP });
    expect(res.statusCode).toBe(409);
    expect(cognito.updateAttributes).not.toHaveBeenCalled();
    const disable = await handler(apiEvent({ method: 'POST', resource: '/api/settings/users/{username}/{action}', path: { username: 'casey.cpa', action: 'disable' } }));
    expect(disable.statusCode).toBe(409);
    expect(cognito.disableUser).not.toHaveBeenCalled();
  });

  test('inviting with the Accountant role is refused here', async () => {
    setup({ users: [paul] });
    const res = await handler(apiEvent({ method: 'POST', resource: '/api/settings/users', body: { username: 'cpa2', email: 'c2@firm.com', role: 'Accountant' } }));
    expect(res.statusCode).toBe(400);
    expect(cognito.createUser).not.toHaveBeenCalled();
  });

  test("an admin can't change their own role", async () => {
    setup({ users: [paul, otherAdmin], controllerOwners: [] });
    const res = await update('paul', { role: 'Owner', groupId: GROUP });
    expect(res.statusCode).toBe(400);
  });

  test("can't demote the last SoftwareAdmin", async () => {
    setup({ users: [paul, otherAdmin], controllerOwners: ['paul'] });
    cognito.listAllUsers.mockResolvedValue([{ ...paul, Enabled: false }, otherAdmin]);
    requireAuth.mockResolvedValue({ ...CONTROLLER_ADMIN, username: 'paul' });
    const res = await update('ana', { role: 'SoftwareRep' });
    expect(res.statusCode).toBe(409);
  });

  test('404 for an unknown user', async () => {
    setup();
    expect((await update('ghost', { email: 'g@x.com' })).statusCode).toBe(404);
  });
});

describe('POST actions', () => {
  const act = (username, action) => handler(apiEvent({ method: 'POST', path: { username, action } }));

  test('disable signs the user out and audits', async () => {
    setup();
    expect((await act('drv', 'disable')).statusCode).toBe(200);
    expect(cognito.disableUser).toHaveBeenCalledWith('drv');
    expect(cognito.globalSignOut).toHaveBeenCalledWith('drv');
    expect(audits()).toEqual(['user.disable']);
  });

  test('reset-mfa removes the authenticator and signs the user out', async () => {
    setup();
    await act('drv', 'reset-mfa');
    expect(cognito.resetMfa).toHaveBeenCalledWith('drv');
    expect(cognito.globalSignOut).toHaveBeenCalledWith('drv');
  });

  test('reset-password needs a verified email', async () => {
    setup();
    const res = await act('drv', 'reset-password');
    expect(res.statusCode).toBe(400);
    expect(cognito.resetPassword).not.toHaveBeenCalled();
  });

  test('reset-password emails a code for a verified user', async () => {
    const verified = cUser('drv', { sub: 's-drv', email: 'd@x.com', email_verified: 'true', 'custom:role': 'Owner', 'custom:groupId': GROUP });
    setup({ users: [paul, verified] });
    expect((await act('drv', 'reset-password')).statusCode).toBe(200);
    expect(cognito.resetPassword).toHaveBeenCalledWith('drv');
  });

  test('resend-invite only for users who never signed in', async () => {
    setup();
    expect((await act('drv', 'resend-invite')).statusCode).toBe(400);
    const invited = cUser('newbie', { sub: 's-n', email: 'n@x.com', 'custom:role': 'TeamMember', 'custom:groupId': GROUP }, { UserStatus: 'FORCE_CHANGE_PASSWORD' });
    setup({ users: [paul, invited] });
    expect((await act('newbie', 'resend-invite')).statusCode).toBe(200);
    expect(cognito.resendInvite).toHaveBeenCalledWith('newbie');
  });

  test("can't act on your own account", async () => {
    setup({ users: [paul, otherAdmin], controllerOwners: [] });
    for (const action of ['disable', 'reset-mfa', 'reset-password']) {
      expect((await act('paul', action)).statusCode).toBe(400);
    }
    expect(cognito.disableUser).not.toHaveBeenCalled();
  });

  test('the ControllerOwner account cannot be disabled or reset from the app', async () => {
    setup({ users: [paul, otherAdmin] });
    requireAuth.mockResolvedValue({ ...CONTROLLER_ADMIN, userId: 's-ana', username: 'ana' });
    for (const action of ['disable', 'reset-mfa', 'reset-password']) {
      expect((await act('paul', action)).statusCode).toBe(403);
    }
  });

  test('404 for an unknown action; there is no delete', async () => {
    setup();
    expect((await act('drv', 'delete')).statusCode).toBe(404);
  });
});

describe('mapCognitoError', () => {
  test('maps known Cognito errors and passes others through', () => {
    expect(mapCognitoError({ name: 'TooManyRequestsException' }).statusCode).toBe(429);
    const other = new Error('boom');
    expect(mapCognitoError(other)).toBe(other);
  });
});

describe('IAM', () => {
  test('the template grants no AdminDeleteUser', () => {
    const template = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'template.yaml'), 'utf8');
    expect(template).toMatch(/cognito-idp:AdminCreateUser/);
    expect(template).not.toMatch(/cognito-idp:AdminDeleteUser\b/);
  });
});
