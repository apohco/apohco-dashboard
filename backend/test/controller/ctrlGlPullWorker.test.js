jest.mock('../../src/shared/db', () => ({ query: jest.fn(), withTransaction: jest.fn() }));
jest.mock('../../src/shared/qboTokens', () => ({
  getValidAccessToken: jest.fn(),
  isRefreshTokenRejected: jest.requireActual('../../src/shared/qboTokens').isRefreshTokenRejected,
}));
jest.mock('../../src/shared/qboClient', () => {
  const actual = jest.requireActual('../../src/shared/qboClient');
  return {
    queryAccounts: jest.fn(),
    getGeneralLedgerReport: jest.fn(),
    flattenGeneralLedgerReport: actual.flattenGeneralLedgerReport,
    buildAccountLookup: actual.buildAccountLookup,
  };
});

const { query, withTransaction } = require('../../src/shared/db');
const { getValidAccessToken } = require('../../src/shared/qboTokens');
const { queryAccounts, getGeneralLedgerReport } = require('../../src/shared/qboClient');
const { handler, describeError, MAX_ATTEMPTS } = require('../../src/functions/controller/ctrlGlPullWorker');
const { generalLedgerReport, accounts } = require('../fixtures/generalLedger');
const { sqlRouter, sqlOf } = require('../helpers');

const sqsEvent = (taskId) => ({ Records: [{ messageId: 'm1', body: JSON.stringify({ taskId }) }] });
const claimed = (attempts = 1) => ({
  taskid: 'task-1', jobid: 'job-1', groupid: 'group-1', qboid: 'qbo-1', month: '2026-10', attempts,
});

let client;

beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => {}));
afterEach(() => console.error.mockRestore());

function setup({ task = claimed(), snapshotInserted = true } = {}) {
  query.mockImplementation(
    sqlRouter([
      [/UPDATE CtrlSyncJobTasks\s+SET Status = 'Running'/, { rows: task ? [task] : [] }],
      [/FROM QBOs/, { rows: [{ qboid: 'qbo-1', groupid: 'group-1', realmid: 'realm-9' }] }],
      [/FROM QBOClasses/, { rows: [{ qboclassid: 'class-lebanon', classname: 'Lebanon' }] }],
    ])
  );
  client = {
    query: sqlRouter([[/INSERT INTO CtrlSnapshots/, { rows: snapshotInserted ? [{ snapshotid: 'snap-1' }] : [] }]]),
  };
  withTransaction.mockImplementation((fn) => fn(client));
  getValidAccessToken.mockResolvedValue('access-token');
  queryAccounts.mockResolvedValue(accounts);
  getGeneralLedgerReport.mockResolvedValue(generalLedgerReport);
}

describe('ctrlGlPullWorker success', () => {
  test('pulls the month read-only and stores a snapshot with its lines', async () => {
    setup();
    const { results } = await handler(sqsEvent('task-1'));
    expect(results[0]).toMatchObject({ taskId: 'task-1', snapshotId: 'snap-1', lineCount: 3 });

    expect(getValidAccessToken).toHaveBeenCalledWith('qbo-1');
    expect(getGeneralLedgerReport).toHaveBeenCalledWith('realm-9', 'access-token', '2026-10-01', '2026-10-31');

    const snap = client.query.mock.calls.find(([sql]) => /INSERT INTO CtrlSnapshots/.test(sql));
    expect(snap[0]).toMatch(/ON CONFLICT \(TaskId\) DO NOTHING/);
    expect(snap[1].slice(0, 7)).toEqual(['group-1', 'qbo-1', '2026-10-01', 'task-1', 3, '142.10', '42.10']);

    const lines = client.query.mock.calls.find(([sql]) => /INSERT INTO CtrlLedgerLines/.test(sql));
    expect(lines[1]).toHaveLength(3 * 20);
    // Payee and resolved class id are stored on the line.
    expect(lines[1]).toEqual(expect.arrayContaining(['Kroger', 'Amazon', 'class-lebanon']));

    const done = client.query.mock.calls.find(([sql]) => /SET Status = 'Succeeded'/.test(sql));
    expect(done[1]).toEqual(['task-1', 3]);
    expect(sqlOf(client.query).some((s) => /INSERT INTO CtrlAuditLog/.test(s))).toBe(true);
  });

  test('never writes to the dashboard tables', async () => {
    setup();
    await handler(sqsEvent('task-1'));
    const all = [...sqlOf(query), ...sqlOf(client.query)];
    const writesToExisting = all.filter((s) =>
      /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(RawTransactions|ChartOfAccountsMappings|QBOClasses|QBOs)\b/i.test(s)
    );
    expect(writesToExisting).toEqual([]);
  });
});

describe('ctrlGlPullWorker idempotency', () => {
  test('does nothing for a task that is already finished', async () => {
    setup({ task: null });
    const { results } = await handler(sqsEvent('task-1'));
    expect(results[0]).toEqual({ taskId: 'task-1', skipped: true });
    expect(getGeneralLedgerReport).not.toHaveBeenCalled();
  });

  test('stores no lines when a duplicate delivery already saved the snapshot', async () => {
    setup({ snapshotInserted: false });
    const { results } = await handler(sqsEvent('task-1'));
    expect(results[0].duplicate).toBe(true);
    expect(sqlOf(client.query).some((s) => /CtrlLedgerLines/.test(s))).toBe(false);
  });

  test('ignores a malformed message', async () => {
    setup();
    const { results } = await handler({ Records: [{ messageId: 'm', body: 'not json' }] });
    expect(results).toEqual([]);
  });
});

describe('ctrlGlPullWorker failures', () => {
  const statusUpdate = () => query.mock.calls.find(([sql]) => /SET Status = \$2/.test(sql));

  test('a transient error before the last attempt re-queues and throws so SQS retries', async () => {
    setup({ task: claimed(1) });
    getGeneralLedgerReport.mockRejectedValue(Object.assign(new Error('socket hang up'), { response: { status: 503 } }));
    await expect(handler(sqsEvent('task-1'))).rejects.toThrow(/will be retried/);
    expect(statusUpdate()[1]).toEqual(['task-1', 'Queued', 'QBO HTTP 503 socket hang up']);
  });

  test(`attempt ${MAX_ATTEMPTS} fails the task permanently without throwing`, async () => {
    setup({ task: claimed(MAX_ATTEMPTS) });
    getGeneralLedgerReport.mockRejectedValue(new Error('timeout'));
    const { results } = await handler(sqsEvent('task-1'));
    expect(results[0]).toMatchObject({ failed: true });
    expect(statusUpdate()[1][1]).toBe('Failed');
  });

  test('a revoked QBO connection fails immediately', async () => {
    setup({ task: claimed(1) });
    getValidAccessToken.mockRejectedValue({ response: { status: 400, data: { error: 'invalid_grant' } }, message: 'Request failed' });
    const { results } = await handler(sqsEvent('task-1'));
    expect(results[0].failed).toBe(true);
    expect(statusUpdate()[1][1]).toBe('Failed');
  });
});

describe('describeError', () => {
  test('never includes request headers such as the bearer token', () => {
    const err = {
      message: 'Request failed with status code 500',
      config: { headers: { Authorization: 'Bearer SECRET-TOKEN' } },
      response: {
        status: 500,
        headers: { intuit_tid: 'tid-1' },
        data: { Fault: { Error: [{ Message: 'Internal', Detail: 'try later' }] } },
      },
    };
    const text = describeError(err);
    expect(text).toBe('QBO HTTP 500 Internal: try later (intuit_tid tid-1)');
    expect(text).not.toContain('SECRET');
  });

  test('caps the length', () => {
    expect(describeError(new Error('x'.repeat(5000))).length).toBe(1000);
  });
});
