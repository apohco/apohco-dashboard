const { v4: uuidv4 } = require('uuid');
const { requireAuth } = require('../../../shared/verifyToken');
const { requireRole, requireGroupAccess } = require('../../../shared/authorize');
const { query, withTransaction } = require('../../../shared/db');
const { json, withErrorHandling } = require('../../../shared/response');
const { getPresignedUploadUrl, getObjectBuffer, deleteObject } = require('../../../shared/s3Client');
const { parseTransactionFile } = require('../../../shared/fileParser');

const ALLOWED_ROLES = ['Owner', 'Manager', 'SoftwareRep', 'SoftwareAdmin'];
const MAX_ERRORS_RETURNED = 50;
const CONTENT_TYPES = {
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

async function loadQbo(qboId, claims) {
  const { rows } = await query(`SELECT * FROM QBOs WHERE QBOId = $1`, [qboId]);
  const qbo = rows[0];
  if (!qbo) {
    const err = new Error('QBO not found');
    err.statusCode = 404;
    throw err;
  }
  requireGroupAccess(claims, qbo.groupid);
  return qbo;
}

// Ensures a QBOClasses row exists for every distinct className referenced
// in the upload (manually-created classes have no real QBO ClassId, so we
// synthesize one). Returns a Map of className -> QBOClassId.
async function resolveClasses(qboId, classNames) {
  const nameToId = new Map();
  if (!classNames.length) return nameToId;

  const { rows: existing } = await query(
    `SELECT QBOClassId, ClassName FROM QBOClasses WHERE QBOId = $1 AND ClassName = ANY($2::text[])`,
    [qboId, classNames]
  );
  for (const row of existing) nameToId.set(row.classname, row.qboclassid);

  for (const name of classNames) {
    if (nameToId.has(name)) continue;
    const { rows } = await query(
      `INSERT INTO QBOClasses (QBOId, ClassName, ClassId) VALUES ($1, $2, $3)
       RETURNING QBOClassId`,
      [qboId, name, `MANUAL-${uuidv4()}`]
    );
    nameToId.set(name, rows[0].qboclassid);
  }

  return nameToId;
}

function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) chunks.push(array.slice(i, i + size));
  return chunks;
}

// Builds a single multi-row "INSERT ... VALUES ($1,$2,...),($n+1,...)..."
// statement (and its flattened parameter list) for a batch of rows, each
// given as an array of column values in the same order as `columns`.
function buildBatchInsert(table, columns, valueRows) {
  const params = [];
  const valueGroups = valueRows.map((row) => {
    const placeholders = row.map((value) => {
      params.push(value);
      return `$${params.length}`;
    });
    return `(${placeholders.join(', ')})`;
  });
  const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${valueGroups.join(', ')}`;
  return { sql, params };
}

// Upserts ChartOfAccountsMappings for every account referenced in the
// upload, preserving existing GroupingId assignments — same "reconcile"
// behavior as syncQBOData's API sync path. Batched (rather than one
// INSERT per account) since a large chart of accounts would otherwise
// mean hundreds of sequential round-trips to the database.
async function upsertAccounts(groupId, qboId, accounts) {
  for (const batch of chunk(accounts, 500)) {
    const { sql, params } = buildBatchInsert(
      'ChartOfAccountsMappings',
      ['GroupId', 'QBOId', 'AccountCode', 'AccountName', 'Classification'],
      batch.map((a) => [groupId, qboId, a.accountCode, a.accountName, a.classification])
    );
    await query(
      `${sql}
       ON CONFLICT (QBOId, AccountCode) DO UPDATE SET
         AccountName = EXCLUDED.AccountName,
         Classification = EXCLUDED.Classification,
         LastUpdated = now()`,
      params
    );
  }
}

function fileExtension(fileName) {
  const match = /\.([a-z0-9]+)$/i.exec(fileName || '');
  return match ? match[1].toLowerCase() : '';
}

// AccountCode -> Classification for accounts this QBO has already been
// reconciled against (via a prior manual upload or API sync). Lets the
// parser accept a blank Classification for accounts it already knows,
// since Classification belongs to the account, not to any one upload.
async function loadKnownClassifications(qboId) {
  const { rows } = await query(
    `SELECT AccountCode, Classification FROM ChartOfAccountsMappings WHERE QBOId = $1`,
    [qboId]
  );
  return Object.fromEntries(rows.map((r) => [r.accountcode, r.classification]));
}

async function handlePresign(body, claims) {
  const { qboId, fileName } = body;
  if (!qboId || !fileName) {
    const err = new Error('qboId and fileName are required');
    err.statusCode = 400;
    throw err;
  }
  const qbo = await loadQbo(qboId, claims);

  const ext = fileExtension(fileName);
  const contentType = CONTENT_TYPES[ext];
  if (!contentType) {
    const err = new Error('Only .csv and .xlsx files are supported');
    err.statusCode = 400;
    throw err;
  }

  const s3Key = `uploads/${qbo.groupid}/${qbo.qboid}/${uuidv4()}-${fileName}`;
  const uploadUrl = await getPresignedUploadUrl(s3Key, contentType);
  return json(200, { uploadUrl, s3Key, contentType });
}

async function handlePreview(body, claims) {
  const { qboId, s3Key } = body;
  if (!qboId || !s3Key) {
    const err = new Error('qboId and s3Key are required');
    err.statusCode = 400;
    throw err;
  }
  const qbo = await loadQbo(qboId, claims);

  const buffer = await getObjectBuffer(s3Key);
  const knownClassifications = await loadKnownClassifications(qbo.qboid);
  const { rows, errors, accounts, totalRows } = parseTransactionFile(
    buffer,
    fileExtension(s3Key),
    knownClassifications
  );

  return json(200, {
    totalRows,
    validRows: rows.length,
    previewRows: rows.slice(0, 10),
    accountCount: accounts.length,
    errors: errors.slice(0, MAX_ERRORS_RETURNED),
    errorCount: errors.length,
  });
}

async function handleConfirm(body, claims) {
  const { qboId, s3Key, startDate, endDate } = body;
  if (!qboId || !s3Key || !startDate || !endDate) {
    const err = new Error('qboId, s3Key, startDate, and endDate are required');
    err.statusCode = 400;
    throw err;
  }
  const qbo = await loadQbo(qboId, claims);

  const buffer = await getObjectBuffer(s3Key);
  const knownClassifications = await loadKnownClassifications(qbo.qboid);
  const { rows, errors, accounts } = parseTransactionFile(
    buffer,
    fileExtension(s3Key),
    knownClassifications
  );

  let classNameToId = new Map();
  if (qbo.isclassbased) {
    const classNames = [...new Set(rows.map((r) => r.className).filter(Boolean))];
    classNameToId = await resolveClasses(qbo.qboid, classNames);
  }

  await upsertAccounts(qbo.groupid, qbo.qboid, accounts);

  // Batched in groups of 500 rather than one INSERT per row -- a single
  // large upload (thousands of rows) doing one round-trip per row was the
  // actual cause of "Network Error" on Confirm: API Gateway has a hard
  // 29-second integration timeout that isn't configurable higher, no
  // matter what the Lambda's own timeout is set to, and thousands of
  // sequential inserts routinely blew past that.
  await withTransaction(async (client) => {
    await client.query(
      `DELETE FROM RawTransactions WHERE QBOId = $1 AND TransactionDate BETWEEN $2 AND $3`,
      [qbo.qboid, startDate, endDate]
    );

    for (const batch of chunk(rows, 500)) {
      const { sql, params } = buildBatchInsert(
        'RawTransactions',
        [
          'GroupId', 'QBOId', 'QBOClassId', 'TransactionDate', 'AccountCode', 'AccountName',
          'Debit', 'Credit', 'Amount', 'TransactionType', 'Description', 'QBOTransactionId',
        ],
        batch.map((row) => [
          qbo.groupid,
          qbo.qboid,
          row.className ? classNameToId.get(row.className) || null : null,
          row.transactionDate,
          row.accountCode,
          row.accountName,
          row.debit,
          row.credit,
          row.amount,
          row.transactionType,
          row.description,
          row.qboTransactionId,
        ])
      );
      await client.query(sql, params);
    }
  });

  await deleteObject(s3Key).catch((err) => console.error('Failed to delete uploaded file from S3:', err));

  return json(200, {
    rowsImported: rows.length,
    rowsSkipped: errors.length,
    errors: errors.slice(0, MAX_ERRORS_RETURNED),
    dateRange: { startDate, endDate },
    lastSyncedAt: new Date().toISOString(),
  });
}

// /api/qbo/manual-upload/presign  POST — get an S3 presigned PUT URL
// /api/qbo/manual-upload/preview  POST — parse the uploaded file, return first 10 rows + errors, no DB writes
// /api/qbo/manual-upload/confirm  POST — parse + import into RawTransactions (overwrites the QBO+date range), deletes the S3 object
exports.handler = withErrorHandling(async (event) => {
  const claims = await requireAuth(event);
  requireRole(claims, ALLOWED_ROLES);
  const body = JSON.parse(event.body || '{}');

  if (event.resource.endsWith('/presign')) return handlePresign(body, claims);
  if (event.resource.endsWith('/preview')) return handlePreview(body, claims);
  if (event.resource.endsWith('/confirm')) return handleConfirm(body, claims);

  const err = new Error('Unknown manual upload action');
  err.statusCode = 404;
  throw err;
});
