// Email notifications for the accountant portal (off by default).
//
// Callers only QUEUE rows in CtrlNotifications, inside their own
// transaction. ctrlNotifyWorker (the only function with the Google key)
// sends them from the Group's Google Workspace admin mailbox. A queueing
// problem never blocks the action that caused it.
const { query } = require('./db');
const { parseMonth } = require('./monthRanges');

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const KINDS = ['ReportPublished', 'Question', 'Reply', 'Test'];

const appUrl = (path) => `${String(process.env.FRONTEND_URL || '').replace(/\/+$/, '')}${path}`;
const oneLine = (s, max = 200) => String(s || '').replace(/[\r\n]+/g, ' ').trim().slice(0, max);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const label = (month) => {
  const p = parseMonth(month);
  return p ? `${MONTHS[p.month - 1]} ${p.year}` : month;
};

async function loadNotifySettings(groupId, db = { query }) {
  const { rows } = await db.query(
    `SELECT n.EmailEnabled, n.ControllerEmail, g.AdminEmail
     FROM Groups grp
     LEFT JOIN CtrlNotifySettings n ON n.GroupId = grp.GroupId
     LEFT JOIN CtrlGoogleSettings g ON g.GroupId = grp.GroupId
     WHERE grp.GroupId = $1`,
    [groupId]
  );
  const r = rows[0] || {};
  return {
    emailEnabled: Boolean(r.emailenabled),
    controllerEmail: r.controlleremail || null,
    senderEmail: r.adminemail || null,
    googleConnected: Boolean(r.adminemail),
  };
}

async function queue(db, { groupId, kind, to, subject, body }) {
  if (!KINDS.includes(kind) || !EMAIL_RE.test(String(to || ''))) return 0;
  await db.query(
    `INSERT INTO CtrlNotifications (GroupId, Kind, ToEmail, Subject, Body) VALUES ($1, $2, $3, $4, $5)`,
    [groupId, kind, to, oneLine(subject, 300), String(body).slice(0, 20000)]
  );
  return 1;
}

// Active accountants who want email and can see this file.
async function accountantsForFile(db, groupId, qboId) {
  const { rows } = await db.query(
    `SELECT a.FullName, a.Email FROM CtrlAccountants a
     JOIN CtrlAccountantAccess x ON x.AccountantId = a.AccountantId
     WHERE x.GroupId = $1 AND a.Active AND a.NotifyByEmail AND (x.QBOIds IS NULL OR $2::uuid = ANY(x.QBOIds))`,
    [groupId, qboId]
  );
  return rows.map((r) => ({ name: r.fullname, email: r.email }));
}

// Runs `fn` only when email is on, and never lets a failure escape.
// `db` is the caller's transaction client; everything runs in a savepoint
// so a failed query here doesn't abort the caller's transaction.
async function safely(db, groupId, fn) {
  await db.query('SAVEPOINT ctrl_notify');
  try {
    const settings = await loadNotifySettings(groupId, db);
    const n = settings.emailEnabled && settings.senderEmail ? await fn(settings) : 0;
    await db.query('RELEASE SAVEPOINT ctrl_notify');
    return n;
  } catch (err) {
    console.error('Notification not queued:', err.message);
    await db.query('ROLLBACK TO SAVEPOINT ctrl_notify').catch(() => {});
    return 0;
  }
}

async function notifyReportPublished(db, { groupId, qboId, reportId, reportNumber, qboName, month, entryCount, supersedes }) {
  return safely(db, groupId, async () => {
    let n = 0;
    for (const a of await accountantsForFile(db, groupId, qboId)) {
      n += await queue(db, {
        groupId, kind: 'ReportPublished', to: a.email,
        subject: `AJE report ${reportNumber} is ready`,
        body: [
          `Hello ${a.name},`,
          '',
          `A new adjusting journal entry report is ready in the AJE portal:`,
          '',
          `  ${reportNumber}: ${qboName}, ${label(month)} (${entryCount} ${entryCount === 1 ? 'entry' : 'entries'})`,
          supersedes ? `  This replaces ${supersedes}.` : null,
          '',
          `Open it: ${appUrl(`/portal/reports/${reportId}`)}`,
        ].filter((l) => l !== null).join('\n'),
      });
    }
    return n;
  });
}

async function notifyQuestion(db, { groupId, entry, authorName, body }) {
  return safely(db, groupId, (settings) => queue(db, {
    groupId, kind: 'Question', to: settings.controllerEmail || settings.senderEmail,
    subject: `Question on ${entry.entryNumber} from ${oneLine(authorName, 80)}`,
    body: [
      `${authorName} asked about ${entry.entryNumber} (${entry.qboName}):`,
      '',
      body,
      '',
      `Reply in the dashboard: ${appUrl('/controller/aje-activity')}`,
    ].join('\n'),
  }));
}

// Paul's reply goes to the accountants who wrote in that entry's thread.
async function notifyReply(db, { groupId, entry, body }) {
  return safely(db, groupId, async () => {
    const { rows } = await db.query(
      `SELECT DISTINCT a.FullName, a.Email FROM CtrlAjeComments c
       JOIN CtrlAccountants a ON a.UserId = c.AuthorUserId
       WHERE c.EntryId = $1 AND c.AuthorRole = 'Accountant' AND a.Active AND a.NotifyByEmail`,
      [entry.entryId]
    );
    let n = 0;
    for (const a of rows) {
      n += await queue(db, {
        groupId, kind: 'Reply', to: a.email,
        subject: `Reply on ${entry.entryNumber}`,
        body: [`Hello ${a.fullname},`, '', `There's a reply on ${entry.entryNumber} (${entry.qboName}):`, '', body, '', `Open it: ${appUrl(`/portal/reports/${entry.reportId}`)}`].join('\n'),
      });
    }
    return n;
  });
}

// RFC 2822 message, base64url, for Gmail users.messages.send. Headers are
// single-line (no injection) and the subject is RFC 2047 encoded.
function buildRawEmail({ from, to, subject, body }) {
  const enc = (s) => `=?UTF-8?B?${Buffer.from(oneLine(s, 300), 'utf8').toString('base64')}?=`;
  const message = [
    `From: ${oneLine(from)}`,
    `To: ${oneLine(to)}`,
    `Subject: ${enc(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(String(body), 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n'),
  ].join('\r\n');
  return Buffer.from(message, 'utf8').toString('base64url');
}

module.exports = { EMAIL_RE, KINDS, loadNotifySettings, queue, notifyReportPublished, notifyQuestion, notifyReply, buildRawEmail };
