// Controller Phase 5a: AJE data access -- building a draft report from the
// stored GL and Paul's decisions, publishing it with permanent numbers, and
// the posted-check that notices booked entries in later GL pulls. See
// ajeBuilder.js for how a decision becomes an entry. Every query is scoped
// by GroupId. Nothing here writes to QuickBooks.
const { query } = require('./db');
const { insertRows, buildBatchInsert, chunk } = require('./bulkInsert');
const { accountKey } = require('./accountKey');
const { buildEntityResolver } = require('./reviewEngine');
const { badRequest, loadEntities, loadEffectiveDueToFrom, loadFileAccounts, payeeKeySql, isUuid } = require('./ctrlReviewData');
const B = require('./ajeBuilder');

const MAX_ENTRIES_PER_REPORT = 999;
const MAX_MEMO = 1000;

const lastDayOfMonth = (month) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

// ---- Files, codes, settings

async function loadFile(groupId, qboId, db = { query }) {
  if (!isUuid(qboId)) throw badRequest('QBO file not found', 404);
  const { rows } = await db.query(
    `SELECT q.QBOId, q.QBOName, q.IsClassBased, f.FileCode
     FROM QBOs q LEFT JOIN CtrlAjeFileSettings f ON f.QBOId = q.QBOId
     WHERE q.QBOId = $1 AND q.GroupId = $2`,
    [qboId, groupId]
  );
  if (!rows.length) throw badRequest('QBO file not found', 404);
  return rows[0];
}

// Every file with its code (saved, else suggested).
async function loadFileCodes(groupId, entities, db = { query }) {
  const { rows } = await db.query(
    `SELECT q.QBOId, q.QBOName, q.IsClassBased, f.FileCode
     FROM QBOs q LEFT JOIN CtrlAjeFileSettings f ON f.QBOId = q.QBOId
     WHERE q.GroupId = $1 ORDER BY q.IsClassBased DESC, q.QBOName`,
    [groupId]
  );
  const taken = new Set(rows.map((r) => r.filecode).filter(Boolean));
  return rows.map((r) => {
    const owners = entities.filter((e) => e.practiceQboId === r.qboid);
    const owner = owners.length === 1 ? owners[0] : null;
    let code = r.filecode;
    if (!code) {
      code = B.suggestFileCode({ isClassBased: Boolean(r.isclassbased), name: r.qboname || (owner ? owner.entityName : '') }, taken);
      taken.add(code);
    }
    return {
      qboId: r.qboid,
      qboName: r.qboname,
      isClassBased: Boolean(r.isclassbased),
      ownerEntityId: owner ? owner.entityId : null,
      fileCode: code,
      codeSaved: Boolean(r.filecode),
    };
  });
}

async function loadAjeSettings(groupId, db = { query }) {
  const { rows } = await db.query(`SELECT DefaultGrouping FROM CtrlAjeSettings WHERE GroupId = $1`, [groupId]);
  return { defaultGrouping: rows[0]?.defaultgrouping || 'Grouped' };
}

// ---- Reading the GL, decisions and earlier entries

const DECISION_CTE = `
  dec AS (
    SELECT DISTINCT ON (QBOId, Fingerprint) DecisionId, QBOId, Fingerprint, Action, EntityId, Allocations, CounterpartyEntityId,
           TargetAccountCode, TargetAccountName, Scope, RequestAje
    FROM CtrlDecisions WHERE GroupId = $1
    ORDER BY QBOId, Fingerprint, DecidedAt DESC
  )`;

const LINE_SELECT = `
  l.LineId, l.QBOId, l.Fingerprint, TO_CHAR(l.TxnDate, 'YYYY-MM-DD') AS TxnDate, l.TxnType, l.DocNum, l.PayeeName,
  ${payeeKeySql('l.PayeeName')} AS PayeeKey, l.Memo, l.AccountCode, l.AccountName, l.ClassName, l.QBOClassId, l.Debit, l.Credit,
  d.DecisionId, d.Action, d.EntityId AS DecisionEntityId, d.Allocations, d.CounterpartyEntityId, d.TargetAccountCode,
  d.TargetAccountName, d.Scope, d.RequestAje`;

function toLine(r, vendorKeys) {
  const vendor = r.payeekey ? vendorKeys.get(r.payeekey) : null;
  return {
    line: {
      lineId: r.lineid,
      sourceQboId: r.qboid,
      fingerprint: r.fingerprint,
      txnDate: r.txndate,
      txnType: r.txntype,
      docNum: r.docnum,
      payeeName: r.payeename,
      payeeKey: r.payeekey,
      vendorKey: vendor ? `v:${vendor.vendorId}` : r.payeekey ? `p:${r.payeekey}` : '',
      vendorName: vendor ? vendor.displayName : r.payeename,
      memo: r.memo,
      accountCode: r.accountcode,
      accountName: r.accountname,
      className: r.classname,
      qboClassId: r.qboclassid,
      debit: Number(r.debit),
      credit: Number(r.credit),
    },
    decision: r.action
      ? {
          decisionId: r.decisionid,
          action: r.action,
          entityId: r.decisionentityid,
          allocations: r.allocations,
          counterpartyEntityId: r.counterpartyentityid,
          targetAccount: r.targetaccountname ? { code: r.targetaccountcode || null, name: r.targetaccountname } : null,
          scope: r.scope || 'Line',
          requestAje: r.requestaje !== false,
        }
      : null,
  };
}

async function loadVendorKeys(groupId, db) {
  const { rows } = await db.query(
    `SELECT a.PayeeKey, v.VendorId, v.DisplayName FROM CtrlVendorAliases a JOIN CtrlVendors v ON v.VendorId = a.VendorId WHERE a.GroupId = $1`,
    [groupId]
  );
  return new Map(rows.map((r) => [r.payeekey, { vendorId: r.vendorid, displayName: r.displayname }]));
}

// The reports in force for a file and month, newest first.
async function loadActiveReports(groupId, qboId, month, db) {
  const { rows } = await db.query(
    `SELECT ReportId, ReportNumber, Seq, PublishedAt FROM CtrlAjeReports
     WHERE GroupId = $1 AND QBOId = $2 AND Period = $3 AND Status = 'Published'
     ORDER BY Seq DESC`,
    [groupId, qboId, `${month}-01`]
  );
  return rows;
}

// `${side}|${sourceQboId}|${fingerprint}` -> ToState of the latest entry in
// force (reports of this file and month, except the one being revised).
async function loadPriorStates(groupId, qboId, month, excludeReportId, db) {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (s.Side, s.SourceQBOId, s.Fingerprint) s.Side, s.SourceQBOId, s.Fingerprint, s.ToState
     FROM CtrlAjeEntrySources s JOIN CtrlAjeReports r ON r.ReportId = s.ReportId
     WHERE r.GroupId = $1 AND r.QBOId = $2 AND r.Period = $3 AND r.Status = 'Published'
       AND ($4::uuid IS NULL OR r.ReportId <> $4::uuid)
     ORDER BY s.Side, s.SourceQBOId, s.Fingerprint, r.Seq DESC`,
    [groupId, qboId, `${month}-01`, excludeReportId || null]
  );
  return new Map(rows.map((r) => [`${r.side}|${r.sourceqboid}|${r.fingerprint}`, r.tostate]));
}

// Lines of the file's latest snapshot for the month that have a decision
// or an earlier entry.
async function loadOwnLines(groupId, qboId, month, priorFingerprints, db) {
  const { rows } = await db.query(
    `WITH snap AS (
       SELECT SnapshotId FROM CtrlSnapshots WHERE GroupId = $1 AND QBOId = $2 AND Period = $3 ORDER BY PulledAt DESC LIMIT 1
     ),
     ${DECISION_CTE}
     SELECT ${LINE_SELECT}
     FROM CtrlLedgerLines l
     JOIN snap ON snap.SnapshotId = l.SnapshotId
     LEFT JOIN dec d ON d.QBOId = l.QBOId AND d.Fingerprint = l.Fingerprint
     WHERE l.GroupId = $1 AND (d.DecisionId IS NOT NULL OR l.Fingerprint = ANY($4::text[]))`,
    [groupId, qboId, `${month}-01`, priorFingerprints]
  );
  return rows;
}

// Lines in OTHER files (latest snapshot of the month) decided Due To/From
// this file's entity, or with an earlier mirror entry here.
async function loadMirrorLines(groupId, qboId, month, ownerEntityId, priorMirror, db) {
  const { rows } = await db.query(
    `WITH snaps AS (
       SELECT DISTINCT ON (QBOId) SnapshotId FROM CtrlSnapshots
       WHERE GroupId = $1 AND QBOId <> $2 AND Period = $3 ORDER BY QBOId, PulledAt DESC
     ),
     ${DECISION_CTE}
     SELECT ${LINE_SELECT}
     FROM CtrlLedgerLines l
     JOIN snaps s ON s.SnapshotId = l.SnapshotId
     LEFT JOIN dec d ON d.QBOId = l.QBOId AND d.Fingerprint = l.Fingerprint
     WHERE l.GroupId = $1
       AND ((d.Action = 'DueToFrom' AND d.CounterpartyEntityId = $4::uuid) OR (l.QBOId::text || '|' || l.Fingerprint) = ANY($5::text[]))`,
    [groupId, qboId, `${month}-01`, ownerEntityId, priorMirror]
  );
  return rows;
}

// Saved support per `${qboId}|${fingerprint}`.
async function loadSupport(groupId, keys, db) {
  if (!keys.length) return new Map();
  const qboIds = keys.map((k) => k.split('|')[0]);
  const fps = keys.map((k) => k.split('|')[1]);
  const { rows } = await db.query(
    `SELECT s.SavedId, s.QBOId, s.Fingerprint, s.Source, s.Title, s.FileName, s.SizeBytes, s.S3Key, s.DrivePath,
            TO_CHAR(s.SavedAt, 'YYYY-MM-DD') AS SavedAt
     FROM CtrlEvidenceSaved s
     JOIN UNNEST($2::uuid[], $3::text[]) AS k(QBOId, Fingerprint) ON k.QBOId = s.QBOId AND k.Fingerprint = s.Fingerprint
     WHERE s.GroupId = $1 AND s.Status = 'Saved'
     ORDER BY s.SavedAt`,
    [groupId, qboIds, fps]
  );
  const out = new Map();
  for (const r of rows) {
    const key = `${r.qboid}|${r.fingerprint}`;
    if (!out.has(key)) out.set(key, []);
    out.get(key).push({
      savedId: r.savedid, source: r.source, title: r.title, fileName: r.filename, sizeBytes: r.sizebytes === null ? null : Number(r.sizebytes),
      s3Key: r.s3key, drivePath: r.drivepath, savedAt: r.savedat,
    });
  }
  return out;
}

// ---- Draft

const serializeSource = (c) => ({
  side: c.side,
  sourceQboId: c.line.sourceQboId,
  fingerprint: c.line.fingerprint,
  lineId: c.line.lineId,
  decisionId: c.decisionId,
  txnDate: c.line.txnDate,
  txnType: c.line.txnType,
  docNum: c.line.docNum,
  payeeName: c.line.payeeName,
  memo: c.line.memo,
  accountCode: c.line.accountCode,
  accountName: c.line.accountName,
  className: c.line.className,
  amount: B.signedAmount(c.line),
  from: c.from,
  to: c.to,
});

// The draft report for one file and month.
//   { groupId, qboId, month, grouping, reviseReportId? }, db (a transaction client when publishing)
async function buildDraft({ groupId, qboId, month, grouping = 'Grouped', reviseReportId = null }, db = { query }) {
  if (!B.GROUPINGS.includes(grouping)) throw badRequest(`grouping must be one of ${B.GROUPINGS.join(', ')}`);
  const file = await loadFile(groupId, qboId, db);
  const entities = await loadEntities(groupId);
  const entitiesById = new Map(entities.map((e) => [e.entityId, e]));
  const files = await loadFileCodes(groupId, entities, db);
  const thisFile = files.find((f) => f.qboId === qboId);
  const ownerEntityId = thisFile.ownerEntityId;

  const active = await loadActiveReports(groupId, qboId, month, db);
  let revise = null;
  if (reviseReportId) {
    if (!isUuid(reviseReportId)) throw badRequest('Report not found', 404);
    revise = active.find((r) => r.reportid === reviseReportId) || null;
    if (!revise) throw badRequest('Only a report still in force can be revised', 409);
    if (revise !== active[0]) throw badRequest(`Revise the latest report for this month (${active[0].reportnumber})`, 409);
  }

  const prior = await loadPriorStates(groupId, qboId, month, revise ? revise.reportid : null, db);
  const vendorKeys = await loadVendorKeys(groupId, db);
  const ownPrior = [...prior.keys()].filter((k) => k.startsWith(`Own|${qboId}|`)).map((k) => k.split('|')[2]);
  const ctx = {
    isClassBased: Boolean(file.isclassbased),
    entitiesById,
    resolve: buildEntityResolver(entities),
    mirrorNote: (counterpartyEntityId) => {
      const cp = entitiesById.get(counterpartyEntityId);
      if (!cp) return null;
      const cpFile = files.find((f) => f.ownerEntityId === counterpartyEntityId && f.qboId !== qboId);
      return cpFile
        ? `The other side is drafted in ${cp.entityName}'s file (${cpFile.fileCode}) for this month.`
        : `${cp.entityName} has no QuickBooks file of its own here; record its side yourself.`;
    },
  };

  const changes = [];
  for (const r of await loadOwnLines(groupId, qboId, month, ownPrior, db)) {
    const { line, decision } = toLine(r, vendorKeys);
    const c = B.lineChange(line, decision, prior.get(`Own|${qboId}|${line.fingerprint}`) || null, ctx);
    if (c) changes.push(c);
  }

  // The other side of Due To/From decisions made in other files.
  if (ownerEntityId) {
    const priorMirror = [...prior.keys()].filter((k) => k.startsWith('Mirror|')).map((k) => k.slice('Mirror|'.length));
    const mirrorRows = await loadMirrorLines(groupId, qboId, month, ownerEntityId, priorMirror, db);
    if (mirrorRows.length) {
      const { effective: dueHere } = await loadEffectiveDueToFrom(groupId, qboId, entities, ownerEntityId, db);
      const accountsHere = new Set((await loadFileAccounts(groupId, qboId)).map((a) => a.key));
      const thisName = entitiesById.get(ownerEntityId)?.entityName || file.qboname;
      for (const r of mirrorRows) {
        const { line, decision } = toLine(r, vendorKeys);
        const srcFile = files.find((f) => f.qboId === line.sourceQboId);
        const srcOwner = srcFile && srcFile.ownerEntityId ? entitiesById.get(srcFile.ownerEntityId) : null;
        const mirror = { dueAccount: null, issues: [], warnings: [`Decided in ${srcFile ? srcFile.qboName : 'another file'}.`] };
        if (!srcOwner) {
          mirror.issues.push(`${srcFile ? srcFile.qboName : 'The other file'} is not linked to an entity (Entities -> practice file), so its Due To account in ${thisName}'s file can't be found`);
        } else {
          const due = dueHere.get(srcOwner.entityId);
          if (due) mirror.dueAccount = { code: due.code, name: due.name };
          else mirror.issues.push(`Choose the Due To/From account for ${srcOwner.entityName} in ${file.qboname} (Review -> Due To/From accounts)`);
        }
        if (!accountsHere.has(accountKey(line.accountCode || null, line.accountName || ''))) {
          mirror.warnings.push(`${[line.accountCode, line.accountName].filter(Boolean).join(' ')} isn't in this file's chart of accounts yet.`);
        }
        const c = B.mirrorChange(line, decision, prior.get(`Mirror|${line.sourceQboId}|${line.fingerprint}`) || null, mirror);
        if (c) changes.push(c);
      }
    }
  }

  const entries = B.groupChanges(changes, grouping);
  const support = await loadSupport(groupId, [...new Set(changes.map((c) => `${c.line.sourceQboId}|${c.line.fingerprint}`))], db);
  return {
    file: thisFile,
    month,
    grouping,
    entryDate: lastDayOfMonth(month),
    revise: revise ? { reportId: revise.reportid, reportNumber: revise.reportnumber } : null,
    activeReports: active.map((r) => ({ reportId: r.reportid, reportNumber: r.reportnumber })),
    entries: entries.map((e) => ({
      key: e.key,
      kind: e.kind,
      kindLabel: e.kindLabel,
      vendor: e.vendor,
      memo: e.memo,
      amount: e.amount,
      lines: e.lines,
      issues: e.issues,
      warnings: e.warnings,
      sources: e.sources.map(serializeSource),
      support: e.sources.flatMap((c) => support.get(`${c.line.sourceQboId}|${c.line.fingerprint}`) || []).map(({ s3Key, ...rest }) => rest),
    })),
  };
}

// ---- Publish

// body: { qboId, month, grouping, expectedKeys: [every key the draft showed],
//         include: [{ key, memo? }], reviseReportId?, note? }
async function publishReport(client, { groupId, userId, body }) {
  const { qboId, month } = body;
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`ctrl-aje:${qboId}:${month}`]);
  const draft = await buildDraft({ groupId, qboId, month, grouping: body.grouping, reviseReportId: body.reviseReportId || null }, client);

  const keys = draft.entries.map((e) => e.key).sort();
  const expected = [...new Set(body.expectedKeys || [])].sort();
  if (keys.length !== expected.length || keys.some((k, i) => k !== expected[i])) {
    throw badRequest('The draft changed since it was loaded (a decision or report changed); reload and review it again', 409);
  }
  if (!Array.isArray(body.include) || !body.include.length) throw badRequest('Include at least one entry');
  const byKey = new Map(draft.entries.map((e) => [e.key, e]));
  const chosen = [];
  const seen = new Set();
  for (const inc of body.include) {
    const e = inc && byKey.get(inc.key);
    if (!e) throw badRequest('An included entry is not in the draft', 409);
    if (seen.has(e.key)) continue;
    seen.add(e.key);
    if (e.issues.length) throw badRequest(`An entry can't be published until this is fixed: ${e.issues[0]}`);
    if (!e.lines.length) throw badRequest('An entry has no lines');
    const memo = typeof inc.memo === 'string' && inc.memo.trim() ? inc.memo.trim().replace(/\s+/g, ' ').slice(0, MAX_MEMO) : e.memo;
    chosen.push({ ...e, memo });
  }
  if (chosen.length > MAX_ENTRIES_PER_REPORT) throw badRequest(`At most ${MAX_ENTRIES_PER_REPORT} entries per report; use Grouped`);
  // Keep the draft's order.
  const order = new Map(draft.entries.map((e, i) => [e.key, i]));
  chosen.sort((a, b) => order.get(a.key) - order.get(b.key));

  // The file's code becomes permanent with its first report.
  const { fileCode } = draft.file;
  if (!draft.file.codeSaved) {
    const { rows: clash } = await client.query(
      `SELECT 1 FROM CtrlAjeFileSettings WHERE GroupId = $1 AND FileCode = $2 AND QBOId <> $3`,
      [groupId, fileCode, qboId]
    );
    if (clash.length) throw badRequest(`Another file already uses the code ${fileCode}; set this file's code in AJE settings`, 409);
    await client.query(
      `INSERT INTO CtrlAjeFileSettings (QBOId, GroupId, FileCode, UpdatedBy) VALUES ($1, $2, $3, $4) ON CONFLICT (QBOId) DO NOTHING`,
      [qboId, groupId, fileCode, userId]
    );
  }

  const { rows: seqRows } = await client.query(
    `SELECT COALESCE(MAX(Seq), 0) + 1 AS seq FROM CtrlAjeReports WHERE QBOId = $1 AND Period = $2`,
    [qboId, `${month}-01`]
  );
  const seq = Number(seqRows[0].seq);
  if (seq > 999) throw badRequest('This month has reached 999 reports');
  const number = B.reportNumber(fileCode, month, seq);
  const total = B.round2(chosen.reduce((s, e) => s + e.amount, 0));
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 2000) || null : null;

  const { rows: rep } = await client.query(
    `INSERT INTO CtrlAjeReports (GroupId, QBOId, Period, FileCode, Seq, ReportNumber, Grouping, SupersedesReportId, EntryCount, TotalAmount, Note, PublishedBy)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING ReportId, PublishedAt`,
    [groupId, qboId, `${month}-01`, fileCode, seq, number, draft.grouping, draft.revise ? draft.revise.reportId : null, chosen.length, total, note, userId]
  );
  const reportId = rep[0].reportid;

  const entryRows = chosen.map((e, i) => {
    const num = B.entryNumber(number, i + 1);
    return [
      reportId, groupId, qboId, i + 1, num, B.qboNum(fileCode, month, seq, i + 1), e.kind, draft.entryDate, e.vendor,
      `${num} ${e.memo}`, e.amount, JSON.stringify(e.lines), JSON.stringify(e.warnings),
    ];
  });
  const { sql, params } = buildBatchInsert(
    'CtrlAjeEntries',
    ['ReportId', 'GroupId', 'QBOId', 'Seq', 'EntryNumber', 'QboNum', 'Kind', 'EntryDate', 'Vendor', 'Memo', 'Amount', 'Lines', 'Warnings'],
    entryRows
  );
  const entryIds = [];
  for (const r of (await client.query(`${sql} RETURNING EntryId, Seq`, params)).rows) entryIds[Number(r.seq) - 1] = r.entryid;

  const sourceRows = [];
  chosen.forEach((e, i) => {
    for (const s of e.sources) {
      sourceRows.push([
        entryIds[i], reportId, groupId, s.sourceQboId, s.side, s.fingerprint, s.lineId, s.decisionId, s.txnDate, s.txnType,
        s.docNum, s.payeeName, s.memo, s.accountCode, s.accountName, s.className, s.amount, JSON.stringify(s.from), JSON.stringify(s.to),
      ]);
    }
  });
  await insertRows(
    client,
    'CtrlAjeEntrySources',
    ['EntryId', 'ReportId', 'GroupId', 'SourceQBOId', 'Side', 'Fingerprint', 'LineId', 'DecisionId', 'TxnDate', 'TxnType',
      'DocNum', 'PayeeName', 'Memo', 'AccountCode', 'AccountName', 'ClassName', 'Amount', 'FromState', 'ToState'],
    sourceRows
  );

  if (draft.revise) {
    await client.query(
      `UPDATE CtrlAjeReports SET Status = 'Superseded', SupersededByReportId = $2, SupersededAt = now()
       WHERE ReportId = $1 AND GroupId = $3 AND Status = 'Published'`,
      [draft.revise.reportId, reportId, groupId]
    );
  }
  return {
    reportId,
    reportNumber: number,
    entryCount: chosen.length,
    totalAmount: total,
    supersedes: draft.revise ? draft.revise.reportNumber : null,
    leftOut: draft.entries.length - chosen.length,
  };
}

// ---- Reading reports

const reportSummary = (r) => ({
  reportId: r.reportid,
  qboId: r.qboid,
  qboName: r.qboname,
  month: r.month,
  fileCode: r.filecode,
  seq: Number(r.seq),
  reportNumber: r.reportnumber,
  grouping: r.grouping,
  status: r.status,
  supersedes: r.supersedesnumber || null,
  supersededBy: r.supersededbynumber || null,
  entryCount: Number(r.entrycount),
  totalAmount: Number(r.totalamount),
  postedCount: Number(r.postedcount || 0),
  note: r.note || null,
  publishedAt: r.publishedat,
  publishedBy: r.publishedby || null,
});

const REPORT_SELECT = `
  SELECT r.ReportId, r.QBOId, q.QBOName, TO_CHAR(r.Period, 'YYYY-MM') AS month, r.FileCode, r.Seq, r.ReportNumber, r.Grouping, r.Status,
         sup.ReportNumber AS SupersedesNumber, sby.ReportNumber AS SupersededByNumber, r.EntryCount, r.TotalAmount, r.Note,
         r.PublishedAt, u.Username AS PublishedBy,
         (SELECT COUNT(DISTINCT p.EntryId) FROM CtrlAjePostings p JOIN CtrlAjeEntries e ON e.EntryId = p.EntryId WHERE e.ReportId = r.ReportId) AS PostedCount
  FROM CtrlAjeReports r
  JOIN QBOs q ON q.QBOId = r.QBOId
  LEFT JOIN CtrlAjeReports sup ON sup.ReportId = r.SupersedesReportId
  LEFT JOIN CtrlAjeReports sby ON sby.ReportId = r.SupersededByReportId
  LEFT JOIN Users u ON u.UserId = r.PublishedBy`;

async function listReports(groupId, { qboId = null, month = null } = {}, db = { query }) {
  const { rows } = await db.query(
    `${REPORT_SELECT}
     WHERE r.GroupId = $1 AND ($2::uuid IS NULL OR r.QBOId = $2::uuid) AND ($3::date IS NULL OR r.Period = $3::date)
     ORDER BY r.Period DESC, q.QBOName, r.Seq DESC
     LIMIT 500`,
    [groupId, qboId, month ? `${month}-01` : null]
  );
  return rows.map(reportSummary);
}

// One report with its entries, backup lines, support and posted-checks.
async function loadReport(groupId, reportId, db = { query }) {
  if (!isUuid(reportId)) throw badRequest('Report not found', 404);
  const { rows } = await db.query(`${REPORT_SELECT} WHERE r.ReportId = $1 AND r.GroupId = $2`, [reportId, groupId]);
  if (!rows.length) throw badRequest('Report not found', 404);
  const report = reportSummary(rows[0]);
  const { rows: entries } = await db.query(
    `SELECT e.EntryId, e.Seq, e.EntryNumber, e.QboNum, e.Kind, TO_CHAR(e.EntryDate, 'YYYY-MM-DD') AS EntryDate, e.Vendor, e.Memo, e.Amount, e.Lines, e.Warnings,
            p.SeenAt AS PostedSeenAt, p.DocNum AS PostedDocNum, p.MatchedOn AS PostedMatchedOn, TO_CHAR(ps.Period, 'YYYY-MM') AS PostedMonth
     FROM CtrlAjeEntries e
     LEFT JOIN LATERAL (SELECT * FROM CtrlAjePostings p WHERE p.EntryId = e.EntryId ORDER BY p.SeenAt LIMIT 1) p ON true
     LEFT JOIN CtrlSnapshots ps ON ps.SnapshotId = p.SnapshotId
     WHERE e.ReportId = $1 AND e.GroupId = $2
     ORDER BY e.Seq`,
    [reportId, groupId]
  );
  const { rows: sources } = await db.query(
    `SELECT EntryId, Side, SourceQBOId, Fingerprint, LineId, TO_CHAR(TxnDate, 'YYYY-MM-DD') AS TxnDate, TxnType, DocNum, PayeeName, Memo,
            AccountCode, AccountName, ClassName, Amount, FromState, ToState
     FROM CtrlAjeEntrySources WHERE ReportId = $1 AND GroupId = $2
     ORDER BY TxnDate, Fingerprint`,
    [reportId, groupId]
  );
  const support = await loadSupport(groupId, [...new Set(sources.map((s) => `${s.sourceqboid}|${s.fingerprint}`))], db);
  const byEntry = new Map();
  for (const s of sources) {
    if (!byEntry.has(s.entryid)) byEntry.set(s.entryid, []);
    byEntry.get(s.entryid).push(s);
  }
  report.entries = entries.map((e) => {
    const srcs = byEntry.get(e.entryid) || [];
    const sup = [];
    const seenSaved = new Set();
    for (const s of srcs) {
      for (const item of support.get(`${s.sourceqboid}|${s.fingerprint}`) || []) {
        if (seenSaved.has(item.savedId)) continue;
        seenSaved.add(item.savedId);
        sup.push(item);
      }
    }
    return {
      entryId: e.entryid,
      seq: Number(e.seq),
      entryNumber: e.entrynumber,
      qboNum: e.qbonum,
      kind: e.kind,
      kindLabel: B.KIND_LABELS[e.kind],
      entryDate: e.entrydate,
      vendor: e.vendor,
      memo: e.memo,
      amount: Number(e.amount),
      lines: e.lines,
      warnings: e.warnings || [],
      posted: e.postedseenat ? { seenAt: e.postedseenat, docNum: e.posteddocnum, matchedOn: e.postedmatchedon, month: e.postedmonth } : null,
      sources: srcs.map((s) => ({
        side: s.side, sourceQboId: s.sourceqboid, fingerprint: s.fingerprint, lineId: s.lineid, txnDate: s.txndate, txnType: s.txntype,
        docNum: s.docnum, payeeName: s.payeename, memo: s.memo, accountCode: s.accountcode, accountName: s.accountname,
        className: s.classname, amount: Number(s.amount), from: s.fromstate, to: s.tostate,
      })),
      support: sup,
    };
  });
  return report;
}

// Files x months with decided lines, for picking what to report on.
async function loadActivity(groupId, db = { query }) {
  const { rows } = await db.query(
    `WITH dec AS (
       SELECT DISTINCT ON (QBOId, Fingerprint) QBOId, Fingerprint, LineId, Action
       FROM CtrlDecisions WHERE GroupId = $1 ORDER BY QBOId, Fingerprint, DecidedAt DESC
     )
     SELECT d.QBOId, TO_CHAR(s.Period, 'YYYY-MM') AS month, COUNT(*)::int AS decided
     FROM dec d JOIN CtrlLedgerLines l ON l.LineId = d.LineId JOIN CtrlSnapshots s ON s.SnapshotId = l.SnapshotId
     WHERE d.Action <> 'Undo'
     GROUP BY 1, 2 ORDER BY 2 DESC`,
    [groupId]
  );
  return rows.map((r) => ({ qboId: r.qboid, month: r.month, decidedLines: r.decided }));
}

// ---- Posted-check

// Looks for entry numbers in one stored GL snapshot (its Num and memo
// columns) and records each entry found. Returns how many were new.
async function checkSnapshotPostings({ groupId, qboId, snapshotId }, db = { query }) {
  const { rows: ents } = await db.query(
    `SELECT r.ReportId, r.FileCode, TO_CHAR(r.Period, 'YYYY-MM') AS month, r.Seq AS ReportSeq, e.EntryId, e.Seq
     FROM CtrlAjeReports r JOIN CtrlAjeEntries e ON e.ReportId = r.ReportId
     WHERE r.GroupId = $1 AND r.QBOId = $2`,
    [groupId, qboId]
  );
  if (!ents.length) return 0;
  const reports = new Map();
  for (const e of ents) {
    if (!reports.has(e.reportid)) reports.set(e.reportid, { reportId: e.reportid, fileCode: e.filecode, month: e.month, seq: Number(e.reportseq), entries: [] });
    reports.get(e.reportid).entries.push({ entryId: e.entryid, seq: Number(e.seq) });
  }
  const { rows: lines } = await db.query(
    `SELECT LineId, DocNum, Memo FROM CtrlLedgerLines
     WHERE SnapshotId = $1 AND GroupId = $2 AND (DocNum ILIKE '%AJE%' OR Memo ILIKE '%AJE%')
     LIMIT 5000`,
    [snapshotId, groupId]
  );
  const found = new Map();
  for (const l of lines) {
    for (const m of B.matchPosting([l.docnum, l.memo], [...reports.values()])) {
      const cur = found.get(m.entryId);
      if (!cur || (cur.matchedOn === 'Report' && m.matchedOn === 'Entry')) found.set(m.entryId, { ...m, lineId: l.lineid, docNum: l.docnum });
    }
  }
  if (!found.size) return 0;
  let added = 0;
  for (const batch of chunk([...found.values()], 500)) {
    const { sql, params } = buildBatchInsert(
      'CtrlAjePostings',
      ['EntryId', 'GroupId', 'SnapshotId', 'LineId', 'DocNum', 'MatchedOn'],
      batch.map((f) => [f.entryId, groupId, snapshotId, f.lineId, f.docNum ? String(f.docNum).slice(0, 100) : null, f.matchedOn])
    );
    const res = await db.query(`${sql} ON CONFLICT (EntryId, SnapshotId) DO NOTHING`, params);
    added += res.rowCount || 0;
  }
  return added;
}

// After a GL pull or upload: never lets a posted-check problem fail the pull.
async function checkPostingsSafely(args, db = { query }) {
  try {
    return await checkSnapshotPostings(args, db);
  } catch (err) {
    console.error('AJE posted-check failed', err.message);
    return 0;
  }
}

// The latest snapshot of every month from the file's first report on.
async function checkFilePostings(groupId, qboId, db = { query }) {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (s.Period) s.SnapshotId FROM CtrlSnapshots s
     WHERE s.GroupId = $1 AND s.QBOId = $2
       AND s.Period >= (SELECT MIN(Period) FROM CtrlAjeReports WHERE GroupId = $1 AND QBOId = $2)
     ORDER BY s.Period, s.PulledAt DESC`,
    [groupId, qboId]
  );
  let added = 0;
  for (const r of rows.slice(-36)) added += await checkSnapshotPostings({ groupId, qboId, snapshotId: r.snapshotid }, db);
  return { snapshotsChecked: Math.min(rows.length, 36), newlyPosted: added };
}

module.exports = {
  MAX_MEMO,
  lastDayOfMonth,
  loadFile,
  loadFileCodes,
  loadAjeSettings,
  buildDraft,
  publishReport,
  listReports,
  loadReport,
  loadActivity,
  checkSnapshotPostings,
  checkPostingsSafely,
  checkFilePostings,
};
