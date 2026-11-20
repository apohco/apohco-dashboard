jest.mock('../../src/shared/verifyToken', () => ({ requireAuth: jest.fn() }));
jest.mock('../../src/shared/db', () => ({ query: jest.fn(), withTransaction: jest.fn() }));
jest.mock('../../src/shared/ctrlQueue', () => ({ enqueueTasks: jest.fn() }));

const { requireAuth } = require('../../src/shared/verifyToken');
const { query, withTransaction } = require('../../src/shared/db');
const { enqueueTasks } = require('../../src/shared/ctrlQueue');
const { handler, validateMonths, MAX_MONTHS_PER_JOB } = require('../../src/functions/controller/startCtrlSync');
const { CONTROLLER_ADMIN, PLAIN_ADMIN, OWNER, sqlRouter, apiEvent, parseBody, sqlOf } = require('../helpers');

const body = { groupId: 'group-1', qboId: 'qbo-1', fromMonth: '2025-01', toMonth: '2025-03' };
const event = (b = body) => apiEvent({ method: 'POST', resource: '/api/controller/sync', body: b });

let client;

function setup({ qbo = { qboid: 'qbo-1', qboname: 'MGMT', isapiconnected: true }, active = [] } = {}) {
  requireAuth.mockResolvedValue(CONTROLLER_ADMIN);
  query.mockImplementation(sqlRouter([[/FROM QBOs/, { rows: qbo ? [qbo] : [] }]]));
  client = {
    query: sqlRouter([
      [/pg_advisory_xact_lock/, { rows: [] }],
      [/SELECT 1 FROM CtrlSyncJobTasks/, { rows: active }],
      [/INSERT INTO CtrlSyncJobs/, { rows: [{ jobid: 'job-1', createddate: '2026-11-19T00:00:00Z' }] }],
      [/SELECT TaskId FROM CtrlSyncJobTasks/, { rows: [{ taskid: 't1' }, { taskid: 't2' }, { taskid: 't3' }] }],
    ]),
  };
  withTransaction.mockImplementation((fn) => fn(client));
  enqueueTasks.mockResolvedValue([]);
}

describe('startCtrlSync access', () => {
  test('403 for a SoftwareAdmin outside ControllerOwner', async () => {
    setup();
    requireAuth.mockResolvedValue(PLAIN_ADMIN);
    const res = await handler(event());
    expect(res.statusCode).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });

  test('403 for an Owner', async () => {
    setup();
    requireAuth.mockResolvedValue(OWNER);
    expect((await handler(event())).statusCode).toBe(403);
  });

  test('401 when the token is invalid', async () => {
    setup();
    requireAuth.mockRejectedValue(Object.assign(new Error('Invalid or expired token'), { statusCode: 401 }));
    expect((await handler(event())).statusCode).toBe(401);
  });
});

describe('startCtrlSync validation', () => {
  test('400 when required fields are missing', async () => {
    setup();
    const res = await handler(event({ groupId: 'group-1' }));
    expect(res.statusCode).toBe(400);
  });

  test('404 when the QBO is not in the Group', async () => {
    setup({ qbo: null });
    const res = await handler(event());
    expect(res.statusCode).toBe(404);
    // The lookup is scoped by GroupId.
    expect(query.mock.calls[0][1]).toEqual(['qbo-1', 'group-1']);
  });

  test('400 for a manual-upload QBO with no API connection', async () => {
    setup({ qbo: { qboid: 'qbo-1', qboname: 'X', isapiconnected: false } });
    expect((await handler(event())).statusCode).toBe(400);
  });

  test('409 when a pull for that file is already running', async () => {
    setup({ active: [{ '?column?': 1 }] });
    const res = await handler(event());
    expect(res.statusCode).toBe(409);
    expect(enqueueTasks).not.toHaveBeenCalled();
  });
});

describe('validateMonths', () => {
  const now = new Date('2026-11-19T00:00:00Z');
  test('accepts a range up to the current month', () => {
    expect(validateMonths('2026-10', '2026-11', now)).toEqual(['2026-10', '2026-11']);
  });
  test.each([
    ['2026-13', '2026-13', 'formatted'],
    ['2026-10', '2026-09', 'before'],
    ['2026-11', '2026-12', 'future'],
  ])('rejects %s..%s (%s)', (from, to, msg) => {
    expect(() => validateMonths(from, to, now)).toThrow(new RegExp(msg));
  });
  test(`rejects more than ${MAX_MONTHS_PER_JOB} months`, () => {
    expect(() => validateMonths('2023-01', '2026-01', now)).toThrow(/at most/);
  });
});

describe('startCtrlSync success', () => {
  test('creates a job with one task per month, audits it, then queues the tasks', async () => {
    setup();
    const res = await handler(event());

    expect(res.statusCode).toBe(202);
    expect(parseBody(res)).toMatchObject({ jobId: 'job-1', taskCount: 3, notQueuedCount: 0 });

    const taskInsert = client.query.mock.calls.find(([sql]) => /INSERT INTO CtrlSyncJobTasks/.test(sql));
    expect(taskInsert[1]).toEqual([
      'job-1', 'group-1', 'qbo-1', '2025-01-01',
      'job-1', 'group-1', 'qbo-1', '2025-02-01',
      'job-1', 'group-1', 'qbo-1', '2025-03-01',
    ]);

    const audit = client.query.mock.calls.find(([sql]) => /INSERT INTO CtrlAuditLog/.test(sql));
    expect(audit[1]).toEqual(expect.arrayContaining(['group-1', 'user-paul', 'ctrl.sync.started']));

    expect(enqueueTasks).toHaveBeenCalledWith(['t1', 't2', 't3']);
  });

  test('takes a per-QBO lock before checking for an in-progress pull', async () => {
    setup();
    await handler(event());
    const sqls = sqlOf(client.query);
    expect(sqls[0]).toMatch(/pg_advisory_xact_lock/);
    expect(client.query.mock.calls[0][1]).toEqual(['ctrl-sync:qbo-1']);
  });

  test('marks tasks SQS would not accept as Failed', async () => {
    setup();
    enqueueTasks.mockResolvedValue(['t3']);
    const res = await handler(event());
    expect(parseBody(res).notQueuedCount).toBe(1);
    const fail = query.mock.calls.find(([sql]) => /UPDATE CtrlSyncJobTasks SET Status = 'Failed'/.test(sql));
    expect(fail[1]).toEqual([['t3']]);
  });
});
