jest.mock('../../src/shared/verifyToken', () => ({ requireAuth: jest.fn() }));
jest.mock('../../src/shared/db', () => ({ query: jest.fn(), withTransaction: jest.fn() }));

const { requireAuth } = require('../../src/shared/verifyToken');
const { query, withTransaction } = require('../../src/shared/db');
const { handler, parseFilters, buildFilterSql, validateSettings, shiftMonth } = require('../../src/functions/controller/ctrlReview');
const { CONTROLLER_ADMIN, PLAIN_ADMIN, OWNER, sqlRouter, apiEvent, parseBody, sqlOf } = require('../helpers');

const RUN_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const L1 = '11111111-1111-1111-1111-111111111111';
const L2 = '22222222-2222-2222-2222-222222222222';
const L3 = '33333333-3333-3333-3333-333333333333';
const ENTITY_ROWS = [
  { entityid: 'ent-leb', entityname: 'Lebanon', managementqboclassid: 'cls-leb', managementclassname: 'Lebanon', aliases: [], keywords: [] },
  { entityid: 'ent-mil', entityname: 'Milford', managementqboclassid: 'cls-mil', managementclassname: 'Milford', aliases: [], keywords: [] },
];
const RUN_ROW = { runid: RUN_ID, qboid: 'qbo-mgmt', month: '2026-10', snapshotid: 'snap-oct', threshold: '0.900', mediumthreshold: '0.700' };

let client;
function setup({ routes = [], clientRoutes = [] } = {}) {
  requireAuth.mockResolvedValue(CONTROLLER_ADMIN);
  query.mockImplementation(
    sqlRouter([
      ...routes,
      [/FROM CtrlReviewSettings/, { rows: [] }],
      [/FROM CtrlEntities e/, { rows: ENTITY_ROWS }],
      [/FROM CtrlReviewRuns WHERE RunId/, { rows: [RUN_ROW] }],
    ])
  );
  client = { query: sqlRouter(clientRoutes) };
  withTransaction.mockImplementation((fn) => fn(client));
}

const get = (resource, q) => handler(apiEvent({ method: 'GET', resource, query: { groupId: 'group-1', ...q } }));
const post = (resource, body) => handler(apiEvent({ method: 'POST', resource, body: { groupId: 'group-1', ...body } }));

describe('helpers', () => {
  test('shiftMonth', () => {
    expect(shiftMonth('2026-03', -12)).toBe('2025-03');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
  });

  test('validateSettings', () => {
    expect(validateSettings({ threshold: 0.9, mediumThreshold: 0.7, historyMonths: 12 })).toEqual({ threshold: 0.9, mediumThreshold: 0.7, historyMonths: 12 });
    expect(() => validateSettings({ threshold: 0.4, mediumThreshold: 0.2, historyMonths: 12 })).toThrow(/threshold/);
    expect(() => validateSettings({ threshold: 0.9, mediumThreshold: 0.95, historyMonths: 12 })).toThrow(/mediumThreshold/);
    expect(() => validateSettings({ threshold: 0.9, mediumThreshold: 0.7, historyMonths: 40 })).toThrow(/historyMonths/);
  });

  test('filters: parsed, validated, and turned into parameterized SQL', () => {
    const f = parseFilters({ status: 'Confirmed,Conflict', reviewState: 'open', accountType: 'Expense,Unknown', vendor: 'kro%', search: 'gloves' });
    const { sql, params } = buildFilterSql(f, 4);
    expect(sql).toContain('s.Status = ANY($4::text[])');
    expect(sql).toContain('d.Fingerprint IS NULL');
    expect(sql).toContain("COALESCE(m.Classification, ua.Classification, 'Unknown') = ANY($5::text[])");
    expect(params).toEqual([['Confirmed', 'Conflict'], ['Expense', 'Unknown'], '%kro\\%%', '%gloves%']);
    expect(() => parseFilters({ status: 'Bogus' })).toThrow(/status/);
    expect(() => parseFilters({ accountType: 'COGS' })).toThrow(/accountType/);
    expect(() => parseFilters({ reviewState: 'maybe' })).toThrow(/reviewState/);
  });
});

describe('access', () => {
  test.each([['Owner', OWNER], ['plain SoftwareAdmin', PLAIN_ADMIN]])('403 for %s', async (_, claims) => {
    setup();
    requireAuth.mockResolvedValue(claims);
    expect((await get('/api/controller/review/settings')).statusCode).toBe(403);
  });
});

describe('POST /api/controller/review/runs', () => {
  const runRoutes = (over = {}) => [
    [/FROM QBOs WHERE QBOId/, { rows: [{ qboid: 'qbo-mgmt', qboname: 'APOHCO', isclassbased: over.classBased ?? true }] }],
    [/FROM CtrlSnapshots WHERE GroupId/, { rows: over.noSnapshot ? [] : [{ snapshotid: 'snap-oct' }] }],
    [
      /FROM CtrlLedgerLines WHERE SnapshotId/,
      {
        rows: [
          { lineid: L1, fingerprint: 'f1', payeename: 'Kroger', memo: '', accountcode: '6100', classname: 'Milford', qboclassid: 'cls-mil' },
          { lineid: L2, fingerprint: 'f2', payeename: 'Amazon', memo: '', accountcode: '6200', classname: '', qboclassid: null },
        ],
      },
    ],
  ];
  const clientRoutes = [
    [/FROM CtrlVendorAliases WHERE GroupId/, { rows: [{ payeekey: 'kroger', vendorid: 'v-kroger' }] }],
    [/INSERT INTO CtrlVendors/, { rows: [{ vendorid: 'v-amazon', displayname: 'Amazon' }] }],
    [/FROM CtrlVendorRules/, { rows: [] }],
    // October history: 19 Kroger lines classed Lebanon.
    [/WITH snaps AS/, { rows: [{ payeename: 'KROGER', accountcode: '6100', classname: 'Lebanon', qboclassid: 'cls-leb', action: null, n: 19 }] }],
    [/INSERT INTO CtrlReviewRuns/, { rows: [{ runid: RUN_ID, rundate: 'now' }] }],
  ];

  test('classifies the month from history, creates new vendors and stores the run', async () => {
    setup({ routes: runRoutes(), clientRoutes });
    const res = await post('/api/controller/review/runs', { qboId: 'qbo-mgmt', month: '2026-10' });
    const data = parseBody(res);
    expect(res.statusCode).toBe(201);
    expect(data.statusCounts).toMatchObject({ LikelyMisclassified: 1, Unclassified: 1 });

    const history = client.query.mock.calls.find(([sql]) => /WITH snaps AS/.test(sql));
    expect(history[1]).toEqual(['group-1', 'qbo-mgmt', '2025-10-01', '2026-10-01']);

    const aliasInsert = client.query.mock.calls.find(([sql]) => /INSERT INTO CtrlVendorAliases/.test(sql));
    expect(aliasInsert[1]).toEqual(['group-1', 'v-amazon', 'amazon', 'Amazon']);

    const sugg = client.query.mock.calls.find(([sql]) => /INSERT INTO CtrlSuggestions/.test(sql))[1];
    // 12 columns per line; first line: Kroger, class Milford, history says Lebanon.
    expect(sugg.slice(0, 12)).toEqual([
      RUN_ID, 'group-1', L1, 'f1', 'v-kroger', 'ent-mil', 'ent-leb', 0.95, 'LikelyMisclassified', 'History', expect.any(String), null,
    ]);
    expect(sqlOf(client.query).some((s) => /INSERT INTO CtrlAuditLog/.test(s))).toBe(true);
  });

  test('only class-based files can be reviewed', async () => {
    setup({ routes: runRoutes({ classBased: false }), clientRoutes });
    const res = await post('/api/controller/review/runs', { qboId: 'qbo-mgmt', month: '2026-10' });
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).message).toMatch(/doesn't use classes/);
  });

  test('needs a stored month', async () => {
    setup({ routes: runRoutes({ noSnapshot: true }), clientRoutes });
    expect((await post('/api/controller/review/runs', { qboId: 'qbo-mgmt', month: '2026-10' })).statusCode).toBe(404);
  });
});

describe('GET /api/controller/review/lines', () => {
  const lineRow = {
    lineid: L1, fingerprint: 'f1', vendorid: 'v-kroger', currententityid: 'ent-mil', suggestedentityid: 'ent-leb', confidence: '0.9500',
    status: 'LikelyMisclassified', source: 'History', reasons: ['History: ...'], txndate: '2026-10-03', payeename: 'Kroger',
    vendorname: 'Kroger', watchmode: false, accounttype: 'Expense', debit: '42.10', credit: '0', amount: '42.10',
    decisionaction: 'Reassign', decisionentityid: 'ent-leb', allocations: null, decidedat: 'd',
  };

  test('returns the page, a per-status summary and the filtered total', async () => {
    setup({
      routes: [
        [/GROUP BY s.Status/, { rows: [{ status: 'LikelyMisclassified', decided: true, n: 1, amount: '42.10' }, { status: 'Confirmed', decided: false, n: 5, amount: '100' }] }],
        [/SELECT COUNT\(\*\)::int AS n, COALESCE/, { rows: [{ n: 1, amount: '42.10' }] }],
        [/ORDER BY CASE s.Status/, { rows: [lineRow] }],
      ],
    });
    const res = await get('/api/controller/review/lines', { runId: RUN_ID, accountType: 'Expense' });
    const data = parseBody(res);
    expect(res.statusCode).toBe(200);
    expect(data.summary.LikelyMisclassified).toEqual({ count: 1, open: 0, amount: 42.1 });
    expect(data.summary.Confirmed).toEqual({ count: 5, open: 5, amount: 100 });
    expect(data.total).toBe(1);
    expect(data.lines[0]).toMatchObject({ lineId: L1, confidence: 0.95, amount: 42.1, decision: { action: 'Reassign', entityId: 'ent-leb' } });
    expect(data.entities).toHaveLength(2);
    // Every queue query is scoped to the Group and the run.
    const queueCalls = query.mock.calls.filter(([sql]) => /FROM CtrlSuggestions s/.test(sql));
    expect(queueCalls.every(([, params]) => params[0] === 'group-1' && params[1] === RUN_ID)).toBe(true);
  });

  test('a run from another Group is not found', async () => {
    setup({ routes: [[/FROM CtrlReviewRuns WHERE RunId/, { rows: [] }]] });
    expect((await get('/api/controller/review/lines', { runId: RUN_ID })).statusCode).toBe(404);
  });
});

describe('POST /api/controller/review/decisions', () => {
  const candidates = [
    { lineid: L1, fingerprint: 'f1', currententityid: 'ent-mil', suggestedentityid: 'ent-leb', amount: '100.00', watchmode: false, decided: false },
    { lineid: L2, fingerprint: 'f2', currententityid: null, suggestedentityid: null, amount: '5.00', watchmode: false, decided: false },
    { lineid: L3, fingerprint: 'f3', currententityid: 'ent-leb', suggestedentityid: 'ent-leb', amount: '7.00', watchmode: true, decided: false },
    { lineid: '44444444-4444-4444-4444-444444444444', fingerprint: 'f4', currententityid: 'ent-leb', suggestedentityid: 'ent-leb', amount: '1', watchmode: false, decided: true },
  ];
  const decisionsInsert = () => client.query.mock.calls.find(([sql]) => /INSERT INTO CtrlDecisions/.test(sql));

  test('bulk approve by filter skips decided lines, watch-mode vendors and lines with nothing to approve', async () => {
    setup({ routes: [[/FROM CtrlSuggestions s/, { rows: candidates }]] });
    const res = await post('/api/controller/review/decisions', {
      runId: RUN_ID, action: 'Approve', filter: { status: 'Confirmed,LikelyMisclassified,Unclassified' }, expectedCount: 4,
    });
    expect(parseBody(res)).toEqual({ decided: 1, skipped: { alreadyDecided: 1, watchMode: 1, nothingToApply: 1 } });
    const params = decisionsInsert()[1];
    expect(params).toEqual(['group-1', 'qbo-mgmt', 'f1', L1, RUN_ID, 'Approve', 'ent-leb', null, null, 'user-paul']);
  });

  test('bulk by filter stops if the matching lines changed since the user looked', async () => {
    setup({ routes: [[/FROM CtrlSuggestions s/, { rows: candidates }]] });
    const res = await post('/api/controller/review/decisions', { runId: RUN_ID, action: 'Approve', filter: {}, expectedCount: 3 });
    expect(res.statusCode).toBe(409);
    expect(withTransaction).not.toHaveBeenCalled();
  });

  test('a single line can be re-decided, including a watch-mode one', async () => {
    setup({ routes: [[/FROM CtrlSuggestions s/, { rows: [{ ...candidates[2], decided: true }] }]] });
    const res = await post('/api/controller/review/decisions', { runId: RUN_ID, action: 'Reassign', entityId: 'ent-mil', lineIds: [L3], note: ' wrong store ' });
    expect(parseBody(res).decided).toBe(1);
    expect(decisionsInsert()[1]).toEqual(['group-1', 'qbo-mgmt', 'f3', L3, RUN_ID, 'Reassign', 'ent-mil', null, 'wrong store', 'user-paul']);
  });

  test('split stores allocations that add up to the line amount', async () => {
    setup({ routes: [[/FROM CtrlSuggestions s/, { rows: [candidates[0]] }]] });
    const allocations = [{ entityId: 'ent-leb', amount: 60 }, { entityId: 'ent-mil', amount: 40 }];
    const res = await post('/api/controller/review/decisions', { runId: RUN_ID, action: 'Split', lineIds: [L1], allocations });
    expect(res.statusCode).toBe(200);
    const params = decisionsInsert()[1];
    expect(params[5]).toBe('Split');
    expect(JSON.parse(params[7])).toEqual(allocations);
  });

  test('a split that does not add up is refused', async () => {
    setup({ routes: [[/FROM CtrlSuggestions s/, { rows: [candidates[0]] }]] });
    const res = await post('/api/controller/review/decisions', {
      runId: RUN_ID, action: 'Split', lineIds: [L1], allocations: [{ entityId: 'ent-leb', amount: 60 }, { entityId: 'ent-mil', amount: 30 }],
    });
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).message).toMatch(/add up to 100.00/);
  });

  test('validation: actions, reassign target, split and undo scope', async () => {
    setup({ routes: [[/FROM CtrlSuggestions s/, { rows: [candidates[0]] }]] });
    const send = (body) => post('/api/controller/review/decisions', { runId: RUN_ID, ...body }).then((r) => r.statusCode);
    expect(await send({ action: 'Delete', lineIds: [L1] })).toBe(400);
    expect(await send({ action: 'Reassign', entityId: 'ent-other', lineIds: [L1] })).toBe(400);
    expect(await send({ action: 'Split', lineIds: [L1, L2] })).toBe(400);
    expect(await send({ action: 'Undo', filter: {}, expectedCount: 1 })).toBe(400);
    expect(await send({ action: 'Approve' })).toBe(400);
  });

  test('undo is recorded only for a decided line', async () => {
    setup({ routes: [[/FROM CtrlSuggestions s/, { rows: [{ ...candidates[0], decided: true }] }]] });
    const res = await post('/api/controller/review/decisions', { runId: RUN_ID, action: 'Undo', lineIds: [L1] });
    expect(parseBody(res).decided).toBe(1);
    expect(decisionsInsert()[1].slice(5, 8)).toEqual(['Undo', null, null]);
  });
});

describe('settings', () => {
  test('defaults to 90% / 70% / 12 months', async () => {
    setup();
    expect(parseBody(await get('/api/controller/review/settings'))).toEqual({ threshold: 0.9, mediumThreshold: 0.7, historyMonths: 12 });
  });

  test('saves new settings', async () => {
    setup();
    const res = await handler(
      apiEvent({ method: 'PUT', resource: '/api/controller/review/settings', body: { groupId: 'group-1', threshold: 0.85, mediumThreshold: 0.6, historyMonths: 24 } })
    );
    expect(res.statusCode).toBe(200);
    const upsert = query.mock.calls.find(([sql]) => /INSERT INTO CtrlReviewSettings/.test(sql));
    expect(upsert[1]).toEqual(['group-1', 0.85, 0.6, 24, 'user-paul']);
  });
});

test('never writes to the dashboard tables or QuickBooks', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../../src/functions/controller/ctrlReview'), 'utf8');
  expect(src).not.toMatch(/(INSERT INTO|UPDATE|DELETE FROM)\s+(RawTransactions|ChartOfAccountsMappings|QBOClasses|QBOs)\b/i);
  expect(src).not.toMatch(/qboClient/);
});
