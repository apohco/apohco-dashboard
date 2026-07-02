const { requireAuth } = require('../../../shared/verifyToken');
const { requireRole, requireGroupAccess } = require('../../../shared/authorize');
const { encrypt, decrypt } = require('../../../shared/crypto');
const { query, withTransaction } = require('../../../shared/db');
const { json, withErrorHandling } = require('../../../shared/response');
const {
  refreshAccessToken,
  queryAccounts,
  queryClasses,
  getGeneralLedgerReport,
  flattenGeneralLedgerReport,
  buildAccountLookup,
} = require('../../../shared/qboClient');

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // refresh if expiring within 5 minutes

async function getValidAccessToken(qbo) {
  const expiry = new Date(qbo.tokenexpiry).getTime();
  if (expiry - Date.now() > TOKEN_REFRESH_BUFFER_MS) {
    return decrypt(qbo.accesstoken);
  }

  const refreshToken = await decrypt(qbo.refreshtoken);
  const refreshed = await refreshAccessToken(refreshToken);
  const newTokenExpiry = new Date(Date.now() + refreshed.expiresInSeconds * 1000).toISOString();

  await query(
    `UPDATE QBOs SET AccessToken = $1, RefreshToken = $2, TokenExpiry = $3 WHERE QBOId = $4`,
    [
      await encrypt(refreshed.accessToken),
      await encrypt(refreshed.refreshToken),
      newTokenExpiry,
      qbo.qboid,
    ]
  );

  return refreshed.accessToken;
}

async function syncClasses(qboId, realmId, accessToken) {
  const classes = await queryClasses(realmId, accessToken);
  const nameToId = new Map();

  for (const cls of classes) {
    const result = await query(
      `INSERT INTO QBOClasses (QBOId, ClassName, ClassId)
       VALUES ($1, $2, $3)
       ON CONFLICT (QBOId, ClassId) DO UPDATE SET ClassName = EXCLUDED.ClassName
       RETURNING QBOClassId, ClassName`,
      [qboId, cls.Name, cls.Id]
    );
    nameToId.set(result.rows[0].classname, result.rows[0].qboclassid);
  }

  return nameToId;
}

// Upserts the Chart of Accounts without disturbing existing Grouping
// assignments made in the Chart of Accounts Setup screen (Phase 2) — new
// accounts appear with a NULL GroupingId, matching the "reconcile" behavior
// described in claude.md. Also returns a lookup used to resolve the
// GeneralLedger report's per-account sections back to these same codes
// (see buildAccountLookup).
async function syncChartOfAccounts(groupId, qboId, realmId, accessToken) {
  const accounts = await queryAccounts(realmId, accessToken);

  for (const account of accounts) {
    const accountCode = account.AcctNum || account.Id;
    await query(
      `INSERT INTO ChartOfAccountsMappings (GroupId, QBOId, AccountCode, AccountName, Classification)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (QBOId, AccountCode) DO UPDATE SET
         AccountName = EXCLUDED.AccountName,
         Classification = EXCLUDED.Classification,
         LastUpdated = now()`,
      [groupId, qboId, accountCode, account.Name, account.Classification || null]
    );
  }

  return buildAccountLookup(accounts);
}

async function syncTransactions(
  groupId,
  qbo,
  realmId,
  accessToken,
  startDate,
  endDate,
  classNameToId,
  accountLookup
) {
  const report = await getGeneralLedgerReport(realmId, accessToken, startDate, endDate);
  const rows = flattenGeneralLedgerReport(report, accountLookup);

  await withTransaction(async (client) => {
    await client.query(
      `DELETE FROM RawTransactions WHERE QBOId = $1 AND TransactionDate BETWEEN $2 AND $3`,
      [qbo.qboid, startDate, endDate]
    );

    for (const row of rows) {
      if (!row.transactionDate) continue; // skip subtotal/summary lines with no date

      const qboClassId = row.className ? classNameToId.get(row.className) || null : null;

      await client.query(
        `INSERT INTO RawTransactions
           (GroupId, QBOId, QBOClassId, TransactionDate, AccountCode, AccountName,
            Debit, Credit, Amount, TransactionType, Description, QBOTransactionId)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          groupId,
          qbo.qboid,
          qboClassId,
          row.transactionDate,
          row.accountCode,
          row.accountName,
          row.debit,
          row.credit,
          row.amount,
          row.transactionType,
          row.description,
          row.qboTransactionId,
        ]
      );
    }
  });

  return rows.filter((r) => r.transactionDate).length;
}

// POST /api/qbo/sync
// Body: { qboId, startDate, endDate }  (dates as YYYY-MM-DD)
// Pulls Chart of Accounts, Classes (if class-based), and General Ledger
// transactions for the date range, overwriting RawTransactions for that
// QBO + range.
exports.handler = withErrorHandling(async (event) => {
  const claims = await requireAuth(event);
  requireRole(claims, ['Owner', 'Manager', 'SoftwareRep', 'SoftwareAdmin']);

  const { qboId, startDate, endDate } = JSON.parse(event.body || '{}');
  if (!qboId || !startDate || !endDate) {
    const err = new Error('qboId, startDate, and endDate are required');
    err.statusCode = 400;
    throw err;
  }

  const { rows } = await query(`SELECT * FROM QBOs WHERE QBOId = $1`, [qboId]);
  const qbo = rows[0];
  if (!qbo) {
    const err = new Error('QBO not found');
    err.statusCode = 404;
    throw err;
  }

  requireGroupAccess(claims, qbo.groupid);

  const accessToken = await getValidAccessToken(qbo);

  let classNameToId = new Map();
  if (qbo.isclassbased) {
    classNameToId = await syncClasses(qbo.qboid, qbo.realmid, accessToken);
  }

  const accountLookup = await syncChartOfAccounts(qbo.groupid, qbo.qboid, qbo.realmid, accessToken);

  const transactionsSynced = await syncTransactions(
    qbo.groupid,
    qbo,
    qbo.realmid,
    accessToken,
    startDate,
    endDate,
    classNameToId,
    accountLookup
  );

  return json(200, {
    transactionsSynced,
    dateRange: { startDate, endDate },
    lastSyncedAt: new Date().toISOString(),
  });
});
