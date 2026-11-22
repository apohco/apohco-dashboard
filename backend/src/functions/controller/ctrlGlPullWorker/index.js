const { query, withTransaction } = require('../../../shared/db');
const { getValidAccessToken, isRefreshTokenRejected } = require('../../../shared/qboTokens');
const {
  queryAccounts,
  getGeneralLedgerReport,
  flattenGeneralLedgerReport,
  buildAccountLookup,
} = require('../../../shared/qboClient');
const { fingerprintLines, snapshotHash } = require('../../../shared/ledgerFingerprint');
const { monthBounds } = require('../../../shared/monthRanges');
const { insertRows } = require('../../../shared/bulkInsert');
const { recordAudit } = require('../../../shared/audit');

// Must match maxReceiveCount on the queue's redrive policy (template.yaml).
const MAX_ATTEMPTS = 3;
const MAX_ERROR_LENGTH = 1000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const LINE_COLUMNS = [
  'GroupId', 'SnapshotId', 'QBOId', 'Fingerprint', 'ContentHash', 'TxnDate', 'TxnType', 'DocNum',
  'QBOTxnId', 'PayeeName', 'PayeeQBOId', 'Memo', 'AccountCode', 'AccountName', 'ClassName',
  'QBOClassId', 'Debit', 'Credit', 'Amount', 'SplitAccount',
];

// A short, token-free description of an error. axios errors carry the
// request config (including the Authorization header), so the raw error
// object is never logged or stored.
function describeError(err) {
  const status = err?.response?.status;
  const intuitTid = err?.response?.headers?.intuit_tid;
  const fault = err?.response?.data?.Fault?.Error?.[0];
  const detail = fault ? `${fault.Message}${fault.Detail ? `: ${fault.Detail}` : ''}` : null;
  const parts = [
    status ? `QBO HTTP ${status}` : null,
    detail || err?.message || 'Unknown error',
    intuitTid ? `(intuit_tid ${intuitTid})` : null,
  ].filter(Boolean);
  return parts.join(' ').slice(0, MAX_ERROR_LENGTH);
}

// Errors retrying can't fix: the connection was revoked or expired, or the
// task's QBO/request is invalid.
function isPermanent(err) {
  if (isRefreshTokenRejected(err)) return true;
  if (err?.statusCode === 400 || err?.statusCode === 404) return true;
  const status = err?.response?.status;
  return status === 401 || status === 403;
}

// Atomically marks the task Running. Returns null when there's nothing to
// do (already Succeeded/Failed, or the task no longer exists), which makes
// SQS redeliveries harmless.
async function claimTask(taskId) {
  const { rows } = await query(
    `UPDATE CtrlSyncJobTasks
     SET Status = 'Running', Attempts = Attempts + 1, StartedDate = now(), Error = NULL
     WHERE TaskId = $1 AND Status IN ('Queued', 'Running')
     RETURNING TaskId, JobId, GroupId, QBOId, TO_CHAR(Period, 'YYYY-MM') AS month, Attempts`,
    [taskId]
  );
  return rows[0] || null;
}

async function loadClassIds(qboId) {
  const { rows } = await query(`SELECT QBOClassId, ClassName FROM QBOClasses WHERE QBOId = $1`, [qboId]);
  return new Map(rows.map((r) => [r.classname, r.qboclassid]));
}

// Pulls one month's General Ledger for one QBO (read-only API calls) and
// stores it as a new snapshot. Never writes to QBO, and never changes the
// dashboard's own tables (RawTransactions, ChartOfAccountsMappings, ...).
async function pullMonth(task) {
  const { rows: qboRows } = await query(
    `SELECT QBOId, GroupId, RealmId FROM QBOs WHERE QBOId = $1 AND GroupId = $2`,
    [task.qboid, task.groupid]
  );
  const qbo = qboRows[0];
  if (!qbo) {
    const err = new Error('QBO not found (it may have been removed)');
    err.statusCode = 404;
    throw err;
  }

  const { startDate, endDate } = monthBounds(task.month);
  const accessToken = await getValidAccessToken(qbo.qboid);
  const accounts = await queryAccounts(qbo.realmid, accessToken);
  const report = await getGeneralLedgerReport(qbo.realmid, accessToken, startDate, endDate);
  const classIds = await loadClassIds(qbo.qboid);

  const lines = fingerprintLines(
    qbo.qboid,
    flattenGeneralLedgerReport(report, buildAccountLookup(accounts))
      // Keep only real dated lines: drops subtotal/summary rows and any
      // label (e.g. an opening balance row) QBO puts in the date column.
      .filter((row) => ISO_DATE.test(row.transactionDate || ''))
      .map((row) => ({
        txnDate: row.transactionDate,
        txnType: row.transactionType,
        docNum: row.docNum,
        qboTxnId: row.qboTxnId,
        payeeName: row.payeeName,
        payeeQBOId: row.payeeQBOId,
        memo: row.description,
        splitAccount: row.splitAccount,
        accountCode: row.accountCode,
        accountName: row.accountName,
        className: row.className,
        qboClassId: row.className ? classIds.get(row.className) || null : null,
        debit: row.debit,
        credit: row.credit,
        amount: row.amount,
      }))
  );

  const totalDebit = lines.reduce((sum, l) => sum + l.debit, 0);
  const totalCredit = lines.reduce((sum, l) => sum + l.credit, 0);

  return withTransaction(async (client) => {
    // TaskId is UNIQUE on CtrlSnapshots: if a duplicate delivery of this
    // task already stored its snapshot, store nothing.
    const { rows: snapRows } = await client.query(
      `INSERT INTO CtrlSnapshots (GroupId, QBOId, Period, TaskId, LineCount, TotalDebit, TotalCredit, ContentHash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (TaskId) DO NOTHING
       RETURNING SnapshotId`,
      [
        task.groupid,
        qbo.qboid,
        `${task.month}-01`,
        task.taskid,
        lines.length,
        totalDebit.toFixed(2),
        totalCredit.toFixed(2),
        snapshotHash(lines),
      ]
    );
    if (!snapRows.length) return { snapshotId: null, lineCount: lines.length, duplicate: true };
    const snapshotId = snapRows[0].snapshotid;

    if (lines.length) {
      await insertRows(
        client,
        'CtrlLedgerLines',
        LINE_COLUMNS,
        lines.map((l) => [
          task.groupid, snapshotId, qbo.qboid, l.fingerprint, l.contentHash, l.txnDate, l.txnType,
          l.docNum, l.qboTxnId, l.payeeName, l.payeeQBOId, l.memo, l.accountCode, l.accountName,
          l.className, l.qboClassId, l.debit, l.credit, l.amount, l.splitAccount,
        ])
      );
    }

    await client.query(
      `UPDATE CtrlSyncJobTasks SET Status = 'Succeeded', LineCount = $2, CompletedDate = now(), Error = NULL
       WHERE TaskId = $1`,
      [task.taskid, lines.length]
    );
    await recordAudit(
      {
        groupId: task.groupid,
        action: 'ctrl.snapshot.stored',
        targetType: 'CtrlSnapshot',
        targetId: snapshotId,
        details: { qboId: qbo.qboid, month: task.month, taskId: task.taskid, lineCount: lines.length },
      },
      client
    );
    return { snapshotId, lineCount: lines.length, duplicate: false };
  });
}

async function processTask(taskId) {
  const task = await claimTask(taskId);
  if (!task) return { taskId, skipped: true };

  try {
    const result = await pullMonth(task);
    return { taskId, ...result };
  } catch (err) {
    const message = describeError(err);
    const final = isPermanent(err) || task.attempts >= MAX_ATTEMPTS;
    console.error(`Task ${taskId} (${task.month}) attempt ${task.attempts} failed${final ? ' permanently' : ''}: ${message}`);

    await query(
      `UPDATE CtrlSyncJobTasks
       SET Status = $2, Error = $3, CompletedDate = CASE WHEN $2 = 'Failed' THEN now() ELSE NULL END
       WHERE TaskId = $1`,
      [taskId, final ? 'Failed' : 'Queued', message]
    );

    if (final) {
      await recordAudit({
        groupId: task.groupid,
        action: 'ctrl.sync.task_failed',
        targetType: 'CtrlSyncJobTask',
        targetId: taskId,
        details: { qboId: task.qboid, month: task.month, attempts: task.attempts, error: message },
      });
      return { taskId, failed: true, error: message };
    }

    // Not final: let SQS redeliver after the visibility timeout.
    const retry = new Error(`Task ${taskId} will be retried: ${message}`);
    retry.retryable = true;
    throw retry;
  }
}

// SQS-triggered (BatchSize 1). Invoked by SQS, not API Gateway, so there is
// no caller JWT here: trust comes from the queue, which only startCtrlSync
// (behind authorizeController) can write to.
exports.handler = async (event) => {
  const results = [];
  for (const record of event.Records || []) {
    let taskId;
    try {
      taskId = JSON.parse(record.body).taskId;
    } catch {
      taskId = null;
    }
    if (!taskId) {
      console.error('Ignoring malformed Controller sync message', record.messageId);
      continue;
    }
    results.push(await processTask(taskId));
  }
  return { results };
};

exports.describeError = describeError;
exports.isPermanent = isPermanent;
exports.MAX_ATTEMPTS = MAX_ATTEMPTS;
