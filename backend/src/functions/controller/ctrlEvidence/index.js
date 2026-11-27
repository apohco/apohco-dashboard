// Controller Phase 4: evidence for review lines.
//
//   GET  /api/controller/evidence?groupId=&runId=&lineId=     a line's candidates and saved support
//   POST /api/controller/evidence/find                        { groupId, runId, lineId }
//        "Find Evidence": searches the opted-in mailboxes and invoice folders now
//   GET  /api/controller/evidence/jobs/{jobId}?groupId=       "Search All" progress
//   GET  /api/controller/evidence/{candidateId}/preview?groupId=
//        an email (fetched on demand, plain text, never stored) or a folder
//        file's indexed text
//   POST /api/controller/evidence/{candidateId}/confirm       { groupId, runId, lineId }
//        "Save as support": queued; the worker stores it in the evidence
//        bucket and files a copy in the admin's Drive
//   GET  /api/controller/evidence/saved/{savedId}/download?groupId=
//        a download link that expires in 5 minutes
//
// "Search All" jobs are started from ctrlReview (POST /review/evidence-search)
// and run in ctrlEvidenceWorker. Never touches QuickBooks.
const { authorizeController } = require('../../../shared/controllerAuth');
const { requireGroupAccess } = require('../../../shared/authorize');
const { query } = require('../../../shared/db');
const { json, withErrorHandling } = require('../../../shared/response');
const { recordAudit } = require('../../../shared/audit');
const { badRequest, isUuid, loadRun } = require('../../../shared/ctrlReviewData');
const google = require('../../../shared/googleApi');
const { extractMessage } = require('../../../shared/evidenceMatcher');
const { searchLines, loadCandidates, loadSources } = require('../../../shared/ctrlEvidence');
const { enqueueEvidenceSave } = require('../../../shared/ctrlQueue');
const { downloadUrl, DOWNLOAD_URL_SECONDS } = require('../../../shared/evidenceSave');

async function loadRunLine(groupId, runId, lineId) {
  const run = await loadRun(groupId, runId);
  if (!isUuid(lineId)) throw badRequest('Line not found', 404);
  const { rows } = await query(
    `SELECT l.LineId, l.Fingerprint, TO_CHAR(l.TxnDate, 'YYYY-MM-DD') AS TxnDate, l.Amount, l.PayeeName,
            s.CurrentEntityId, s.SuggestedEntityId, d.EntityId AS DecisionEntityId, d.CounterpartyEntityId
     FROM CtrlSuggestions s JOIN CtrlLedgerLines l ON l.LineId = s.LineId
     LEFT JOIN LATERAL (
       SELECT Action, EntityId, CounterpartyEntityId FROM CtrlDecisions
       WHERE GroupId = s.GroupId AND QBOId = $4 AND Fingerprint = s.Fingerprint ORDER BY DecidedAt DESC LIMIT 1
     ) d ON d.Action <> 'Undo'
     WHERE s.RunId = $1 AND s.GroupId = $2 AND s.LineId = $3`,
    [run.runid, groupId, lineId, run.qboid]
  );
  if (!rows.length) throw badRequest('Line not found in this review run', 404);
  const r = rows[0];
  return {
    run,
    line: { lineId: r.lineid, fingerprint: r.fingerprint, txnDate: r.txndate, amount: Number(r.amount), payeeName: r.payeename },
    // The practice the line belongs to, best known first (for filing).
    entityOrder: [r.decisionentityid, r.counterpartyentityid, r.suggestedentityid, r.currententityid],
  };
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

async function loadCandidate(groupId, candidateId) {
  if (!isUuid(candidateId)) throw badRequest('Evidence not found', 404);
  const { rows } = await query(
    `SELECT CandidateId, QBOId, Fingerprint, Source, SourceAccount, ExternalId, Title, EntityHintId, Link
     FROM CtrlEvidenceCandidates WHERE CandidateId = $1 AND GroupId = $2`,
    [candidateId, groupId]
  );
  if (!rows.length) throw badRequest('Evidence not found', 404);
  return rows[0];
}

// The allowlist is checked again on every use: a mailbox or folder
// switched off since is not read.
async function assertStillAllowed(groupId, c) {
  if (c.source === 'Gmail') {
    const ok = (await loadSources(groupId, { kind: 'Mailbox' })).some((s) => s.sourceKey === c.sourceaccount);
    if (!ok) throw badRequest(`${c.sourceaccount} is no longer opted in (Controller → Google Workspace)`, 403);
  } else {
    const ok = (await loadSources(groupId, { kind: 'Folder' })).some((s) => s.sourceId === c.sourceaccount);
    if (!ok) throw badRequest('That invoice folder is no longer switched on (Controller → Google Workspace)', 403);
  }
}

async function handlePreview(claims, groupId, candidateId) {
  const c = await loadCandidate(groupId, candidateId);
  await assertStillAllowed(groupId, c);
  if (c.source === 'Drive') {
    const { rows } = await query(
      `SELECT f.Name, f.OwnerEmail, f.ModifiedTime, f.Path, f.WebViewLink, f.Text, f.Extract, s.DisplayName
       FROM CtrlDriveFiles f JOIN CtrlGoogleSources s ON s.SourceId = f.SourceId WHERE f.SourceId = $1 AND f.FileId = $2`,
      [c.sourceaccount, c.externalid]
    );
    if (!rows.length) throw badRequest('The file is no longer in the folder', 404);
    const f = rows[0];
    await recordAudit({ groupId, userId: claims.userId, action: 'ctrl.evidence.preview', targetType: 'DriveFile', targetId: candidateId });
    return json(200, {
      candidateId,
      source: 'Drive',
      subject: f.name,
      from: f.owneremail,
      sentAt: f.modifiedtime,
      folder: [f.displayname, f.path].filter(Boolean).join(' / '),
      link: f.webviewlink,
      text: f.text,
      readBy: f.extract,
      attachments: [],
    });
  }
  let msg;
  try {
    msg = extractMessage(await google.gmailGetMessage(c.sourceaccount, c.externalid, { format: 'full' }));
  } catch (err) {
    throw badRequest(err.status === 404 ? 'The email no longer exists' : err.message, err.status === 404 ? 404 : 502);
  }
  await recordAudit({ groupId, userId: claims.userId, action: 'ctrl.evidence.preview', targetType: 'Email', targetId: candidateId, details: { mailbox: c.sourceaccount } });
  return json(200, {
    candidateId,
    source: 'Gmail',
    mailbox: c.sourceaccount,
    subject: msg.subject,
    from: msg.from,
    to: msg.to,
    sentAt: msg.sentAt,
    text: msg.text,
    attachments: msg.attachments.map((a) => ({ name: a.name, mimeType: a.mimeType, size: a.size })),
  });
}

async function handleConfirm(claims, groupId, candidateId, body) {
  const c = await loadCandidate(groupId, candidateId);
  const { run, line, entityOrder } = await loadRunLine(groupId, body.runId, body.lineId);
  if (c.qboid !== run.qboid || c.fingerprint !== line.fingerprint) throw badRequest('That evidence belongs to another line', 409);
  await assertStillAllowed(groupId, c);
  const entityId = [entityOrder[0], entityOrder[1], c.entityhintid, entityOrder[2], entityOrder[3]].find(Boolean) || null;
  // A failed save can be confirmed again; a saved or saving one is returned.
  const { rows } = await query(
    `INSERT INTO CtrlEvidenceSaved (GroupId, QBOId, Fingerprint, LineId, Source, SourceAccount, ExternalId, Title, EntityId, ConfirmedBy)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (QBOId, Fingerprint, Source, ExternalId) DO UPDATE SET Status = 'Saving', Attempts = 0, Error = NULL,
       LineId = EXCLUDED.LineId, EntityId = EXCLUDED.EntityId, ConfirmedBy = EXCLUDED.ConfirmedBy, ConfirmedAt = now()
       WHERE CtrlEvidenceSaved.Status = 'Failed'
     RETURNING SavedId, Status`,
    [groupId, run.qboid, line.fingerprint, line.lineId, c.source, c.sourceaccount, c.externalid, c.title, entityId, claims.userId]
  );
  if (!rows.length) {
    const { rows: existing } = await query(`SELECT SavedId, Status FROM CtrlEvidenceSaved WHERE QBOId = $1 AND Fingerprint = $2 AND Source = $3 AND ExternalId = $4`, [
      run.qboid, line.fingerprint, c.source, c.externalid,
    ]);
    return json(200, { savedId: existing[0].savedid, status: existing[0].status, alreadySaved: true });
  }
  const savedId = rows[0].savedid;
  let failed;
  try {
    failed = await enqueueEvidenceSave(savedId);
  } catch (err) {
    console.error('Save enqueue failed:', err.message);
    failed = [0];
  }
  if (failed.length) {
    await query(`UPDATE CtrlEvidenceSaved SET Status = 'Failed', Error = 'Could not be queued; confirm again' WHERE SavedId = $1`, [savedId]);
  }
  await recordAudit({
    groupId, userId: claims.userId, action: 'ctrl.evidence.confirm', targetType: 'CtrlEvidenceSaved', targetId: savedId,
    details: { source: c.source, candidateId, lineId: line.lineId },
  });
  return json(202, { savedId, status: failed.length ? 'Failed' : 'Saving' });
}

async function handleDownload(claims, groupId, savedId) {
  if (!isUuid(savedId)) throw badRequest('Not found', 404);
  const { rows } = await query(`SELECT S3Key, FileName, Status FROM CtrlEvidenceSaved WHERE SavedId = $1 AND GroupId = $2`, [savedId, groupId]);
  if (!rows.length) throw badRequest('Not found', 404);
  if (rows[0].status !== 'Saved' || !rows[0].s3key) throw badRequest('It is not saved yet', 409);
  const url = await downloadUrl(rows[0].s3key, rows[0].filename);
  await recordAudit({ groupId, userId: claims.userId, action: 'ctrl.evidence.download', targetType: 'CtrlEvidenceSaved', targetId: savedId });
  return json(200, { url, fileName: rows[0].filename, expiresInSeconds: DOWNLOAD_URL_SECONDS });
}

exports.handler = withErrorHandling(async (event) => {
  const claims = await authorizeController(event);
  const { resource, httpMethod } = event;
  if (httpMethod === 'GET') {
    const qs = event.queryStringParameters || {};
    if (!qs.groupId) throw badRequest('groupId is required');
    requireGroupAccess(claims, qs.groupId);
    if (resource.endsWith('/preview')) return handlePreview(claims, qs.groupId, event.pathParameters?.candidateId);
    if (resource.endsWith('/download')) return handleDownload(claims, qs.groupId, event.pathParameters?.savedId);
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
  if (httpMethod === 'POST' && resource.endsWith('/confirm')) return handleConfirm(claims, body.groupId, event.pathParameters?.candidateId, body);
  throw badRequest('Unknown evidence route', 404);
});
