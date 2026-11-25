// Controller Phase 4a: evidence search (Gmail) shared by ctrlEvidence
// ("Find Evidence" on one line) and ctrlEvidenceWorker ("Search All").
// Searches only the Group's opted-in mailboxes (server-side allowlist),
// keeps metadata and a short snippet per candidate (linked, not copied),
// and audits every search. Never touches QuickBooks.
const { query, withTransaction } = require('./db');
const { insertRows } = require('./bulkInsert');
const { recordAudit } = require('./audit');
const { payeeKey } = require('./reviewEngine');
const { loadEntities } = require('./ctrlReviewData');
const google = require('./googleApi');
const { buildGmailQueries, extractMessage, scoreCandidate } = require('./evidenceMatcher');

const PER_QUERY = 10;
const MAX_FETCH_PER_LINE = 8;
const KEEP_PER_LINE = 5;
const MIN_SCORE = 0.25;
const LINE_CONCURRENCY = 3;

const CANDIDATE_COLUMNS = [
  'GroupId', 'QBOId', 'Fingerprint', 'Source', 'SourceAccount', 'ExternalId', 'ThreadId', 'Title', 'Sender', 'SentAt', 'Snippet',
  'AttachmentNames', 'Score', 'Signals', 'EntityHintId',
];

async function loadGoogleSettings(groupId, db = { query }) {
  const { rows } = await db.query(
    `SELECT AdminEmail, Domain, EvidenceFolderId, LastTestAt, LastTestOk, LastTestMessage FROM CtrlGoogleSettings WHERE GroupId = $1`,
    [groupId]
  );
  if (!rows.length) return null;
  const r = rows[0];
  return {
    adminEmail: r.adminemail,
    domain: r.domain,
    evidenceFolderId: r.evidencefolderid,
    lastTest: r.lasttestat ? { at: r.lasttestat, ok: r.lasttestok, message: r.lasttestmessage } : null,
  };
}

// Opted-in sources of a kind (enabled only unless all is true).
async function loadSources(groupId, { kind = null, all = false } = {}, db = { query }) {
  const params = [groupId];
  let where = 'GroupId = $1';
  if (kind) where += ` AND Kind = $${params.push(kind)}`;
  if (!all) where += ' AND Enabled';
  const { rows } = await db.query(
    `SELECT SourceId, Kind, SourceKey, DisplayName, Enabled, AddedAt FROM CtrlGoogleSources WHERE ${where} ORDER BY Kind, SourceKey`,
    params
  );
  return rows.map((r) => ({ sourceId: r.sourceid, kind: r.kind, sourceKey: r.sourcekey, displayName: r.displayname, enabled: r.enabled, addedAt: r.addedat }));
}

// Vendor names (display name + payee aliases) per payee key.
async function loadVendorNames(groupId, payeeKeys) {
  if (!payeeKeys.length) return new Map();
  const { rows } = await query(
    `SELECT a.PayeeKey, v.DisplayName, ARRAY(SELECT PayeeName FROM CtrlVendorAliases x WHERE x.VendorId = v.VendorId) AS Names
     FROM CtrlVendorAliases a JOIN CtrlVendors v ON v.VendorId = a.VendorId
     WHERE a.GroupId = $1 AND a.PayeeKey = ANY($2::text[])`,
    [groupId, payeeKeys]
  );
  return new Map(rows.map((r) => [r.payeekey, [r.displayname, ...(r.names || [])]]));
}

// Runs fn over items, at most `limit` at a time.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// Candidates for one line from one mailbox. fetchMessage is cached per call.
async function searchMailbox({ mailbox, line, vendorNames, entities, fetchMessage, api }) {
  const ids = new Map();
  for (const q of buildGmailQueries({ txnDate: line.txnDate, amount: line.amount, vendorNames })) {
    for (const m of await api.gmailSearch(mailbox, q, { maxResults: PER_QUERY })) ids.set(m.id, m);
    if (ids.size >= MAX_FETCH_PER_LINE) break;
  }
  const found = [];
  for (const { id } of [...ids.values()].slice(0, MAX_FETCH_PER_LINE)) {
    const msg = extractMessage(await fetchMessage(mailbox, id));
    const { score, signals, entityHintId } = scoreCandidate({ line, vendorNames, entities, candidate: msg });
    if (score >= MIN_SCORE) found.push({ mailbox, msg, score, signals, entityHintId });
  }
  return found;
}

// Searches the opted-in mailboxes for each line and replaces the lines'
// Gmail candidates. lines: [{ lineId, fingerprint, txnDate, amount,
// payeeName }]. Returns { searched, found, sources, errors }.
async function searchLines({ groupId, qboId, lines, userId = null, via, api = google }) {
  const mailboxes = (await loadSources(groupId, { kind: 'Mailbox' })).map((s) => s.sourceKey);
  if (!mailboxes.length) {
    const err = new Error('No mailbox is opted in yet (Controller → Google Workspace)');
    err.statusCode = 409;
    throw err;
  }
  const entities = await loadEntities(groupId);
  const names = await loadVendorNames(groupId, [...new Set(lines.map((l) => payeeKey(l.payeeName)).filter(Boolean))]);
  const cache = new Map();
  const fetchMessage = (mailbox, id) => {
    const k = `${mailbox}|${id}`;
    if (!cache.has(k)) cache.set(k, api.gmailGetMessage(mailbox, id, { format: 'full' }));
    return cache.get(k);
  };

  const errors = [];
  const results = await mapLimit(lines, LINE_CONCURRENCY, async (line) => {
    const vendorNames = names.get(payeeKey(line.payeeName)) || (line.payeeName ? [line.payeeName] : []);
    const found = [];
    let error = null;
    let failed = 0;
    for (const mailbox of mailboxes) {
      try {
        found.push(...(await searchMailbox({ mailbox, line, vendorNames, entities, fetchMessage, api })));
      } catch (err) {
        failed += 1;
        error = `${mailbox}: ${err.message}`;
        errors.push(error);
      }
    }
    found.sort((a, b) => b.score - a.score);
    return { line, found: found.slice(0, KEEP_PER_LINE), error, allFailed: failed === mailboxes.length };
  });

  await withTransaction(async (client) => {
    for (const { line, found, error, allFailed } of results) {
      // When every mailbox failed, the line keeps its earlier candidates
      // (only the error is recorded).
      if (!allFailed) {
        await client.query(`DELETE FROM CtrlEvidenceCandidates WHERE QBOId = $1 AND Fingerprint = $2 AND Source = 'Gmail'`, [qboId, line.fingerprint]);
      }
      if (found.length) {
        await insertRows(
          client,
          'CtrlEvidenceCandidates',
          CANDIDATE_COLUMNS,
          found.map((f) => [
            groupId, qboId, line.fingerprint, 'Gmail', f.mailbox, f.msg.id, f.msg.threadId, f.msg.subject.slice(0, 1000), f.msg.from.slice(0, 500),
            f.msg.sentAt, f.msg.snippet, f.msg.attachments.map((a) => a.name.slice(0, 255)).slice(0, 20), f.score, JSON.stringify(f.signals),
            f.entityHintId,
          ]),
          'ON CONFLICT (GroupId, QBOId, Fingerprint, Source, SourceAccount, ExternalId) DO NOTHING'
        );
      }
      await client.query(
        `INSERT INTO CtrlEvidenceSearches (GroupId, QBOId, Fingerprint, SearchedAt, SourcesSearched, CandidateCount, Error)
         VALUES ($1, $2, $3, now(), $4, $5, $6)
         ON CONFLICT (QBOId, Fingerprint) DO UPDATE SET SearchedAt = now(), SourcesSearched = EXCLUDED.SourcesSearched,
           CandidateCount = EXCLUDED.CandidateCount, Error = EXCLUDED.Error`,
        [groupId, qboId, line.fingerprint, mailboxes.length, found.length, error]
      );
    }
    await recordAudit(
      {
        groupId, userId, action: 'ctrl.evidence.search', targetType: 'QBO', targetId: qboId,
        details: { via, lines: lines.length, mailboxes, found: results.reduce((n, r) => n + r.found.length, 0), errors: errors.length },
      },
      client
    );
  });
  return {
    searched: lines.length,
    found: results.filter((r) => r.found.length).length,
    sources: mailboxes.length,
    errors: [...new Set(errors)].slice(0, 5),
  };
}

// A line's candidates, best first.
async function loadCandidates(groupId, qboId, fingerprint) {
  const { rows } = await query(
    `SELECT CandidateId, Source, SourceAccount, ExternalId, ThreadId, Title, Sender, SentAt, Snippet, AttachmentNames, Score, Signals, EntityHintId, SearchedAt
     FROM CtrlEvidenceCandidates WHERE GroupId = $1 AND QBOId = $2 AND Fingerprint = $3 ORDER BY Score DESC, SentAt DESC`,
    [groupId, qboId, fingerprint]
  );
  const { rows: s } = await query(
    `SELECT SearchedAt, SourcesSearched, CandidateCount, Error FROM CtrlEvidenceSearches WHERE GroupId = $1 AND QBOId = $2 AND Fingerprint = $3`,
    [groupId, qboId, fingerprint]
  );
  return {
    lastSearch: s.length ? { at: s[0].searchedat, sources: s[0].sourcessearched, found: s[0].candidatecount, error: s[0].error } : null,
    candidates: rows.map((r) => ({
      candidateId: r.candidateid,
      source: r.source,
      account: r.sourceaccount,
      externalId: r.externalid,
      threadId: r.threadid,
      title: r.title,
      sender: r.sender,
      sentAt: r.sentat,
      snippet: r.snippet,
      attachmentNames: r.attachmentnames || [],
      score: Number(r.score),
      signals: r.signals || {},
      entityHintId: r.entityhintid,
    })),
  };
}

module.exports = { loadGoogleSettings, loadSources, searchLines, loadCandidates, mapLimit, MIN_SCORE, KEEP_PER_LINE };
