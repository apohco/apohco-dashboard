jest.mock('../../src/shared/verifyToken', () => ({ requireAuth: jest.fn() }));
jest.mock('../../src/shared/db', () => ({ query: jest.fn(), withTransaction: jest.fn() }));
jest.mock('../../src/shared/googleApi', () => ({
  ...jest.requireActual('../../src/shared/googleApi'),
  testConnection: jest.fn(),
  listDirectoryUsers: jest.fn(),
  listSharedDrives: jest.fn(),
  driveGetFile: jest.fn(),
}));
jest.mock('../../src/shared/driveIndex', () => ({ startFolderIndex: jest.fn() }));

const { requireAuth } = require('../../src/shared/verifyToken');
const { query } = require('../../src/shared/db');
const google = require('../../src/shared/googleApi');
const { startFolderIndex } = require('../../src/shared/driveIndex');
const { handler, folderIdFromLink } = require('../../src/functions/controller/ctrlGoogle');
const { CONTROLLER_ADMIN, PLAIN_ADMIN, sqlRouter, apiEvent, parseBody } = require('../helpers');

const SETTINGS = { adminemail: 'info@apohco.com', domain: 'apohco.com' };
const FOLDER_ID = '1AbCdEfGhIjKlMnOpQrStUv';
const SOURCE_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
function setup({ settings = SETTINGS, sources = [], routes = [] } = {}) {
  requireAuth.mockResolvedValue(CONTROLLER_ADMIN);
  query.mockImplementation(
    sqlRouter([
      ...routes,
      [/SELECT AdminEmail, Domain/, { rows: settings ? [settings] : [] }],
      [/FROM CtrlGoogleSources WHERE GroupId = \$1/, { rows: sources }],
      [/INSERT INTO CtrlGoogleSources .*RETURNING SourceId/s, { rows: [{ sourceid: SOURCE_ID }] }],
    ])
  );
}
const call = (method, resource, body, q, path) =>
  handler(apiEvent({ method, resource, body: body && { groupId: 'g1', ...body }, query: q && { groupId: 'g1', ...q }, path }));
const sqlCalls = (re) => query.mock.calls.filter(([sql]) => re.test(sql));

beforeEach(() => {
  process.env.GOOGLE_SA_SECRET_ID = 'apohco-dashboard/google-service-account';
  startFolderIndex.mockResolvedValue({ indexRunId: 'run-1', alreadyRunning: false });
});

test('only the Controller owner', async () => {
  setup();
  requireAuth.mockResolvedValue(PLAIN_ADMIN);
  expect((await call('GET', '/api/controller/google', null, {})).statusCode).toBe(403);
});

test('GET: settings, mailboxes and folders (with index stats); old whole-drive sources are not shown', async () => {
  setup({
    sources: [
      { sourceid: 's1', kind: 'Mailbox', sourcekey: 'info@apohco.com', displayname: 'info@apohco.com', enabled: true },
      { sourceid: SOURCE_ID, kind: 'Folder', sourcekey: FOLDER_ID, displayname: 'Invoices', enabled: true, folderpath: 'Shared drive CFO / Invoices', actas: 'info@apohco.com' },
      { sourceid: 's3', kind: 'UserDrive', sourcekey: 'x@apohco.com', enabled: true },
    ],
    routes: [[/FROM CtrlGoogleSources s\s+LEFT JOIN LATERAL/, { rows: [{ sourceid: SOURCE_ID, files: 12, readable: 11, status: 'Succeeded', filesseen: 12, filestoindex: 12, filesindexed: 11, filesfailed: 1, ocrpages: 3 }] }]],
  });
  const data = parseBody(await call('GET', '/api/controller/google', null, {}));
  expect(data.keyConfigured).toBe(true);
  expect(data.sources.map((s) => s.kind)).toEqual(['Mailbox', 'Folder']);
  expect(data.sources[1]).toMatchObject({ folderPath: 'Shared drive CFO / Invoices', files: 12, readable: 11, lastRun: { status: 'Succeeded', ocrPages: 3, failed: 1 } });
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
  expect(sqlCalls(/UPDATE CtrlGoogleSettings SET LastTestAt/)[0][1]).toEqual(['g1', true, 'OK: Service account key: Key for x']);
});

test('directory: workspace users with their Gmail opt-in state (no drives)', async () => {
  setup({ sources: [{ kind: 'Mailbox', sourcekey: 'info@apohco.com', enabled: true }] });
  google.listDirectoryUsers.mockResolvedValue([
    { email: 'info@apohco.com', name: 'Info', suspended: false },
    { email: 'drvaughan@apohco.com', name: 'Dr Vaughan', suspended: false },
    { email: 'guest@other.com', name: 'Guest', suspended: false },
  ]);
  const data = parseBody(await call('GET', '/api/controller/google/directory', null, {}));
  expect(data).toEqual({
    users: [
      { email: 'info@apohco.com', name: 'Info', suspended: false, mailbox: true },
      { email: 'drvaughan@apohco.com', name: 'Dr Vaughan', suspended: false, mailbox: false },
    ],
  });
  expect(google.listSharedDrives).not.toHaveBeenCalled();
});

test('directory errors from Google come back as 502 with the reason', async () => {
  setup();
  google.listDirectoryUsers.mockRejectedValue(new Error('Domain-wide delegation is not set up for this service account'));
  const res = await call('GET', '/api/controller/google/directory', null, {});
  expect(res.statusCode).toBe(502);
  expect(parseBody(res).message).toMatch(/Domain-wide delegation/);
});

describe('sources', () => {
  test('a workspace mailbox; audited', async () => {
    setup();
    const res = await call('PUT', '/api/controller/google/sources', { kind: 'Mailbox', sourceKey: 'drvaughan@apohco.com', displayName: 'Dr Vaughan', enabled: true });
    expect(res.statusCode).toBe(200);
    expect(sqlCalls(/INSERT INTO CtrlGoogleSources/)[0][1]).toEqual(['g1', 'Mailbox', 'drvaughan@apohco.com', 'Dr Vaughan', true, 'user-paul']);
    expect(sqlCalls(/INSERT INTO CtrlAuditLog/)[0][1][2]).toBe('ctrl.google.source.enable');
  });
  test('whole drives can no longer be opted in; accounts outside the workspace are refused', async () => {
    setup();
    expect((await call('PUT', '/api/controller/google/sources', { kind: 'UserDrive', sourceKey: 'a@apohco.com', enabled: true })).statusCode).toBe(400);
    expect((await call('PUT', '/api/controller/google/sources', { kind: 'SharedDrive', sourceKey: 'drv1abcde', enabled: true })).statusCode).toBe(400);
    expect((await call('PUT', '/api/controller/google/sources', { kind: 'Mailbox', sourceKey: 'someone@gmail.com', enabled: true })).statusCode).toBe(400);
    expect((await call('PUT', '/api/controller/google/sources', { kind: 'Mailbox', sourceKey: 'a@apohco.com' })).statusCode).toBe(400);
  });
  test('a folder is switched off (not created) through sources', async () => {
    setup({ routes: [[/UPDATE CtrlGoogleSources SET Enabled/, { rows: [{ sourceid: SOURCE_ID }] }]] });
    expect((await call('PUT', '/api/controller/google/sources', { kind: 'Folder', sourceKey: FOLDER_ID, enabled: false })).statusCode).toBe(200);
    setup({ routes: [[/UPDATE CtrlGoogleSources SET Enabled/, { rows: [] }]] });
    expect((await call('PUT', '/api/controller/google/sources', { kind: 'Folder', sourceKey: 'nope', enabled: true })).statusCode).toBe(404);
  });
  test('needs the connection first', async () => {
    setup({ settings: null });
    expect((await call('PUT', '/api/controller/google/sources', { kind: 'Mailbox', sourceKey: 'a@apohco.com', enabled: true })).statusCode).toBe(409);
  });
});

describe('invoice folders', () => {
  test('folderIdFromLink', () => {
    expect(folderIdFromLink(`https://drive.google.com/drive/folders/${FOLDER_ID}?usp=sharing`)).toBe(FOLDER_ID);
    expect(folderIdFromLink(`https://drive.google.com/drive/u/0/folders/${FOLDER_ID}`)).toBe(FOLDER_ID);
    expect(folderIdFromLink(`https://drive.google.com/open?id=${FOLDER_ID}`)).toBe(FOLDER_ID);
    expect(folderIdFromLink(FOLDER_ID)).toBe(FOLDER_ID);
    expect(folderIdFromLink('https://example.com/x')).toBeNull();
  });

  test('add a shared-drive folder by link: its path is shown and indexing starts', async () => {
    setup();
    google.driveGetFile.mockImplementation(async (actAs, id) =>
      ({
        [FOLDER_ID]: { id: FOLDER_ID, name: 'Invoices', mimeType: google.FOLDER_MIME, parents: ['p2026'], driveId: 'drvCFO' },
        p2026: { id: 'p2026', name: 'Accounting', parents: ['drvCFO'] },
        drvCFO: { id: 'drvCFO', name: 'CFO' },
      })[id]
    );
    google.listSharedDrives.mockResolvedValue([{ id: 'drvCFO', name: 'CFO' }]);
    const res = await call('POST', '/api/controller/google/folders', { link: `https://drive.google.com/drive/folders/${FOLDER_ID}` });
    expect(res.statusCode).toBe(200);
    expect(parseBody(res).added).toEqual({ sourceId: SOURCE_ID, folderPath: 'Shared drive CFO / Accounting / Invoices', indexRunId: 'run-1' });
    expect(google.driveGetFile.mock.calls[0][0]).toBe('info@apohco.com');
    const insert = sqlCalls(/INSERT INTO CtrlGoogleSources/)[0][1];
    expect(insert).toEqual(['g1', FOLDER_ID, 'Invoices', 'user-paul', 'Shared drive CFO / Accounting / Invoices', 'drvCFO', 'info@apohco.com']);
    expect(startFolderIndex).toHaveBeenCalledWith('g1', SOURCE_ID, 'Manual');
  });

  test('a folder in someone\'s My Drive, read as its owner', async () => {
    setup();
    google.driveGetFile.mockImplementation(async (actAs, id) =>
      id === FOLDER_ID
        ? { id, name: 'Receipts', mimeType: google.FOLDER_MIME, parents: ['root1'], owners: [{ emailAddress: 'amy@apohco.com' }] }
        : { id, name: 'My Drive', parents: [] }
    );
    const res = await call('POST', '/api/controller/google/folders', { link: FOLDER_ID, actAs: 'amy@apohco.com' });
    expect(parseBody(res).added.folderPath).toBe("amy@apohco.com's My Drive / Receipts");
    expect(google.driveGetFile.mock.calls[0][0]).toBe('amy@apohco.com');
  });

  test('refusals: not visible, not a folder, bad link, outside account', async () => {
    setup();
    google.driveGetFile.mockRejectedValue(Object.assign(new Error('File not found'), { status: 404 }));
    const notVisible = await call('POST', '/api/controller/google/folders', { link: FOLDER_ID });
    expect(notVisible.statusCode).toBe(404);
    expect(parseBody(notVisible).message).toMatch(/can't see that folder\. Share it with info@apohco.com/);
    google.driveGetFile.mockResolvedValue({ id: FOLDER_ID, name: 'a.pdf', mimeType: 'application/pdf' });
    expect((await call('POST', '/api/controller/google/folders', { link: FOLDER_ID })).statusCode).toBe(400);
    expect((await call('POST', '/api/controller/google/folders', { link: 'hello' })).statusCode).toBe(400);
    expect((await call('POST', '/api/controller/google/folders', { link: FOLDER_ID, actAs: 'x@gmail.com' })).statusCode).toBe(400);
    expect(startFolderIndex).not.toHaveBeenCalled();
  });

  test('index now, and remove (with its candidates)', async () => {
    setup({ routes: [[/SELECT SourceId, SourceKey, Enabled FROM CtrlGoogleSources/, { rows: [{ sourceid: SOURCE_ID, sourcekey: FOLDER_ID, enabled: true }] }]] });
    expect((await call('POST', '/api/controller/google/folders/{sourceId}/index', {}, null, { sourceId: SOURCE_ID })).statusCode).toBe(202);
    const res = await call('DELETE', '/api/controller/google/folders/{sourceId}', null, {}, { sourceId: SOURCE_ID });
    expect(res.statusCode).toBe(200);
    expect(sqlCalls(/DELETE FROM CtrlEvidenceCandidates WHERE GroupId = \$1 AND Source = 'Drive'/)[0][1]).toEqual(['g1', SOURCE_ID]);
    expect(sqlCalls(/DELETE FROM CtrlGoogleSources WHERE SourceId/)[0][1]).toEqual([SOURCE_ID]);
  });

  test('a switched-off folder is not indexed', async () => {
    setup({ routes: [[/SELECT SourceId, SourceKey, Enabled FROM CtrlGoogleSources/, { rows: [{ sourceid: SOURCE_ID, sourcekey: FOLDER_ID, enabled: false }] }]] });
    expect((await call('POST', '/api/controller/google/folders/{sourceId}/index', {}, null, { sourceId: SOURCE_ID })).statusCode).toBe(409);
  });
});
