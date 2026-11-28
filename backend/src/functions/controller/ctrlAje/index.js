// Controller Phase 5a: recommended adjusting journal entries (AJEs).
//
// GET  /api/controller/aje?groupId=                      files (codes), settings, months with decisions, reports
// PUT  /api/controller/aje/settings                      { groupId, defaultGrouping?, files?: [{ qboId, fileCode }] }
// GET  /api/controller/aje/draft?groupId=&qboId=&month=&grouping=&reviseReportId=
// POST /api/controller/aje/reports                       publish: { groupId, qboId, month, grouping, expectedKeys,
//                                                          include: [{ key, memo? }], reviseReportId?, note? }
// GET  /api/controller/aje/reports/{reportId}?groupId=
// POST /api/controller/aje/reports/{reportId}/export     { groupId, format: 'pdf' | 'xlsx', includeSupport? }
// POST /api/controller/aje/check-posted                  { groupId, qboId } -- look for booked entries in the stored GLs
// GET  /api/controller/aje/rollup?groupId=               accountant portal rollup: status counts, open questions, activity
// POST /api/controller/aje/entries/{entryId}/comments    { groupId, body } -- answer an accountant's question
//
// Nothing here writes to QuickBooks: entries are recommendations the
// accountant books. Exports are written to the private evidence bucket
// (aje-exports/, removed after a day) and handed out as 5-minute links.
const { authorizeController } = require('../../../shared/controllerAuth');
const { requireGroupAccess } = require('../../../shared/authorize');
const { query, withTransaction } = require('../../../shared/db');
const { json, withErrorHandling } = require('../../../shared/response');
const { recordAudit } = require('../../../shared/audit');
const { parseMonth } = require('../../../shared/monthRanges');
const { badRequest, isUuid, loadEntities } = require('../../../shared/ctrlReviewData');
const B = require('../../../shared/ajeBuilder');
const data = require('../../../shared/ajeData');
const { exportReport } = require('../../../shared/ajeExportService');
const portal = require('../../../shared/portalData');
const { notifyReportPublished, notifyReply } = require('../../../shared/ctrlNotify');

const requireMonth = (month) => {
  if (!month || !parseMonth(month)) throw badRequest('month must be formatted YYYY-MM');
  return month;
};

async function handleOverview(groupId) {
  const entities = await loadEntities(groupId);
  const [files, settings, activity, reports] = await Promise.all([
    data.loadFileCodes(groupId, entities),
    data.loadAjeSettings(groupId),
    data.loadActivity(groupId),
    data.listReports(groupId),
  ]);
  return json(200, { ...settings, files, activity, reports });
}

async function handleSettings(claims, body) {
  const { groupId } = body;
  if (body.defaultGrouping !== undefined && !B.GROUPINGS.includes(body.defaultGrouping)) {
    throw badRequest(`defaultGrouping must be one of ${B.GROUPINGS.join(', ')}`);
  }
  const files = body.files === undefined ? [] : body.files;
  if (!Array.isArray(files)) throw badRequest('files must be a list');
  const codes = new Map();
  for (const f of files) {
    if (!f || !isUuid(f.qboId)) throw badRequest('Each file needs a qboId');
    const code = String(f.fileCode || '').trim().toUpperCase();
    if (!B.FILE_CODE_RE.test(code)) throw badRequest(`"${f.fileCode}" is not a valid code: 2 to 6 letters or digits, starting with a letter`);
    codes.set(f.qboId, code);
  }
  if (new Set(codes.values()).size !== codes.size) throw badRequest('Two files can\'t share a code');

  await withTransaction(async (client) => {
    if (codes.size) {
      const { rows } = await client.query(`SELECT QBOId FROM QBOs WHERE GroupId = $1 AND QBOId = ANY($2::uuid[])`, [groupId, [...codes.keys()]]);
      if (rows.length !== codes.size) throw badRequest('A file is not in this Group', 404);
      const { rows: clash } = await client.query(
        `SELECT FileCode FROM CtrlAjeFileSettings WHERE GroupId = $1 AND FileCode = ANY($2::text[]) AND NOT (QBOId = ANY($3::uuid[]))`,
        [groupId, [...codes.values()], [...codes.keys()]]
      );
      if (clash.length) throw badRequest(`Another file already uses the code ${clash[0].filecode}`, 409);
      // Move codes out of the way first so two files can swap codes.
      await client.query(`DELETE FROM CtrlAjeFileSettings WHERE GroupId = $1 AND QBOId = ANY($2::uuid[])`, [groupId, [...codes.keys()]]);
      for (const [qboId, code] of codes) {
        await client.query(
          `INSERT INTO CtrlAjeFileSettings (QBOId, GroupId, FileCode, UpdatedBy) VALUES ($1, $2, $3, $4)`,
          [qboId, groupId, code, claims.userId]
        );
      }
    }
    if (body.defaultGrouping) {
      await client.query(
        `INSERT INTO CtrlAjeSettings (GroupId, DefaultGrouping, UpdatedBy) VALUES ($1, $2, $3)
         ON CONFLICT (GroupId) DO UPDATE SET DefaultGrouping = EXCLUDED.DefaultGrouping, UpdatedBy = EXCLUDED.UpdatedBy, LastUpdated = now()`,
        [groupId, body.defaultGrouping, claims.userId]
      );
    }
    await recordAudit(
      {
        groupId, userId: claims.userId, action: 'ctrl.aje.settings', targetType: 'CtrlAjeSettings', targetId: groupId,
        details: { defaultGrouping: body.defaultGrouping, fileCodes: Object.fromEntries(codes) },
      },
      client
    );
  });
  return handleOverview(groupId);
}

async function handleDraft(groupId, qs) {
  const month = requireMonth(qs.month);
  const grouping = qs.grouping || (await data.loadAjeSettings(groupId)).defaultGrouping;
  const draft = await data.buildDraft({ groupId, qboId: qs.qboId, month, grouping, reviseReportId: qs.reviseReportId || null });
  return json(200, draft);
}

async function handlePublish(claims, body) {
  requireMonth(body.month);
  if (!isUuid(body.qboId)) throw badRequest('qboId is required');
  if (!B.GROUPINGS.includes(body.grouping)) throw badRequest(`grouping must be one of ${B.GROUPINGS.join(', ')}`);
  if (!Array.isArray(body.expectedKeys)) throw badRequest('expectedKeys is required');
  const result = await withTransaction(async (client) => {
    const r = await data.publishReport(client, { groupId: body.groupId, userId: claims.userId, body });
    await recordAudit(
      {
        groupId: body.groupId, userId: claims.userId, action: 'ctrl.aje.publish', targetType: 'CtrlAjeReport', targetId: r.reportId,
        details: { qboId: body.qboId, month: body.month, reportNumber: r.reportNumber, entries: r.entryCount, total: r.totalAmount, supersedes: r.supersedes, leftOut: r.leftOut },
      },
      client
    );
    const file = await data.loadFile(body.groupId, body.qboId, client);
    await notifyReportPublished(client, {
      groupId: body.groupId, qboId: body.qboId, reportId: r.reportId, reportNumber: r.reportNumber, qboName: file.qboname,
      month: body.month, entryCount: r.entryCount, supersedes: r.supersedes,
    });
    return r;
  });
  return json(201, result);
}

async function handleExport(claims, groupId, reportId, body) {
  const report = await data.loadReport(groupId, reportId);
  const result = await exportReport({ groupId, report, format: body.format, includeSupport: body.includeSupport });
  await recordAudit({
    groupId, userId: claims.userId, action: 'ctrl.aje.export', targetType: 'CtrlAjeReport', targetId: reportId,
    details: { format: body.format, bytes: result.bytes, supportIncluded: result.supportIncluded },
  });
  const { bytes, ...out } = result;
  return json(200, out);
}

async function handleReport(groupId, reportId) {
  return json(200, await portal.attachPortalState(groupId, await data.loadReport(groupId, reportId)));
}

async function handleReply(claims, groupId, entryId, body) {
  const entry = await portal.entryForAccountant(null, entryId);
  if (entry.groupId !== groupId) throw badRequest('Entry not found', 404);
  const comment = await withTransaction(async (client) => {
    const c = await portal.addComment(client, { entry, body: body.body, userId: claims.userId, userName: claims.username || 'Controller', role: 'Controller' });
    await recordAudit({
      groupId, userId: claims.userId, action: 'ctrl.aje.reply', targetType: 'CtrlAjeEntry', targetId: entryId,
      details: { entryNumber: entry.entryNumber, commentId: c.commentId, length: c.body.length },
    }, client);
    await notifyReply(client, { groupId, entry, body: c.body });
    return c;
  });
  return json(201, comment);
}

async function handleCheckPosted(claims, body) {
  if (!isUuid(body.qboId)) throw badRequest('qboId is required');
  await data.loadFile(body.groupId, body.qboId);
  const result = await data.checkFilePostings(body.groupId, body.qboId);
  await recordAudit({
    groupId: body.groupId, userId: claims.userId, action: 'ctrl.aje.checkPosted', targetType: 'QBO', targetId: body.qboId, details: result,
  });
  return json(200, result);
}

exports.handler = withErrorHandling(async (event) => {
  const claims = await authorizeController(event);
  const method = event.httpMethod;
  const resource = event.resource || '';
  const qs = event.queryStringParameters || {};
  let body = {};
  if (method !== 'GET') {
    try {
      body = event.body ? JSON.parse(event.body) : {};
    } catch {
      throw badRequest('Request body must be JSON');
    }
  }
  const groupId = method === 'GET' ? qs.groupId : body.groupId;
  if (!groupId) throw badRequest('groupId is required');
  requireGroupAccess(claims, groupId);
  const reportId = event.pathParameters?.reportId;

  if (method === 'GET' && resource === '/api/controller/aje') return handleOverview(groupId);
  if (method === 'PUT' && resource === '/api/controller/aje/settings') return handleSettings(claims, body);
  if (method === 'GET' && resource === '/api/controller/aje/draft') return handleDraft(groupId, qs);
  if (method === 'POST' && resource === '/api/controller/aje/reports') return handlePublish(claims, body);
  if (method === 'GET' && resource === '/api/controller/aje/reports/{reportId}') return handleReport(groupId, reportId);
  if (method === 'POST' && resource === '/api/controller/aje/reports/{reportId}/export') return handleExport(claims, groupId, reportId, body);
  if (method === 'POST' && resource === '/api/controller/aje/check-posted') return handleCheckPosted(claims, body);
  if (method === 'GET' && resource === '/api/controller/aje/rollup') return json(200, await portal.loadRollup(groupId));
  if (method === 'POST' && resource === '/api/controller/aje/entries/{entryId}/comments') return handleReply(claims, groupId, event.pathParameters?.entryId, body);
  throw badRequest('Unknown AJE route', 404);
});
