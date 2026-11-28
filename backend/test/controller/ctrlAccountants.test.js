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
const db = require('../../src/shared/db');
const cognito = require('../../src/shared/cognitoAdmin');
const { handler } = require('../../src/functions/controller/ctrlAccountants');
const { CONTROLLER_ADMIN, PLAIN_ADMIN, OWNER, sqlRouter, apiEvent, parseBody, sqlOf } = require('../helpers');

const G = '11111111-1111-4111-8111-111111111111';
const MGMT = '22222222-2222-4222-8222-222222222222';
const WPD = '33333333-3333-4333-8333-333333333333';
const ACC = '44444444-4444-4444-8444-444444444444';
const SUB = '55555555-5555-4555-8555-555555555555';

const ACC_ROW = { accountantid: ACC, username: 'casey.cpa', userid: SUB, fullname: 'Casey CPA', email: 'casey@firm.com', firm: 'Firm LLP', active: true, notifybyemail: true };

function routes({ list = [], dupe = [], extra = [] } = {}) {
  return [
    ...extra,
    [/FROM CtrlAccountants a\s+LEFT JOIN CtrlAccountantAccess x/, { rows: list }],
    [/SELECT QBOId, QBOName FROM QBOs WHERE GroupId/, { rows: [{ qboid: MGMT, qboname: 'APOHCO Management' }, { qboid: WPD, qboname: 'Westside' }] }],
    [/SELECT QBOId FROM QBOs WHERE GroupId = \$1 AND QBOId = ANY/, (sql, [, ids]) => ({ rows: ids.filter((i) => [MGMT, WPD].includes(i)).map((qboid) => ({ qboid })) })],
    [/FROM Groups grp\s+LEFT JOIN CtrlNotifySettings/, { rows: [{ emailenabled: false, controlleremail: null, adminemail: 'admin@apohco.com' }] }],
    [/SELECT FullName FROM CtrlAccountants WHERE lower\(Email\)/, { rows: dupe }],
    [/SELECT \* FROM CtrlAccountants WHERE AccountantId/, { rows: [ACC_ROW] }],
    [/INSERT INTO CtrlAccountants/, { rows: [{ accountantid: ACC }] }],
  ];
}

const invite = (body) => apiEvent({ method: 'POST', resource: '/api/controller/accountants', body: { groupId: G, fullName: 'Casey CPA', email: 'casey@firm.com', username: 'casey.cpa', firm: 'Firm LLP', ...body } });

beforeEach(() => {
  jest.clearAllMocks();
  requireAuth.mockResolvedValue(CONTROLLER_ADMIN);
  db.withTransaction.mockImplementation(async (fn) => fn({ query: db.query }));
  cognito.createUser.mockResolvedValue({ User: { Username: 'casey.cpa', Attributes: [{ Name: 'sub', Value: SUB }] } });
  cognito.getUser.mockResolvedValue({ Enabled: true, UserStatus: 'FORCE_CHANGE_PASSWORD' });
});

test.each([['a SoftwareAdmin outside ControllerOwner', PLAIN_ADMIN], ['a practice Owner', OWNER]])('%s is refused', async (_, claims) => {
  requireAuth.mockResolvedValue(claims);
  db.query.mockImplementation(sqlRouter(routes()));
  expect((await handler(invite())).statusCode).toBe(403);
  expect(cognito.createUser).not.toHaveBeenCalled();
});

describe('invite', () => {
  test('creates an Accountant login with NO groupId, then the portal record and its access to every file', async () => {
    db.query.mockImplementation(sqlRouter(routes()));
    const res = await handler(invite());
    expect(res.statusCode).toBe(201);
    expect(cognito.createUser).toHaveBeenCalledWith('casey.cpa', { email: 'casey@firm.com', email_verified: 'true', 'custom:role': 'Accountant' });
    expect(cognito.createUser.mock.calls[0][1]['custom:groupId']).toBeUndefined();
    expect(db.query.mock.calls.find(([s]) => /INSERT INTO CtrlAccountants/.test(s))[1]).toEqual(['casey.cpa', SUB, 'Casey CPA', 'casey@firm.com', 'Firm LLP', true, CONTROLLER_ADMIN.userId]);
    expect(db.query.mock.calls.find(([s]) => /INSERT INTO CtrlAccountantAccess/.test(s))[1]).toEqual([ACC, G, null, CONTROLLER_ADMIN.userId]);
    const sql = sqlOf(db.query);
    expect(sql.some((s) => /INSERT INTO UserAdminAuditLog/.test(s))).toBe(true);
    expect(sql.some((s) => /INSERT INTO CtrlAuditLog/.test(s))).toBe(true);
  });

  test('can be limited to some files of the Group', async () => {
    db.query.mockImplementation(sqlRouter(routes()));
    expect((await handler(invite({ qboIds: [WPD] }))).statusCode).toBe(201);
    expect(db.query.mock.calls.find(([s]) => /INSERT INTO CtrlAccountantAccess/.test(s))[1][2]).toEqual([WPD]);
  });

  test('a file from another Group is refused before any login is made', async () => {
    db.query.mockImplementation(sqlRouter(routes()));
    const res = await handler(invite({ qboIds: ['99999999-9999-4999-8999-999999999999'] }));
    expect(res.statusCode).toBe(404);
    expect(cognito.createUser).not.toHaveBeenCalled();
  });

  test('an email that already has a portal login is refused', async () => {
    db.query.mockImplementation(sqlRouter(routes({ dupe: [{ fullname: 'Casey CPA' }] })));
    const res = await handler(invite());
    expect(res.statusCode).toBe(409);
    expect(cognito.createUser).not.toHaveBeenCalled();
  });

  test.each([
    [{ fullName: '' }, /Name is required/],
    [{ email: 'nope' }, /valid email/],
    [{ username: 'a b' }, /Username/],
  ])('validates %o', async (body, message) => {
    db.query.mockImplementation(sqlRouter(routes()));
    const res = await handler(invite(body));
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).message).toMatch(message);
  });

  test('a taken username comes back as 409', async () => {
    db.query.mockImplementation(sqlRouter(routes()));
    cognito.createUser.mockRejectedValue(Object.assign(new Error('exists'), { name: 'UsernameExistsException' }));
    expect((await handler(invite())).statusCode).toBe(409);
  });

  test('if saving the portal record fails, the new login is disabled again', async () => {
    db.query.mockImplementation(sqlRouter(routes({ extra: [[/INSERT INTO CtrlAccountants/, () => { throw new Error('db down'); }]] })));
    expect((await handler(invite())).statusCode).toBe(500);
    expect(cognito.disableUser).toHaveBeenCalledWith('casey.cpa');
  });
});

describe('list', () => {
  test('shows each accountant with access to this Group, login state and last activity', async () => {
    db.query.mockImplementation(sqlRouter(routes({
      list: [{ ...ACC_ROW, createdat: '2026-11-28', accessgroupid: G, qboids: [MGMT], othergroups: '0', lastactiveat: '2026-11-28T10:00:00Z' }],
    })));
    const res = await handler(apiEvent({ resource: '/api/controller/accountants', query: { groupId: G } }));
    expect(res.statusCode).toBe(200);
    const body = parseBody(res);
    expect(body.accountants[0]).toMatchObject({ fullName: 'Casey CPA', hasAccess: true, qboIds: [MGMT], loginStatus: 'InvitePending', lastActiveAt: '2026-11-28T10:00:00Z' });
    expect(body.files).toHaveLength(2);
    expect(body.notify).toMatchObject({ emailEnabled: false, senderEmail: 'admin@apohco.com' });
  });
});

describe('update and actions', () => {
  const put = (body) => apiEvent({ method: 'PUT', resource: '/api/controller/accountants/{accountantId}', path: { accountantId: ACC }, body: { groupId: G, ...body } });
  const act = (action) => apiEvent({ method: 'POST', resource: '/api/controller/accountants/{accountantId}/{action}', path: { accountantId: ACC, action }, body: { groupId: G } });

  test('changing the email updates Cognito and marks it verified', async () => {
    db.query.mockImplementation(sqlRouter(routes()));
    expect((await handler(put({ email: 'casey@newfirm.com' }))).statusCode).toBe(200);
    expect(cognito.updateAttributes).toHaveBeenCalledWith('casey.cpa', { email: 'casey@newfirm.com', email_verified: 'true' });
  });

  test('access can be narrowed to files, or removed for this Group', async () => {
    db.query.mockImplementation(sqlRouter(routes()));
    await handler(put({ qboIds: [MGMT] }));
    expect(db.query.mock.calls.find(([s]) => /INSERT INTO CtrlAccountantAccess/.test(s))[1]).toEqual([ACC, G, [MGMT], CONTROLLER_ADMIN.userId]);
    db.query.mockClear();
    await handler(put({ access: false }));
    expect(db.query.mock.calls.find(([s]) => /DELETE FROM CtrlAccountantAccess/.test(s))[1]).toEqual([ACC, G]);
    expect(cognito.updateAttributes).not.toHaveBeenCalled();
  });

  test('deactivate turns the portal record off, disables the login and ends sessions', async () => {
    db.query.mockImplementation(sqlRouter(routes()));
    expect((await handler(act('deactivate'))).statusCode).toBe(200);
    expect(sqlOf(db.query).some((s) => /UPDATE CtrlAccountants SET Active = false/.test(s))).toBe(true);
    expect(cognito.disableUser).toHaveBeenCalledWith('casey.cpa');
    expect(cognito.globalSignOut).toHaveBeenCalledWith('casey.cpa');
  });

  test('resend invite only before the first sign-in', async () => {
    db.query.mockImplementation(sqlRouter(routes()));
    cognito.getUser.mockResolvedValue({ Enabled: true, UserStatus: 'CONFIRMED' });
    expect((await handler(act('resend-invite'))).statusCode).toBe(400);
    expect(cognito.resendInvite).not.toHaveBeenCalled();
  });

  test('unknown actions are refused', async () => {
    db.query.mockImplementation(sqlRouter(routes()));
    expect((await handler(act('delete'))).statusCode).toBe(404);
  });
});

describe('email notification settings', () => {
  const settings = (body) => apiEvent({ method: 'PUT', resource: '/api/controller/accountant-settings', body: { groupId: G, ...body } });

  test('turning email on needs Google Workspace connected', async () => {
    db.query.mockImplementation(sqlRouter(routes({ extra: [[/FROM Groups grp\s+LEFT JOIN CtrlNotifySettings/, { rows: [{ emailenabled: false, controlleremail: null, adminemail: null }] }]] })));
    expect((await handler(settings({ emailEnabled: true }))).statusCode).toBe(409);
  });

  test('saves the setting and where questions go', async () => {
    db.query.mockImplementation(sqlRouter(routes()));
    expect((await handler(settings({ emailEnabled: true, controllerEmail: 'paul@apohco.com' }))).statusCode).toBe(200);
    expect(db.query.mock.calls.find(([s]) => /INSERT INTO CtrlNotifySettings/.test(s))[1]).toEqual([G, true, 'paul@apohco.com', CONTROLLER_ADMIN.userId]);
  });

  test('a test email is queued only when email is on', async () => {
    db.query.mockImplementation(sqlRouter(routes()));
    const test = apiEvent({ method: 'POST', resource: '/api/controller/accountant-settings/test', body: { groupId: G } });
    expect((await handler(test)).statusCode).toBe(409);
    db.query.mockImplementation(sqlRouter(routes({ extra: [[/FROM Groups grp\s+LEFT JOIN CtrlNotifySettings/, { rows: [{ emailenabled: true, controlleremail: null, adminemail: 'admin@apohco.com' }] }]] })));
    const res = await handler(test);
    expect(res.statusCode).toBe(202);
    expect(db.query.mock.calls.find(([s]) => /INSERT INTO CtrlNotifications/.test(s))[1]).toEqual([G, 'Test', 'admin@apohco.com', expect.any(String), expect.any(String)]);
  });
});
