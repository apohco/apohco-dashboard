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
//
// Nothing here writes to QuickBooks: entries are recommendations the
// accountant books. Exports are written to the private evidence bucket
// (aje-exports/, removed after a day) and handed out as 5-minute links.
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { authorizeController } = require('../../../shared/controllerAuth');
const { requireGroupAccess } = require('../../../shared/authorize');
const { query, withTransaction } = require('../../../shared/db');
const { json, withErrorHandling } = require('../../../shared/response');
const { recordAudit } = require('../../../shared/audit');
const { parseMonth } = require('../../../shared/monthRanges');
const { badRequest, isUuid, loadEntities } = require('../../../shared/ctrlReviewData');
const B = require('../../../shared/ajeBuilder');
const data = require('../../../shared/ajeData');
const { buildXlsx, buildPdf, exportFileName } = require('../../../shared/ajeExport');

const LINK_SECONDS = 300;
const EXPORT_PREFIX = 'aje-exports';

let s3 = null;
const getS3 = () => {
  if (!s3) s3 = new S3Client({});
  return s3;
};

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
    return r;
  });
  return json(201, result);
}

async function readObject(key) {
  const { Body } = await getS3().send(new GetObjectCommand({ Bucket: process.env.EVIDENCE_BUCKET, Key: key }));
  const chunks = [];
  for await (const c of Body) chunks.push(c);
  return Buffer.concat(chunks);
}

// Saved support PDFs for a report, in entry order (with their S3 keys).
async function loadSupportFiles(groupId, report) {
  const ids = [...new Set(report.entries.flatMap((e) => e.support.map((s) => s.savedId)))];
  if (!ids.length) return [];
  const { rows } = await query(
    `SELECT SavedId, S3Key, FileName, SizeBytes FROM CtrlEvidenceSaved WHERE GroupId = $1 AND SavedId = ANY($2::uuid[]) AND Status = 'Saved'`,
    [groupId, ids]
  );
  const byId = new Map(rows.map((r) => [r.savedid, r]));
  const out = [];
  const done = new Set();
  for (const e of report.entries) {
    for (const s of e.support) {
      const row = byId.get(s.savedId);
      if (!row || done.has(s.savedId) || !/\.pdf$/i.test(row.filename || '')) continue;
      done.add(s.savedId);
      out.push({ entryNumber: e.entryNumber, fileName: row.filename, s3Key: row.s3key });
    }
  }
  return out;
}

async function handleExport(claims, groupId, reportId, body) {
  const format = body.format;
  if (!['pdf', 'xlsx'].includes(format)) throw badRequest('format must be pdf or xlsx');
  if (!process.env.EVIDENCE_BUCKET) throw new Error('EVIDENCE_BUCKET is not set');
  const report = await data.loadReport(groupId, reportId);
  let buffer;
  let contentType;
  let supportIncluded = 0;
  if (format === 'xlsx') {
    buffer = buildXlsx(report);
    contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  } else {
    const support = [];
    if (body.includeSupport !== false) {
      for (const s of await loadSupportFiles(groupId, report)) {
        try {
          support.push({ ...s, data: await readObject(s.s3Key) });
        } catch (err) {
          console.error('AJE export: support file unreadable', err.message);
        }
      }
    }
    supportIncluded = support.length;
    buffer = await buildPdf(report, { support });
    contentType = 'application/pdf';
  }
  const fileName = exportFileName(report, format);
  const key = `${EXPORT_PREFIX}/${groupId}/${reportId}/${Date.now()}-${format}.${format}`;
  await getS3().send(new PutObjectCommand({
    Bucket: process.env.EVIDENCE_BUCKET, Key: key, Body: buffer, ContentType: contentType, ServerSideEncryption: 'AES256',
  }));
  const url = await getSignedUrl(
    getS3(),
    new GetObjectCommand({ Bucket: process.env.EVIDENCE_BUCKET, Key: key, ResponseContentDisposition: `attachment; filename="${fileName.replace(/"/g, '')}"` }),
    { expiresIn: LINK_SECONDS }
  );
  await recordAudit({
    groupId, userId: claims.userId, action: 'ctrl.aje.export', targetType: 'CtrlAjeReport', targetId: reportId,
    details: { format, bytes: buffer.length, supportIncluded },
  });
  return json(200, { url, fileName, expiresInSeconds: LINK_SECONDS, supportIncluded });
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
  if (method === 'GET' && resource === '/api/controller/aje/reports/{reportId}') return json(200, await data.loadReport(groupId, reportId));
  if (method === 'POST' && resource === '/api/controller/aje/reports/{reportId}/export') return handleExport(claims, groupId, reportId, body);
  if (method === 'POST' && resource === '/api/controller/aje/check-posted') return handleCheckPosted(claims, body);
  throw badRequest('Unknown AJE route', 404);
});
