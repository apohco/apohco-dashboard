jest.mock('../../src/shared/verifyToken', () => ({ requireAuth: jest.fn() }));
jest.mock('../../src/shared/db', () => ({ query: jest.fn(), withTransaction: jest.fn() }));
jest.mock('@aws-sdk/client-s3', () => {
  const send = jest.fn(async () => ({}));
  return {
    __send: send,
    S3Client: jest.fn(() => ({ send })),
    PutObjectCommand: jest.fn((input) => ({ type: 'put', input })),
    GetObjectCommand: jest.fn((input) => ({ type: 'get', input })),
  };
});
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn(async () => 'https://signed.example/doc') }));

const { requireAuth } = require('../../src/shared/verifyToken');
const db = require('../../src/shared/db');
const s3 = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { handler } = require('../../src/functions/controller/ctrlPortal');
const { CONTROLLER_ADMIN, OWNER, sqlRouter, apiEvent, parseBody, sqlOf } = require('../helpers');

const G = '11111111-1111-4111-8111-111111111111';
const MGMT = '22222222-2222-4222-8222-222222222222';
const WPD = '33333333-3333-4333-8333-333333333333';
const REPORT = '44444444-4444-4444-8444-444444444444';
const ENTRY = '55555555-5555-4555-8555-555555555555';
const SAVED = '66666666-6666-4666-8666-666666666666';
const USER = '77777777-7777-4777-8777-777777777777';

const ACCT = { userId: USER, username: 'cpa', role: 'Accountant', groupId: null, groups: [] };

const accountantRow = (over = {}) => ({
  accountantid: 'acct-1', username: 'cpa', userid: USER, fullname: 'Casey CPA', email: 'casey@firm.com', firm: 'Firm LLP', active: true,
  access: [{ groupId: G, qboIds: null }], ...over,
});

const REPORT_ROW = {
  reportid: REPORT, qboid: MGMT, qboname: 'APOHCO Management', month: '2026-10', filecode: 'MGMT', seq: 1, reportnumber: 'MGMT-2026-10-AJE-001',
  grouping: 'Grouped', status: 'Published', supersedesnumber: null, supersededbynumber: null, entrycount: 1, totalamount: '150.00', note: null,
  publishedat: '2026-11-20', publishedby: 'paul', postedcount: 0,
};
const ENTRY_ROW = {
  entryid: ENTRY, seq: 1, entrynumber: 'MGMT-2026-10-AJE-001.01', qbonum: 'MGMT-2610-AJE001.01', kind: 'ClassMove', entrydate: '2026-10-31',
  vendor: 'Kroger', memo: 'MGMT-2026-10-AJE-001.01 Class change', amount: '150.00', lines: [], warnings: [], postedseenat: null,
};
const SOURCE_ROW = {
  entryid: ENTRY, side: 'Own', sourceqboid: MGMT, fingerprint: 'f1', lineid: 'l1', txndate: '2026-10-05', txntype: 'Expense', docnum: null,
  payeename: 'Kroger', memo: 'x', accountcode: '6100', accountname: 'Supplies', classname: 'Unclassified', amount: '150.00', fromstate: [], tostate: [],
};
const SUPPORT_ROW = {
  savedid: SAVED, qboid: MGMT, fingerprint: 'f1', source: 'Gmail', title: 'Invoice', filename: 'inv.pdf', sizebytes: '10',
  s3key: `${G}/${MGMT}/2026-10/${SAVED}/inv.pdf`, drivepath: 'Controller Evidence / Lebanon / inv.pdf', savedat: '2026-11-01',
};

function routes({ accountant = accountantRow(), reportRow = REPORT_ROW, reportQbo = MGMT, statuses = [], threads = [], notify = null, extra = [] } = {}) {
  return [
    ...extra,
    [/FROM CtrlAccountants a\s+LEFT JOIN CtrlAccountantAccess/, { rows: accountant ? [accountant] : [] }],
    [/SELECT ReportId, GroupId, QBOId, Status FROM CtrlAjeReports WHERE ReportId = \$1/, { rows: reportRow ? [{ reportid: REPORT, groupid: G, qboid: reportQbo, status: reportRow.status }] : [] }],
    [/FROM CtrlAjeEntries e JOIN CtrlAjeReports r ON r.ReportId = e.ReportId JOIN QBOs/, {
      rows: [{ entryid: ENTRY, reportid: REPORT, groupid: G, qboid: reportQbo, entrynumber: ENTRY_ROW.entrynumber, reportnumber: REPORT_ROW.reportnumber, reportstatus: reportRow.status, qboname: 'APOHCO Management' }],
    }],
    [/FROM CtrlAjeReports r\s+JOIN QBOs q[\s\S]*WHERE r.ReportId = \$1 AND r.GroupId = \$2/, { rows: [reportRow] }],
    [/FROM CtrlAjeReports r\s+JOIN QBOs q[\s\S]*WHERE r.GroupId = \$1/, { rows: [reportRow, { ...REPORT_ROW, reportid: 'r-wpd', qboid: WPD, qboname: 'Westside', reportnumber: 'WPD-2026-10-AJE-001' }] }],
    [/FROM CtrlAjeEntries e\s+LEFT JOIN LATERAL/, { rows: [ENTRY_ROW] }],
    [/FROM CtrlAjeEntrySources WHERE ReportId/, { rows: [SOURCE_ROW] }],
    [/FROM CtrlEvidenceSaved s\s+JOIN UNNEST/, { rows: [SUPPORT_ROW] }],
    [/SELECT SavedId, S3Key, FileName, SizeBytes FROM CtrlEvidenceSaved/, { rows: [{ savedid: SAVED, s3key: SUPPORT_ROW.s3key, filename: 'inv.pdf', sizebytes: '10' }] }],
    [/SELECT DISTINCT ON \(EntryId\) EntryId, Status, Reason/, { rows: statuses }],
    [/SELECT EntryId, COUNT\(\*\) AS comments/, { rows: threads }],
    [/SELECT GroupId, GroupName FROM Groups/, { rows: [{ groupid: G, groupname: 'APOHCO' }] }],
    [/WITH st AS/, { rows: [] }],
    [/INSERT INTO CtrlAjeEntryStatus/, { rows: [{ setat: '2026-11-28T12:00:00Z' }] }],
    [/INSERT INTO CtrlAjeComments/, { rows: [{ commentid: 'c1', createdat: '2026-11-28T12:00:00Z' }] }],
    [/FROM Groups grp\s+LEFT JOIN CtrlNotifySettings/, { rows: [notify || { emailenabled: false, controlleremail: null, adminemail: null }] }],
  ];
}

const reportEvent = () => apiEvent({ resource: '/api/controller/portal/reports/{reportId}', path: { reportId: REPORT } });
const statusEvent = (body) => apiEvent({ method: 'PUT', resource: '/api/controller/portal/entries/{entryId}/status', path: { entryId: ENTRY }, body });

beforeEach(() => {
  jest.clearAllMocks();
  requireAuth.mockResolvedValue(ACCT);
  db.withTransaction.mockImplementation(async (fn) => fn({ query: db.query }));
  process.env.EVIDENCE_BUCKET = 'evidence-bucket';
});

describe('access', () => {
  test.each([['the Controller owner', CONTROLLER_ADMIN], ['a practice Owner', OWNER]])('%s cannot use the portal', async (_, claims) => {
    requireAuth.mockResolvedValue(claims);
    db.query.mockImplementation(sqlRouter(routes()));
    expect((await handler(reportEvent())).statusCode).toBe(403);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('a deactivated accountant is refused at once (before their token expires)', async () => {
    db.query.mockImplementation(sqlRouter(routes({ accountant: accountantRow({ active: false }) })));
    const res = await handler(reportEvent());
    expect(res.statusCode).toBe(403);
    expect(parseBody(res).message).toMatch(/not active/);
  });

  test('an Accountant login with no portal record is refused', async () => {
    db.query.mockImplementation(sqlRouter(routes({ accountant: null })));
    expect((await handler(reportEvent())).statusCode).toBe(403);
  });

  test('a report in a file outside their access looks like it does not exist', async () => {
    db.query.mockImplementation(sqlRouter(routes({ accountant: accountantRow({ access: [{ groupId: G, qboIds: [WPD] }] }) })));
    expect((await handler(reportEvent())).statusCode).toBe(404);
  });

  test('a report in another Group is not found', async () => {
    db.query.mockImplementation(sqlRouter(routes({ accountant: accountantRow({ access: [{ groupId: '99999999-9999-4999-8999-999999999999', qboIds: null }] }) })));
    expect((await handler(reportEvent())).statusCode).toBe(404);
  });
});

describe('GET /portal/reports', () => {
  test('lists only files the accountant can see, with status counts', async () => {
    db.query.mockImplementation(sqlRouter(routes({ accountant: accountantRow({ access: [{ groupId: G, qboIds: [MGMT] }] }) })));
    const res = await handler(apiEvent({ resource: '/api/controller/portal/reports' }));
    expect(res.statusCode).toBe(200);
    const body = parseBody(res);
    expect(body.reports.map((r) => r.reportNumber)).toEqual(['MGMT-2026-10-AJE-001']);
    expect(body.reports[0].counts).toEqual({ notWorked: 1, booked: 0, declined: 0, bookedUnconfirmed: 0, openQuestions: 0 });
    expect(body.accountant).toEqual({ fullName: 'Casey CPA', firm: 'Firm LLP' });
  });

  test('a groupId filter outside their access is refused', async () => {
    db.query.mockImplementation(sqlRouter(routes()));
    const res = await handler(apiEvent({ resource: '/api/controller/portal/reports', query: { groupId: '99999999-9999-4999-8999-999999999999' } }));
    expect(res.statusCode).toBe(403);
  });
});

describe('GET /portal/reports/{reportId}', () => {
  test('entries with status and thread; no storage keys, Drive paths or decision ids; the view is logged', async () => {
    db.query.mockImplementation(sqlRouter(routes({
      statuses: [{ entryid: ENTRY, status: 'Booked', reason: null, setbyname: 'Casey CPA', setat: '2026-11-27' }],
      threads: [{ entryid: ENTRY, comments: '1', lastat: '2026-11-27', lastrole: 'Accountant' }],
    })));
    const res = await handler(reportEvent());
    expect(res.statusCode).toBe(200);
    const body = parseBody(res);
    const e = body.entries[0];
    expect(e.portal).toMatchObject({ status: 'Booked', statusLabel: 'Booked', questionOpen: true, comments: 1 });
    expect(e.support).toEqual([{ savedId: SAVED, fileName: 'inv.pdf', title: 'Invoice', source: 'Gmail', sizeBytes: 10, savedAt: '2026-11-01' }]);
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/s3Key|drivePath|Controller Evidence|decisionId|fingerprint|publishedBy/);
    expect(sqlOf(db.query).some((s) => /INSERT INTO CtrlAuditLog/.test(s))).toBe(true);
    const audit = db.query.mock.calls.find(([s]) => /INSERT INTO CtrlAuditLog/.test(s))[1];
    expect(audit).toEqual(expect.arrayContaining([G, USER, 'portal.report.view']));
  });
});

describe('PUT /portal/entries/{entryId}/status', () => {
  test('Booked is recorded with who and when, and logged', async () => {
    db.query.mockImplementation(sqlRouter(routes()));
    const res = await handler(statusEvent({ status: 'Booked' }));
    expect(res.statusCode).toBe(200);
    expect(parseBody(res)).toMatchObject({ changed: true, status: 'Booked', setBy: 'Casey CPA' });
    const insert = db.query.mock.calls.find(([s]) => /INSERT INTO CtrlAjeEntryStatus/.test(s))[1];
    expect(insert).toEqual([ENTRY, REPORT, G, 'Booked', null, USER, 'Casey CPA']);
    expect(db.query.mock.calls.find(([s]) => /INSERT INTO CtrlAuditLog/.test(s))[1]).toEqual(expect.arrayContaining(['portal.entry.status']));
  });

  test('Declined needs a reason', async () => {
    db.query.mockImplementation(sqlRouter(routes()));
    const res = await handler(statusEvent({ status: 'Declined', reason: '  ' }));
    expect(res.statusCode).toBe(400);
    expect(sqlOf(db.query).some((s) => /INSERT INTO CtrlAjeEntryStatus/.test(s))).toBe(false);
  });

  test('an unknown status is refused', async () => {
    db.query.mockImplementation(sqlRouter(routes()));
    expect((await handler(statusEvent({ status: 'Posted' }))).statusCode).toBe(400);
  });

  test('a superseded report is read-only', async () => {
    db.query.mockImplementation(sqlRouter(routes({ reportRow: { ...REPORT_ROW, status: 'Superseded' } })));
    expect((await handler(statusEvent({ status: 'Booked' }))).statusCode).toBe(409);
  });

  test('setting the same status again changes nothing', async () => {
    db.query.mockImplementation(sqlRouter(routes({ statuses: [{ entryid: ENTRY, status: 'Booked', reason: null, setbyname: 'Casey CPA', setat: '2026-11-27' }] })));
    const res = await handler(statusEvent({ status: 'Booked' }));
    expect(parseBody(res).changed).toBe(false);
    expect(sqlOf(db.query).some((s) => /INSERT INTO CtrlAjeEntryStatus/.test(s))).toBe(false);
  });
});

describe('POST /portal/entries/{entryId}/comments', () => {
  const commentEvent = (body) => apiEvent({ method: 'POST', resource: '/api/controller/portal/entries/{entryId}/comments', path: { entryId: ENTRY }, body });

  test('a question is saved as the accountant and, with email on, queued to the controller', async () => {
    db.query.mockImplementation(sqlRouter(routes({ notify: { emailenabled: true, controlleremail: 'paul@apohco.com', adminemail: 'admin@apohco.com' } })));
    const res = await handler(commentEvent({ body: 'Which class is right for the Kroger charge?' }));
    expect(res.statusCode).toBe(201);
    expect(db.query.mock.calls.find(([s]) => /INSERT INTO CtrlAjeComments/.test(s))[1]).toEqual([ENTRY, REPORT, G, USER, 'Casey CPA', 'Accountant', 'Which class is right for the Kroger charge?']);
    const queued = db.query.mock.calls.find(([s]) => /INSERT INTO CtrlNotifications/.test(s))[1];
    expect(queued).toEqual([G, 'Question', 'paul@apohco.com', expect.stringContaining('MGMT-2026-10-AJE-001.01'), expect.stringContaining('Kroger charge')]);
  });

  test('with email off nothing is queued', async () => {
    db.query.mockImplementation(sqlRouter(routes()));
    expect((await handler(commentEvent({ body: 'Question' }))).statusCode).toBe(201);
    expect(sqlOf(db.query).some((s) => /INSERT INTO CtrlNotifications/.test(s))).toBe(false);
  });

  test('a notification failure never loses the comment', async () => {
    db.query.mockImplementation(sqlRouter(routes({ extra: [[/FROM Groups grp\s+LEFT JOIN CtrlNotifySettings/, () => { throw new Error('boom'); }]] })));
    expect((await handler(commentEvent({ body: 'Question' }))).statusCode).toBe(201);
    expect(sqlOf(db.query)).toContain('ROLLBACK TO SAVEPOINT ctrl_notify');
  });

  test('an empty comment is refused', async () => {
    db.query.mockImplementation(sqlRouter(routes()));
    expect((await handler(commentEvent({ body: '   ' }))).statusCode).toBe(400);
  });
});

describe('support documents and exports', () => {
  test('a support PDF of the report opens through a 5-minute inline link, logged', async () => {
    db.query.mockImplementation(sqlRouter(routes()));
    const res = await handler(apiEvent({ resource: '/api/controller/portal/reports/{reportId}/docs/{savedId}', path: { reportId: REPORT, savedId: SAVED } }));
    expect(res.statusCode).toBe(200);
    expect(parseBody(res)).toEqual({ url: 'https://signed.example/doc', fileName: 'inv.pdf', expiresInSeconds: 300 });
    const get = s3.GetObjectCommand.mock.calls[0][0];
    expect(get).toMatchObject({ Bucket: 'evidence-bucket', Key: SUPPORT_ROW.s3key });
    expect(get.ResponseContentDisposition).toMatch(/^inline;/);
    expect(getSignedUrl.mock.calls[0][2]).toEqual({ expiresIn: 300 });
    expect(db.query.mock.calls.find(([s]) => /INSERT INTO CtrlAuditLog/.test(s))[1]).toEqual(expect.arrayContaining(['portal.doc.view']));
  });

  test('a document that is not support for that report is not found', async () => {
    db.query.mockImplementation(sqlRouter(routes()));
    const other = '88888888-8888-4888-8888-888888888888';
    const res = await handler(apiEvent({ resource: '/api/controller/portal/reports/{reportId}/docs/{savedId}', path: { reportId: REPORT, savedId: other } }));
    expect(res.statusCode).toBe(404);
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  test('Excel export: the accountant copy leaves out Drive paths', async () => {
    db.query.mockImplementation(sqlRouter(routes()));
    const res = await handler(apiEvent({ method: 'POST', resource: '/api/controller/portal/reports/{reportId}/export', path: { reportId: REPORT }, body: { format: 'xlsx' } }));
    expect(res.statusCode).toBe(200);
    expect(parseBody(res)).toMatchObject({ url: 'https://signed.example/doc', expiresInSeconds: 300 });
    expect(parseBody(res).bytes).toBeUndefined();
    const put = s3.PutObjectCommand.mock.calls[0][0];
    expect(put.Key).toMatch(new RegExp(`^aje-exports/${G}/${REPORT}/`));
    const XLSX = require('xlsx');
    const wb = XLSX.read(put.Body, { type: 'buffer' });
    expect(JSON.stringify(XLSX.utils.sheet_to_json(wb.Sheets.Support, { header: 1 }))).not.toMatch(/Controller Evidence/);
  });
});
