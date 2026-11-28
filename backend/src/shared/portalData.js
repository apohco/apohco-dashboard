// Controller Phase 5b: the accountant AJE portal's data layer.
//
// An accountant's reach is CtrlAccountantAccess (Groups, optionally limited
// to some QBO files). Every read here is filtered by it server-side; the
// portal never trusts a groupId from the client on its own.
//
// Entry status (NotWorked / Booked / Declined) and question threads are
// append-only histories; the current status is the latest row.
const { query } = require('./db');
const { requireAuth } = require('./verifyToken');
const { requireRole } = require('./authorize');
const { badRequest, isUuid } = require('./ctrlReviewData');
const { listReports, loadReport } = require('./ajeData');

const ACCOUNTANT_ROLE = 'Accountant';
const STATUSES = ['NotWorked', 'Booked', 'Declined'];
const STATUS_LABELS = { NotWorked: 'Not worked', Booked: 'Booked', Declined: 'Declined' };
const MAX_REASON = 2000;
const MAX_COMMENT = 4000;

const forbidden = (message = 'Not authorized for this report') => badRequest(message, 403);

// ---- Who is calling

async function loadAccountantByUserId(userId, db = { query }) {
  if (!isUuid(userId)) return null;
  const { rows } = await db.query(
    `SELECT a.AccountantId, a.Username, a.UserId, a.FullName, a.Email, a.Firm, a.Active,
            COALESCE(json_agg(json_build_object('groupId', x.GroupId, 'qboIds', x.QBOIds)) FILTER (WHERE x.GroupId IS NOT NULL), '[]') AS access
     FROM CtrlAccountants a
     LEFT JOIN CtrlAccountantAccess x ON x.AccountantId = a.AccountantId
     WHERE a.UserId = $1
     GROUP BY a.AccountantId`,
    [userId]
  );
  if (!rows.length) return null;
  const r = rows[0];
  return {
    accountantId: r.accountantid,
    username: r.username,
    userId: r.userid,
    fullName: r.fullname,
    email: r.email,
    firm: r.firm || null,
    active: r.active,
    access: (r.access || []).map((a) => ({ groupId: a.groupId, qboIds: a.qboIds || null })),
  };
}

// requireAuth -> requireRole(Accountant) -> an active CtrlAccountants row.
// The database check means deactivating someone takes effect at once, even
// before their current ID token expires.
async function authorizePortal(event, db = { query }) {
  const claims = await requireAuth(event);
  requireRole(claims, [ACCOUNTANT_ROLE]);
  const accountant = await loadAccountantByUserId(claims.userId, db);
  if (!accountant || !accountant.active) throw forbidden('This portal login is not active');
  return { claims, accountant };
}

// May this accountant see this file? (access row for the Group, and the
// file is in its list or the list is "all files").
function canSeeFile(accountant, groupId, qboId) {
  const a = accountant.access.find((x) => x.groupId === groupId);
  if (!a) return false;
  return !a.qboIds || a.qboIds.includes(qboId);
}

// ---- Status and threads

// entryId -> { status, statusLabel, reason, setBy, setAt, questionOpen, comments, lastCommentAt }
async function loadEntryStates(groupId, entryIds, db = { query }) {
  const out = new Map(entryIds.map((id) => [id, { status: 'NotWorked', statusLabel: STATUS_LABELS.NotWorked, reason: null, setBy: null, setAt: null, questionOpen: false, comments: 0, lastCommentAt: null }]));
  if (!entryIds.length) return out;
  const [{ rows: statuses }, { rows: threads }] = await Promise.all([
    db.query(
      `SELECT DISTINCT ON (EntryId) EntryId, Status, Reason, SetByName, SetAt
       FROM CtrlAjeEntryStatus WHERE GroupId = $1 AND EntryId = ANY($2::uuid[])
       ORDER BY EntryId, SetAt DESC, StatusId DESC`,
      [groupId, entryIds]
    ),
    db.query(
      `SELECT EntryId, COUNT(*) AS comments, MAX(CreatedAt) AS lastat,
              (ARRAY_AGG(AuthorRole ORDER BY CreatedAt DESC, CommentId DESC))[1] AS lastrole
       FROM CtrlAjeComments WHERE GroupId = $1 AND EntryId = ANY($2::uuid[])
       GROUP BY EntryId`,
      [groupId, entryIds]
    ),
  ]);
  for (const s of statuses) {
    Object.assign(out.get(s.entryid), { status: s.status, statusLabel: STATUS_LABELS[s.status], reason: s.reason || null, setBy: s.setbyname, setAt: s.setat });
  }
  for (const t of threads) {
    Object.assign(out.get(t.entryid), { comments: Number(t.comments), lastCommentAt: t.lastat, questionOpen: t.lastrole === ACCOUNTANT_ROLE });
  }
  return out;
}

async function loadThreads(groupId, entryIds, db = { query }) {
  const out = new Map(entryIds.map((id) => [id, []]));
  if (!entryIds.length) return out;
  const { rows } = await db.query(
    `SELECT CommentId, EntryId, AuthorName, AuthorRole, Body, CreatedAt
     FROM CtrlAjeComments WHERE GroupId = $1 AND EntryId = ANY($2::uuid[])
     ORDER BY CreatedAt, CommentId`,
    [groupId, entryIds]
  );
  for (const r of rows) {
    out.get(r.entryid).push({ commentId: r.commentid, authorName: r.authorname, authorRole: r.authorrole, body: r.body, createdAt: r.createdat });
  }
  return out;
}

// Per-report counts: { reportId: { notWorked, booked, declined, bookedUnconfirmed, openQuestions } }.
// groupIds: the Groups the reports belong to (every query stays Group-scoped).
async function loadReportCounts(groupIds, reportIds, db = { query }) {
  const out = new Map();
  if (!reportIds.length) return out;
  const { rows } = await db.query(
    `WITH st AS (
       SELECT DISTINCT ON (EntryId) EntryId, Status FROM CtrlAjeEntryStatus
       WHERE GroupId = ANY($1::uuid[]) AND ReportId = ANY($2::uuid[]) ORDER BY EntryId, SetAt DESC, StatusId DESC
     ), q AS (
       SELECT EntryId, (ARRAY_AGG(AuthorRole ORDER BY CreatedAt DESC, CommentId DESC))[1] AS lastrole
       FROM CtrlAjeComments WHERE GroupId = ANY($1::uuid[]) AND ReportId = ANY($2::uuid[]) GROUP BY EntryId
     )
     SELECT e.ReportId,
            COUNT(*) FILTER (WHERE COALESCE(st.Status, 'NotWorked') = 'NotWorked') AS notworked,
            COUNT(*) FILTER (WHERE st.Status = 'Booked') AS booked,
            COUNT(*) FILTER (WHERE st.Status = 'Declined') AS declined,
            COUNT(*) FILTER (WHERE st.Status = 'Booked' AND NOT EXISTS (SELECT 1 FROM CtrlAjePostings p WHERE p.EntryId = e.EntryId)) AS bookedunconfirmed,
            COUNT(*) FILTER (WHERE q.lastrole = 'Accountant') AS openquestions
     FROM CtrlAjeEntries e
     LEFT JOIN st ON st.EntryId = e.EntryId
     LEFT JOIN q ON q.EntryId = e.EntryId
     WHERE e.GroupId = ANY($1::uuid[]) AND e.ReportId = ANY($2::uuid[])
     GROUP BY e.ReportId`,
    [groupIds, reportIds]
  );
  for (const r of rows) {
    out.set(r.reportid, {
      notWorked: Number(r.notworked), booked: Number(r.booked), declined: Number(r.declined),
      bookedUnconfirmed: Number(r.bookedunconfirmed), openQuestions: Number(r.openquestions),
    });
  }
  return out;
}

const EMPTY_COUNTS = { notWorked: 0, booked: 0, declined: 0, bookedUnconfirmed: 0, openQuestions: 0 };

// Adds status, question state and the thread to each entry of a loaded report.
async function attachPortalState(groupId, report, db = { query }) {
  const ids = report.entries.map((e) => e.entryId);
  const [states, threads] = await Promise.all([loadEntryStates(groupId, ids, db), loadThreads(groupId, ids, db)]);
  for (const e of report.entries) {
    e.portal = states.get(e.entryId);
    e.thread = threads.get(e.entryId) || [];
  }
  return report;
}

// What an accountant sees of a report: no storage keys, Drive paths or
// internal decision ids. Support is reached only through /portal/docs.
function portalView(report) {
  return {
    reportId: report.reportId,
    qboId: report.qboId,
    qboName: report.qboName,
    month: report.month,
    reportNumber: report.reportNumber,
    grouping: report.grouping,
    status: report.status,
    supersedes: report.supersedes,
    supersededBy: report.supersededBy,
    entryCount: report.entryCount,
    totalAmount: report.totalAmount,
    postedCount: report.postedCount,
    note: report.note,
    publishedAt: report.publishedAt,
    entries: (report.entries || []).map((e) => ({
      entryId: e.entryId,
      entryNumber: e.entryNumber,
      qboNum: e.qboNum,
      kind: e.kind,
      kindLabel: e.kindLabel,
      entryDate: e.entryDate,
      vendor: e.vendor,
      memo: e.memo,
      amount: e.amount,
      lines: e.lines,
      warnings: e.warnings,
      posted: e.posted ? { month: e.posted.month, docNum: e.posted.docNum } : null,
      sources: e.sources.map((s) => ({
        side: s.side, txnDate: s.txnDate, txnType: s.txnType, docNum: s.docNum, payeeName: s.payeeName, memo: s.memo,
        accountCode: s.accountCode, accountName: s.accountName, className: s.className, amount: s.amount, from: s.from, to: s.to,
      })),
      support: e.support.map((s) => ({ savedId: s.savedId, fileName: s.fileName, title: s.title, source: s.source, sizeBytes: s.sizeBytes, savedAt: s.savedAt })),
      portal: e.portal,
      thread: e.thread,
    })),
  };
}

// ---- Accountant reads

async function listPortalReports(accountant, { groupId = null } = {}, db = { query }) {
  const access = groupId ? accountant.access.filter((a) => a.groupId === groupId) : accountant.access;
  if (groupId && !access.length) throw forbidden('Not authorized for this Group');
  const { rows: groups } = access.length
    ? await db.query(`SELECT GroupId, GroupName FROM Groups WHERE GroupId = ANY($1::uuid[]) ORDER BY GroupName`, [access.map((a) => a.groupId)])
    : { rows: [] };
  const reports = [];
  for (const a of access) {
    const g = groups.find((x) => x.groupid === a.groupId);
    for (const r of await listReports(a.groupId, {}, db)) {
      if (a.qboIds && !a.qboIds.includes(r.qboId)) continue;
      reports.push({ ...r, groupId: a.groupId, groupName: g ? g.groupname : null });
    }
  }
  const counts = await loadReportCounts(access.map((a) => a.groupId), reports.map((r) => r.reportId), db);
  return {
    accountant: { fullName: accountant.fullName, firm: accountant.firm },
    groups: groups.map((g) => ({ groupId: g.groupid, groupName: g.groupname })),
    reports: reports.map((r) => ({
      reportId: r.reportId, groupId: r.groupId, groupName: r.groupName, qboId: r.qboId, qboName: r.qboName, month: r.month,
      reportNumber: r.reportNumber, status: r.status, supersedes: r.supersedes, supersededBy: r.supersededBy,
      entryCount: r.entryCount, totalAmount: r.totalAmount, postedCount: r.postedCount, publishedAt: r.publishedAt,
      counts: counts.get(r.reportId) || { ...EMPTY_COUNTS, notWorked: r.entryCount },
    })),
  };
}

// The report's Group and file, checked against the accountant's access.
// Unknown and not-allowed look the same (404) so ids can't be probed.
async function reportForAccountant(accountant, reportId, db = { query }) {
  if (!isUuid(reportId)) throw badRequest('Report not found', 404);
  const { rows } = await db.query(`SELECT ReportId, GroupId, QBOId, Status FROM CtrlAjeReports WHERE ReportId = $1`, [reportId]);
  if (!rows.length || !canSeeFile(accountant, rows[0].groupid, rows[0].qboid)) throw badRequest('Report not found', 404);
  return { reportId, groupId: rows[0].groupid, qboId: rows[0].qboid, status: rows[0].status };
}

async function entryForAccountant(accountant, entryId, db = { query }) {
  if (!isUuid(entryId)) throw badRequest('Entry not found', 404);
  const { rows } = await db.query(
    `SELECT e.EntryId, e.ReportId, e.GroupId, e.QBOId, e.EntryNumber, r.ReportNumber, r.Status AS ReportStatus, q.QBOName
     FROM CtrlAjeEntries e JOIN CtrlAjeReports r ON r.ReportId = e.ReportId JOIN QBOs q ON q.QBOId = e.QBOId
     WHERE e.EntryId = $1`,
    [entryId]
  );
  const r = rows[0];
  if (!r || (accountant && !canSeeFile(accountant, r.groupid, r.qboid))) throw badRequest('Entry not found', 404);
  return {
    entryId, reportId: r.reportid, groupId: r.groupid, qboId: r.qboid, entryNumber: r.entrynumber,
    reportNumber: r.reportnumber, reportStatus: r.reportstatus, qboName: r.qboname,
  };
}

async function loadPortalReport(accountant, reportId, db = { query }) {
  const ref = await reportForAccountant(accountant, reportId, db);
  const report = await attachPortalState(ref.groupId, await loadReport(ref.groupId, reportId, db), db);
  return { ref, report };
}

// A saved support file the accountant may open: it must be support for an
// entry in a report they can see.
async function supportForAccountant(accountant, reportId, savedId, db = { query }) {
  if (!isUuid(savedId)) throw badRequest('Document not found', 404);
  const { ref, report } = await loadPortalReport(accountant, reportId, db);
  const item = report.entries.flatMap((e) => e.support.map((s) => ({ ...s, entryNumber: e.entryNumber }))).find((s) => s.savedId === savedId);
  if (!item || !item.s3Key) throw badRequest('Document not found', 404);
  return { ref, item };
}

// ---- Writes (inside a transaction)

function cleanText(value, max, label) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length > max) throw badRequest(`${label} can be at most ${max} characters`);
  return text;
}

async function setEntryStatus(client, { entry, status, reason, userId, userName }) {
  if (!STATUSES.includes(status)) throw badRequest(`status must be one of ${STATUSES.join(', ')}`);
  if (entry.reportStatus !== 'Published') throw badRequest('This report was superseded; work the newer report instead', 409);
  const why = cleanText(reason, MAX_REASON, 'The reason');
  if (status === 'Declined' && !why) throw badRequest('Say why the entry is declined');
  const current = (await loadEntryStates(entry.groupId, [entry.entryId], client)).get(entry.entryId);
  if (current.status === status && (current.reason || '') === why) return { changed: false, ...current };
  const { rows } = await client.query(
    `INSERT INTO CtrlAjeEntryStatus (EntryId, ReportId, GroupId, Status, Reason, SetByUserId, SetByName)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING SetAt`,
    [entry.entryId, entry.reportId, entry.groupId, status, why || null, userId, userName]
  );
  return { changed: true, status, statusLabel: STATUS_LABELS[status], reason: why || null, setBy: userName, setAt: rows[0].setat, previous: current.status };
}

async function addComment(client, { entry, body, userId, userName, role }) {
  const text = cleanText(body, MAX_COMMENT, 'A comment');
  if (!text) throw badRequest('Write a comment first');
  const { rows } = await client.query(
    `INSERT INTO CtrlAjeComments (EntryId, ReportId, GroupId, AuthorUserId, AuthorName, AuthorRole, Body)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING CommentId, CreatedAt`,
    [entry.entryId, entry.reportId, entry.groupId, userId, userName, role, text]
  );
  return { commentId: rows[0].commentid, authorName: userName, authorRole: role, body: text, createdAt: rows[0].createdat };
}

// ---- Controller rollup

// Reports in force (plus superseded ones that still have an open question),
// open questions first, then recent portal activity.
async function loadRollup(groupId, db = { query }) {
  const reports = await listReports(groupId, {}, db);
  const counts = await loadReportCounts([groupId], reports.map((r) => r.reportId), db);
  const rows = reports
    .map((r) => ({ ...r, counts: counts.get(r.reportId) || { ...EMPTY_COUNTS, notWorked: r.entryCount } }))
    .filter((r) => r.status === 'Published' || r.counts.openQuestions > 0);

  const [{ rows: questions }, { rows: activity }, { rows: accountants }] = await Promise.all([
    db.query(
      `WITH last AS (
         SELECT DISTINCT ON (c.EntryId) c.EntryId, c.ReportId, c.AuthorName, c.AuthorRole, c.Body, c.CreatedAt
         FROM CtrlAjeComments c WHERE c.GroupId = $1
         ORDER BY c.EntryId, c.CreatedAt DESC, c.CommentId DESC
       )
       SELECT last.*, e.EntryNumber, r.ReportNumber, q.QBOName
       FROM last JOIN CtrlAjeEntries e ON e.EntryId = last.EntryId JOIN CtrlAjeReports r ON r.ReportId = last.ReportId JOIN QBOs q ON q.QBOId = r.QBOId
       WHERE last.AuthorRole = 'Accountant'
       ORDER BY last.CreatedAt`,
      [groupId]
    ),
    db.query(
      `SELECT * FROM (
         SELECT 'status' AS kind, s.SetAt AS at, s.SetByName AS who, s.Status AS status, s.Reason AS text, e.EntryNumber, s.ReportId
         FROM CtrlAjeEntryStatus s JOIN CtrlAjeEntries e ON e.EntryId = s.EntryId WHERE s.GroupId = $1
         UNION ALL
         SELECT 'comment', c.CreatedAt, c.AuthorName, c.AuthorRole, c.Body, e.EntryNumber, c.ReportId
         FROM CtrlAjeComments c JOIN CtrlAjeEntries e ON e.EntryId = c.EntryId WHERE c.GroupId = $1
       ) x ORDER BY at DESC LIMIT 50`,
      [groupId]
    ),
    db.query(
      `SELECT a.AccountantId, a.FullName, a.Firm, a.Active FROM CtrlAccountants a
       JOIN CtrlAccountantAccess x ON x.AccountantId = a.AccountantId WHERE x.GroupId = $1 ORDER BY a.FullName`,
      [groupId]
    ),
  ]);
  const totals = rows.reduce(
    (t, r) => Object.fromEntries(Object.keys(EMPTY_COUNTS).map((k) => [k, t[k] + (r.status === 'Published' || k === 'openQuestions' ? r.counts[k] : 0)])),
    { ...EMPTY_COUNTS }
  );
  return {
    totals,
    reports: rows.map((r) => ({
      reportId: r.reportId, qboId: r.qboId, qboName: r.qboName, month: r.month, reportNumber: r.reportNumber, status: r.status,
      entryCount: r.entryCount, totalAmount: r.totalAmount, postedCount: r.postedCount, publishedAt: r.publishedAt, counts: r.counts,
    })),
    openQuestions: questions.map((q) => ({
      entryId: q.entryid, reportId: q.reportid, entryNumber: q.entrynumber, reportNumber: q.reportnumber, qboName: q.qboname,
      authorName: q.authorname, body: q.body, askedAt: q.createdat,
    })),
    activity: activity.map((a) => ({
      kind: a.kind, at: a.at, who: a.who, entryNumber: a.entrynumber, reportId: a.reportid,
      ...(a.kind === 'status' ? { status: a.status, statusLabel: STATUS_LABELS[a.status], reason: a.text } : { authorRole: a.status, body: a.text }),
    })),
    accountants: accountants.map((a) => ({ accountantId: a.accountantid, fullName: a.fullname, firm: a.firm || null, active: a.active })),
  };
}

module.exports = {
  ACCOUNTANT_ROLE,
  STATUSES,
  STATUS_LABELS,
  loadAccountantByUserId,
  authorizePortal,
  canSeeFile,
  loadEntryStates,
  loadThreads,
  loadReportCounts,
  attachPortalState,
  portalView,
  listPortalReports,
  reportForAccountant,
  entryForAccountant,
  loadPortalReport,
  supportForAccountant,
  setEntryStatus,
  addComment,
  loadRollup,
};
