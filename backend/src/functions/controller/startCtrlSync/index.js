const { authorizeController } = require('../../../shared/controllerAuth');
const { requireGroupAccess } = require('../../../shared/authorize');
const { query, withTransaction } = require('../../../shared/db');
const { json, withErrorHandling } = require('../../../shared/response');
const { parseMonth, monthsBetween, currentMonth } = require('../../../shared/monthRanges');
const { insertRows } = require('../../../shared/bulkInsert');
const { enqueueTasks } = require('../../../shared/ctrlQueue');
const { recordAudit } = require('../../../shared/audit');
const { ACTIVE_TASK_SQL } = require('../../../shared/ctrlJobs');

const MAX_MONTHS_PER_JOB = 36;

function badRequest(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function validateMonths(fromMonth, toMonth, now) {
  if (!parseMonth(fromMonth) || !parseMonth(toMonth)) {
    throw badRequest('fromMonth and toMonth must be formatted YYYY-MM');
  }
  if (toMonth < fromMonth) throw badRequest('toMonth must not be before fromMonth');
  if (toMonth > currentMonth(now)) throw badRequest('Cannot pull a future month');
  const months = monthsBetween(fromMonth, toMonth);
  if (months.length > MAX_MONTHS_PER_JOB) {
    throw badRequest(`A single pull can cover at most ${MAX_MONTHS_PER_JOB} months`);
  }
  return months;
}

// POST /api/controller/sync
// Body: { groupId, qboId, fromMonth: "YYYY-MM", toMonth: "YYYY-MM" }
// Manually starts a read-only GL pull: one task per month, each queued for
// ctrlGlPullWorker. Returns 202 immediately; poll GET /api/controller/jobs/{jobId}.
exports.handler = withErrorHandling(async (event) => {
  const claims = await authorizeController(event);

  const { groupId, qboId, fromMonth, toMonth } = JSON.parse(event.body || '{}');
  if (!groupId || !qboId || !fromMonth || !toMonth) {
    throw badRequest('groupId, qboId, fromMonth and toMonth are required');
  }
  requireGroupAccess(claims, groupId);
  const months = validateMonths(fromMonth, toMonth, new Date());

  const { rows: qboRows } = await query(
    `SELECT QBOId, QBOName, (RefreshToken IS NOT NULL) AS isapiconnected
     FROM QBOs WHERE QBOId = $1 AND GroupId = $2`,
    [qboId, groupId]
  );
  const qbo = qboRows[0];
  if (!qbo) throw badRequest('QBO not found for this Group', 404);
  if (!qbo.isapiconnected) {
    throw badRequest('This QBO is not connected through the QuickBooks API, so it cannot be pulled');
  }

  const { job, tasks } = await withTransaction(async (client) => {
    // Serialize job creation per QBO (released at commit) so two clicks
    // can't both pass the in-progress check.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`ctrl-sync:${qboId}`]);
    const { rows: active } = await client.query(
      `SELECT 1 FROM CtrlSyncJobTasks t JOIN CtrlSyncJobs j ON j.JobId = t.JobId
       WHERE t.QBOId = $1 AND ${ACTIVE_TASK_SQL} LIMIT 1`,
      [qboId]
    );
    if (active.length) {
      throw badRequest(`A pull for ${qbo.qboname} is already in progress; wait for it to finish`, 409);
    }

    const { rows: jobRows } = await client.query(
      `INSERT INTO CtrlSyncJobs (GroupId, QBOId, PeriodFrom, PeriodTo, RequestedBy)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING JobId, CreatedDate`,
      [groupId, qboId, `${fromMonth}-01`, `${toMonth}-01`, claims.userId]
    );
    const jobRow = jobRows[0];

    await insertRows(
      client,
      'CtrlSyncJobTasks',
      ['JobId', 'GroupId', 'QBOId', 'Period'],
      months.map((m) => [jobRow.jobid, groupId, qboId, `${m}-01`])
    );
    const { rows: taskRows } = await client.query(
      `SELECT TaskId FROM CtrlSyncJobTasks WHERE JobId = $1 ORDER BY Period`,
      [jobRow.jobid]
    );

    await recordAudit(
      {
        groupId,
        userId: claims.userId,
        action: 'ctrl.sync.started',
        targetType: 'CtrlSyncJob',
        targetId: jobRow.jobid,
        details: { qboId, fromMonth, toMonth, months: months.length },
      },
      client
    );

    return { job: jobRow, tasks: taskRows };
  });

  // Enqueued only after the commit, so a worker can never pick up a task
  // whose row doesn't exist yet.
  const notQueued = await enqueueTasks(tasks.map((t) => t.taskid));
  if (notQueued.length) {
    await query(
      `UPDATE CtrlSyncJobTasks SET Status = 'Failed', Error = 'Could not be queued; start the pull again',
         CompletedDate = now()
       WHERE TaskId = ANY($1::uuid[])`,
      [notQueued]
    );
  }

  return json(202, {
    jobId: job.jobid,
    qboId,
    fromMonth,
    toMonth,
    taskCount: tasks.length,
    notQueuedCount: notQueued.length,
    createdDate: job.createddate,
  });
});

exports.validateMonths = validateMonths;
exports.MAX_MONTHS_PER_JOB = MAX_MONTHS_PER_JOB;
