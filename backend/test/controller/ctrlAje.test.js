jest.mock('../../src/shared/verifyToken', () => ({ requireAuth: jest.fn() }));
jest.mock('../../src/shared/db', () => ({ query: jest.fn(), withTransaction: jest.fn() }));
jest.mock('@aws-sdk/client-s3', () => {
  const send = jest.fn();
  return {
    __send: send,
    S3Client: jest.fn(() => ({ send })),
    PutObjectCommand: jest.fn((input) => ({ type: 'put', input })),
    GetObjectCommand: jest.fn((input) => ({ type: 'get', input })),
  };
});
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn(async () => 'https://signed.example/export') }));

const { requireAuth } = require('../../src/shared/verifyToken');
const db = require('../../src/shared/db');
const s3 = require('@aws-sdk/client-s3');
const { handler } = require('../../src/functions/controller/ctrlAje');
const { checkSnapshotPostings } = require('../../src/shared/ajeData');
const { CONTROLLER_ADMIN, PLAIN_ADMIN, OWNER, sqlRouter, apiEvent, parseBody, sqlOf } = require('../helpers');

const G = '11111111-1111-4111-8111-111111111111';
const MGMT = '22222222-2222-4222-8222-222222222222';
const WPD = '33333333-3333-4333-8333-333333333333';
const REPORT = '44444444-4444-4444-8444-444444444444';

const ENTITY_ROWS = [
  { entityid: 'ent-leb', entityname: 'Lebanon', managementqboclassid: 'c-leb', managementclassname: 'Lebanon', aliases: [], keywords: [], practiceqboid: null },
  { entityid: 'ent-wpd', entityname: 'Westside', managementqboclassid: 'c-wpd', managementclassname: 'Westside', aliases: [], keywords: [], practiceqboid: WPD },
];
const FILE_ROWS = [
  { qboid: MGMT, qboname: 'APOHCO Management', isclassbased: true, filecode: null },
  { qboid: WPD, qboname: 'Westside Pediatric Dentistry', isclassbased: false, filecode: null },
];

const glLine = (over) => ({
  lineid: `line-${over.fingerprint}`, qboid: MGMT, txndate: '2026-10-05', txntype: 'Expense', docnum: null, payeename: 'Kroger', payeekey: 'kroger',
  memo: 'groceries', accountcode: '6100', accountname: 'Supplies', classname: 'Unclassified', qboclassid: null, debit: '100.00', credit: '0.00',
  decisionid: `dec-${over.fingerprint}`, action: 'Reassign', decisionentityid: 'ent-leb', allocations: null, counterpartyentityid: null,
  targetaccountcode: null, targetaccountname: null, scope: 'Line', requestaje: true, ...over,
});

function routes({ ownLines = [], mirrorLines = [], active = [], prior = [], support = [], fileCode = null, extra = [] } = {}) {
  return [
    ...extra,
    [/pg_advisory_xact_lock/, { rows: [] }],
    [/FROM CtrlEntities e LEFT JOIN QBOClasses/, { rows: ENTITY_ROWS }],
    [/WHERE q.QBOId = \$1 AND q.GroupId = \$2/, (sql, [qboId]) => ({ rows: FILE_ROWS.filter((f) => f.qboid === qboId).map((f) => ({ ...f, filecode: f.qboid === MGMT ? fileCode : null })) })],
    [/WHERE q.GroupId = \$1 ORDER BY q.IsClassBased/, { rows: FILE_ROWS.map((f) => ({ ...f, filecode: f.qboid === MGMT ? fileCode : null })) }],
    [/FROM CtrlAjeSettings/, { rows: [] }],
    [/SELECT ReportId, ReportNumber, Seq, PublishedAt FROM CtrlAjeReports/, { rows: active }],
    [/FROM CtrlAjeEntrySources s JOIN CtrlAjeReports r/, { rows: prior }],
    [/FROM CtrlVendorAliases a JOIN CtrlVendors/, { rows: [{ payeekey: 'kroger', vendorid: 'v-kroger', displayname: 'Kroger' }] }],
    [/WITH snap AS/, { rows: ownLines }],
    [/WITH snaps AS \(\s+SELECT DISTINCT ON \(QBOId\) SnapshotId/, { rows: mirrorLines }],
    [/FROM CtrlDueToFromAccounts/, { rows: [{ counterpartyentityid: 'ent-leb', accountcode: '2510', accountname: 'Due To Lebanon' }] }],
    [/FROM ChartOfAccountsMappings WHERE GroupId/, { rows: [{ accountcode: '6100', accountname: 'Supplies' }] }],
    [/FROM CtrlEvidenceSaved s\s+JOIN UNNEST/, { rows: support }],
  ];
}

const draftEvent = (qs) => apiEvent({ resource: '/api/controller/aje/draft', query: { groupId: G, qboId: MGMT, month: '2026-10', ...qs } });

beforeEach(() => {
  requireAuth.mockResolvedValue(CONTROLLER_ADMIN);
  db.withTransaction.mockImplementation(async (fn) => fn({ query: db.query }));
  process.env.EVIDENCE_BUCKET = 'evidence-bucket';
});

describe('access', () => {
  test.each([['a SoftwareAdmin outside ControllerOwner', PLAIN_ADMIN], ['a practice Owner', OWNER]])('%s is refused', async (_, claims) => {
    requireAuth.mockResolvedValue(claims);
    db.query.mockImplementation(sqlRouter(routes()));
    const res = await handler(draftEvent());
    expect(res.statusCode).toBe(403);
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('GET /aje/draft', () => {
  test('groups the same vendor and move into one entry, with backup and saved support', async () => {
    db.query.mockImplementation(sqlRouter(routes({
      ownLines: [glLine({ fingerprint: 'f1' }), glLine({ fingerprint: 'f2', debit: '50.00', txndate: '2026-10-09' })],
      support: [{ savedid: 'sv1', qboid: MGMT, fingerprint: 'f1', source: 'Gmail', title: 'Invoice', filename: 'inv.pdf', sizebytes: '1000', s3key: 'k', drivepath: null, savedat: '2026-11-01' }],
    })));
    const res = await handler(draftEvent());
    expect(res.statusCode).toBe(200);
    const body = parseBody(res);
    expect(body.file).toMatchObject({ fileCode: 'MGMT', codeSaved: false });
    expect(body.grouping).toBe('Grouped');
    expect(body.entryDate).toBe('2026-10-31');
    expect(body.entries).toHaveLength(1);
    const [e] = body.entries;
    expect(e).toMatchObject({ kind: 'ClassMove', vendor: 'Kroger', amount: 150, issues: [] });
    expect(e.sources.map((s) => s.fingerprint)).toEqual(['f1', 'f2']);
    expect(e.support).toEqual([{ savedId: 'sv1', source: 'Gmail', title: 'Invoice', fileName: 'inv.pdf', sizeBytes: 1000, drivePath: null, savedAt: '2026-11-01' }]);
  });

  test('per line, on request', async () => {
    db.query.mockImplementation(sqlRouter(routes({ ownLines: [glLine({ fingerprint: 'f1' }), glLine({ fingerprint: 'f2' })] })));
    const body = parseBody(await handler(draftEvent({ grouping: 'PerLine' })));
    expect(body.entries).toHaveLength(2);
  });

  test('a relabel without "request AJE" and a line already covered are left out', async () => {
    db.query.mockImplementation(sqlRouter(routes({
      ownLines: [glLine({ fingerprint: 'f1', scope: 'Relabel', requestaje: false }), glLine({ fingerprint: 'f2' })],
      active: [{ reportid: REPORT, reportnumber: 'MGMT-2026-10-AJE-001', seq: 1 }],
      prior: [{ side: 'Own', sourceqboid: MGMT, fingerprint: 'f2', tostate: [{ code: '6100', name: 'Supplies', className: 'Lebanon', amount: 100 }] }],
    })));
    const body = parseBody(await handler(draftEvent()));
    expect(body.entries).toEqual([]);
    expect(body.activeReports).toEqual([{ reportId: REPORT, reportNumber: 'MGMT-2026-10-AJE-001' }]);
  });

  test("the practice file gets the other side of another file's Due To/From decision", async () => {
    db.query.mockImplementation(sqlRouter(routes({
      mirrorLines: [glLine({
        fingerprint: 'm1', qboid: MGMT, classname: 'Westside', action: 'DueToFrom', decisionentityid: null, counterpartyentityid: 'ent-wpd',
        targetaccountcode: '1510', targetaccountname: 'Due From Westside',
      })],
    })));
    const res = await handler(draftEvent({ qboId: WPD }));
    const body = parseBody(res);
    expect(body.file.fileCode).toBe('WPD');
    expect(body.entries).toHaveLength(1);
    const [e] = body.entries;
    expect(e.kind).toBe('DueToFromMirror');
    // The management file has no owning entity, so its Due To account can't be found.
    expect(e.issues[0]).toMatch(/not linked to an entity/);
    const mirrorSql = db.query.mock.calls.find(([sql]) => /SELECT DISTINCT ON \(QBOId\) SnapshotId/.test(sql));
    expect(mirrorSql[1]).toEqual([G, WPD, '2026-10-01', 'ent-wpd', []]);
  });

  test('bad month and unknown file', async () => {
    db.query.mockImplementation(sqlRouter(routes()));
    expect((await handler(draftEvent({ month: '2026-13' }))).statusCode).toBe(400);
    expect((await handler(draftEvent({ qboId: '55555555-5555-4555-8555-555555555555' }))).statusCode).toBe(404);
  });
});

describe('POST /aje/reports (publish)', () => {
  const lines = [glLine({ fingerprint: 'f1' }), glLine({ fingerprint: 'f2', payeename: 'Amazon', payeekey: 'amazon', debit: '20.00' })];
  const publish = (body) => handler(apiEvent({ method: 'POST', resource: '/api/controller/aje/reports', body: { groupId: G, qboId: MGMT, month: '2026-10', grouping: 'Grouped', ...body } }));

  async function draftKeys(extraRoutes = {}) {
    db.query.mockImplementation(sqlRouter(routes({ ownLines: lines, ...extraRoutes })));
    return parseBody(await handler(draftEvent())).entries.map((e) => e.key);
  }

  test('numbers the report and its entries, saves the file code, keeps the backup', async () => {
    const keys = await draftKeys();
    const inserted = {};
    db.query.mockImplementation(sqlRouter(routes({
      ownLines: lines,
      extra: [
        [/COALESCE\(MAX\(Seq\), 0\) \+ 1/, { rows: [{ seq: 1 }] }],
        [/INSERT INTO CtrlAjeReports/, (sql, params) => { inserted.report = params; return { rows: [{ reportid: REPORT, publishedat: new Date() }] }; }],
        [/INSERT INTO CtrlAjeEntries/, (sql, params) => { inserted.entries = params; return { rows: [{ entryid: 'e1', seq: 1 }] }; }],
        [/INSERT INTO CtrlAjeEntrySources/, (sql, params) => { inserted.sources = params; return { rows: [] }; }],
        [/SELECT 1 FROM CtrlAjeFileSettings/, { rows: [] }],
      ],
    })));
    // Only the Amazon entry (keys are in draft order: Amazon before Kroger).
    const res = await publish({ expectedKeys: keys, include: [{ key: keys[0], memo: 'Breakroom supplies to Lebanon' }] });
    expect(res.statusCode).toBe(201);
    expect(parseBody(res)).toMatchObject({ reportId: REPORT, reportNumber: 'MGMT-2026-10-AJE-001', entryCount: 1, totalAmount: 20, leftOut: 1 });
    expect(inserted.report.slice(3, 7)).toEqual(['MGMT', 1, 'MGMT-2026-10-AJE-001', 'Grouped']);
    expect(inserted.entries.slice(4, 10)).toEqual(['MGMT-2026-10-AJE-001.01', 'MGMT-2610-AJE001.01', 'ClassMove', '2026-10-31', 'Amazon', 'MGMT-2026-10-AJE-001.01 Breakroom supplies to Lebanon']);
    expect(inserted.sources).toContain('f2');
    const sqls = sqlOf(db.query);
    expect(sqls.some((s) => /INSERT INTO CtrlAjeFileSettings/.test(s))).toBe(true);
    expect(sqls.some((s) => /INSERT INTO CtrlAuditLog/.test(s))).toBe(true);
    expect(sqls.some((s) => /UPDATE CtrlAjeReports/.test(s))).toBe(false);
  });

  test('refuses when the draft changed since it was shown', async () => {
    const keys = await draftKeys();
    db.query.mockImplementation(sqlRouter(routes({ ownLines: lines.slice(0, 1) })));
    const res = await publish({ expectedKeys: keys, include: [{ key: keys[0] }] });
    expect(res.statusCode).toBe(409);
  });

  test('refuses an entry with an open problem', async () => {
    const bad = [glLine({ fingerprint: 'f1', decisionentityid: 'gone' })];
    db.query.mockImplementation(sqlRouter(routes({ ownLines: bad })));
    const keys = parseBody(await handler(draftEvent())).entries.map((e) => e.key);
    const res = await publish({ expectedKeys: keys, include: [{ key: keys[0] }] });
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).message).toMatch(/can't be published/);
  });

  test('a revision takes the next number and supersedes the latest report', async () => {
    const active = [{ reportid: REPORT, reportnumber: 'MGMT-2026-10-AJE-001', seq: 1 }];
    const keys = await draftKeys({ active, fileCode: 'MGMT' });
    db.query.mockImplementation(sqlRouter(routes({
      ownLines: lines, active, fileCode: 'MGMT',
      extra: [
        [/COALESCE\(MAX\(Seq\), 0\) \+ 1/, { rows: [{ seq: 2 }] }],
        [/INSERT INTO CtrlAjeReports/, { rows: [{ reportid: 'new-report', publishedat: new Date() }] }],
        [/INSERT INTO CtrlAjeEntries/, { rows: [{ entryid: 'e1', seq: 1 }, { entryid: 'e2', seq: 2 }] }],
      ],
    })));
    const res = await publish({ expectedKeys: keys, include: keys.map((key) => ({ key })), reviseReportId: REPORT });
    expect(res.statusCode).toBe(201);
    expect(parseBody(res)).toMatchObject({ reportNumber: 'MGMT-2026-10-AJE-002', supersedes: 'MGMT-2026-10-AJE-001' });
    const upd = db.query.mock.calls.find(([sql]) => /UPDATE CtrlAjeReports SET Status = 'Superseded'/.test(sql));
    expect(upd[1]).toEqual([REPORT, 'new-report', G]);
    // The prior states exclude the report being revised.
    const prior = db.query.mock.calls.filter(([sql]) => /FROM CtrlAjeEntrySources s JOIN CtrlAjeReports r/.test(sql)).pop();
    expect(prior[1][3]).toBe(REPORT);
    expect(sqlOf(db.query).some((s) => /INSERT INTO CtrlAjeFileSettings/.test(s))).toBe(false);
  });

  test('only the latest report in force can be revised', async () => {
    db.query.mockImplementation(sqlRouter(routes({
      ownLines: lines,
      active: [{ reportid: 'newer', reportnumber: 'MGMT-2026-10-AJE-002', seq: 2 }, { reportid: REPORT, reportnumber: 'MGMT-2026-10-AJE-001', seq: 1 }],
    })));
    const res = await handler(draftEvent({ reviseReportId: REPORT }));
    expect(res.statusCode).toBe(409);
    expect(parseBody(res).message).toMatch(/MGMT-2026-10-AJE-002/);
  });
});

describe('PUT /aje/settings', () => {
  const put = (body) => handler(apiEvent({ method: 'PUT', resource: '/api/controller/aje/settings', body: { groupId: G, ...body } }));

  test('validates codes', async () => {
    db.query.mockImplementation(sqlRouter(routes()));
    expect((await put({ files: [{ qboId: MGMT, fileCode: 'm' }] })).statusCode).toBe(400);
    expect((await put({ files: [{ qboId: MGMT, fileCode: 'ABC' }, { qboId: WPD, fileCode: 'abc' }] })).statusCode).toBe(400);
    expect((await put({ defaultGrouping: 'Weekly' })).statusCode).toBe(400);
  });

  test('saves codes (upper-cased) and the default grouping', async () => {
    db.query.mockImplementation(sqlRouter(routes({ extra: [[/SELECT QBOId FROM QBOs WHERE GroupId/, { rows: [{ qboid: MGMT }] }]] })));
    const res = await put({ files: [{ qboId: MGMT, fileCode: 'apo' }], defaultGrouping: 'PerLine' });
    expect(res.statusCode).toBe(200);
    const ins = db.query.mock.calls.find(([sql]) => /INSERT INTO CtrlAjeFileSettings/.test(sql));
    expect(ins[1]).toEqual([MGMT, G, 'APO', CONTROLLER_ADMIN.userId]);
    expect(sqlOf(db.query).some((s) => /INSERT INTO CtrlAjeSettings/.test(s))).toBe(true);
  });
});

const REPORT_ROW = {
  reportid: REPORT, qboid: MGMT, qboname: 'APOHCO Management', month: '2026-10', filecode: 'MGMT', seq: 1, reportnumber: 'MGMT-2026-10-AJE-001',
  grouping: 'Grouped', status: 'Published', supersedesnumber: null, supersededbynumber: null, entrycount: 1, totalamount: '150.00', note: null,
  publishedat: new Date('2026-11-20T12:00:00Z'), publishedby: 'paul', postedcount: '1',
};
const ENTRY_ROW = {
  entryid: 'e1', seq: 1, entrynumber: 'MGMT-2026-10-AJE-001.01', qbonum: 'MGMT-2610-AJE001.01', kind: 'ClassMove', entrydate: '2026-10-31', vendor: 'Kroger',
  memo: 'MGMT-2026-10-AJE-001.01 Class change', amount: '150.00', warnings: [],
  lines: [{ accountCode: '6100', accountName: 'Supplies', className: 'Lebanon', debit: 150, credit: 0 }, { accountCode: '6100', accountName: 'Supplies', className: 'Unclassified', debit: 0, credit: 150 }],
  postedseenat: new Date('2026-11-25T00:00:00Z'), posteddocnum: 'MGMT-2610-AJE001.01', postedmatchedon: 'Entry', postedmonth: '2026-10',
};
const SOURCE_ROW = {
  entryid: 'e1', side: 'Own', sourceqboid: MGMT, fingerprint: 'f1', lineid: 'l1', txndate: '2026-10-05', txntype: 'Expense', docnum: null, payeename: 'Kroger',
  memo: 'groceries', accountcode: '6100', accountname: 'Supplies', classname: 'Unclassified', amount: '150.00',
  fromstate: [{ code: '6100', name: 'Supplies', className: 'Unclassified', amount: 150 }], tostate: [{ code: '6100', name: 'Supplies', className: 'Lebanon', amount: 150 }],
};
const reportRoutes = (extra = []) => [
  ...extra,
  [/FROM CtrlAjeReports r\s+JOIN QBOs q/, { rows: [REPORT_ROW] }],
  [/FROM CtrlAjeEntries e/, { rows: [ENTRY_ROW] }],
  [/FROM CtrlAjeEntrySources WHERE ReportId/, { rows: [SOURCE_ROW] }],
  [/FROM CtrlEvidenceSaved s\s+JOIN UNNEST/, { rows: [{ savedid: 'sv1', qboid: MGMT, fingerprint: 'f1', source: 'Drive', title: 'Invoice', filename: 'inv.pdf', sizebytes: '10', s3key: 'g/k/inv.pdf', drivepath: null, savedat: '2026-11-01' }] }],
];

describe('GET /aje/reports/{reportId}', () => {
  test('entries with backup, support and the posted-check', async () => {
    db.query.mockImplementation(sqlRouter(reportRoutes()));
    const res = await handler(apiEvent({ resource: '/api/controller/aje/reports/{reportId}', query: { groupId: G }, path: { reportId: REPORT } }));
    expect(res.statusCode).toBe(200);
    const body = parseBody(res);
    expect(body).toMatchObject({ reportNumber: 'MGMT-2026-10-AJE-001', postedCount: 1, totalAmount: 150 });
    expect(body.entries[0]).toMatchObject({ kindLabel: 'Class change', posted: { docNum: 'MGMT-2610-AJE001.01', month: '2026-10' } });
    expect(body.entries[0].sources[0].to[0].className).toBe('Lebanon');
    expect(body.entries[0].support[0]).toMatchObject({ savedId: 'sv1', fileName: 'inv.pdf' });
    // Every query is scoped to the Group.
    for (const [, params] of db.query.mock.calls) expect(params).toContain(G);
  });

  test('another Group\'s report is not found', async () => {
    db.query.mockImplementation(sqlRouter([]));
    const res = await handler(apiEvent({ resource: '/api/controller/aje/reports/{reportId}', query: { groupId: G }, path: { reportId: REPORT } }));
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /aje/reports/{reportId}/export', () => {
  const exportEvent = (body) => apiEvent({ method: 'POST', resource: '/api/controller/aje/reports/{reportId}/export', path: { reportId: REPORT }, body: { groupId: G, ...body } });

  test('Excel: written to aje-exports/ and handed out as a short link', async () => {
    db.query.mockImplementation(sqlRouter(reportRoutes()));
    s3.__send.mockResolvedValue({});
    const res = await handler(exportEvent({ format: 'xlsx' }));
    expect(res.statusCode).toBe(200);
    expect(parseBody(res)).toMatchObject({ url: 'https://signed.example/export', fileName: 'MGMT-2026-10-AJE-001 APOHCO Management.xlsx', expiresInSeconds: 300 });
    const put = s3.PutObjectCommand.mock.calls[0][0];
    expect(put.Key).toMatch(new RegExp(`^aje-exports/${G}/${REPORT}/`));
    expect(put.ServerSideEncryption).toBe('AES256');
  });

  test('PDF: appends saved support read from the bucket', async () => {
    const { PDFDocument } = require('pdf-lib');
    const supportDoc = await PDFDocument.create();
    supportDoc.addPage([300, 300]);
    const supportBytes = Buffer.from(await supportDoc.save());
    db.query.mockImplementation(sqlRouter(reportRoutes([
      [/SELECT SavedId, S3Key, FileName, SizeBytes FROM CtrlEvidenceSaved/, { rows: [{ savedid: 'sv1', s3key: 'g/k/inv.pdf', filename: 'inv.pdf', sizebytes: '10' }] }],
    ])));
    s3.__send.mockImplementation(async (cmd) => (cmd.type === 'get' ? { Body: [supportBytes] } : {}));
    const res = await handler(exportEvent({ format: 'pdf' }));
    expect(res.statusCode).toBe(200);
    expect(parseBody(res).supportIncluded).toBe(1);
    const put = s3.PutObjectCommand.mock.calls.pop()[0];
    const out = await PDFDocument.load(put.Body);
    // Report page + divider + the support page.
    expect(out.getPageCount()).toBe(3);
  });

  test('unknown format', async () => {
    db.query.mockImplementation(sqlRouter(reportRoutes()));
    expect((await handler(exportEvent({ format: 'csv' }))).statusCode).toBe(400);
  });
});

describe('posted-check', () => {
  test('records entries whose number appears in a stored GL', async () => {
    const q = sqlRouter([
      [/FROM CtrlAjeReports r JOIN CtrlAjeEntries e/, { rows: [
        { reportid: REPORT, filecode: 'MGMT', month: '2026-10', reportseq: 1, entryid: 'e1', seq: 1 },
        { reportid: REPORT, filecode: 'MGMT', month: '2026-10', reportseq: 1, entryid: 'e2', seq: 2 },
      ] }],
      [/FROM CtrlLedgerLines\s+WHERE SnapshotId/, { rows: [
        { lineid: 'gl1', docnum: 'MGMT-2610-AJE001.02', memo: null },
        { lineid: 'gl2', docnum: 'MGMT-2610-AJE001.02', memo: 'MGMT-2026-10-AJE-001.02 Class change' },
      ] }],
      [/INSERT INTO CtrlAjePostings/, { rowCount: 1, rows: [] }],
    ]);
    const added = await checkSnapshotPostings({ groupId: G, qboId: MGMT, snapshotId: 'snap1' }, { query: q });
    expect(added).toBe(1);
    const ins = q.mock.calls.find(([sql]) => /INSERT INTO CtrlAjePostings/.test(sql));
    expect(ins[0]).toMatch(/ON CONFLICT \(EntryId, SnapshotId\) DO NOTHING/);
    expect(ins[1]).toEqual(['e2', G, 'snap1', 'gl1', 'MGMT-2610-AJE001.02', 'Entry']);
  });

  test('skips the GL scan when the file has no reports', async () => {
    const q = sqlRouter([]);
    expect(await checkSnapshotPostings({ groupId: G, qboId: MGMT, snapshotId: 'snap1' }, { query: q })).toBe(0);
    expect(q).toHaveBeenCalledTimes(1);
  });

  test('POST /aje/check-posted checks the latest snapshot of each month', async () => {
    db.query.mockImplementation(sqlRouter([
      [/WHERE q.QBOId = \$1 AND q.GroupId = \$2/, { rows: [FILE_ROWS[0]] }],
      [/SELECT DISTINCT ON \(s.Period\) s.SnapshotId/, { rows: [{ snapshotid: 's1' }, { snapshotid: 's2' }] }],
    ]));
    const res = await handler(apiEvent({ method: 'POST', resource: '/api/controller/aje/check-posted', body: { groupId: G, qboId: MGMT } }));
    expect(parseBody(res)).toEqual({ snapshotsChecked: 2, newlyPosted: 0 });
  });
});

describe('GET /aje (overview)', () => {
  test('files with suggested codes, months with decisions, reports', async () => {
    db.query.mockImplementation(sqlRouter([
      ...routes(),
      [/WITH dec AS \(\s+SELECT DISTINCT ON \(QBOId, Fingerprint\) QBOId, Fingerprint, LineId, Action/, { rows: [{ qboid: MGMT, month: '2026-10', decided: 12 }] }],
      [/FROM CtrlAjeReports r\s+JOIN QBOs q/, { rows: [REPORT_ROW] }],
    ]));
    const body = parseBody(await handler(apiEvent({ resource: '/api/controller/aje', query: { groupId: G } })));
    expect(body.defaultGrouping).toBe('Grouped');
    expect(body.files.map((f) => [f.qboName, f.fileCode, f.ownerEntityId])).toEqual([
      ['APOHCO Management', 'MGMT', null],
      ['Westside Pediatric Dentistry', 'WPD', 'ent-wpd'],
    ]);
    expect(body.activity).toEqual([{ qboId: MGMT, month: '2026-10', decidedLines: 12 }]);
    expect(body.reports[0]).toMatchObject({ reportNumber: 'MGMT-2026-10-AJE-001', postedCount: 1 });
  });
});
