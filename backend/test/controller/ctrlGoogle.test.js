jest.mock('../../src/shared/verifyToken', () => ({ requireAuth: jest.fn() }));
jest.mock('../../src/shared/db', () => ({ query: jest.fn(), withTransaction: jest.fn() }));
jest.mock('../../src/shared/googleApi', () => ({
  ...jest.requireActual('../../src/shared/googleApi'),
  testConnection: jest.fn(),
  listDirectoryUsers: jest.fn(),
  listSharedDrives: jest.fn(),
}));

const { requireAuth } = require('../../src/shared/verifyToken');
const { query } = require('../../src/shared/db');
const google = require('../../src/shared/googleApi');
const { handler } = require('../../src/functions/controller/ctrlGoogle');
const { CONTROLLER_ADMIN, PLAIN_ADMIN, sqlRouter, apiEvent, parseBody } = require('../helpers');

const SETTINGS = { adminemail: 'info@apohco.com', domain: 'apohco.com' };
function setup({ settings = SETTINGS, sources = [] } = {}) {
  requireAuth.mockResolvedValue(CONTROLLER_ADMIN);
  query.mockImplementation(
    sqlRouter([
      [/SELECT AdminEmail, Domain/, { rows: settings ? [settings] : [] }],
      [/FROM CtrlGoogleSources WHERE/, { rows: sources }],
    ])
  );
}
const call = (method, resource, body, q) =>
  handler(apiEvent({ method, resource, body: body && { groupId: 'g1', ...body }, query: q && { groupId: 'g1', ...q } }));
const sqlCalls = (re) => query.mock.calls.filter(([sql]) => re.test(sql));

beforeEach(() => {
  process.env.GOOGLE_SA_SECRET_ID = 'apohco-dashboard/google-service-account';
});

test('only the Controller owner', async () => {
  setup();
  requireAuth.mockResolvedValue(PLAIN_ADMIN);
  expect((await call('GET', '/api/controller/google', null, {})).statusCode).toBe(403);
});

test('GET: settings, sources, and whether the key is configured', async () => {
  setup({ sources: [{ sourceid: 's1', kind: 'Mailbox', sourcekey: 'info@apohco.com', displayname: 'info@apohco.com', enabled: true }] });
  const data = parseBody(await call('GET', '/api/controller/google', null, {}));
  expect(data).toMatchObject({ keyConfigured: true, settings: { adminEmail: 'info@apohco.com', domain: 'apohco.com' }, sources: [{ kind: 'Mailbox', sourceKey: 'info@apohco.com', enabled: true }] });
});

test('first save: the admin mailbox becomes the first source', async () => {
  setup({ settings: null });
  const res = await call('PUT', '/api/controller/google', { adminEmail: ' Info@APOHCO.com ' });
  expect(res.statusCode).toBe(200);
  expect(sqlCalls(/INSERT INTO CtrlGoogleSettings/)[0][1]).toEqual(['g1', 'info@apohco.com', 'apohco.com', 'user-paul']);
  expect(sqlCalls(/INSERT INTO CtrlGoogleSources/)[0][1]).toEqual(['g1', 'info@apohco.com', 'user-paul']);
  expect((await call('PUT', '/api/controller/google', { adminEmail: 'not an email' })).statusCode).toBe(400);
});

test('test connection stores the result', async () => {
  setup();
  google.testConnection.mockResolvedValue({ ok: true, checks: [{ name: 'Service account key', ok: true, detail: 'Key for x' }] });
  const res = await call('POST', '/api/controller/google/test', {});
  expect(parseBody(res).ok).toBe(true);
  expect(google.testConnection).toHaveBeenCalledWith('info@apohco.com');
  expect(sqlCalls(/UPDATE CtrlGoogleSettings SET LastTestAt/)[0][1]).toEqual(['g1', true, 'OK: Service account key: Key for x']);
});

test('directory: workspace users and shared drives with their opt-in state', async () => {
  setup({ sources: [{ kind: 'Mailbox', sourcekey: 'info@apohco.com', enabled: true }, { kind: 'SharedDrive', sourcekey: 'drv1', enabled: true }] });
  google.listDirectoryUsers.mockResolvedValue([
    { email: 'info@apohco.com', name: 'Info', suspended: false },
    { email: 'drvaughan@apohco.com', name: 'Dr Vaughan', suspended: false },
    { email: 'guest@other.com', name: 'Guest', suspended: false },
  ]);
  google.listSharedDrives.mockResolvedValue([{ id: 'drv1', name: 'Accounting' }, { id: 'drv2', name: 'Marketing' }]);
  const data = parseBody(await call('GET', '/api/controller/google/directory', null, {}));
  expect(data.users).toEqual([
    { email: 'info@apohco.com', name: 'Info', suspended: false, mailbox: true, drive: false },
    { email: 'drvaughan@apohco.com', name: 'Dr Vaughan', suspended: false, mailbox: false, drive: false },
  ]);
  expect(data.sharedDrives).toEqual([{ id: 'drv1', name: 'Accounting', enabled: true }, { id: 'drv2', name: 'Marketing', enabled: false }]);
});

test('directory errors from Google come back as 502 with the reason', async () => {
  setup();
  google.listDirectoryUsers.mockRejectedValue(new Error('Domain-wide delegation is not set up for this service account'));
  google.listSharedDrives.mockResolvedValue([]);
  const res = await call('GET', '/api/controller/google/directory', null, {});
  expect(res.statusCode).toBe(502);
  expect(parseBody(res).message).toMatch(/Domain-wide delegation/);
});

describe('opt in / out', () => {
  test('a workspace mailbox or drive; audited', async () => {
    setup();
    const res = await call('PUT', '/api/controller/google/sources', { kind: 'UserDrive', sourceKey: 'drvaughan@apohco.com', displayName: 'Dr Vaughan', enabled: true });
    expect(res.statusCode).toBe(200);
    expect(sqlCalls(/INSERT INTO CtrlGoogleSources/)[0][1]).toEqual(['g1', 'UserDrive', 'drvaughan@apohco.com', 'Dr Vaughan', true, 'user-paul']);
    expect(sqlCalls(/INSERT INTO CtrlAuditLog/)[0][1][2]).toBe('ctrl.google.source.enable');
  });
  test('accounts outside the workspace, bad kinds and bad drive ids are refused', async () => {
    setup();
    expect((await call('PUT', '/api/controller/google/sources', { kind: 'Mailbox', sourceKey: 'someone@gmail.com', enabled: true })).statusCode).toBe(400);
    expect((await call('PUT', '/api/controller/google/sources', { kind: 'Inbox', sourceKey: 'a@apohco.com', enabled: true })).statusCode).toBe(400);
    expect((await call('PUT', '/api/controller/google/sources', { kind: 'SharedDrive', sourceKey: 'x y', enabled: true })).statusCode).toBe(400);
    expect((await call('PUT', '/api/controller/google/sources', { kind: 'Mailbox', sourceKey: 'a@apohco.com' })).statusCode).toBe(400);
  });
  test('needs the connection first', async () => {
    setup({ settings: null });
    expect((await call('PUT', '/api/controller/google/sources', { kind: 'Mailbox', sourceKey: 'a@apohco.com', enabled: true })).statusCode).toBe(409);
  });
});
