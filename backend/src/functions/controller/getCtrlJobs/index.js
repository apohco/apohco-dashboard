const { authorizeController } = require('../../../shared/controllerAuth');
const { requireGroupAccess } = require('../../../shared/authorize');
const { query } = require('../../../shared/db');
const { json, withErrorHandling } = require('../../../shared/response');
const { monthOf } = require('../../../shared/monthRanges');
const { deriveJobStatus, STALE_QUEUED_INTERVAL, STALE_RUNNING_INTERVAL } = require('../../../shared/ctrlJobs');

const RECENT_JOB_LIMIT = 25;

// Per-task status as shown to the user: Queued/Running tasks past their
// staleness window are reported as Stalled.
const TASK_STATUS_SQL = `CASE
  WHEN t.Status = 'Queued' AND j.CreatedDate <= now() - interval '${STALE_QUEUED_INTERVAL}' THEN 'Stalled'
  WHEN t.Status = 'Running' AND t.StartedDate <= now() - interval '${STALE_RUNNING_INTERVAL}' THEN 'Stalled'
  ELSE t.Status END`;

function shapeJob(row) {
  const counts = {
    queued: Number(row.queued),
    running: Number(row.running),
    succeeded: Number(row.succeeded),
    failed: Number(row.failed),
    stalled: Number(row.stalled),
  };
  return {
    jobId: row.jobid,
    qboId: row.qboid,
    qboName: row.qboname,
    fromMonth: monthOf(row.periodfrom),
    toMonth: monthOf(row.periodto),
    createdDate: row.createddate,
    requestedBy: row.requestedby,
    status: deriveJobStatus(counts),
    taskCounts: counts,
    lineCount: Number(row.linecount),
  };
}

const JOB_SELECT = `
  SELECT j.JobId, j.QBOId, q.QBOName, j.PeriodFrom, j.PeriodTo, j.CreatedDate, j.RequestedBy,
         COUNT(*) FILTER (WHERE s.status = 'Queued') AS queued,
         COUNT(*) FILTER (WHERE s.status = 'Running') AS running,
         COUNT(*) FILTER (WHERE s.status = 'Succeeded') AS succeeded,
         COUNT(*) FILTER (WHERE s.status = 'Failed') AS failed,
         COUNT(*) FILTER (WHERE s.status = 'Stalled') AS stalled,
         COALESCE(SUM(s.linecount), 0) AS linecount
  FROM CtrlSyncJobs j
  JOIN QBOs q ON q.QBOId = j.QBOId
  JOIN LATERAL (
    SELECT ${TASK_STATUS_SQL} AS status, t.LineCount AS linecount
    FROM CtrlSyncJobTasks t WHERE t.JobId = j.JobId
  ) s ON true`;

// GET /api/controller/jobs?groupId=          recent jobs for the Group
// GET /api/controller/jobs/{jobId}?groupId=  one job with its per-month tasks
exports.handler = withErrorHandling(async (event) => {
  const claims = await authorizeController(event);
  const groupId = event.queryStringParameters?.groupId;
  if (!groupId) {
    const err = new Error('groupId is required');
    err.statusCode = 400;
    throw err;
  }
  requireGroupAccess(claims, groupId);

  const jobId = event.pathParameters?.jobId;

  if (!jobId) {
    const { rows } = await query(
      `${JOB_SELECT}
       WHERE j.GroupId = $1
       GROUP BY j.JobId, q.QBOName
       ORDER BY j.CreatedDate DESC
       LIMIT ${RECENT_JOB_LIMIT}`,
      [groupId]
    );
    return json(200, rows.map(shapeJob));
  }

  const { rows } = await query(
    `${JOB_SELECT}
     WHERE j.GroupId = $1 AND j.JobId = $2
     GROUP BY j.JobId, q.QBOName`,
    [groupId, jobId]
  );
  if (!rows.length) {
    const err = new Error('Job not found');
    err.statusCode = 404;
    throw err;
  }

  const { rows: taskRows } = await query(
    `SELECT t.TaskId, t.Period, ${TASK_STATUS_SQL} AS status, t.Attempts, t.LineCount, t.Error,
            t.StartedDate, t.CompletedDate, sn.SnapshotId
     FROM CtrlSyncJobTasks t
     JOIN CtrlSyncJobs j ON j.JobId = t.JobId
     LEFT JOIN CtrlSnapshots sn ON sn.TaskId = t.TaskId
     WHERE t.JobId = $1 AND t.GroupId = $2
     ORDER BY t.Period`,
    [jobId, groupId]
  );

  return json(200, {
    ...shapeJob(rows[0]),
    tasks: taskRows.map((t) => ({
      taskId: t.taskid,
      month: monthOf(t.period),
      status: t.status,
      attempts: t.attempts,
      lineCount: t.linecount,
      error: t.error,
      startedDate: t.starteddate,
      completedDate: t.completeddate,
      snapshotId: t.snapshotid,
    })),
  });
});

exports.shapeJob = shapeJob;
