// Controller Phase 4: evidence worker.
//   { batchId }  "Search All": searches the opted-in mailboxes and invoice
//                folders for up to 10 review lines (read-only)
//   { saveId }   "Save as support" (Phase 4b): stores confirmed evidence in
//                the evidence bucket; the only Google write is the copy in
//                the admin's own Controller Evidence folder
// Never touches QuickBooks.
const { query } = require('../../../shared/db');
const { searchLines } = require('../../../shared/ctrlEvidence');
const { processSave } = require('../../../shared/evidenceSave');

// Must match maxReceiveCount on the queue's redrive policy (template.yaml).
const MAX_ATTEMPTS = 3;

async function claimBatch(batchId) {
  const { rows } = await query(
    `UPDATE CtrlEvidenceBatches b SET Status = 'Running', Attempts = b.Attempts + 1, StartedDate = now(), Error = NULL
     FROM CtrlEvidenceJobs j, CtrlReviewRuns r
     WHERE b.BatchId = $1 AND b.Status IN ('Queued', 'Running') AND j.JobId = b.JobId AND r.RunId = j.RunId
     RETURNING b.BatchId, b.GroupId, b.LineIds, b.Attempts, j.CreatedBy, r.QBOId`,
    [batchId]
  );
  return rows[0] || null;
}

const finish = (batchId, status, error = null) =>
  query(`UPDATE CtrlEvidenceBatches SET Status = $2, Error = $3, FinishedDate = now() WHERE BatchId = $1`, [batchId, status, error && String(error).slice(0, 1000)]);

async function processBatch(batchId) {
  const batch = await claimBatch(batchId);
  if (!batch) return { batchId, status: 'Skipped (nothing to do)' };
  const { rows } = await query(
    `SELECT LineId, Fingerprint, TO_CHAR(TxnDate, 'YYYY-MM-DD') AS TxnDate, Amount, PayeeName
     FROM CtrlLedgerLines WHERE LineId = ANY($1::uuid[]) AND GroupId = $2`,
    [batch.lineids, batch.groupid]
  );
  const lines = rows.map((r) => ({ lineId: r.lineid, fingerprint: r.fingerprint, txnDate: r.txndate, amount: Number(r.amount), payeeName: r.payeename }));
  try {
    const result = await searchLines({ groupId: batch.groupid, qboId: batch.qboid, lines, userId: batch.createdby, via: 'SearchAll' });
    // Some mailbox errors (e.g. one opted-out account) don't fail the batch.
    await finish(batchId, 'Succeeded', result.errors[0] || null);
    return { batchId, status: 'Succeeded', ...result };
  } catch (err) {
    const permanent = err.code === 'GOOGLE_NOT_CONFIGURED' || err.statusCode === 409;
    console.error('Evidence batch failed', batchId, err.message);
    if (!permanent && batch.attempts < MAX_ATTEMPTS) throw err; // SQS delivers it again
    await finish(batchId, 'Failed', err.message);
    return { batchId, status: 'Failed' };
  }
}

exports.handler = async (event) => {
  const results = [];
  for (const record of event.Records || []) {
    let body;
    try {
      body = JSON.parse(record.body);
    } catch {
      body = null;
    }
    // { saveId }: "Save as support" (Phase 4b); { batchId }: "Search All".
    if (body?.saveId) results.push(await processSave(body.saveId));
    else if (body?.batchId) results.push(await processBatch(body.batchId));
    else console.error('Ignoring malformed Controller evidence message', record.messageId);
  }
  return { results };
};

exports.processBatch = processBatch;
exports.MAX_ATTEMPTS = MAX_ATTEMPTS;
