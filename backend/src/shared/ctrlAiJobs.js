// Creating, queueing and reporting Controller AI jobs (Phase 3). A job is
// split into batches (one model call each), each sent to the AI queue as
// { batchId } and handled by ctrlAiWorker.
const { query, withTransaction } = require('./db');
const { enqueueAiBatches } = require('./ctrlQueue');
const { selectAiLines, packBatches, groupKeyOf, aiOutcomeKey, decisionOutcomeKey } = require('./aiMatcher');
const { buildEntityResolver } = require('./reviewEngine');
const { loadEntities, ACCOUNT_TYPE_SQL, accountTypeJoin } = require('./ctrlReviewData');
const { modelId } = require('./bedrock');

// A batch that's been Queued this long or Running this long without
// finishing is treated as stalled (its message went to the dead-letter
// queue), so it doesn't hold a job "in progress" forever.
const STALE_SQL = `((b.Status = 'Queued' AND j.CreatedDate < now() - interval '2 hours')
  OR (b.Status = 'Running' AND b.StartedDate < now() - interval '30 minutes'))`;

// Estimated AI spend (USD) for the Group in the current calendar month (UTC).
async function monthSpend(groupId, db = { query }) {
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(CostUsd), 0) AS spend, COUNT(*)::int AS calls FROM CtrlAiCalls
     WHERE GroupId = $1 AND CreatedDate >= date_trunc('month', now())`,
    [groupId]
  );
  return { spend: Number(rows[0].spend), calls: rows[0].calls };
}

// Inserts a job and its batches; returns { jobId, batchIds }.
async function createJob(client, { groupId, kind, runId = null, vendorId = null, qboId = null, params = {}, batches, userId }) {
  const lineCount = batches.reduce((n, b) => n + b.length, 0);
  const { rows } = await client.query(
    `INSERT INTO CtrlAiJobs (GroupId, Kind, RunId, VendorId, QBOId, Model, Params, LineCount, CreatedBy)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING JobId`,
    [groupId, kind, runId, vendorId, qboId, modelId(), JSON.stringify(params), lineCount, userId || null]
  );
  const jobId = rows[0].jobid;
  const batchIds = [];
  if (batches.length) {
    // One INSERT per batch keeps RETURNING in step with the input order.
    for (const lineIds of batches) {
      const { rows: b } = await client.query(
        `INSERT INTO CtrlAiBatches (JobId, GroupId, LineIds) VALUES ($1, $2, $3::uuid[]) RETURNING BatchId`,
        [jobId, groupId, lineIds]
      );
      batchIds.push(b[0].batchid);
    }
  }
  return { jobId, batchIds, lineCount };
}

// Sends a job's batches to the queue; a batch SQS refused is marked Failed.
async function queueBatches(batchIds) {
  if (!batchIds.length) return [];
  let failed;
  try {
    failed = await enqueueAiBatches(batchIds);
  } catch (err) {
    console.error('AI enqueue failed:', err.message);
    failed = batchIds;
  }
  if (failed.length) {
    await query(
      `UPDATE CtrlAiBatches SET Status = 'Failed', Error = 'Could not be queued', FinishedDate = now()
       WHERE BatchId = ANY($1::uuid[])`,
      [failed]
    );
  }
  return failed;
}

// The engine's results for a run, for choosing the AI's lines: lines not
// decided yet and (onlyMissing) without an AI answer in this run.
async function loadRunCandidates(groupId, runId, qboId, { onlyMissing = false } = {}) {
  const { rows } = await query(
    `SELECT s.LineId, s.Fingerprint, s.VendorId, s.Status, s.Confidence, s.Source,
            l.PayeeName, l.AccountCode, l.AccountName, l.Amount, ${ACCOUNT_TYPE_SQL} AS AccountType,
            (d.Fingerprint IS NOT NULL) AS decided, (a.LineId IS NOT NULL) AS hasAi
     FROM CtrlSuggestions s
     JOIN CtrlLedgerLines l ON l.LineId = s.LineId
     ${accountTypeJoin('l')}
     LEFT JOIN (
       SELECT DISTINCT ON (Fingerprint) Fingerprint, Action FROM CtrlDecisions
       WHERE GroupId = $1 AND QBOId = $3 ORDER BY Fingerprint, DecidedAt DESC
     ) d ON d.Fingerprint = s.Fingerprint AND d.Action <> 'Undo'
     LEFT JOIN CtrlAiSuggestions a ON a.RunId = s.RunId AND a.LineId = s.LineId
     WHERE s.RunId = $2 AND s.GroupId = $1`,
    [groupId, runId, qboId]
  );
  const usable = rows.filter((r) => !(onlyMissing && r.hasai));
  return {
    results: usable.map((r) => ({
      lineId: r.lineid,
      fingerprint: r.fingerprint,
      vendorId: r.vendorid,
      status: r.status,
      confidence: Number(r.confidence),
      source: r.source,
    })),
    lines: new Map(
      usable.map((r) => [
        r.lineid,
        { vendorId: r.vendorid, accountCode: r.accountcode, accountName: r.accountname, accountType: r.accounttype, amount: Number(r.amount) },
      ])
    ),
    decidedFingerprints: new Set(rows.filter((r) => r.decided).map((r) => r.fingerprint)),
  };
}

// Starts the AI pass of a review run. Returns { jobId, lineCount, batchCount }
// or { skipped: reason } when nothing is sent.
async function startReviewAiJob({ groupId, run, settings, rules, userId, onlyMissing = false }) {
  if (!settings.aiEnabled) return { skipped: 'AI matching is turned off in Review settings' };
  const { spend } = await monthSpend(groupId);
  if (spend >= settings.aiMonthlyBudget) return { skipped: "This month's AI budget has been reached" };
  const candidates = await loadRunCandidates(groupId, run.runId, run.qboId, { onlyMissing });
  const picked = selectAiLines({ ...candidates, rules, threshold: settings.threshold });
  if (!picked.length) return { skipped: 'No lines need the AI' };
  const batches = packBatches(picked);
  const job = await withTransaction((client) =>
    createJob(client, { groupId, kind: 'Review', runId: run.runId, qboId: run.qboId, batches, userId })
  );
  const failed = await queueBatches(job.batchIds);
  return { jobId: job.jobId, lineCount: job.lineCount, batchCount: job.batchIds.length, failedToQueue: failed.length };
}

// Progress of one job: batch counts by status (stalled counted apart),
// lines answered, and estimated cost.
async function jobStatus(groupId, jobId) {
  const { rows: jobs } = await query(
    `SELECT JobId, Kind, RunId, VendorId, QBOId, Model, Params, LineCount, CreatedDate FROM CtrlAiJobs WHERE JobId = $1 AND GroupId = $2`,
    [jobId, groupId]
  );
  if (!jobs.length) return null;
  const j = jobs[0];
  const { rows: counts } = await query(
    `SELECT CASE WHEN ${STALE_SQL} THEN 'Stalled' ELSE b.Status END AS status, COUNT(*)::int AS n,
            COALESCE(SUM(cardinality(b.LineIds)), 0)::int AS lines
     FROM CtrlAiBatches b JOIN CtrlAiJobs j ON j.JobId = b.JobId
     WHERE b.JobId = $1 GROUP BY 1`,
    [jobId]
  );
  const { rows: cost } = await query(`SELECT COALESCE(SUM(CostUsd), 0) AS cost FROM CtrlAiCalls WHERE JobId = $1`, [jobId]);
  const { rows: errs } = await query(
    `SELECT DISTINCT Error FROM CtrlAiBatches WHERE JobId = $1 AND Status IN ('Failed', 'Skipped') AND Error IS NOT NULL LIMIT 3`,
    [jobId]
  );
  const batches = { Queued: 0, Running: 0, Succeeded: 0, Failed: 0, Skipped: 0, Stalled: 0 };
  for (const c of counts) batches[c.status] = c.n;
  const total = Object.values(batches).reduce((a, b) => a + b, 0);
  const done = batches.Succeeded + batches.Failed + batches.Skipped + batches.Stalled;
  return {
    jobId: j.jobid,
    kind: j.kind,
    runId: j.runid,
    vendorId: j.vendorid,
    qboId: j.qboid,
    model: j.model,
    params: j.params,
    lineCount: j.linecount,
    createdDate: j.createddate,
    batches,
    batchCount: total,
    finished: done === total,
    costUsd: Number(cost[0].cost),
    errors: errs.map((e) => e.error),
  };
}

const liveDecision = (d) => (d && d.action !== 'Undo' ? d : null);

// For each line with an AI suggestion (its latest one) that Paul has since
// decided: did his decision match? Optionally for one vendor.
// Returns { suggested, decided, agreed, agreeRate }.
async function aiAgreement(groupId, { vendorId = null, days = 180 } = {}) {
  const params = [groupId, days];
  const vendorFilter = vendorId ? ` AND s.VendorId = $${params.push(vendorId)}` : '';
  const { rows } = await query(
    `SELECT DISTINCT ON (l.QBOId, l.Fingerprint)
            a.SuggestedAction, a.SuggestedEntityId, a.SuggestedAccountCode, a.SuggestedAccountName,
            r.ReviewKind, l.ClassName, l.QBOClassId, d.Action, d.EntityId, d.TargetAccountCode, d.TargetAccountName, d.CounterpartyEntityId
     FROM CtrlAiSuggestions a
     JOIN CtrlReviewRuns r ON r.RunId = a.RunId
     JOIN CtrlLedgerLines l ON l.LineId = a.LineId
     JOIN CtrlSuggestions s ON s.RunId = a.RunId AND s.LineId = a.LineId
     LEFT JOIN LATERAL (
       SELECT Action, EntityId, TargetAccountCode, TargetAccountName, CounterpartyEntityId FROM CtrlDecisions
       WHERE GroupId = a.GroupId AND QBOId = l.QBOId AND Fingerprint = l.Fingerprint AND Scope = 'Line'
       ORDER BY DecidedAt DESC LIMIT 1
     ) d ON true
     WHERE a.GroupId = $1 AND a.CreatedDate > now() - make_interval(days => $2::int) AND a.SuggestedAction <> 'Unsure'${vendorFilter}
     ORDER BY l.QBOId, l.Fingerprint, a.CreatedDate DESC`,
    params
  );
  const entities = await loadEntities(groupId);
  const resolve = buildEntityResolver(entities);
  let decided = 0;
  let agreed = 0;
  for (const r of rows) {
    const kind = r.reviewkind || 'Class';
    const decision = r.action
      ? {
          action: r.action,
          entityId: r.entityid,
          counterpartyEntityId: r.counterpartyentityid,
          targetAccount: r.targetaccountname ? { code: r.targetaccountcode, name: r.targetaccountname } : null,
        }
      : null;
    const theirs = decisionOutcomeKey(kind, liveDecision(decision), kind === 'Class' ? resolve(r.classname, r.qboclassid) : null);
    if (!theirs) continue;
    decided += 1;
    const ai = aiOutcomeKey({
      action: r.suggestedaction,
      entityId: r.suggestedentityid,
      account: r.suggestedaccountname ? { code: r.suggestedaccountcode, name: r.suggestedaccountname } : null,
    });
    if (ai === theirs) agreed += 1;
  }
  return { suggested: rows.length, decided, agreed, agreeRate: decided ? Math.round((agreed / decided) * 1000) / 1000 : null };
}

module.exports = {
  monthSpend,
  createJob,
  queueBatches,
  loadRunCandidates,
  startReviewAiJob,
  jobStatus,
  aiAgreement,
  liveDecision,
  groupKeyOf,
  STALE_SQL,
};
