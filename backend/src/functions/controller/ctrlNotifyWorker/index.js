// Sends queued portal notification emails (CtrlNotifications), every few
// minutes on a schedule. This is the only portal-related function with the
// Google service account key; the accountant-facing portal only queues rows.
//
// Each message is sent from the Group's Google Workspace admin mailbox with
// the gmail.send scope. A message is retried on later runs and marked
// Failed after MAX_ATTEMPTS. Nothing here reads mail or writes to QuickBooks.
const { withTransaction, query } = require('../../../shared/db');
const google = require('../../../shared/googleApi');
const { buildRawEmail, loadNotifySettings } = require('../../../shared/ctrlNotify');

const BATCH = 25;
const MAX_ATTEMPTS = 5;

async function claimBatch() {
  // Claim rows by bumping Attempts, so two overlapping runs never send the same one.
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT NotificationId, GroupId, Kind, ToEmail, Subject, Body, Attempts
       FROM CtrlNotifications
       WHERE Status = 'Pending' AND Attempts < $1
       ORDER BY CreatedAt
       LIMIT $2
       FOR UPDATE SKIP LOCKED`,
      [MAX_ATTEMPTS, BATCH]
    );
    if (rows.length) {
      await client.query(`UPDATE CtrlNotifications SET Attempts = Attempts + 1 WHERE NotificationId = ANY($1::uuid[])`, [rows.map((r) => r.notificationid)]);
    }
    return rows;
  });
}

async function sendOne(n, settingsCache) {
  if (!settingsCache.has(n.groupid)) settingsCache.set(n.groupid, await loadNotifySettings(n.groupid));
  const settings = settingsCache.get(n.groupid);
  if (!settings.emailEnabled || !settings.senderEmail) {
    // Email was switched off after this was queued: drop it rather than send.
    await query(`UPDATE CtrlNotifications SET Status = 'Failed', LastError = 'Email notifications are turned off' WHERE NotificationId = $1`, [n.notificationid]);
    return 'skipped';
  }
  try {
    await google.gmailSend(settings.senderEmail, buildRawEmail({ from: settings.senderEmail, to: n.toemail, subject: n.subject, body: n.body }));
    await query(`UPDATE CtrlNotifications SET Status = 'Sent', SentAt = now(), LastError = NULL WHERE NotificationId = $1`, [n.notificationid]);
    return 'sent';
  } catch (err) {
    const final = n.attempts + 1 >= MAX_ATTEMPTS;
    await query(
      `UPDATE CtrlNotifications SET Status = $2, LastError = $3 WHERE NotificationId = $1`,
      [n.notificationid, final ? 'Failed' : 'Pending', String(err.message || err).slice(0, 500)]
    );
    console.error('Notification send failed', n.notificationid, err.message);
    return final ? 'failed' : 'retry';
  }
}

exports.handler = async () => {
  const counts = { sent: 0, retry: 0, failed: 0, skipped: 0 };
  const settingsCache = new Map();
  const batch = await claimBatch();
  for (const n of batch) counts[await sendOne(n, settingsCache)] += 1;
  if (batch.length) console.log('Notifications', JSON.stringify(counts));
  return counts;
};

exports.MAX_ATTEMPTS = MAX_ATTEMPTS;
