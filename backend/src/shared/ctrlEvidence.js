// Controller Phase 4: evidence search shared by ctrlEvidence ("Find
// Evidence" on one line) and ctrlEvidenceWorker ("Search All").
//   Gmail:  targeted searches of the opted-in mailboxes (live)
//   Drive:  a lookup in the invoice-folder index (CtrlDriveFiles), only
//           for folders switched on
// Keeps metadata and a short snippet per candidate (linked, not copied),
// and audits every search. Never touches QuickBooks.
const { query, withTransaction } = require('./db');
const { insertRows } = require('./bulkInsert');
const { recordAudit } = require('./audit');
const { payeeKey } = require('./reviewEngine');
const { loadEntities } = require('./ctrlReviewData');
const google = require('./googleApi');
const { pdfText } = require('./docText');
const {
  buildGmailQueries,
  extractMessage,
  scoreCandidate,
  vendorTerms,
  amountFormats,
  extractInvoiceNumbers,
  buildInvoiceQueries,
  scoreInvoiceCandidate,
  readInvoiceTotal,
} = require('./evidenceMatcher');

const PER_QUERY = 10;
const MAX_FETCH_PER_LINE = 8;
const KEEP_PER_LINE = 5;
const MIN_SCORE = 0.25;
const LINE_CONCURRENCY = 3;
const DRIVE_PER_LINE = 20;
// Invoices are often saved to a folder weeks after the charge.
const DRIVE_DATE_DAYS = 45;

const CANDIDATE_COLUMNS = [
  'GroupId', 'QBOId', 'Fingerprint', 'Source', 'SourceAccount', 'ExternalId', 'ThreadId', 'Title', 'Sender', 'SentAt', 'Snippet',
  'AttachmentNames', 'Score', 'Signals', 'EntityHintId', 'Link', 'Path',
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
    `SELECT SourceId, Kind, SourceKey, DisplayName, Enabled, AddedAt, FolderPath, DriveId, ActAs, LastIndexedAt, LastIndexError
     FROM CtrlGoogleSources WHERE ${where} ORDER BY Kind, DisplayName, SourceKey`,
    params
  );
  return rows.map((r) => ({
    sourceId: r.sourceid,
    kind: r.kind,
    sourceKey: r.sourcekey,
    displayName: r.displayname,
    enabled: r.enabled,
    addedAt: r.addedat,
    ...(r.kind === 'Folder'
      ? { folderPath: r.folderpath, driveId: r.driveid, actAs: r.actas, lastIndexedAt: r.lastindexedat, lastIndexError: r.lastindexerror }
      : {}),
  }));
}

// Vendor names (display name + payee aliases) and learned sender
// addresses, per payee key.
async function loadVendorInfo(groupId, payeeKeys) {
  if (!payeeKeys.length) return new Map();
  const { rows } = await query(
    `SELECT a.PayeeKey, v.VendorId, v.DisplayName,
            ARRAY(SELECT PayeeName FROM CtrlVendorAliases x WHERE x.VendorId = v.VendorId) AS Names,
            ARRAY(SELECT Email FROM CtrlVendorSenders s WHERE s.VendorId = v.VendorId ORDER BY s.ConfirmCount DESC LIMIT 5) AS Senders
     FROM CtrlVendorAliases a JOIN CtrlVendors v ON v.VendorId = a.VendorId
     WHERE a.GroupId = $1 AND a.PayeeKey = ANY($2::text[])`,
    [groupId, payeeKeys]
  );
  return new Map(rows.map((r) => [r.payeekey, { vendorId: r.vendorid, names: [r.displayname, ...(r.names || [])], senders: r.senders || [] }]));
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
async function searchMailbox({ mailbox, line, vendorNames, senders, entities, fetchMessage, api }) {
  const ids = new Map();
  for (const q of buildGmailQueries({ txnDate: line.txnDate, amount: line.amount, vendorNames, senders })) {
    for (const m of await api.gmailSearch(mailbox, q, { maxResults: PER_QUERY })) ids.set(m.id, m);
    if (ids.size >= MAX_FETCH_PER_LINE) break;
  }
  const found = [];
  for (const { id } of [...ids.values()].slice(0, MAX_FETCH_PER_LINE)) {
    const msg = extractMessage(await fetchMessage(mailbox, id));
    const { score, signals, entityHintId } = scoreCandidate({ line, vendorNames, entities, candidate: msg });
    // Invoice numbers it mentions (a payment for several invoices).
    const mentions = extractInvoiceNumbers([msg.subject, msg.text].join('\n')).slice(0, 10);
    if (score >= MIN_SCORE) found.push({ source: 'Gmail', account: mailbox, msg, score, signals: { ...signals, mentions }, entityHintId });
  }
  return found;
}

// The date of a document nearest the line: a date written in it within
// DRIVE_DATE_DAYS of the line, else the file's modified time.
function nearestDate(txnDate, dates, modifiedTime) {
  const t = new Date(`${txnDate}T00:00:00Z`).getTime();
  let best = null;
  for (const d of dates || []) {
    const v = new Date(`${typeof d === 'string' ? d.slice(0, 10) : new Date(d).toISOString().slice(0, 10)}T00:00:00Z`).getTime();
    if (Math.abs(v - t) <= DRIVE_DATE_DAYS * 86400000 && (best === null || Math.abs(v - t) < Math.abs(best - t))) best = v;
  }
  if (best !== null) return new Date(best).toISOString();
  return modifiedTime ? new Date(modifiedTime).toISOString() : null;
}

// A short snippet around the amount, else the start of the text.
function snippetAround(text, amount) {
  const t = String(text || '').replace(/\s+/g, ' ');
  const f = amountFormats(amount).find((x) => t.includes(x));
  const at = f ? Math.max(0, t.indexOf(f) - 120) : 0;
  return t.slice(at, at + 300);
}

// Candidates for one line from the invoice-folder index: files with the
// amount, or naming the vendor.
async function searchFolders({ groupId, folderIds, line, vendorNames, entities }) {
  const amount = Math.round(Math.abs(Number(line.amount) || 0) * 100) / 100;
  const terms = vendorTerms(vendorNames);
  const tsq = terms.map((t) => `"${t.replace(/"/g, '')}"`).join(' or ');
  const { rows } = await query(
    `SELECT f.FileId, f.SourceId, f.Name, f.OwnerEmail, f.Path, f.ModifiedTime, f.WebViewLink, left(f.Text, 20000) AS Text, f.Dates,
            s.DisplayName AS FolderName
     FROM CtrlDriveFiles f JOIN CtrlGoogleSources s ON s.SourceId = f.SourceId
     WHERE f.GroupId = $1 AND f.SourceId = ANY($2::uuid[])
       AND (($3::numeric > 0 AND f.Amounts @> ARRAY[$3::numeric]) OR ($4 <> '' AND f.TextTsv @@ websearch_to_tsquery('simple', $4)))
     ORDER BY f.ModifiedTime DESC NULLS LAST
     LIMIT ${DRIVE_PER_LINE}`,
    [groupId, folderIds, amount, tsq]
  );
  const found = [];
  for (const r of rows) {
    const candidate = {
      subject: r.name,
      from: r.owneremail || '',
      snippet: '',
      text: r.text,
      sentAt: nearestDate(line.txnDate, r.dates, r.modifiedtime),
      attachments: [],
    };
    const { score, signals, entityHintId } = scoreCandidate({ line, vendorNames, entities, candidate });
    if (score < MIN_SCORE) continue;
    found.push({
      source: 'Drive',
      account: r.sourceid,
      msg: {
        id: r.fileid, threadId: null, subject: r.name, from: r.owneremail || '', sentAt: candidate.sentAt, snippet: snippetAround(r.text, line.amount), attachments: [],
      },
      score,
      signals: { ...signals, mentions: extractInvoiceNumbers([r.name, r.text].join('\n')).slice(0, 10) },
      entityHintId,
      link: r.webviewlink,
      path: [r.foldername, r.path].filter(Boolean).join(' / '),
    });
  }
  return found;
}

// Searches the opted-in mailboxes and invoice folders for each line and
// replaces the lines' candidates. lines: [{ lineId, fingerprint, txnDate,
// amount, payeeName }]. Returns { searched, found, sources, errors }.
async function searchLines({ groupId, qboId, lines, userId = null, via, api = google }) {
  const mailboxes = (await loadSources(groupId, { kind: 'Mailbox' })).map((s) => s.sourceKey);
  const folderIds = (await loadSources(groupId, { kind: 'Folder' })).map((s) => s.sourceId);
  if (!mailboxes.length && !folderIds.length) {
    const err = new Error('No mailbox or invoice folder is switched on yet (Controller → Google Workspace)');
    err.statusCode = 409;
    throw err;
  }
  const entities = await loadEntities(groupId);
  const info = await loadVendorInfo(groupId, [...new Set(lines.map((l) => payeeKey(l.payeeName)).filter(Boolean))]);
  const cache = new Map();
  const fetchMessage = (mailbox, id) => {
    const k = `${mailbox}|${id}`;
    if (!cache.has(k)) cache.set(k, api.gmailGetMessage(mailbox, id, { format: 'full' }));
    return cache.get(k);
  };

  const errors = [];
  const results = await mapLimit(lines, LINE_CONCURRENCY, async (line) => {
    const v = info.get(payeeKey(line.payeeName));
    const vendorNames = v?.names || (line.payeeName ? [line.payeeName] : []);
    const found = [];
    let error = null;
    let gmailFailed = 0;
    for (const mailbox of mailboxes) {
      try {
        found.push(...(await searchMailbox({ mailbox, line, vendorNames, senders: v?.senders || [], entities, fetchMessage, api })));
      } catch (err) {
        gmailFailed += 1;
        error = `${mailbox}: ${err.message}`;
        errors.push(error);
      }
    }
    if (folderIds.length) found.push(...(await searchFolders({ groupId, folderIds, line, vendorNames, entities })));
    found.sort((a, b) => b.score - a.score);
    return { line, found: found.slice(0, KEEP_PER_LINE), error, gmailAllFailed: mailboxes.length > 0 && gmailFailed === mailboxes.length };
  });

  await withTransaction(async (client) => {
    for (const { line, found, error, gmailAllFailed } of results) {
      // When every mailbox failed, the line keeps its earlier Gmail
      // candidates (only the error is recorded).
      const replace = [...(gmailAllFailed ? [] : ['Gmail']), ...(folderIds.length ? ['Drive'] : [])];
      if (replace.length) {
        await client.query(`DELETE FROM CtrlEvidenceCandidates WHERE QBOId = $1 AND Fingerprint = $2 AND Source = ANY($3::text[]) AND NOT (Signals ? 'invoiceNumber')`, [qboId, line.fingerprint, replace]);
      }
      const keep = found.filter((f) => replace.includes(f.source));
      if (keep.length) {
        await insertRows(
          client,
          'CtrlEvidenceCandidates',
          CANDIDATE_COLUMNS,
          keep.map((f) => [
            groupId, qboId, line.fingerprint, f.source, f.account, f.msg.id, f.msg.threadId, String(f.msg.subject || '').slice(0, 1000),
            String(f.msg.from || '').slice(0, 500), f.msg.sentAt, f.msg.snippet, (f.msg.attachments || []).map((a) => a.name.slice(0, 255)).slice(0, 20),
            f.score, JSON.stringify(f.signals), f.entityHintId, f.link || null, f.path || null,
          ]),
          'ON CONFLICT (GroupId, QBOId, Fingerprint, Source, SourceAccount, ExternalId) DO NOTHING'
        );
      }
      await client.query(
        `INSERT INTO CtrlEvidenceSearches (GroupId, QBOId, Fingerprint, SearchedAt, SourcesSearched, CandidateCount, Error)
         VALUES ($1, $2, $3, now(), $4, $5, $6)
         ON CONFLICT (QBOId, Fingerprint) DO UPDATE SET SearchedAt = now(), SourcesSearched = EXCLUDED.SourcesSearched,
           CandidateCount = EXCLUDED.CandidateCount, Error = EXCLUDED.Error`,
        [groupId, qboId, line.fingerprint, mailboxes.length + folderIds.length, found.length, error]
      );
    }
    await recordAudit(
      {
        groupId, userId, action: 'ctrl.evidence.search', targetType: 'QBO', targetId: qboId,
        details: { via, lines: lines.length, mailboxes, folders: folderIds.length, found: results.reduce((n, r) => n + r.found.length, 0), errors: errors.length },
      },
      client
    );
  });
  return {
    searched: lines.length,
    found: results.filter((r) => r.found.length).length,
    sources: mailboxes.length + folderIds.length,
    errors: [...new Set(errors)].slice(0, 5),
  };
}

// A line's candidates (best first) and saved support.
async function loadCandidates(groupId, qboId, fingerprint) {
  const { rows } = await query(
    `SELECT c.CandidateId, c.Source, c.SourceAccount, c.ExternalId, c.ThreadId, c.Title, c.Sender, c.SentAt, c.Snippet, c.AttachmentNames, c.Score,
            c.Signals, c.EntityHintId, c.SearchedAt, c.Link, c.Path, s.SavedId, s.Status AS SavedStatus
     FROM CtrlEvidenceCandidates c
     LEFT JOIN CtrlEvidenceSaved s ON s.QBOId = c.QBOId AND s.Fingerprint = c.Fingerprint AND s.Source = c.Source AND s.ExternalId = c.ExternalId
     WHERE c.GroupId = $1 AND c.QBOId = $2 AND c.Fingerprint = $3 ORDER BY c.Score DESC, c.SentAt DESC`,
    [groupId, qboId, fingerprint]
  );
  const { rows: s } = await query(
    `SELECT SearchedAt, SourcesSearched, CandidateCount, Error FROM CtrlEvidenceSearches WHERE GroupId = $1 AND QBOId = $2 AND Fingerprint = $3`,
    [groupId, qboId, fingerprint]
  );
  const { rows: saved } = await query(
    `SELECT SavedId, Source, Title, Status, FileName, SizeBytes, DrivePath, DriveFileId, Error, ConfirmedAt, SavedAt
     FROM CtrlEvidenceSaved WHERE GroupId = $1 AND QBOId = $2 AND Fingerprint = $3 ORDER BY ConfirmedAt DESC`,
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
      link: r.link || null,
      path: r.path || null,
      saved: r.savedid ? { savedId: r.savedid, status: r.savedstatus } : null,
    })),
    saved: saved.map((x) => ({
      savedId: x.savedid,
      source: x.source,
      title: x.title,
      status: x.status,
      fileName: x.filename,
      sizeBytes: x.sizebytes === null ? null : Number(x.sizebytes),
      drivePath: x.drivepath,
      driveCopied: Boolean(x.drivefileid),
      error: x.error,
      confirmedAt: x.confirmedat,
      savedAt: x.savedat,
    })),
  };
}

// ---- Search by invoice number (a payment covering several invoices)

const INVOICE_PER_QUERY = 15;
const INVOICE_FETCH = 15;
const MAX_ATTACHMENT_READS = 6;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Searches the opted-in mailboxes and invoice folders for these invoice
// numbers (up to 18 months before the line), and replaces the line's
// earlier candidates for the same numbers. Returns { numbers, found, sources, errors }.
async function searchInvoiceNumbers({ groupId, qboId, line, numbers, userId = null, api = google }) {
  const mailboxes = (await loadSources(groupId, { kind: 'Mailbox' })).map((s) => s.sourceKey);
  const folderIds = (await loadSources(groupId, { kind: 'Folder' })).map((s) => s.sourceId);
  if (!mailboxes.length && !folderIds.length) {
    const err = new Error('No mailbox or invoice folder is switched on yet (Controller → Google Workspace)');
    err.statusCode = 409;
    throw err;
  }
  const entities = await loadEntities(groupId);
  const info = await loadVendorInfo(groupId, [payeeKey(line.payeeName)].filter(Boolean));
  const vendorNames = info.get(payeeKey(line.payeeName))?.names || (line.payeeName ? [line.payeeName] : []);
  const found = [];
  const errors = [];

  for (const mailbox of mailboxes) {
    try {
      const ids = new Map();
      for (const q of buildInvoiceQueries({ txnDate: line.txnDate, numbers })) {
        for (const m of await api.gmailSearch(mailbox, q, { maxResults: INVOICE_PER_QUERY })) ids.set(m.id, m);
      }
      let readPdfs = 0;
      for (const { id } of [...ids.values()].slice(0, INVOICE_FETCH)) {
        const msg = extractMessage(await api.gmailGetMessage(mailbox, id, { format: 'full' }));
        const s = scoreInvoiceCandidate({ vendorNames, entities, candidate: msg, numbers });
        if (!s.matched.length) continue;
        // The total is often only in the attached invoice PDF: read its text
        // layer (no OCR), a few small ones per search.
        if (s.signals.invoiceTotal === null && readPdfs < MAX_ATTACHMENT_READS) {
          const pdf = msg.attachments.find((a) => /\.pdf$/i.test(a.name) && a.attachmentId && a.size <= MAX_ATTACHMENT_BYTES);
          if (pdf) {
            readPdfs += 1;
            try {
              const text = await pdfText(await api.gmailGetAttachment(mailbox, id, pdf.attachmentId));
              s.signals.invoiceTotal = readInvoiceTotal(text);
            } catch {
              // Total unknown; the match still counts.
            }
          }
        }
        found.push({ source: 'Gmail', account: mailbox, msg, ...s });
      }
    } catch (err) {
      errors.push(`${mailbox}: ${err.message}`);
    }
  }

  if (folderIds.length) {
    // Whole-token matches in the file name or text (\m \M: word boundaries).
    const patterns = numbers.map((n) => `\\m${escapeRe(n)}\\M`);
    const { rows } = await query(
      `SELECT f.FileId, f.SourceId, f.Name, f.OwnerEmail, f.Path, f.ModifiedTime, f.WebViewLink, left(f.Text, 20000) AS Text, s.DisplayName AS FolderName
       FROM CtrlDriveFiles f JOIN CtrlGoogleSources s ON s.SourceId = f.SourceId
       WHERE f.GroupId = $1 AND f.SourceId = ANY($2::uuid[]) AND (f.Name ~* ANY($3::text[]) OR f.Text ~* ANY($3::text[]))
       ORDER BY f.ModifiedTime DESC NULLS LAST LIMIT 50`,
      [groupId, folderIds, patterns]
    );
    for (const r of rows) {
      const candidate = { subject: r.name, from: r.owneremail || '', snippet: '', text: r.text, attachments: [] };
      const s = scoreInvoiceCandidate({ vendorNames, entities, candidate, numbers });
      if (!s.matched.length) continue;
      found.push({
        source: 'Drive', account: r.sourceid, ...s, link: r.webviewlink, path: [r.foldername, r.path].filter(Boolean).join(' / '),
        msg: { id: r.fileid, threadId: null, subject: r.name, from: r.owneremail || '', sentAt: r.modifiedtime ? new Date(r.modifiedtime).toISOString() : null, snippet: snippetAround(r.text, s.signals.invoiceTotal || 0), attachments: [] },
      });
    }
  }

  await withTransaction(async (client) => {
    // A new search for a number replaces what the last one found for it.
    await client.query(
      `DELETE FROM CtrlEvidenceCandidates WHERE QBOId = $1 AND Fingerprint = $2 AND Signals ->> 'invoiceNumber' = ANY($3::text[])`,
      [qboId, line.fingerprint, numbers]
    );
    if (found.length) {
      await insertRows(
        client,
        'CtrlEvidenceCandidates',
        CANDIDATE_COLUMNS,
        found.map((f) => [
          groupId, qboId, line.fingerprint, f.source, f.account, f.msg.id, f.msg.threadId, String(f.msg.subject || '').slice(0, 1000),
          String(f.msg.from || '').slice(0, 500), f.msg.sentAt, f.msg.snippet, (f.msg.attachments || []).map((a) => a.name.slice(0, 255)).slice(0, 20),
          f.score, JSON.stringify(f.signals), f.entityHintId, f.link || null, f.path || null,
        ]),
        // Already a candidate (e.g. the payment email itself): kept as is.
        'ON CONFLICT (GroupId, QBOId, Fingerprint, Source, SourceAccount, ExternalId) DO NOTHING'
      );
    }
    await recordAudit(
      {
        groupId, userId, action: 'ctrl.evidence.invoices', targetType: 'QBO', targetId: qboId,
        details: { numbers, mailboxes, folders: folderIds.length, found: found.length, errors: errors.length },
      },
      client
    );
  });
  const foundNumbers = [...new Set(found.flatMap((f) => f.matched))];
  return { numbers, foundNumbers, notFound: numbers.filter((n) => !foundNumbers.includes(n)), found: found.length, sources: mailboxes.length + folderIds.length, errors };
}

module.exports = {
  loadGoogleSettings,
  loadSources,
  searchLines,
  searchInvoiceNumbers,
  loadCandidates,
  mapLimit,
  nearestDate,
  snippetAround,
  MIN_SCORE,
  KEEP_PER_LINE,
};
