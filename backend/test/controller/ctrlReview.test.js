jest.mock('../../src/shared/verifyToken', () => ({ requireAuth: jest.fn() }));
jest.mock('../../src/shared/db', () => ({ query: jest.fn(), withTransaction: jest.fn() }));
jest.mock('../../src/shared/ctrlAiJobs', () => ({ startReviewAiJob: jest.fn(async () => ({ skipped: 'No lines need the AI' })) }));

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
    expect(validateSettings({ threshold: 0.9, mediumThreshold: 0.7, historyMonths: 12 })).toEqual({
      threshold: 0.9, mediumThreshold: 0.7, historyMonths: 12, splitShiftPoints: 25, spikePercent: 50, spikeMinAmount: 500, recurringMonths: 3, baselineMonths: 6,
      aiEnabled: true, aiConfidenceCap: 0.85, aiMonthlyBudget: 25, aiRedactPatientInfo: true,
    });
    const base = { threshold: 0.9, mediumThreshold: 0.7, historyMonths: 12 };
    expect(validateSettings({ ...base, splitShiftPoints: 30, spikeMinAmount: 0 })).toMatchObject({ splitShiftPoints: 30, spikeMinAmount: 0 });
    expect(() => validateSettings({ ...base, splitShiftPoints: 0 })).toThrow(/splitShiftPoints/);
    expect(() => validateSettings({ ...base, recurringMonths: 1 })).toThrow(/recurringMonths/);
    expect(() => validateSettings({ ...base, spikeMinAmount: -5 })).toThrow(/spikeMinAmount/);
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

  test('a file without classes gets an account review', async () => {
    setup({
      routes: [
        [/FROM QBOs WHERE QBOId/, { rows: [{ qboid: 'qbo-mil', qboname: 'Milford', isclassbased: false }] }],
        [/FROM CtrlSnapshots WHERE GroupId/, { rows: [{ snapshotid: 'snap-oct' }] }],
        // Milford's own file.
        [/FROM CtrlEntities WHERE GroupId = \$1 AND PracticeQBOId/, { rows: [{ entityid: 'ent-mil' }] }],
        [
          /FROM CtrlLedgerLines WHERE SnapshotId/,
          {
            rows: [
              { lineid: L1, fingerprint: 'f1', payeename: 'Kroger', memo: '', accountcode: '6100', accountname: 'Supplies' },
              { lineid: L2, fingerprint: 'f2', payeename: 'Henry Schein', memo: 'Lebanon order', accountcode: '6200', accountname: 'Dental Supplies' },
            ],
          },
        ],
      ],
      clientRoutes: [
        [/FROM CtrlVendorAliases WHERE GroupId/, { rows: [{ payeekey: 'kroger', vendorid: 'v-kroger' }] }],
        [/INSERT INTO CtrlVendors/, { rows: [{ vendorid: 'v-schein', displayname: 'Henry Schein' }] }],
        [/FROM CtrlUploads/, { rows: [{ accountclassifications: { 'code:6100': 'Expense', 'code:6150': 'Expense', 'code:6200': 'Expense', 'code:1500': 'Asset' } }] }],
        [/FROM CtrlDueToFromAccounts/, { rows: [{ counterpartyentityid: 'ent-leb', accountcode: '1500', accountname: 'Due From Lebanon' }] }],
        // September: 19 Kroger expense lines in 6150 Breakroom.
        [/TargetAccountCode/, { rows: [{ payeename: 'Kroger', accountcode: '6150', accountname: 'Breakroom', action: null, n: 19 }] }],
        [/INSERT INTO CtrlReviewRuns/, { rows: [{ runid: RUN_ID, rundate: 'now' }] }],
      ],
    });
    const res = await post('/api/controller/review/runs', { qboId: 'qbo-mil', month: '2026-10' });
    const data = parseBody(res);
    expect(res.statusCode).toBe(201);
    expect(data).toMatchObject({ reviewKind: 'Account', statusCounts: { LikelyMisclassified: 1, NeedsEvidence: 1 } });
    // No class history or vendor rules are read for an account review.
    expect(sqlOf(client.query).some((s) => /FROM CtrlVendorRules/.test(s))).toBe(false);

    const runInsert = client.query.mock.calls.find(([sql]) => /INSERT INTO CtrlReviewRuns/.test(sql))[1];
    expect(runInsert[10]).toBe('Account');
    const sugg = client.query.mock.calls.find(([sql]) => /INSERT INTO CtrlSuggestions/.test(sql))[1];
    // 15 columns per line. Kroger: history says Breakroom.
    expect(sugg.slice(0, 15)).toEqual([
      RUN_ID, 'group-1', L1, 'f1', 'v-kroger', 'ent-mil', null, 0.95, 'LikelyMisclassified', 'History', expect.any(String), null,
      'Reclassify', '6150', 'Breakroom',
    ]);
    // Henry Schein: the memo names Lebanon (a bare name: medium confidence).
    expect(sugg.slice(15)).toEqual([
      RUN_ID, 'group-1', L2, 'f2', 'v-schein', 'ent-mil', 'ent-leb', 0.85, 'NeedsEvidence', 'Keyword', expect.any(String), null,
      'DueToFrom', '1500', 'Due From Lebanon',
    ]);
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
    expect(parseBody(res)).toEqual({ decided: 1, skipped: { alreadyDecided: 1, watchMode: 1, nothingToApply: 1, noDueToFromAccount: 0 } });
    const params = decisionsInsert()[1];
    expect(params).toEqual(['group-1', 'qbo-mgmt', 'f1', L1, RUN_ID, 'Approve', 'ent-leb', null, null, 'user-paul', null, null, null, 'Engine']);
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
    expect(decisionsInsert()[1]).toEqual(['group-1', 'qbo-mgmt', 'f3', L3, RUN_ID, 'Reassign', 'ent-mil', null, 'wrong store', 'user-paul', null, null, null, null]);
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

describe('account review: Reclassify and Due To/From', () => {
  const ACCOUNT_RUN = { ...RUN_ROW, qboid: 'qbo-mil', reviewkind: 'Account' };
  const L4 = '44444444-4444-4444-4444-444444444444';
  const FILE_ACCOUNTS = [
    { accountcode: '6100', accountname: 'Supplies' },
    { accountcode: '6150', accountname: 'Breakroom' },
    { accountcode: '1500', accountname: 'Due From Lebanon' },
    { accountcode: '1510', accountname: 'Due From Milford' },
  ];
  const row = (over) => ({
    currententityid: 'ent-mil', suggestedentityid: null, suggestedaction: null, suggestedaccountcode: null, suggestedaccountname: null,
    accountcode: '6100', accountname: 'Supplies', amount: '10.00', watchmode: false, decided: false, ...over,
  });
  const accountRoutes = ({ lines = [], mappings = [], owner = 'ent-mil', accounts = FILE_ACCOUNTS } = {}) => [
    [/FROM CtrlReviewRuns WHERE RunId/, { rows: [ACCOUNT_RUN] }],
    [/FROM CtrlSuggestions s/, { rows: lines }],
    [/FROM CtrlEntities WHERE GroupId = \$1 AND PracticeQBOId/, { rows: owner ? [{ entityid: owner }] : [] }],
    [/FROM CtrlDueToFromAccounts/, { rows: mappings }],
    [/SELECT DISTINCT AccountCode, AccountName FROM CtrlLedgerLines/, { rows: accounts }],
    [/FROM CtrlUploads/, { rows: [{ accountclassifications: { 'code:6100': 'Expense', 'code:1500': 'Asset' } }] }],
    [/FROM QBOs WHERE QBOId/, { rows: [{ qboid: 'qbo-mil' }] }],
  ];
  const decisionRows = () => client.query.mock.calls.find(([sql]) => /INSERT INTO CtrlDecisions/.test(sql))?.[1];
  const send = (body) => post('/api/controller/review/decisions', { runId: RUN_ID, ...body });

  test('bulk approve records what each suggestion stands for', async () => {
    setup({
      routes: accountRoutes({
        mappings: [{ counterpartyentityid: 'ent-leb', accountcode: '1500', accountname: 'Due From Lebanon' }],
        lines: [
          row({ lineid: L1, fingerprint: 'f1', suggestedaction: 'Reclassify', suggestedaccountcode: '6150', suggestedaccountname: 'Breakroom' }),
          row({ lineid: L2, fingerprint: 'f2', suggestedaction: 'DueToFrom', suggestedentityid: 'ent-leb' }),
          // No Due To/From account set up for this entity yet.
          row({ lineid: L3, fingerprint: 'f3', suggestedaction: 'DueToFrom', suggestedentityid: 'ent-other' }),
          row({ lineid: L4, fingerprint: 'f4', suggestedaction: 'Keep' }),
          row({ lineid: '55555555-5555-5555-5555-555555555555', fingerprint: 'f5' }),
        ],
      }),
    });
    const res = await send({ action: 'Approve', filter: {}, expectedCount: 5 });
    expect(parseBody(res)).toEqual({ decided: 3, skipped: { alreadyDecided: 0, watchMode: 0, nothingToApply: 1, noDueToFromAccount: 1 } });
    const p = decisionRows();
    // 14 columns per decision.
    expect(p.slice(0, 14)).toEqual(['group-1', 'qbo-mil', 'f1', L1, RUN_ID, 'Reclassify', null, null, null, 'user-paul', '6150', 'Breakroom', null, 'Engine']);
    expect(p.slice(14, 28)).toEqual(['group-1', 'qbo-mil', 'f2', L2, RUN_ID, 'DueToFrom', null, null, null, 'user-paul', '1500', 'Due From Lebanon', 'ent-leb', 'Engine']);
    expect(p.slice(28, 42)).toEqual(['group-1', 'qbo-mil', 'f4', L4, RUN_ID, 'Keep', null, null, null, 'user-paul', null, null, null, 'Engine']);
  });

  test('reclassify moves lines to an account in the file and skips lines already there', async () => {
    setup({ routes: accountRoutes({ lines: [row({ lineid: L1, fingerprint: 'f1' }), row({ lineid: L2, fingerprint: 'f2', accountcode: '6150', accountname: 'Breakroom' })] }) });
    const res = await send({ action: 'Reclassify', lineIds: [L1, L2], account: { code: '6150', name: 'Breakroom' } });
    expect(parseBody(res)).toMatchObject({ decided: 1, skipped: { nothingToApply: 1 } });
    expect(decisionRows().slice(5, 13)).toEqual(['Reclassify', null, null, null, 'user-paul', '6150', 'Breakroom', null]);
  });

  test('reclassify to an account the file does not have is refused', async () => {
    setup({ routes: accountRoutes({ lines: [row({ lineid: L1, fingerprint: 'f1' })] }) });
    const res = await send({ action: 'Reclassify', lineIds: [L1], account: { code: '9999', name: 'Made Up' } });
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).message).toMatch(/not an account in this QBO file/);
  });

  test('due to/from with an account remembers it for that entity', async () => {
    setup({ routes: accountRoutes({ lines: [row({ lineid: L1, fingerprint: 'f1' })] }) });
    const res = await send({ action: 'DueToFrom', lineIds: [L1], counterpartyEntityId: 'ent-leb', account: { code: '1500', name: 'Due From Lebanon' } });
    expect(parseBody(res).decided).toBe(1);
    const upsert = client.query.mock.calls.find(([sql]) => /INSERT INTO CtrlDueToFromAccounts/.test(sql));
    expect(upsert[1]).toEqual(['group-1', 'qbo-mil', 'ent-leb', '1500', 'Due From Lebanon', 'user-paul']);
    expect(decisionRows().slice(5, 13)).toEqual(['DueToFrom', null, null, null, 'user-paul', '1500', 'Due From Lebanon', 'ent-leb']);
  });

  test('due to/from without an account uses the saved one, else the one named for the entity, else asks', async () => {
    const lines = [row({ lineid: L1, fingerprint: 'f1' })];
    // Saved (wins over the name match).
    setup({ routes: accountRoutes({ lines, mappings: [{ counterpartyentityid: 'ent-leb', accountcode: '1510', accountname: 'Due From Milford' }] }) });
    expect(parseBody(await send({ action: 'DueToFrom', lineIds: [L1], counterpartyEntityId: 'ent-leb' })).decided).toBe(1);
    expect(decisionRows().slice(10, 13)).toEqual(['1510', 'Due From Milford', 'ent-leb']);
    expect(sqlOf(client.query).some((s) => /INSERT INTO CtrlDueToFromAccounts/.test(s))).toBe(false);

    // Nothing saved: "1500 Due From Lebanon" is found by name.
    setup({ routes: accountRoutes({ lines }) });
    expect(parseBody(await send({ action: 'DueToFrom', lineIds: [L1], counterpartyEntityId: 'ent-leb' })).decided).toBe(1);
    expect(decisionRows().slice(10, 13)).toEqual(['1500', 'Due From Lebanon', 'ent-leb']);

    // Neither.
    setup({ routes: accountRoutes({ lines, accounts: FILE_ACCOUNTS.filter((a) => !/Due/.test(a.accountname)) }) });
    const res = await send({ action: 'DueToFrom', lineIds: [L1], counterpartyEntityId: 'ent-leb' });
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).message).toMatch(/Choose the Due To\/From account for Lebanon/);
  });

  test('due to/from with rememberAccount false uses the account without saving it', async () => {
    setup({ routes: accountRoutes({ lines: [row({ lineid: L1, fingerprint: 'f1' })] }) });
    const res = await send({
      action: 'DueToFrom', lineIds: [L1], counterpartyEntityId: 'ent-leb', account: { code: '1510', name: 'Due From Milford' }, rememberAccount: false,
    });
    expect(parseBody(res).decided).toBe(1);
    expect(decisionRows().slice(10, 13)).toEqual(['1510', 'Due From Milford', 'ent-leb']);
    expect(sqlOf(client.query).some((s) => /INSERT INTO CtrlDueToFromAccounts/.test(s))).toBe(false);
  });

  test('validation: own entity, unknown entity, and class-only actions', async () => {
    setup({ routes: accountRoutes({ lines: [row({ lineid: L1, fingerprint: 'f1' })] }) });
    const status = (body) => send(body).then((r) => r.statusCode);
    expect(await status({ action: 'DueToFrom', lineIds: [L1], counterpartyEntityId: 'ent-mil', account: { code: '1510', name: 'Due From Milford' } })).toBe(400);
    expect(await status({ action: 'DueToFrom', lineIds: [L1], counterpartyEntityId: 'ent-nope' })).toBe(400);
    expect(await status({ action: 'Reassign', lineIds: [L1], entityId: 'ent-leb' })).toBe(400);
    expect(await status({ action: 'Split', lineIds: [L1], allocations: [] })).toBe(400);
    expect(await status({ action: 'Reclassify', lineIds: [L1] })).toBe(400);
    expect(withTransaction).not.toHaveBeenCalled();
  });

  test('reclassify also works on a class review (management file)', async () => {
    setup({
      routes: [
        [/FROM CtrlSuggestions s/, { rows: [row({ lineid: L1, fingerprint: 'f1' })] }],
        [/SELECT DISTINCT AccountCode, AccountName FROM CtrlLedgerLines/, { rows: FILE_ACCOUNTS }],
      ],
    });
    const res = await send({ action: 'Reclassify', lineIds: [L1], account: { code: '6150', name: 'Breakroom' } });
    expect(parseBody(res).decided).toBe(1);
    expect(decisionRows()[1]).toBe('qbo-mgmt');
  });

  test('GET accounts lists the file accounts with types and its Due To/From accounts', async () => {
    setup({ routes: accountRoutes({ mappings: [{ counterpartyentityid: 'ent-leb', accountcode: '1500', accountname: 'Due From Lebanon' }] }) });
    const data = parseBody(await get('/api/controller/review/accounts', { qboId: '99999999-9999-9999-9999-999999999999' }));
    expect(data.ownerEntityId).toBe('ent-mil');
    expect(data.accounts.map((a) => `${a.code} ${a.type}`)).toEqual(['1500 Asset', '1510 Unknown', '6100 Expense', '6150 Unknown']);
    expect(data.dueToFrom).toEqual([{ entityId: 'ent-leb', account: { code: '1500', name: 'Due From Lebanon' } }]);
    // Found by name; "Due From Milford" is not offered in Milford's own file.
    expect(data.detectedDueToFrom).toEqual([{ entityId: 'ent-leb', account: { code: '1500', name: 'Due From Lebanon' } }]);
  });

  test('PUT due-to-from saves or clears the account for an entity', async () => {
    setup({ routes: accountRoutes() });
    const put = (body) =>
      handler(apiEvent({ method: 'PUT', resource: '/api/controller/review/due-to-from', body: { groupId: 'group-1', qboId: '99999999-9999-9999-9999-999999999999', ...body } }));
    const saved = await put({ counterpartyEntityId: 'ent-leb', account: { code: '1500', name: 'Due From Lebanon' } });
    expect(parseBody(saved)).toEqual({ counterpartyEntityId: 'ent-leb', account: { code: '1500', name: 'Due From Lebanon' } });
    expect(sqlOf(client.query).some((s) => /INSERT INTO CtrlDueToFromAccounts/.test(s))).toBe(true);

    await put({ counterpartyEntityId: 'ent-leb', account: null });
    expect(sqlOf(client.query).some((s) => /DELETE FROM CtrlDueToFromAccounts/.test(s))).toBe(true);

    expect((await put({ counterpartyEntityId: 'ent-mil', account: { code: '1510', name: 'Due From Milford' } })).statusCode).toBe(400);
  });
});

describe('settings', () => {
  test('defaults to 90% / 70% / 12 months', async () => {
    setup();
    expect(parseBody(await get('/api/controller/review/settings'))).toEqual({
      threshold: 0.9, mediumThreshold: 0.7, historyMonths: 12, splitShiftPoints: 25, spikePercent: 50, spikeMinAmount: 500, recurringMonths: 3, baselineMonths: 6,
      aiEnabled: true, aiConfidenceCap: 0.85, aiMonthlyBudget: 25, aiRedactPatientInfo: true,
    });
  });

  test('saves new settings', async () => {
    setup();
    const res = await handler(
      apiEvent({ method: 'PUT', resource: '/api/controller/review/settings', body: { groupId: 'group-1', threshold: 0.85, mediumThreshold: 0.6, historyMonths: 24 } })
    );
    expect(res.statusCode).toBe(200);
    const upsert = query.mock.calls.find(([sql]) => /INSERT INTO CtrlReviewSettings/.test(sql));
    expect(upsert[1]).toEqual(['group-1', 0.85, 0.6, 24, 'user-paul', 25, 50, 500, 3, 6, true, 0.85, 25, true]);
  });
});

test('never writes to the dashboard tables or QuickBooks', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../../src/functions/controller/ctrlReview'), 'utf8');
  expect(src).not.toMatch(/(INSERT INTO|UPDATE|DELETE FROM)\s+(RawTransactions|ChartOfAccountsMappings|QBOClasses|QBOs)\b/i);
  expect(src).not.toMatch(/qboClient/);
});
