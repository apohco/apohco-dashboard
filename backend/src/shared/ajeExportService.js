// Builds an AJE report export (Excel or PDF with support), writes it to the
// private evidence bucket under aje-exports/ (removed after a day by a
// lifecycle rule) and returns a 5-minute download link. Shared by the
// Controller's AJE page and the accountant portal.
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { query } = require('./db');
const { badRequest } = require('./ctrlReviewData');
const { buildXlsx, buildPdf, exportFileName } = require('./ajeExport');

const LINK_SECONDS = 300;
const EXPORT_PREFIX = 'aje-exports';

let s3 = null;
const getS3 = () => {
  if (!s3) s3 = new S3Client({});
  return s3;
};
const setS3 = (client) => {
  s3 = client;
};

const bucket = () => {
  if (!process.env.EVIDENCE_BUCKET) throw new Error('EVIDENCE_BUCKET is not set');
  return process.env.EVIDENCE_BUCKET;
};

async function readObject(key) {
  const { Body } = await getS3().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  const chunks = [];
  for await (const c of Body) chunks.push(c);
  return Buffer.concat(chunks);
}

// A short-lived link to an object in the evidence bucket. `inline` lets a
// browser show a PDF instead of downloading it.
function signedLink(key, fileName, { inline = false } = {}) {
  const disposition = `${inline ? 'inline' : 'attachment'}; filename="${String(fileName || 'file').replace(/["\r\n]/g, '')}"`;
  return getSignedUrl(getS3(), new GetObjectCommand({ Bucket: bucket(), Key: key, ResponseContentDisposition: disposition }), {
    expiresIn: LINK_SECONDS,
  });
}

// Saved support PDFs for a report, in entry order (with their S3 keys).
async function loadSupportFiles(groupId, report, db = { query }) {
  const ids = [...new Set(report.entries.flatMap((e) => e.support.map((s) => s.savedId)))];
  if (!ids.length) return [];
  const { rows } = await db.query(
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

// `report` is a full loadReport() result (with support s3 keys resolved
// server-side). Returns { url, fileName, expiresInSeconds, supportIncluded, bytes }.
async function exportReport({ groupId, report, format, includeSupport = true }) {
  if (!['pdf', 'xlsx'].includes(format)) throw badRequest('format must be pdf or xlsx');
  bucket();
  let buffer;
  let contentType;
  let supportIncluded = 0;
  if (format === 'xlsx') {
    buffer = buildXlsx(report);
    contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  } else {
    const support = [];
    if (includeSupport !== false) {
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
  const key = `${EXPORT_PREFIX}/${groupId}/${report.reportId}/${Date.now()}-${format}.${format}`;
  await getS3().send(new PutObjectCommand({
    Bucket: bucket(), Key: key, Body: buffer, ContentType: contentType, ServerSideEncryption: 'AES256',
  }));
  const url = await signedLink(key, fileName);
  return { url, fileName, expiresInSeconds: LINK_SECONDS, supportIncluded, bytes: buffer.length };
}

module.exports = { LINK_SECONDS, EXPORT_PREFIX, exportReport, loadSupportFiles, signedLink, setS3 };
