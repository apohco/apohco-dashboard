// Phase 3 additions to ctrlReview: starting the AI pass after a run, AI
// suggestions in the queue, the AI filter, and "Accept AI".
jest.mock('../../src/shared/verifyToken', () => ({ requireAuth: jest.fn() }));
jest.mock('../../src/shared/db', () => ({ query: jest.fn(), withTransaction: jest.fn() }));
jest.mock('../../src/shared/ctrlAiJobs', () => ({ startReviewAiJob: jest.fn() }));

const { requireAuth } = require('../../src/shared/verifyToken');
const { query, withTransaction } = require('../../src/shared/db');
const { startReviewAiJob } = require('../../src/shared/ctrlAiJobs');
const { handler, parseFilters, buildFilterSql } = require('../../src/functions/controller/ctrlReview');
const { CONTROLLER_ADMIN, sqlRouter, apiEvent, parseBody } = require('../helpers');

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
const decisionRows = () => client.query.mock.calls.find(([sql]) => /INSERT INTO CtrlDecisions/.test(sql))?.[1];

describe('a review run starts the AI pass', () => {
  const runRoutes = [
    [/FROM QBOs WHERE QBOId/, { rows: [{ qboid: 'qbo-mgmt', qboname: 'APOHCO', isclassbased: true }] }],
    [/FROM CtrlSnapshots WHERE GroupId/, { rows: [{ snapshotid: 'snap-oct' }] }],
    [/FROM CtrlLedgerLines WHERE SnapshotId/, { rows: [{ lineid: L1, fingerprint: 'f1', payeename: 'Kroger', memo: '', accountcode: '6100', classname: 'Milford', qboclassid: 'cls-mil' }] }],
    [/FROM CtrlVendorRules/, { rows: [{ ruleid: 'r1', vendorid: 'v-kroger', version: 2, ruletext: 'Kroger is Milford', hints: {} }] }],
  ];
  const clientRoutes = [
    [/FROM CtrlVendorAliases WHERE GroupId/, { rows: [{ payeekey: 'kroger', vendorid: 'v-kroger' }] }],
    [/INSERT INTO CtrlReviewRuns/, { rows: [{ runid: RUN_ID, rundate: 'now' }] }],
  ];

  test('after the run is stored, with the settings and vendor rules', async () => {
    setup({ routes: runRoutes, clientRoutes });
    startReviewAiJob.mockResolvedValue({ jobId: 'job-1', lineCount: 12, batchCount: 1, failedToQueue: 0 });
    const res = await post('/api/controller/review/runs', { qboId: 'qbo-mgmt', month: '2026-10' });
    expect(res.statusCode).toBe(201);
    expect(parseBody(res).ai).toEqual({ jobId: 'job-1', lineCount: 12, batchCount: 1, failedToQueue: 0 });
    const args = startReviewAiJob.mock.calls[0][0];
    expect(args).toMatchObject({ groupId: 'group-1', run: { runId: RUN_ID, qboId: 'qbo-mgmt' }, userId: 'user-paul' });
    expect(args.settings).toMatchObject({ threshold: 0.9, aiEnabled: true, aiConfidenceCap: 0.85 });
    expect(args.rules.get('v-kroger')).toMatchObject({ ruleText: 'Kroger is Milford' });
  });

  test('a problem starting it never fails the review', async () => {
    setup({ routes: runRoutes, clientRoutes });
    startReviewAiJob.mockRejectedValue(new Error('SQS down'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post('/api/controller/review/runs', { qboId: 'qbo-mgmt', month: '2026-10' });
    expect(res.statusCode).toBe(201);
    expect(parseBody(res).ai.skipped).toMatch(/could not be started/);
  });
});

describe('AI suggestions in the queue', () => {
  test('each line carries the AI answer, if any', async () => {
    const base = {
      lineid: L1, fingerprint: 'f1', confidence: '0.5', status: 'NeedsEvidence', source: 'None', reasons: [], amount: '10', debit: '10', credit: '0',
    };
    setup({
      routes: [
        [/GROUP BY s.Status/, { rows: [] }],
        [/SELECT COUNT\(\*\)::int AS n, COALESCE/, { rows: [{ n: 2, amount: '20' }] }],
        [
          /ORDER BY CASE s.Status/,
          {
            rows: [
              { ...base, aiaction: 'Assign', aientityid: 'ent-mil', aiconfidence: '0.8200', aireason: 'Memo says Milford', aiusedrule: false, airedacted: false },
              { ...base, lineid: L2, fingerprint: 'f2', aiaction: null },
            ],
          },
        ],
      ],
    });
    const data = parseBody(await get('/api/controller/review/lines', { runId: RUN_ID }));
    expect(data.lines[0].ai).toEqual({
      action: 'Assign', entityId: 'ent-mil', account: null, confidence: 0.82, reason: 'Memo says Milford', usedRule: false, redacted: false,
    });
    expect(data.lines[1].ai).toBeNull();
  });

  test('the ai filter', () => {
    expect(buildFilterSql(parseFilters({ ai: 'suggested' }), 4).sql).toMatch(/a.SuggestedAction <> 'Unsure'/);
    expect(buildFilterSql(parseFilters({ ai: 'unsure' }), 4).sql).toMatch(/a.SuggestedAction = 'Unsure'/);
    expect(buildFilterSql(parseFilters({ ai: 'none' }), 4).sql).toMatch(/a.LineId IS NULL/);
    expect(() => parseFilters({ ai: 'maybe' })).toThrow(/ai must be/);
  });
});

describe('Accept AI', () => {
  test('class review: records an approval of the AI entity, marked AI', async () => {
    const rows = [
      { lineid: L1, fingerprint: 'f1', currententityid: 'ent-leb', aiaction: 'Assign', aientityid: 'ent-mil', amount: '1', watchmode: false, decided: false },
      { lineid: L2, fingerprint: 'f2', currententityid: 'ent-leb', aiaction: 'Unsure', aientityid: null, amount: '1', watchmode: false, decided: false },
      { lineid: L3, fingerprint: 'f3', currententityid: 'ent-leb', aiaction: null, amount: '1', watchmode: false, decided: false },
    ];
    setup({ routes: [[/FROM CtrlSuggestions s/, { rows }]] });
    const res = await post('/api/controller/review/decisions', { runId: RUN_ID, action: 'AcceptAi', filter: { ai: 'suggested' }, expectedCount: 3 });
    expect(parseBody(res)).toEqual({ decided: 1, skipped: { alreadyDecided: 0, watchMode: 0, nothingToApply: 2, noDueToFromAccount: 0 } });
    expect(decisionRows()).toEqual(['group-1', 'qbo-mgmt', 'f1', L1, RUN_ID, 'Approve', 'ent-mil', null, null, 'user-paul', null, null, null, 'AI']);
  });

  test('class review: an entity no longer active is not applied', async () => {
    setup({
      routes: [[/FROM CtrlSuggestions s/, { rows: [{ lineid: L1, fingerprint: 'f1', aiaction: 'Assign', aientityid: 'ent-gone', amount: '1', watchmode: false, decided: false }] }]],
    });
    const res = await post('/api/controller/review/decisions', { runId: RUN_ID, action: 'AcceptAi', lineIds: [L1] });
    expect(parseBody(res)).toMatchObject({ decided: 0, skipped: { nothingToApply: 1 } });
  });

  test('account review: Reclassify, Due To/From and Keep, as the AI said', async () => {
    const line = (over) => ({
      currententityid: 'ent-mil', accountcode: '6100', accountname: 'Supplies', amount: '10', watchmode: false, decided: false,
      aiaction: null, aientityid: null, aiaccountcode: null, aiaccountname: null, ...over,
    });
    setup({
      routes: [
        [/FROM CtrlReviewRuns WHERE RunId/, { rows: [{ ...RUN_ROW, qboid: 'qbo-mil', reviewkind: 'Account' }] }],
        [
          /FROM CtrlSuggestions s/,
          {
            rows: [
              line({ lineid: L1, fingerprint: 'f1', aiaction: 'Reclassify', aiaccountcode: '6150', aiaccountname: 'Breakroom' }),
              line({ lineid: L2, fingerprint: 'f2', aiaction: 'DueToFrom', aientityid: 'ent-leb' }),
              line({ lineid: L3, fingerprint: 'f3', aiaction: 'Keep' }),
            ],
          },
        ],
        [/FROM CtrlEntities WHERE GroupId = \$1 AND PracticeQBOId/, { rows: [{ entityid: 'ent-mil' }] }],
        [/FROM CtrlDueToFromAccounts/, { rows: [{ counterpartyentityid: 'ent-leb', accountcode: '1500', accountname: 'Due From Lebanon' }] }],
        [/SELECT DISTINCT AccountCode, AccountName FROM CtrlLedgerLines/, { rows: [{ accountcode: '1500', accountname: 'Due From Lebanon' }] }],
      ],
    });
    const res = await post('/api/controller/review/decisions', { runId: RUN_ID, action: 'AcceptAi', lineIds: [L1, L2, L3] });
    expect(parseBody(res).decided).toBe(3);
    const p = decisionRows();
    expect(p.slice(0, 14)).toEqual(['group-1', 'qbo-mil', 'f1', L1, RUN_ID, 'Reclassify', null, null, null, 'user-paul', '6150', 'Breakroom', null, 'AI']);
    expect(p.slice(14, 28)).toEqual(['group-1', 'qbo-mil', 'f2', L2, RUN_ID, 'DueToFrom', null, null, null, 'user-paul', '1500', 'Due From Lebanon', 'ent-leb', 'AI']);
    expect(p.slice(28, 42)).toEqual(['group-1', 'qbo-mil', 'f3', L3, RUN_ID, 'Keep', null, null, null, 'user-paul', null, null, null, 'AI']);
  });
});

describe('AI settings', () => {
  test('are saved with the rest', async () => {
    setup();
    const res = await handler(
      apiEvent({
        method: 'PUT', resource: '/api/controller/review/settings',
        body: { groupId: 'group-1', threshold: 0.9, mediumThreshold: 0.7, historyMonths: 12, aiEnabled: false, aiConfidenceCap: 0.95, aiMonthlyBudget: 10, aiRedactPatientInfo: true },
      })
    );
    expect(parseBody(res)).toMatchObject({ aiEnabled: false, aiConfidenceCap: 0.95, aiMonthlyBudget: 10, aiRedactPatientInfo: true });
    const upsert = query.mock.calls.find(([sql]) => /INSERT INTO CtrlReviewSettings/.test(sql));
    expect(upsert[1].slice(10)).toEqual([false, 0.95, 10, true]);
  });

  test('are checked', async () => {
    setup();
    const put = (body) =>
      handler(apiEvent({ method: 'PUT', resource: '/api/controller/review/settings', body: { groupId: 'group-1', threshold: 0.9, mediumThreshold: 0.7, historyMonths: 12, ...body } }));
    expect((await put({ aiConfidenceCap: 0.3 })).statusCode).toBe(400);
    expect((await put({ aiMonthlyBudget: -1 })).statusCode).toBe(400);
    expect((await put({ aiEnabled: 'yes' })).statusCode).toBe(400);
  });
});
