jest.mock('../../src/shared/verifyToken', () => ({ requireAuth: jest.fn() }));
jest.mock('../../src/shared/db', () => ({ query: jest.fn() }));

const { requireAuth } = require('../../src/shared/verifyToken');
const { query } = require('../../src/shared/db');
const { handler, shapeJob } = require('../../src/functions/controller/getCtrlJobs');
const { CONTROLLER_ADMIN, PLAIN_ADMIN, sqlRouter, apiEvent, parseBody } = require('../helpers');

const jobRow = {
  jobid: 'job-1', qboid: 'qbo-1', qboname: 'MGMT', periodfrom: '2026-09-01', periodto: '2026-10-01',
  createddate: 'c', requestedby: 'user-paul', queued: '0', running: '1', succeeded: '1', failed: '0', stalled: '0', linecount: '40',
};

beforeEach(() => requireAuth.mockResolvedValue(CONTROLLER_ADMIN));

test('shapeJob derives status and converts counts', () => {
  expect(shapeJob(jobRow)).toMatchObject({
    jobId: 'job-1', fromMonth: '2026-09', toMonth: '2026-10', status: 'Running', lineCount: 40,
    taskCounts: { running: 1, succeeded: 1 },
  });
});

test('403 without ControllerOwner', async () => {
  requireAuth.mockResolvedValue(PLAIN_ADMIN);
  expect((await handler(apiEvent({ query: { groupId: 'group-1' } }))).statusCode).toBe(403);
});

test('400 without groupId', async () => {
  expect((await handler(apiEvent({ query: null }))).statusCode).toBe(400);
});

test('lists recent jobs for the Group only', async () => {
  query.mockImplementation(sqlRouter([[/FROM CtrlSyncJobs/, { rows: [jobRow] }]]));
  const res = await handler(apiEvent({ query: { groupId: 'group-1' } }));
  expect(parseBody(res)).toHaveLength(1);
  expect(query.mock.calls[0][0]).toMatch(/WHERE j.GroupId = \$1/);
  expect(query.mock.calls[0][1]).toEqual(['group-1']);
});

test('one job with its tasks', async () => {
  query.mockImplementation(
    sqlRouter([
      [/FROM CtrlSyncJobTasks t\s+JOIN/, { rows: [{ taskid: 't1', period: '2026-09-01', status: 'Succeeded', attempts: 1, linecount: 40, snapshotid: 's1' }] }],
      [/FROM CtrlSyncJobs/, { rows: [jobRow] }],
    ])
  );
  const data = parseBody(await handler(apiEvent({ query: { groupId: 'group-1' }, path: { jobId: 'job-1' } })));
  expect(data.tasks).toEqual([expect.objectContaining({ taskId: 't1', month: '2026-09', snapshotId: 's1' })]);
});

test('404 for a job in another Group', async () => {
  query.mockImplementation(sqlRouter([[/FROM CtrlSyncJobs/, { rows: [] }]]));
  const res = await handler(apiEvent({ query: { groupId: 'group-1' }, path: { jobId: 'job-x' } }));
  expect(res.statusCode).toBe(404);
});
