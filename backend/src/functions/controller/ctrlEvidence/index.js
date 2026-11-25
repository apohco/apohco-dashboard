// Controller Phase 4a: evidence for review lines.
//
//   GET  /api/controller/evidence?groupId=&runId=&lineId=     a line's candidates
//   POST /api/controller/evidence/find                        { groupId, runId, lineId }
//        "Find Evidence": searches the opted-in mailboxes now, returns candidates
//   GET  /api/controller/evidence/jobs/{jobId}?groupId=       "Search All" progress
//   GET  /api/controller/evidence/{candidateId}/preview?groupId=
//        the email itself (plain text + attachment names), fetched on demand
//        and never stored
//
// "Search All" jobs are started from ctrlReview (POST /review/evidence-search)
// and run in ctrlEvidenceWorker. Read-only to Google; never touches QuickBooks.
const { authorizeController } = require('../../../shared/controllerAuth');
const { requireGroupAccess } = require('../../../shared/authorize');
const { query } = require('../../../shared/db');
const { json, withErrorHandling } = require('../../../shared/response');
const { recordAudit } = require('../../../shared/audit');
const { badRequest, isUuid, loadRun } = require('../../../shared/ctrlReviewData');
const google = require('../../../shared/googleApi');
const { extractMessage } = require('../../../shared/evidenceMatcher');
const { searchLines, loadCandidates, loadSources } = require('../../../shared/ctrlEvidence');

async function loadRunLine(groupId, runId, lineId) {
  const run = await loadRun(groupId, runId);
  if (!isUuid(lineId)) throw badRequest('Line not found', 404);
  const { rows } = await query(
    `SELECT l.LineId, l.Fingerprint, TO_CHAR(l.TxnDate, 'YYYY-MM-DD') AS TxnDate, l.Amount, l.PayeeName
     FROM CtrlSuggestions s JOIN CtrlLedgerLines l ON l.LineId = s.LineId
     WHERE s.RunId = $1 AND s.GroupId = $2 AND s.LineId = $3`,
    [run.runid, groupId, lineId]
  );
  if (!rows.length) throw badRequest('Line not found in this review run', 404);
  const r = rows[0];
  return { run, line: { lineId: r.lineid, fingerprint: r.fingerprint, txnDate: r.txndate, amount: Number(r.amount), payeeName: r.payeename } };
}

async function handleGet(groupId, qs) {
  const { run, line } = await loadRunLine(groupId, qs.runId, qs.lineId);
  return json(200, await loadCandidates(groupId, run.qboid, line.fingerprint));
}

async function handleFind(claims, body) {
  const { run, line } = await loadRunLine(body.groupId, body.runId, body.lineId);
  let result;
  try {
    result = await searchLines({ groupId: body.groupId, qboId: run.qboid, lines: [line], userId: claims.userId, via: 'FindEvidence' });
  } catch (err) {
    if (err.code === 'GOOGLE_NOT_CONFIGURED') throw badRequest(err.message, 409);
    throw err;
  }
  return json(200, { ...result, ...(await loadCandidates(body.groupId, run.qboid, line.fingerprint)) });
}

async function handleJob(groupId, jobId) {
  if (!isUuid(jobId)) throw badRequest('Job not found', 404);
  const { rows: jobs } = await query(`SELECT JobId, RunId, LineCount, CreatedDate FROM CtrlEvidenceJobs WHERE JobId = $1 AND GroupId = $2`, [jobId, groupId]);
  if (!jobs.length) throw badRequest('Job not found', 404);
  const { rows } = await query(
    `SELECT CASE WHEN (b.Status = 'Queued' AND j.CreatedDate < now() - interval '2 hours')
                   OR (b.Status = 'Running' AND b.StartedDate < now() - interval '30 minutes') THEN 'Stalled' ELSE b.Status END AS status,
            COUNT(*)::int AS n
     FROM CtrlEvidenceBatches b JOIN CtrlEvidenceJobs j ON j.JobId = b.JobId WHERE b.JobId = $1 GROUP BY 1`,
    [jobId]
  );
  const { rows: errs } = await query(`SELECT DISTINCT Error FROM CtrlEvidenceBatches WHERE JobId = $1 AND Error IS NOT NULL LIMIT 3`, [jobId]);
  const batches = { Queued: 0, Running: 0, Succeeded: 0, Failed: 0, Stalled: 0 };
  for (const r of rows) batches[r.status] = r.n;
  const total = Object.values(batches).reduce((a, b) => a + b, 0);
  return json(200, {
    jobId,
    runId: jobs[0].runid,
    lineCount: jobs[0].linecount,
    batches,
    batchCount: total,
    finished: batches.Queued + batches.Running === 0,
    errors: errs.map((e) => e.error),
  });
}

async function handlePreview(claims, groupId, candidateId) {
  if (!isUuid(candidateId)) throw badRequest('Evidence not found', 404);
  const { rows } = await query(
    `SELECT CandidateId, Source, SourceAccount, ExternalId FROM CtrlEvidenceCandidates WHERE CandidateId = $1 AND GroupId = $2`,
    [candidateId, groupId]
  );
  if (!rows.length) throw badRequest('Evidence not found', 404);
  const c = rows[0];
  if (c.source !== 'Gmail') throw badRequest('Only emails can be previewed for now');
  // The allowlist is checked again: a mailbox opted out since is not read.
  const allowed = (await loadSources(groupId, { kind: 'Mailbox' })).some((s) => s.sourceKey === c.sourceaccount);
  if (!allowed) throw badRequest(`${c.sourceaccount} is no longer opted in (Controller → Google Workspace)`, 403);
  let msg;
  try {
    msg = extractMessage(await google.gmailGetMessage(c.sourceaccount, c.externalid, { format: 'full' }));
  } catch (err) {
    throw badRequest(err.status === 404 ? 'The email no longer exists' : err.message, err.status === 404 ? 404 : 502);
  }
  await recordAudit({ groupId, userId: claims.userId, action: 'ctrl.evidence.preview', targetType: 'Email', targetId: candidateId, details: { mailbox: c.sourceaccount } });
  return json(200, {
    candidateId,
    mailbox: c.sourceaccount,
    subject: msg.subject,
    from: msg.from,
    to: msg.to,
    sentAt: msg.sentAt,
    text: msg.text,
    attachments: msg.attachments.map((a) => ({ name: a.name, mimeType: a.mimeType, size: a.size })),
  });
}

exports.handler = withErrorHandling(async (event) => {
  const claims = await authorizeController(event);
  const { resource, httpMethod } = event;
  if (httpMethod === 'GET') {
    const qs = event.queryStringParameters || {};
    if (!qs.groupId) throw badRequest('groupId is required');
    requireGroupAccess(claims, qs.groupId);
    if (resource.endsWith('/preview')) return handlePreview(claims, qs.groupId, event.pathParameters?.candidateId);
    if (resource.endsWith('/jobs/{jobId}')) return handleJob(qs.groupId, event.pathParameters?.jobId);
    return handleGet(qs.groupId, qs);
  }
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    throw badRequest('Request body must be JSON');
  }
  if (!body.groupId) throw badRequest('groupId is required');
  requireGroupAccess(claims, body.groupId);
  if (httpMethod === 'POST' && resource.endsWith('/find')) return handleFind(claims, body);
  throw badRequest('Unknown evidence route', 404);
});
