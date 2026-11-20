// Shared definitions for Controller sync jobs and their per-month tasks.

// A task that's been Queued this long without starting, or Running this
// long without finishing, is treated as stalled (e.g. its SQS message went
// to the dead-letter queue after the worker timed out). Stalled tasks
// don't block a new pull of the same file.
const STALE_QUEUED_INTERVAL = '2 hours';
const STALE_RUNNING_INTERVAL = '30 minutes';

// SQL predicate (task alias `t`, job alias `j`) for tasks still in flight.
const ACTIVE_TASK_SQL = `(
  (t.Status = 'Queued' AND j.CreatedDate > now() - interval '${STALE_QUEUED_INTERVAL}')
  OR (t.Status = 'Running' AND t.StartedDate > now() - interval '${STALE_RUNNING_INTERVAL}')
)`;

// Overall job status from its task counts. Derived on read rather than
// stored, so concurrent workers never race on a shared column.
function deriveJobStatus({ queued = 0, running = 0, succeeded = 0, failed = 0, stalled = 0 }) {
  const total = queued + running + succeeded + failed + stalled;
  if (total === 0) return 'Failed';
  if (queued + running > 0) return running > 0 || succeeded + failed > 0 ? 'Running' : 'Queued';
  if (failed + stalled === 0) return 'Succeeded';
  if (succeeded === 0) return stalled > 0 && failed === 0 ? 'Stalled' : 'Failed';
  return 'PartiallyFailed';
}

module.exports = { ACTIVE_TASK_SQL, STALE_QUEUED_INTERVAL, STALE_RUNNING_INTERVAL, deriveJobStatus };
