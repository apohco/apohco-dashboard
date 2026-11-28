const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { authorizeController } = require('../../../shared/controllerAuth');
const { requireGroupAccess } = require('../../../shared/authorize');
const { query, withTransaction } = require('../../../shared/db');
const { json, withErrorHandling } = require('../../../shared/response');
const { getPresignedUploadUrl, getObjectBuffer, deleteObject } = require('../../../shared/s3Client');
const { readRowArrays } = require('../../../shared/fileParser');
const { FIELDS, CLASSIFICATIONS, accountKey, parseGlRows } = require('../../../shared/glUploadParser');
const { fingerprintLines, snapshotHash } = require('../../../shared/ledgerFingerprint');
const { parseMonth, monthsBetween } = require('../../../shared/monthRanges');
const { insertRows } = require('../../../shared/bulkInsert');
const { recordAudit } = require('../../../shared/audit');
const { checkPostingsSafely } = require('../../../shared/ajeData');

// Same cap as an API pull (startCtrlSync).
const MAX_MONTHS_PER_UPLOAD = 36;
const RAW_PREVIEW_ROWS = 15;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTENT_TYPES = {
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
const LINE_COLUMNS = [
  'GroupId', 'SnapshotId', 'QBOId', 'Fingerprint', 'ContentHash', 'TxnDate', 'TxnType', 'DocNum',
  'QBOTxnId', 'PayeeName', 'PayeeQBOId', 'Memo', 'AccountCode', 'AccountName', 'ClassName',
  'QBOClassId', 'Debit', 'Credit', 'Amount', 'SplitAccount',
];

function badRequest(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

const fileExtension = (name) => (/\.([a-z0-9]+)$/i.exec(name || '')?.[1] || '').toLowerCase();

async function loadQbo(groupId, qboId) {
  const { rows } = await query(`SELECT QBOId, QBOName FROM QBOs WHERE QBOId = $1 AND GroupId = $2`, [qboId, groupId]);
  if (!rows.length) throw badRequest('QBO not found for this Group', 404);
  return rows[0];
}

async function loadUpload(groupId, uploadId) {
  const { rows } = await query(
    `SELECT u.*, q.QBOName FROM CtrlUploads u JOIN QBOs q ON q.QBOId = u.QBOId
     WHERE u.UploadId = $1 AND u.GroupId = $2`,
    [uploadId, groupId]
  );
  if (!rows.length) throw badRequest('Upload not found', 404);
  return rows[0];
}

// Account classifications this QBO file already has in the dashboard's
// Chart of Accounts (read only), keyed like glUploadParser.accountKey.
async function loadKnownClassifications(qboId) {
  const { rows } = await query(
    `SELECT AccountCode, AccountName, Classification FROM ChartOfAccountsMappings
     WHERE QBOId = $1 AND Classification IS NOT NULL`,
    [qboId]
  );
  const known = {};
  for (const r of rows) {
    if (r.accountcode) known[accountKey(r.accountcode, null)] = r.classification;
    if (r.accountname) known[accountKey(null, r.accountname)] = r.classification;
  }
  return known;
}

async function loadClassIds(qboId) {
  const { rows } = await query(`SELECT QBOClassId, ClassName FROM QBOClasses WHERE QBOId = $1`, [qboId]);
  return new Map(rows.map((r) => [r.classname, r.qboclassid]));
}

// The mapping used for the last imported file from this QBO with exactly
// these headers, so a recurring export maps itself.
async function loadSavedMapping(qboId, headerRow, headers) {
  const { rows } = await query(
    `SELECT ColumnMapping, AmountConvention FROM CtrlUploads
     WHERE QBOId = $1 AND Status = 'Imported' AND HeaderRow = $2 AND ColumnMapping->'headers' = $3::jsonb
     ORDER BY ImportedDate DESC LIMIT 1`,
    [qboId, headerRow, JSON.stringify(headers)]
  );
  return rows[0] ? { mapping: rows[0].columnmapping.fields, amountConvention: rows[0].amountconvention } : null;
}

function cleanClassifications(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw badRequest('classifications must be an object');
  for (const c of Object.values(value)) {
    if (!CLASSIFICATIONS.includes(c)) throw badRequest(`Classification must be one of ${CLASSIFICATIONS.join(', ')}`);
  }
  return value;
}

// Reads the stored file and parses it with the caller's options (or the
// detected / saved ones). Returns everything analyze and import need.
async function parseUpload(upload, body) {
  const buffer = await getObjectBuffer(upload.s3key).catch(() => {
    throw badRequest('The uploaded file is no longer available; upload it again', 410);
  });
  const rows = readRowArrays(buffer, fileExtension(upload.filename));
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

  const [knownClassifications, classIds] = await Promise.all([
    loadKnownClassifications(upload.qboid),
    loadClassIds(upload.qboid),
  ]);
  const options = {
    headerRow: body.headerRow === undefined || body.headerRow === null ? undefined : Number(body.headerRow),
    mapping: body.mapping || undefined,
    amountConvention: body.amountConvention || undefined,
    classifications: cleanClassifications(body.classifications),
    knownClassifications,
    classIds,
  };

  let mappingSource = options.mapping ? 'custom' : 'detected';
  let result;
  try {
    result = parseGlRows(rows, options);
    if (!options.mapping) {
      const saved = await loadSavedMapping(upload.qboid, result.headerRow, result.headers);
      if (saved) {
        mappingSource = 'saved';
        result = parseGlRows(rows, {
          ...options,
          headerRow: result.headerRow,
          mapping: saved.mapping,
          amountConvention: options.amountConvention || saved.amountConvention,
        });
      }
    }
  } catch (err) {
    throw badRequest(err.message);
  }
  return { rows, sha256, result, mappingSource };
}

// POST /api/controller/uploads  { groupId, qboId, fileName }
async function handleCreate(claims, body) {
  const { groupId, qboId, fileName } = body;
  if (!groupId || !qboId || !fileName) throw badRequest('groupId, qboId and fileName are required');
  requireGroupAccess(claims, groupId);
  const contentType = CONTENT_TYPES[fileExtension(fileName)];
  if (!contentType) throw badRequest('Only .csv and .xlsx files are supported');
  await loadQbo(groupId, qboId);

  const safeName = String(fileName).replace(/[^\w.\- ]+/g, '_').slice(-200);
  const s3Key = `controller-uploads/${groupId}/${qboId}/${uuidv4()}-${safeName}`;
  const { rows } = await query(
    `INSERT INTO CtrlUploads (GroupId, QBOId, FileName, S3Key, UploadedBy)
     VALUES ($1, $2, $3, $4, $5) RETURNING UploadId`,
    [groupId, qboId, safeName, s3Key, claims.userId]
  );
  const uploadUrl = await getPresignedUploadUrl(s3Key, contentType);
  return json(201, { uploadId: rows[0].uploadid, uploadUrl, contentType });
}

// POST /api/controller/uploads/{uploadId}/analyze
//   { groupId, headerRow?, mapping?, amountConvention?, classifications? }
// Detects (or applies) the column mapping and returns a preview. Stores
// nothing except the file's hash.
async function handleAnalyze(claims, uploadId, body) {
  const upload = await loadUpload(body.groupId, uploadId);
  if (upload.status !== 'Pending') throw badRequest('This file has already been imported', 409);
  const { rows, sha256, result, mappingSource } = await parseUpload(upload, body);

  if (!upload.filesha256) {
    await query(`UPDATE CtrlUploads SET FileSha256 = $2 WHERE UploadId = $1`, [uploadId, sha256]);
  }
  const { rows: dupes } = await query(
    `SELECT UploadId, FileName, ImportedDate FROM CtrlUploads
     WHERE QBOId = $1 AND FileSha256 = $2 AND Status = 'Imported' AND UploadId <> $3
     ORDER BY ImportedDate DESC LIMIT 1`,
    [upload.qboid, sha256, uploadId]
  );

  return json(200, {
    uploadId,
    fileName: upload.filename,
    qboName: upload.qboname,
    fields: FIELDS.map(({ key, label, required }) => ({ key, label, required: Boolean(required) })),
    mappingSource,
    headerRow: result.headerRow,
    headers: result.headers,
    mapping: result.mapping,
    amountConvention: result.amountConvention,
    problems: result.problems,
    rawPreview: rows.slice(0, RAW_PREVIEW_ROWS).map((r) => (r || []).map((c) => String(c ?? ''))),
    sample: result.sample,
    lineCount: result.lines.length,
    months: result.months,
    totals: result.totals,
    errorCount: result.errorCount,
    errors: result.errors,
    skippedRows: result.skippedRows,
    unknownAccounts: result.unknownAccounts,
    previousImport: dupes[0]
      ? { uploadId: dupes[0].uploadid, fileName: dupes[0].filename, importedDate: dupes[0].importeddate }
      : null,
  });
}

function validatePeriod(fromMonth, toMonth) {
  if (!parseMonth(fromMonth) || !parseMonth(toMonth)) throw badRequest('fromMonth and toMonth must be formatted YYYY-MM');
  if (toMonth < fromMonth) throw badRequest('toMonth must not be before fromMonth');
  const months = monthsBetween(fromMonth, toMonth);
  if (months.length > MAX_MONTHS_PER_UPLOAD) {
    throw badRequest(`An upload can cover at most ${MAX_MONTHS_PER_UPLOAD} months`);
  }
  return months;
}

// POST /api/controller/uploads/{uploadId}/import
//   { groupId, headerRow, mapping, amountConvention, classifications, fromMonth, toMonth }
// Stores one new snapshot per month from fromMonth to toMonth (a month with
// no lines in the file is stored as an empty snapshot: the file says
// nothing posted that month). Lines dated outside the range are left out.
async function handleImport(claims, uploadId, body) {
  const upload = await loadUpload(body.groupId, uploadId);
  if (upload.status !== 'Pending') throw badRequest('This file has already been imported', 409);
  if (!body.mapping || body.headerRow === undefined) throw badRequest('headerRow and mapping are required');
  const months = validatePeriod(body.fromMonth, body.toMonth);

  const { sha256, result } = await parseUpload(upload, body);
  if (result.problems.length) throw badRequest(result.problems.join(' '));
  if (result.unknownAccounts.length) {
    throw badRequest(`Classify ${result.unknownAccounts.length} account(s) before importing, so their amounts get the right sign`);
  }

  const byMonth = new Map(months.map((m) => [m, []]));
  let outsideRange = 0;
  for (const line of result.lines) {
    const bucket = byMonth.get(line.txnDate.slice(0, 7));
    if (bucket) bucket.push(line);
    else outsideRange += 1;
  }
  const lineCount = result.lines.length - outsideRange;
  if (lineCount === 0) throw badRequest('No lines in the file fall within the selected months');

  const stored = await withTransaction(async (client) => {
    // Row lock: a double-clicked Import can't store the file twice.
    const { rows: lock } = await client.query(
      `SELECT Status FROM CtrlUploads WHERE UploadId = $1 FOR UPDATE`,
      [uploadId]
    );
    if (lock[0]?.status !== 'Pending') throw badRequest('This file has already been imported', 409);

    const snapshots = [];
    for (const [month, monthLines] of byMonth) {
      const lines = fingerprintLines(upload.qboid, monthLines);
      const totalDebit = lines.reduce((s, l) => s + l.debit, 0);
      const totalCredit = lines.reduce((s, l) => s + l.credit, 0);
      const { rows: snap } = await client.query(
        `INSERT INTO CtrlSnapshots (GroupId, QBOId, Period, Source, UploadId, LineCount, TotalDebit, TotalCredit, ContentHash)
         VALUES ($1, $2, $3, 'Upload', $4, $5, $6, $7, $8)
         RETURNING SnapshotId`,
        [upload.groupid, upload.qboid, `${month}-01`, uploadId, lines.length, totalDebit.toFixed(2), totalCredit.toFixed(2), snapshotHash(lines)]
      );
      const snapshotId = snap[0].snapshotid;
      if (lines.length) {
        await insertRows(
          client,
          'CtrlLedgerLines',
          LINE_COLUMNS,
          lines.map((l) => [
            upload.groupid, snapshotId, upload.qboid, l.fingerprint, l.contentHash, l.txnDate, l.txnType,
            l.docNum, l.qboTxnId, l.payeeName, l.payeeQBOId, l.memo, l.accountCode, l.accountName,
            l.className, l.qboClassId, l.debit, l.credit, l.amount, l.splitAccount,
          ])
        );
      }
      snapshots.push({ snapshotId, month, lineCount: lines.length });
    }

    await client.query(
      `UPDATE CtrlUploads
       SET Status = 'Imported', ImportedDate = now(), FileSha256 = $2, HeaderRow = $3, ColumnMapping = $4,
           AmountConvention = $5, AccountClassifications = $6, PeriodFrom = $7, PeriodTo = $8,
           LineCount = $9, ErrorRowCount = $10
       WHERE UploadId = $1`,
      [
        uploadId, sha256, result.headerRow,
        JSON.stringify({ headers: result.headers, fields: result.mapping }),
        result.amountConvention, JSON.stringify(cleanClassifications(body.classifications)),
        `${body.fromMonth}-01`, `${body.toMonth}-01`, lineCount, result.errorCount,
      ]
    );
    await recordAudit(
      {
        groupId: upload.groupid,
        userId: claims.userId,
        action: 'ctrl.upload.imported',
        targetType: 'CtrlUpload',
        targetId: uploadId,
        details: {
          qboId: upload.qboid, fileName: upload.filename, fileSha256: sha256,
          fromMonth: body.fromMonth, toMonth: body.toMonth, lineCount, errorRowCount: result.errorCount,
          snapshotIds: snapshots.map((s) => s.snapshotId),
        },
      },
      client
    );
    return snapshots;
  });

  await deleteObject(upload.s3key).catch((err) => console.error('Could not delete uploaded GL file:', err.message));
  // Entries the accountant has booked since (their AJE number in Num or memo).
  for (const snap of stored) await checkPostingsSafely({ groupId: upload.groupid, qboId: upload.qboid, snapshotId: snap.snapshotId });

  return json(200, {
    uploadId,
    lineCount,
    outsideRange,
    errorCount: result.errorCount,
    snapshots: stored,
  });
}

// GET /api/controller/uploads?groupId=
async function handleList(groupId) {
  const { rows } = await query(
    `SELECT u.UploadId, u.FileName, u.Status, u.LineCount, u.ErrorRowCount, u.CreatedDate, u.ImportedDate,
            TO_CHAR(u.PeriodFrom, 'YYYY-MM') AS frommonth, TO_CHAR(u.PeriodTo, 'YYYY-MM') AS tomonth,
            q.QBOId, q.QBOName
     FROM CtrlUploads u JOIN QBOs q ON q.QBOId = u.QBOId
     WHERE u.GroupId = $1 AND u.Status = 'Imported'
     ORDER BY u.ImportedDate DESC LIMIT 50`,
    [groupId]
  );
  return json(
    200,
    rows.map((r) => ({
      uploadId: r.uploadid,
      fileName: r.filename,
      qboId: r.qboid,
      qboName: r.qboname,
      fromMonth: r.frommonth,
      toMonth: r.tomonth,
      lineCount: r.linecount,
      errorRowCount: r.errorrowcount,
      importedDate: r.importeddate,
    }))
  );
}

exports.handler = withErrorHandling(async (event) => {
  const claims = await authorizeController(event);

  if (event.httpMethod === 'GET') {
    const groupId = event.queryStringParameters?.groupId;
    if (!groupId) throw badRequest('groupId is required');
    requireGroupAccess(claims, groupId);
    return handleList(groupId);
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    throw badRequest('Request body must be JSON');
  }
  if (event.resource === '/api/controller/uploads') {
    if (event.httpMethod !== 'POST') throw badRequest('Method not allowed', 405);
    return handleCreate(claims, body);
  }

  if (!body.groupId) throw badRequest('groupId is required');
  requireGroupAccess(claims, body.groupId);
  const uploadId = event.pathParameters?.uploadId;
  if (!UUID_RE.test(uploadId || '')) throw badRequest('Upload not found', 404);
  if (event.resource.endsWith('/analyze')) return handleAnalyze(claims, uploadId, body);
  if (event.resource.endsWith('/import')) return handleImport(claims, uploadId, body);
  throw badRequest('Unknown Controller upload route', 404);
});

exports.validatePeriod = validatePeriod;
exports.MAX_MONTHS_PER_UPLOAD = MAX_MONTHS_PER_UPLOAD;
