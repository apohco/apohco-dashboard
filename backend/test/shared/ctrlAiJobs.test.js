jest.mock('../../src/shared/db', () => ({ query: jest.fn(), withTransaction: jest.fn() }));
jest.mock('../../src/shared/ctrlQueue', () => ({ enqueueAiBatches: jest.fn() }));

const { query, withTransaction } = require('../../src/shared/db');
const { enqueueAiBatches } = require('../../src/shared/ctrlQueue');
const { startReviewAiJob, jobStatus, aiAgreement, monthSpend } = require('../../src/shared/ctrlAiJobs');
const { classify, isRetryable } = require('../../src/shared/bedrock');
const { enqueueAiBatches: realEnqueue } = jest.requireActual('../../src/shared/ctrlQueue');
const { sqlRouter } = require('../helpers');

const SETTINGS = { threshold: 0.9, aiEnabled: true, aiMonthlyBudget: 25 };
const RUN = { runId: 'run-1', qboId: 'qbo-1' };
const candidate = (over) => ({
  lineid: 'l1', fingerprint: 'f1', vendorid: 'v1', status: 'NeedsEvidence', confidence: '0.4', source: 'History',
  payeename: 'Kroger', accountcode: '6100', accountname: 'Supplies', amount: '10', accounttype: 'Expense', decided: false, hasai: false, ...over,
});

let client;
let batchSeq;
function setup({ candidates = [], spend = '0' } = {}) {
  batchSeq = 0;
  query.mockImplementation(
    sqlRouter([
      [/FROM CtrlAiCalls/, { rows: [{ spend, calls: 3 }] }],
      [/FROM CtrlSuggestions s/, { rows: candidates }],
      [/UPDATE CtrlAiBatches SET Status = 'Failed'/, { rows: [] }],
    ])
  );
  client = {
    query: sqlRouter([
      [/INSERT INTO CtrlAiJobs/, { rows: [{ jobid: 'job-1' }] }],
      [/INSERT INTO CtrlAiBatches/, () => ({ rows: [{ batchid: `b${(batchSeq += 1)}` }] })],
    ]),
  };
  withTransaction.mockImplementation((fn) => fn(client));
  enqueueAiBatches.mockResolvedValue([]);
}

describe('startReviewAiJob', () => {
  test('picks the unsure, undecided lines, batches them and queues each batch', async () => {
    setup({
      candidates: [
        candidate({}),
        candidate({ lineid: 'l2', fingerprint: 'f2', confidence: '0.97', status: 'Confirmed' }),
        candidate({ lineid: 'l3', fingerprint: 'f3', decided: true }),
        candidate({ lineid: 'l4', fingerprint: 'f4', vendorid: 'v2', amount: '99' }),
      ],
    });
    const out = await startReviewAiJob({ groupId: 'group-1', run: RUN, settings: SETTINGS, rules: new Map(), userId: 'u' });
    expect(out).toEqual({ jobId: 'job-1', lineCount: 2, batchCount: 1, failedToQueue: 0 });
    const batchInsert = client.query.mock.calls.find(([sql]) => /INSERT INTO CtrlAiBatches/.test(sql));
    expect(batchInsert[1]).toEqual(['job-1', 'group-1', ['l4', 'l1']]);
    const jobInsert = client.query.mock.calls.find(([sql]) => /INSERT INTO CtrlAiJobs/.test(sql));
    expect(jobInsert[1].slice(0, 6)).toEqual(['group-1', 'Review', 'run-1', null, 'qbo-1', 'us.anthropic.claude-opus-5-5']);
    expect(enqueueAiBatches).toHaveBeenCalledWith(['b1']);
  });

  test('nothing is sent when AI is off, over budget, or no line needs it', async () => {
    setup({ candidates: [candidate({})] });
    expect(await startReviewAiJob({ groupId: 'g', run: RUN, settings: { ...SETTINGS, aiEnabled: false }, rules: new Map() })).toEqual({
      skipped: 'AI matching is turned off in Review settings',
    });
    setup({ candidates: [candidate({})], spend: '25' });
    expect((await startReviewAiJob({ groupId: 'g', run: RUN, settings: SETTINGS, rules: new Map() })).skipped).toMatch(/budget/);
    setup({ candidates: [candidate({ confidence: '0.99' })] });
    expect((await startReviewAiJob({ groupId: 'g', run: RUN, settings: SETTINGS, rules: new Map() })).skipped).toBe('No lines need the AI');
    expect(withTransaction).not.toHaveBeenCalled();
  });

  test('re-running skips lines that already have an AI answer', async () => {
    setup({ candidates: [candidate({ hasai: true }), candidate({ lineid: 'l2', fingerprint: 'f2' })] });
    const out = await startReviewAiJob({ groupId: 'g', run: RUN, settings: SETTINGS, rules: new Map(), onlyMissing: true });
    expect(out.lineCount).toBe(1);
  });

  test('a batch SQS refused is marked Failed', async () => {
    setup({ candidates: [candidate({})] });
    enqueueAiBatches.mockResolvedValue(['b1']);
    const out = await startReviewAiJob({ groupId: 'g', run: RUN, settings: SETTINGS, rules: new Map() });
    expect(out.failedToQueue).toBe(1);
    expect(query.mock.calls.find(([sql]) => /UPDATE CtrlAiBatches SET Status = 'Failed'/.test(sql))[1]).toEqual([['b1']]);
  });
});

test('monthSpend', async () => {
  setup({ spend: '3.2500' });
  expect(await monthSpend('g')).toEqual({ spend: 3.25, calls: 3 });
});

test('jobStatus: counts batches (stalled apart), cost and errors', async () => {
  query.mockImplementation(
    sqlRouter([
      [/FROM CtrlAiJobs WHERE JobId/, { rows: [{ jobid: 'j1', kind: 'Review', runid: 'r1', model: 'm', params: {}, linecount: 40 }] }],
      [/GROUP BY 1/, { rows: [{ status: 'Succeeded', n: 1, lines: 25 }, { status: 'Running', n: 1, lines: 15 }] }],
      [/SUM\(CostUsd\)/, { rows: [{ cost: '0.4100' }] }],
      [/SELECT DISTINCT Error/, { rows: [] }],
    ])
  );
  expect(await jobStatus('g', 'j1')).toMatchObject({
    jobId: 'j1', batches: { Succeeded: 1, Running: 1, Queued: 0 }, batchCount: 2, finished: false, costUsd: 0.41,
  });
});

test('aiAgreement: compares the latest AI answer with the decision made since', async () => {
  query.mockImplementation(
    sqlRouter([
      [
        /FROM CtrlAiSuggestions a/,
        {
          rows: [
            { suggestedaction: 'Assign', suggestedentityid: 'ent-mil', reviewkind: 'Class', action: 'Approve', entityid: 'ent-mil' },
            { suggestedaction: 'Assign', suggestedentityid: 'ent-mil', reviewkind: 'Class', action: 'Reassign', entityid: 'ent-leb' },
            { suggestedaction: 'Assign', suggestedentityid: 'ent-leb', reviewkind: 'Class', classname: 'Lebanon', qboclassid: 'cls-leb', action: 'Keep', entityid: null },
            { suggestedaction: 'Reclassify', suggestedaccountcode: '6150', suggestedaccountname: 'Breakroom', reviewkind: 'Account', action: 'Reclassify', targetaccountcode: '6150', targetaccountname: 'Breakroom' },
            { suggestedaction: 'Keep', reviewkind: 'Account', action: null },
          ],
        },
      ],
      [/FROM CtrlEntities e/, { rows: [{ entityid: 'ent-leb', entityname: 'Lebanon', managementqboclassid: 'cls-leb', managementclassname: 'Lebanon' }] }],
    ])
  );
  expect(await aiAgreement('g')).toEqual({ suggested: 5, decided: 4, agreed: 3, agreeRate: 0.75 });
  expect(query.mock.calls[0][1]).toEqual(['g', 180]);
  await aiAgreement('g', { vendorId: 'v1' });
  expect(query.mock.calls.find(([sql]) => /s.VendorId = \$3/.test(sql))[1]).toEqual(['g', 180, 'v1']);
});

describe('bedrock', () => {
  test('classify sends the cached file context and the strict output format', async () => {
    const create = jest.fn().mockResolvedValue({
      content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"answers":[]}' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 },
    });
    const out = await classify({ system: 'S', context: 'C', user: 'U' }, { anthropic: { messages: { create } } });
    const req = create.mock.calls[0][0];
    expect(req.model).toBe('us.anthropic.claude-opus-5-5');
    expect(req.system).toEqual([{ type: 'text', text: 'S' }, { type: 'text', text: 'C', cache_control: { type: 'ephemeral' } }]);
    expect(req.messages).toEqual([{ role: 'user', content: 'U' }]);
    expect(req.output_config.effort).toBe('low');
    expect(req.output_config.format.type).toBe('json_schema');
    expect(req.thinking).toBeUndefined();
    expect(out).toMatchObject({ text: '{"answers":[]}', stopReason: 'end_turn', model: 'us.anthropic.claude-opus-5-5' });
    // 1000 x 4.4 + 2000 x 0.44 + 100 x 22, per million.
    expect(out.costUsd).toBe(0.0075);
  });

  test('isRetryable', () => {
    expect(isRetryable({ status: 429 })).toBe(true);
    expect(isRetryable({ status: 529 })).toBe(true);
    expect(isRetryable({ name: 'APIConnectionTimeoutError', message: 'Request timed out.' })).toBe(true);
    expect(isRetryable({ status: 400 })).toBe(false);
    expect(isRetryable({ status: 403 })).toBe(false);
  });
});

test('enqueueAiBatches sends one { batchId } message per batch', async () => {
  const sqs = { send: jest.fn().mockResolvedValue({ Failed: [] }) };
  await realEnqueue(['b1', 'b2'], { queueUrl: 'https://q', sqs });
  const entries = sqs.send.mock.calls[0][0].input.Entries;
  expect(entries.map((e) => JSON.parse(e.MessageBody))).toEqual([{ batchId: 'b1' }, { batchId: 'b2' }]);
  await expect(realEnqueue(['b1'], { queueUrl: '', sqs })).rejects.toThrow(/CTRL_AI_QUEUE_URL/);
});
