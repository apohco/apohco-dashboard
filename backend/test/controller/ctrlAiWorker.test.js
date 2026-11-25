jest.mock('../../src/shared/db', () => ({ query: jest.fn(), withTransaction: jest.fn() }));
jest.mock('../../src/shared/bedrock', () => ({
  classify: jest.fn(),
  isRetryable: jest.requireActual('../../src/shared/bedrock').isRetryable,
  modelId: () => 'us.anthropic.claude-opus-5-5',
}));

const { query } = require('../../src/shared/db');
const { classify } = require('../../src/shared/bedrock');
const worker = require('../../src/functions/controller/ctrlAiWorker');
const { sqlRouter, sqlOf } = require('../helpers');

const RUN_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const ENTITY_ROWS = [
  { entityid: 'ent-leb', entityname: 'Lebanon', managementqboclassid: 'cls-leb', managementclassname: 'Lebanon', aliases: [], keywords: [] },
  { entityid: 'ent-mil', entityname: 'Milford', managementqboclassid: 'cls-mil', managementclassname: 'Milford', aliases: [], keywords: [] },
];
const LINE_ROWS = [
  {
    lineid: 'l1', fingerprint: 'f1', qboid: 'qbo-mgmt', txndate: '2026-10-03', txntype: 'Bill', payeename: 'Kroger', memo: 'Milford snacks',
    accountcode: '6100', accountname: 'Supplies', classname: 'Lebanon', qboclassid: 'cls-leb', amount: '42.10', month: '2026-10',
    status: 'NeedsEvidence', reasons: ['History: 55% Lebanon'], suggestionvendorid: 'v-kroger',
  },
  {
    lineid: 'l2', fingerprint: 'f2', qboid: 'qbo-mgmt', txndate: '2026-10-09', txntype: 'Refund Receipt', payeename: 'Jane Doe', memo: 'refund Jane',
    accountcode: '4900', accountname: 'Patient Refunds', classname: '', qboclassid: null, amount: '-80', month: '2026-10',
    status: 'NeedsEvidence', reasons: [], suggestionvendorid: 'v-jane',
  },
];
const claimRow = (over = {}) => ({
  batchid: 'b1', jobid: 'j1', groupid: 'group-1', lineids: ['l1', 'l2'], attempts: 1, kind: 'Review', runid: RUN_ID, vendorid: null, qboid: 'qbo-mgmt', params: {}, ...over,
});

function setup({ claim = claimRow(), settings = [], spend = '0', routes = [] } = {}) {
  query.mockImplementation(
    sqlRouter([
      ...routes,
      [/UPDATE CtrlAiBatches b SET Status = 'Running'/, { rows: claim ? [claim] : [] }],
      [/FROM CtrlReviewSettings/, { rows: settings }],
      [/FROM CtrlAiCalls/, { rows: [{ spend, calls: 0 }] }],
      [/FROM CtrlLedgerLines l\s+JOIN CtrlSnapshots sn/, { rows: LINE_ROWS }],
      [/SELECT IsClassBased FROM QBOs/, { rows: [{ isclassbased: true }] }],
      [/FROM CtrlEntities e/, { rows: ENTITY_ROWS }],
      [/FROM CtrlVendorRules/, { rows: [{ ruleid: 'r1', vendorid: 'v-kroger', version: 3, defaultentityid: null, hints: {}, ruletext: 'Snacks go where the memo says' }] }],
      [
        /FROM CtrlVendorAliases a JOIN CtrlVendors/,
        { rows: [{ payeekey: 'kroger', vendorid: 'v-kroger', displayname: 'Kroger' }, { payeekey: 'jane doe', vendorid: 'v-jane', displayname: 'Jane Doe' }] },
      ],
      [
        /FROM CtrlDecisions d JOIN CtrlLedgerLines l/,
        {
          rows: [
            { fingerprint: 'f9', action: 'Reassign', entityid: 'ent-mil', txndate: '2026-09-02', payeename: 'Kroger', memo: 'Milford', accountcode: '6100', accountname: 'Supplies', amount: '9', pkey: 'kroger', akey: 'code:6100' },
          ],
        },
      ],
      [/FROM CtrlUploads/, { rows: [] }],
      [/FROM ChartOfAccountsMappings/, { rows: [{ accountcode: '6100', accountname: 'Supplies', classification: 'Expense' }, { accountcode: '2570', accountname: 'Card', classification: 'Liability' }] }],
      [
        /WITH snaps AS/,
        {
          rows: [
            { payeename: 'Kroger', accountcode: '6100', classname: 'Lebanon', qboclassid: 'cls-leb', action: null, n: 11 },
            // The card side of the same purchases: left out of the history.
            { payeename: 'Kroger', accountcode: '2570', classname: '', qboclassid: null, action: null, n: 11 },
          ],
        },
      ],
    ])
  );
}

const answer = (answers) => ({
  text: JSON.stringify({ answers }),
  stopReason: 'end_turn',
  usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 800 },
  costUsd: 0.0158,
  durationMs: 4200,
  model: 'us.anthropic.claude-opus-5-5',
});
const callsTo = (re) => query.mock.calls.filter(([sql]) => re.test(sql));

describe('processBatch (review job)', () => {
  test('asks the model with the context, stores capped suggestions and logs the call', async () => {
    setup();
    classify.mockResolvedValue(
      answer([
        { line: 'L1', outcome: 'E2', confidence: 0.93, reason: 'Memo says Milford', used_rule: true },
        { line: 'L2', outcome: 'UNSURE', confidence: 0.1, reason: 'Withheld', used_rule: false },
      ])
    );
    const out = await worker.processBatch('b1');
    expect(out).toEqual({ batchId: 'b1', status: 'Succeeded', answered: 2 });

    const prompt = classify.mock.calls[0][0];
    expect(prompt.user).toMatch(/## Vendor: Kroger/);
    expect(prompt.user).toMatch(/Written rule: """Snacks go where the memo says"""/);
    // Only the P&L side: the card lines aren't counted ("no class 11 lines").
    expect(prompt.user).toMatch(/Past months: over the previous 12 months: Lebanon 11 lines\n/);
    expect(prompt.user).toMatch(/2026-09-02 \| payee "Kroger" \| memo "Milford" .*=> E2 Milford/);
    expect(prompt.user).toMatch(/engine: NeedsEvidence; History: 55% Lebanon/);
    // The refund line and its payee's vendor heading are withheld.
    expect(prompt.user).not.toMatch(/Jane/);

    const [, params] = callsTo(/INSERT INTO CtrlAiSuggestions/)[0];
    // 14 columns per row; the 0.93 is capped at the default 0.85.
    expect(params.slice(0, 14)).toEqual([
      RUN_ID, 'group-1', 'l1', 'j1', 'Assign', 'ent-mil', null, null, 0.85, 0.93, 'Memo says Milford', true, false, 'us.anthropic.claude-opus-5-5',
    ]);
    expect(params.slice(14, 28)).toEqual([
      RUN_ID, 'group-1', 'l2', 'j1', 'Unsure', null, null, null, 0, 0.1, 'Withheld', false, true, 'us.anthropic.claude-opus-5-5',
    ]);
    expect(callsTo(/INSERT INTO CtrlAiSuggestions/)[0][0]).toMatch(/ON CONFLICT \(RunId, LineId\) DO NOTHING/);

    const [, log] = callsTo(/INSERT INTO CtrlAiCalls/)[0];
    expect(log).toEqual(['group-1', 'j1', 'b1', 'us.anthropic.claude-opus-5-5', 2, 1200, 0, 800, 300, 0.0158, 4200, 'end_turn', null]);
    const finish = callsTo(/UPDATE CtrlAiBatches SET Status = \$2/)[0][1];
    expect(finish.slice(0, 3)).toEqual(['b1', 'Succeeded', null]);
  });

  test('examples never include the batch lines themselves', async () => {
    setup();
    classify.mockResolvedValue(answer([]));
    await worker.processBatch('b1').catch(() => {});
    const [, params] = callsTo(/FROM CtrlDecisions d JOIN CtrlLedgerLines l/)[0];
    expect(params[4]).toEqual(['f1', 'f2']);
  });

  test('nothing to do when the batch is already finished (SQS redelivery)', async () => {
    setup({ claim: null });
    expect(await worker.processBatch('b1')).toEqual({ batchId: 'b1', status: 'Skipped (nothing to do)' });
    expect(classify).not.toHaveBeenCalled();
  });

  test('skipped when AI is off, or the monthly budget is used up', async () => {
    setup({ settings: [{ threshold: '0.9', mediumthreshold: '0.7', historymonths: 12, aienabled: false }] });
    expect((await worker.processBatch('b1')).status).toBe('Skipped');
    setup({ spend: '25.10' });
    expect((await worker.processBatch('b1')).status).toBe('Skipped');
    expect(callsTo(/UPDATE CtrlAiBatches SET Status = \$2/).pop()[1][2]).toMatch(/budget \(\$25\) has been reached/);
    expect(classify).not.toHaveBeenCalled();
  });

  test('a throttled call is retried by SQS until the last attempt', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    setup();
    classify.mockRejectedValue(Object.assign(new Error('Too many requests'), { status: 429 }));
    await expect(worker.processBatch('b1')).rejects.toThrow('Too many requests');
    expect(callsTo(/INSERT INTO CtrlAiCalls/)[0][1][12]).toBe('HTTP 429: Too many requests');

    setup({ claim: claimRow({ attempts: 3 }) });
    expect((await worker.processBatch('b1')).status).toBe('Failed');
  });

  test('a request error fails the batch at once', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    setup();
    classify.mockRejectedValue(Object.assign(new Error('Bad request'), { status: 400 }));
    expect((await worker.processBatch('b1')).status).toBe('Failed');
  });

  test('a refusal fails the batch; the lines stay for manual review', async () => {
    setup();
    classify.mockResolvedValue({ ...answer([]), stopReason: 'refusal', text: '' });
    expect((await worker.processBatch('b1')).status).toBe('Failed');
    expect(callsTo(/INSERT INTO CtrlAiSuggestions/)).toHaveLength(0);
  });

  test('an unusable answer is retried, then fails', async () => {
    setup();
    classify.mockResolvedValue({ ...answer([]), text: 'not json' });
    await expect(worker.processBatch('b1')).rejects.toThrow(/not valid JSON/);
    setup({ claim: claimRow({ attempts: 3 }) });
    expect((await worker.processBatch('b1')).status).toBe('Failed');
  });
});

describe('rule test and backtest jobs', () => {
  test('a rule test uses the draft rule and keeps the answers on the batch', async () => {
    setup({ claim: claimRow({ kind: 'RuleTest', runid: null, vendorid: 'v-kroger', params: { ruleText: 'DRAFT: all Kroger is Milford', months: 3 } }) });
    classify.mockResolvedValue(answer([{ line: 'L1', outcome: 'E2', confidence: 0.9, reason: 'Draft rule', used_rule: true }]));
    await worker.processBatch('b1');
    expect(classify.mock.calls[0][0].user).toMatch(/Written rule: """DRAFT: all Kroger is Milford"""/);
    // No engine note outside a review job.
    expect(classify.mock.calls[0][0].user).not.toMatch(/engine:/);
    expect(callsTo(/INSERT INTO CtrlAiSuggestions/)).toHaveLength(0);
    const finish = callsTo(/UPDATE CtrlAiBatches SET Status = \$2/)[0][1];
    expect(JSON.parse(finish[3])).toMatchObject({ kind: 'Class', answers: [{ lineId: 'l1', action: 'Assign', entityId: 'ent-mil', rawConfidence: 0.9 }] });
  });
});

test('handler: one message per batch, malformed ones ignored', async () => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  setup({ claim: null });
  const out = await worker.handler({ Records: [{ body: JSON.stringify({ batchId: 'b1' }) }, { body: 'oops', messageId: 'm2' }] });
  expect(out.results).toHaveLength(1);
});

describe('helpers', () => {
  test('classHistoryText: decisions over classes, splits counted apart', () => {
    const rows = [
      { payeename: 'Kroger', classname: 'Lebanon', qboclassid: 'cls-leb', action: null, n: 5 },
      { payeename: 'Kroger', classname: 'Lebanon', qboclassid: 'cls-leb', action: 'Reassign', decisionentityid: 'ent-mil', n: 2 },
      { payeename: 'Kroger', classname: '', qboclassid: null, action: 'Split', n: 1 },
      { payeename: 'Kroger', classname: 'Old', qboclassid: null, action: null, n: 1 },
      { payeename: 'Other', classname: 'Milford', qboclassid: 'cls-mil', action: null, n: 50 },
    ];
    const entities = ENTITY_ROWS.map((e) => ({ entityId: e.entityid, entityName: e.entityname, managementQboClassId: e.managementqboclassid, managementClassName: e.managementclassname, aliases: [] }));
    expect(worker.classHistoryText(rows, (r) => r.payeename === 'Kroger', entities, 12)).toBe(
      'over the previous 12 months: Lebanon 5 lines, Milford 2 lines, split between entities 1 line, class "Old" (not linked to an entity) 1 line'
    );
    expect(worker.classHistoryText([], () => true, entities, 12)).toBeNull();
  });

  test('accountHistoryText: where lines ended up', () => {
    const rows = [
      { accountcode: '6100', accountname: 'Supplies', action: null, n: 4 },
      { accountcode: '6100', accountname: 'Supplies', action: 'DueToFrom', targetaccountcode: '1500', targetaccountname: 'Due From Lebanon', n: 2 },
    ];
    expect(worker.accountHistoryText(rows, () => true, 6)).toBe('over the previous 6 months: 6100 Supplies 4 lines, 1500 Due From Lebanon 2 lines');
  });

  test('exampleOutcome', () => {
    expect(worker.exampleOutcome('Class', { action: 'Approve', entityid: 'e1' })).toEqual({ entityId: 'e1' });
    expect(worker.exampleOutcome('Class', { action: 'Split', allocations: [{ entityId: 'e1', amount: 30 }, { entityId: 'e2', amount: 70 }] })).toEqual({
      split: [{ entityId: 'e1', share: 0.3 }, { entityId: 'e2', share: 0.7 }],
    });
    expect(worker.exampleOutcome('Account', { action: 'Keep' })).toEqual({ keep: true });
    expect(worker.exampleOutcome('Account', { action: 'DueToFrom', counterpartyentityid: 'e2' })).toEqual({ dueEntityId: 'e2' });
    expect(worker.exampleOutcome('Account', { action: 'Reclassify', targetaccountcode: '6150', targetaccountname: 'Breakroom' })).toEqual({ accountKey: 'code:6150' });
  });

  test('ruleNote', () => {
    const entities = [{ entityId: 'e1', entityName: 'Lebanon' }];
    expect(worker.ruleNote({ defaultEntityId: 'e1', hints: { keywords: [{ keyword: 'Main St', entityId: 'e1' }] } }, entities)).toBe('defaults to Lebanon; "Main St" means Lebanon');
    expect(worker.ruleNote({ hints: {} }, entities)).toBeNull();
  });
});

test('the worker never calls QuickBooks', () => {
  expect(sqlOf(query).every((s) => !/QBOTokens|AccessToken/.test(s))).toBe(true);
});
