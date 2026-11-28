// Controller Phase 5b: the accountant AJE portal. Accountant role only.
//
// GET  /api/controller/portal/reports?groupId=                     reports the caller can see, with status counts
// GET  /api/controller/portal/reports/{reportId}                   one report: entries, status, threads, support list
// PUT  /api/controller/portal/entries/{entryId}/status             { status: NotWorked|Booked|Declined, reason? }
// POST /api/controller/portal/entries/{entryId}/comments           { body }
// GET  /api/controller/portal/reports/{reportId}/docs/{savedId}    5-minute link to a support PDF
// POST /api/controller/portal/reports/{reportId}/export            { format: pdf|xlsx }
//
// Access: requireAuth -> requireRole(Accountant) -> an active
// CtrlAccountants row -> the report's Group and file in their
// CtrlAccountantAccess. The accountant never sends a Group to be trusted;
// everything is looked up from the report or entry. Every view, status
// change, comment, document link and export is logged in CtrlAuditLog.
const { query, withTransaction } = require('../../../shared/db');
const { json, withErrorHandling } = require('../../../shared/response');
const { recordAudit } = require('../../../shared/audit');
const { badRequest, isUuid } = require('../../../shared/ctrlReviewData');
const portal = require('../../../shared/portalData');
const { exportReport, signedLink, LINK_SECONDS } = require('../../../shared/ajeExportService');
const { notifyQuestion } = require('../../../shared/ctrlNotify');

const audit = (claims, groupId, action, targetType, targetId, details = {}, db) =>
  recordAudit({ groupId, userId: claims.userId, action, targetType, targetId, details }, db);

async function handleList(claims, accountant, qs) {
  const groupId = qs.groupId || null;
  if (groupId && !isUuid(groupId)) throw badRequest('groupId is not valid');
  return json(200, await portal.listPortalReports(accountant, { groupId }));
}

async function handleReport(claims, accountant, reportId) {
  const { ref, report } = await portal.loadPortalReport(accountant, reportId);
  await audit(claims, ref.groupId, 'portal.report.view', 'CtrlAjeReport', reportId, { reportNumber: report.reportNumber });
  return json(200, portal.portalView(report));
}

async function handleStatus(claims, accountant, entryId, body) {
  const entry = await portal.entryForAccountant(accountant, entryId);
  const result = await withTransaction(async (client) => {
    const r = await portal.setEntryStatus(client, { entry, status: body.status, reason: body.reason, userId: claims.userId, userName: accountant.fullName });
    if (r.changed) {
      await audit(claims, entry.groupId, 'portal.entry.status', 'CtrlAjeEntry', entryId, {
        entryNumber: entry.entryNumber, from: r.previous, to: r.status, reason: r.reason,
      }, client);
    }
    return r;
  });
  const { previous, ...out } = result;
  return json(200, out);
}

async function handleComment(claims, accountant, entryId, body) {
  const entry = await portal.entryForAccountant(accountant, entryId);
  const comment = await withTransaction(async (client) => {
    const c = await portal.addComment(client, { entry, body: body.body, userId: claims.userId, userName: accountant.fullName, role: portal.ACCOUNTANT_ROLE });
    await audit(claims, entry.groupId, 'portal.entry.comment', 'CtrlAjeEntry', entryId, { entryNumber: entry.entryNumber, commentId: c.commentId, length: c.body.length }, client);
    await notifyQuestion(client, { groupId: entry.groupId, entry, authorName: accountant.fullName, body: c.body });
    return c;
  });
  return json(201, comment);
}

async function handleDoc(claims, accountant, reportId, savedId) {
  const { ref, item } = await portal.supportForAccountant(accountant, reportId, savedId);
  const url = await signedLink(item.s3Key, item.fileName, { inline: /\.pdf$/i.test(item.fileName || '') });
  await audit(claims, ref.groupId, 'portal.doc.view', 'CtrlEvidenceSaved', savedId, { reportId, entryNumber: item.entryNumber, fileName: item.fileName });
  return json(200, { url, fileName: item.fileName, expiresInSeconds: LINK_SECONDS });
}

async function handleExport(claims, accountant, reportId, body) {
  const { ref, report } = await portal.loadPortalReport(accountant, reportId);
  // The accountant's copy doesn't name folders in the company's Google Drive.
  for (const e of report.entries) e.support = e.support.map((s) => ({ ...s, drivePath: null }));
  const result = await exportReport({ groupId: ref.groupId, report, format: body.format, includeSupport: body.includeSupport !== false });
  await audit(claims, ref.groupId, 'portal.report.export', 'CtrlAjeReport', reportId, { format: body.format, bytes: result.bytes, supportIncluded: result.supportIncluded });
  const { bytes, ...out } = result;
  return json(200, out);
}

exports.handler = withErrorHandling(async (event) => {
  const { claims, accountant } = await portal.authorizePortal(event, { query });
  const method = event.httpMethod;
  const resource = event.resource || '';
  const qs = event.queryStringParameters || {};
  const params = event.pathParameters || {};
  let body = {};
  if (method !== 'GET') {
    try {
      body = event.body ? JSON.parse(event.body) : {};
    } catch {
      throw badRequest('Request body must be JSON');
    }
  }

  if (method === 'GET' && resource === '/api/controller/portal/reports') return handleList(claims, accountant, qs);
  if (method === 'GET' && resource === '/api/controller/portal/reports/{reportId}') return handleReport(claims, accountant, params.reportId);
  if (method === 'PUT' && resource === '/api/controller/portal/entries/{entryId}/status') return handleStatus(claims, accountant, params.entryId, body);
  if (method === 'POST' && resource === '/api/controller/portal/entries/{entryId}/comments') return handleComment(claims, accountant, params.entryId, body);
  if (method === 'GET' && resource === '/api/controller/portal/reports/{reportId}/docs/{savedId}') return handleDoc(claims, accountant, params.reportId, params.savedId);
  if (method === 'POST' && resource === '/api/controller/portal/reports/{reportId}/export') return handleExport(claims, accountant, params.reportId, body);
  throw badRequest('Unknown portal route', 404);
});
