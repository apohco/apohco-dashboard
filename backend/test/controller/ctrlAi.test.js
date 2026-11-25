jest.mock('../../src/shared/verifyToken', () => ({ requireAuth: jest.fn() }));
jest.mock('../../src/shared/db', () => ({ query: jest.fn(), withTransaction: jest.fn() }));
jest.mock('../../src/shared/ctrlQueue', () => ({ enqueueAiBatches: jest.fn() }));

const { requireAuth } = require('../../src/shared/verifyToken');
const { query, withTransaction } = require('../../src/shared/db');
const { enqueueAiBatches } = require('../../src/shared/ctrlQueue');
const { handler, currentOutcomeKey } = require('../../src/functions/controller/ctrlAi');
const { CONTROLLER_ADMIN, PLAIN_ADMIN, sqlRouter, apiEvent, parseBody } = require('../helpers');

const RUN_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const VENDOR_ID = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';
const QBO_ID = 'cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee';
const JOB_ID = 'dddddddd-bbbb-cccc-dddd-eeeeeeeeeeee';
const ENTITY_ROWS = [
  { entityid: 'ent-leb', entityname: 'Lebanon', managementqboclassid: 'cls-leb', managementclassname: 'Lebanon', aliases: [], keywords: [] },
  { entityid: 'ent-mil', entityname: 'Milford', managementqboclassid: 'cls-mil', managementclassname: 'Milford', aliases: [], keywords: [] },
];
// loadStoredLines rows.
const stored = (over) => ({
  lineid: 'l1', qboid: QBO_ID, month: '2026-10', fingerprint: 'f1', txndate: '2026-10-03', payeename: 'Kroger', payeekey: 'kroger', memo: 'm',
  accountcode: '6100', accountname: 'Supplies', classname: 'Lebanon', qboclassid: 'cls-leb', amount: '10', accounttype: 'Expense', action: null, ...over,
});

let client;
let batchSeq;
function setup(routes = []) {
  batchSeq = 0;
  requireAuth.mockResolvedValue(CONTROLLER_ADMIN);
  query.mockImplementation(
    sqlRouter([
      ...routes,
      [/FROM CtrlReviewSettings/, { rows: [] }],
      [/FROM CtrlEntities e/, { rows: ENTITY_ROWS }],
      [/FROM CtrlReviewRuns WHERE RunId/, { rows: [{ runid: RUN_ID, qboid: QBO_ID, month: '2026-10' }] }],
      [/SUM\(CostUsd\), 0\) AS spend/, { rows: [{ spend: '1.5', calls: 4 }] }],
    ])
  );
  client = {
    query: sqlRouter([
      [/INSERT INTO CtrlAiJobs/, { rows: [{ jobid: JOB_ID }] }],
      [/INSERT INTO CtrlAiBatches/, () => ({ rows: [{ batchid: `b${(batchSeq += 1)}` }] })],
    ]),
  };
  withTransaction.mockImplementation((fn) => fn(client));
  enqueueAiBatches.mockResolvedValue([]);
}
const get = (resource, q, path) => handler(apiEvent({ method: 'GET', resource, query: { groupId: 'group-1', ...q }, path }));
const start = (body) => handler(apiEvent({ method: 'POST', resource: '/api/controller/ai/jobs', body: { groupId: 'group-1', ...body } }));

test('only the Controller owner may use it', async () => {
  setup();
  requireAuth.mockResolvedValue(PLAIN_ADMIN);
  expect((await get('/api/controller/ai/usage')).statusCode).toBe(403);
});

test('status of a run: answers so far, spend and the latest job', async () => {
  setup([
    [/FROM CtrlAiJobs WHERE GroupId = \$1 AND RunId/, { rows: [] }],
    [/FROM CtrlAiSuggestions WHERE RunId/, { rows: [{ n: 30, suggested: 22 }] }],
  ]);
  expect(parseBody(await get('/api/controller/ai/status', { runId: RUN_ID }))).toEqual({
    enabled: true, confidenceCap: 0.85, monthSpend: 1.5, monthlyBudget: 25, answered: 30, suggested: 22, job: null,
  });
});

describe('starting jobs', () => {
  test('Review: refused with the reason when nothing is sent', async () => {
    setup([[/FROM CtrlSuggestions s/, { rows: [] }]]);
    const res = await start({ kind: 'Review', runId: RUN_ID });
    expect(res.statusCode).toBe(409);
    expect(parseBody(res).message).toBe('No lines need the AI');
  });

  test('RuleTest: the vendor\'s recent lines in its main file, with the draft rule', async () => {
    setup([
      [/FROM CtrlVendors WHERE VendorId/, { rows: [{ vendorid: VENDOR_ID }] }],
      [/FROM CtrlVendorAliases a JOIN CtrlVendors/, { rows: [{ payeekey: 'kroger', vendorid: VENDOR_ID, displayname: 'Kroger' }] }],
      [/SELECT DISTINCT QBOId, TO_CHAR\(Period/, { rows: [{ qboid: QBO_ID, month: '2026-10' }, { qboid: QBO_ID, month: '2026-09' }] }],
      [/FROM CtrlLedgerLines l\s+JOIN snaps/, { rows: [stored({}), stored({ lineid: 'l2', fingerprint: 'f2', txndate: '2026-09-20' }), stored({ lineid: 'l3', qboid: 'other' })] }],
    ]);
    const res = await start({ kind: 'RuleTest', vendorId: VENDOR_ID, ruleText: '  Kroger is Milford  ', months: 2 });
    expect(res.statusCode).toBe(202);
    expect(parseBody(res)).toEqual({ jobId: JOB_ID, kind: 'RuleTest', lineCount: 2, batchCount: 1, failedToQueue: 0 });
    const job = client.query.mock.calls.find(([sql]) => /INSERT INTO CtrlAiJobs/.test(sql))[1];
    expect(job.slice(0, 5)).toEqual(['group-1', 'RuleTest', null, VENDOR_ID, QBO_ID]);
    expect(JSON.parse(job[6])).toEqual({ ruleText: 'Kroger is Milford', months: 2 });
    const lines = query.mock.calls.find(([sql]) => /FROM CtrlLedgerLines l\s+JOIN snaps/.test(sql))[1];
    expect(lines.slice(1, 3)).toEqual(['2026-09-01', '2026-10-01']);
  });

  test('RuleTest: checks its input', async () => {
    setup();
    expect((await start({ kind: 'RuleTest', vendorId: VENDOR_ID, ruleText: ' ' })).statusCode).toBe(400);
    expect((await start({ kind: 'RuleTest', vendorId: VENDOR_ID, ruleText: 'x', months: 13 })).statusCode).toBe(400);
    expect((await start({ kind: 'RuleTest', vendorId: 'nope', ruleText: 'x' })).statusCode).toBe(400);
    expect((await start({ kind: 'Nope' })).statusCode).toBe(400);
  });

  test('Backtest: up to 50 decided lines of the latest decided month (not splits or relabels)', async () => {
    setup([
      [/SELECT QBOId FROM QBOs/, { rows: [{ qboid: QBO_ID }] }],
      [/MAX\(sn.Period\)/, { rows: [{ month: '2026-10' }] }],
      [
        /FROM CtrlLedgerLines l\s+JOIN snaps/,
        {
          rows: [
            stored({ action: 'Approve', decisionentityid: 'ent-leb', scope: 'Line' }),
            stored({ lineid: 'l2', fingerprint: 'f2', action: 'Split', scope: 'Line' }),
            stored({ lineid: 'l3', fingerprint: 'f3', action: 'Reassign', decisionentityid: 'ent-mil', scope: 'Relabel' }),
            stored({ lineid: 'l4', fingerprint: 'f0', action: 'Undo', scope: 'Line' }),
            stored({ lineid: 'l5', fingerprint: 'f5' }),
          ],
        },
      ],
    ]);
    const res = await start({ kind: 'Backtest', qboId: QBO_ID });
    expect(parseBody(res)).toMatchObject({ kind: 'Backtest', lineCount: 1 });
    const job = client.query.mock.calls.find(([sql]) => /INSERT INTO CtrlAiJobs/.test(sql))[1];
    expect(JSON.parse(job[6])).toEqual({ month: '2026-10' });
  });

  test('refused when the monthly budget is used up', async () => {
    setup([
      [/SUM\(CostUsd\), 0\) AS spend/, { rows: [{ spend: '30', calls: 9 }] }],
      [/SELECT QBOId FROM QBOs/, { rows: [{ qboid: QBO_ID }] }],
      [/FROM CtrlLedgerLines l\s+JOIN snaps/, { rows: [stored({ action: 'Approve', decisionentityid: 'ent-leb', scope: 'Line' })] }],
    ]);
    const res = await start({ kind: 'Backtest', qboId: QBO_ID, month: '2026-10' });
    expect(res.statusCode).toBe(409);
    expect(withTransaction).not.toHaveBeenCalled();
  });
});

test('a backtest\'s results: agreement overall and by confidence', async () => {
  setup([
    [/FROM CtrlAiJobs WHERE JobId/, { rows: [{ jobid: JOB_ID, kind: 'Backtest', qboid: QBO_ID, params: { month: '2026-10' }, linecount: 3, model: 'm' }] }],
    [/GROUP BY 1/, { rows: [{ status: 'Succeeded', n: 1, lines: 3 }] }],
    [/FROM CtrlAiCalls WHERE JobId/, { rows: [{ cost: '0.2' }] }],
    [
      /SELECT Result FROM CtrlAiBatches/,
      {
        rows: [
          {
            result: {
              kind: 'Class',
              answers: [
                { lineId: 'l1', action: 'Assign', entityId: 'ent-leb', rawConfidence: 0.95, reason: 'r1' },
                { lineId: 'l2', action: 'Assign', entityId: 'ent-leb', rawConfidence: 0.75, reason: 'r2' },
                { lineId: 'l3', action: 'Unsure', entityId: null, rawConfidence: 0.2, reason: 'r3' },
              ],
            },
          },
        ],
      },
    ],
    [
      /FROM CtrlLedgerLines l\s+JOIN snaps/,
      {
        rows: [
          stored({ action: 'Approve', decisionentityid: 'ent-leb', scope: 'Line' }),
          stored({ lineid: 'l2', fingerprint: 'f2', action: 'Reassign', decisionentityid: 'ent-mil', scope: 'Line' }),
          stored({ lineid: 'l3', fingerprint: 'f3', action: 'Keep', decisionentityid: 'ent-leb', scope: 'Line' }),
        ],
      },
    ],
  ]);
  const data = parseBody(await get('/api/controller/ai/jobs/{jobId}', {}, { jobId: JOB_ID }));
  expect(data.summary).toEqual({
    lines: 3, unsure: 1, agree: 1, disagree: 1,
    byConfidence: [{ level: 'High', lines: 1, agree: 1 }, { level: 'Medium', lines: 1, agree: 0 }, { level: 'Low', lines: 0, agree: 0 }],
  });
  // Disagreements first.
  expect(data.results[0]).toMatchObject({ lineId: 'l2', current: 'entity:ent-mil', aiOutcome: 'entity:ent-leb', matches: false });
  expect(data.finished).toBe(true);
});

test('usage: this month, the last months and the agree rate', async () => {
  setup([
    [/GROUP BY 1 ORDER BY 1/, { rows: [{ month: '2026-11', cost: '1.5', calls: 4, lines: 90 }] }],
    [/FROM CtrlAiSuggestions a/, { rows: [] }],
  ]);
  expect(parseBody(await get('/api/controller/ai/usage'))).toEqual({
    enabled: true, confidenceCap: 0.85, monthlyBudget: 25, redactPatientInfo: true, monthSpend: 1.5, monthCalls: 4,
    months: [{ month: '2026-11', costUsd: 1.5, calls: 4, lines: 90 }],
    agreement: { suggested: 0, decided: 0, agreed: 0, agreeRate: null },
  });
});

test('currentOutcomeKey', () => {
  const resolve = (cls) => (cls === 'Lebanon' ? 'ent-leb' : null);
  expect(currentOutcomeKey('Class', { className: 'Lebanon', decision: null }, resolve)).toBe('entity:ent-leb');
  expect(currentOutcomeKey('Class', { className: 'Lebanon', decision: { action: 'Reassign', entityId: 'ent-mil' } }, resolve)).toBe('entity:ent-mil');
  expect(currentOutcomeKey('Class', { className: 'X', decision: { action: 'Undo' } }, resolve)).toBeNull();
  expect(currentOutcomeKey('Class', { decision: { action: 'Split' } }, resolve)).toBe('split');
  expect(currentOutcomeKey('Account', { decision: null }, resolve)).toBe('keep');
});
