const { requireAuth } = require('../../../shared/verifyToken');
const { requireRole, requireGroupAccess } = require('../../../shared/authorize');
const { query, withTransaction } = require('../../../shared/db');
const { json, withErrorHandling } = require('../../../shared/response');
const { getReportLayout } = require('../../../shared/reportHelpers');

const STATEMENTS = ['PL', 'BalanceSheet', 'CashFlow'];
const ROW_TYPES = ['Grouping', 'Total', 'Net'];

// A CashFlow layout can pull Groupings from either statement's Chart of
// Accounts setup (period activity from PL Groupings, period-over-period
// balance change from BalanceSheet Groupings); PL/BalanceSheet layouts can
// only reference their own AccountType.
function allowedAccountTypesFor(statement) {
  if (statement === 'PL') return ['PL'];
  if (statement === 'BalanceSheet') return ['BalanceSheet'];
  return ['PL', 'BalanceSheet'];
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

// Validates the submitted rows array before any DB write. Throws a 400 with
// a specific, actionable message on the first problem found. Returns
// nothing -- callers rely on the throw.
async function validateRows(groupId, statement, rows) {
  if (!Array.isArray(rows) || !rows.length) throw badRequest('rows[] must be a non-empty array');

  const tempIdToIndex = new Map();
  rows.forEach((row, i) => {
    if (!row.tempId) throw badRequest(`Row ${i + 1} is missing a tempId`);
    if (tempIdToIndex.has(row.tempId)) throw badRequest(`Duplicate row id: ${row.tempId}`);
    tempIdToIndex.set(row.tempId, i);
    if (!ROW_TYPES.includes(row.rowType)) throw badRequest(`Row ${i + 1} has an invalid rowType`);
    if (!row.label || !String(row.label).trim()) throw badRequest(`Row ${i + 1} is missing a label`);
  });

  const groupingRows = rows.filter((r) => r.rowType === 'Grouping' && !r.isSystemRow);
  const groupingIds = groupingRows.map((r) => r.groupingId).filter(Boolean);
  if (groupingRows.some((r) => !r.groupingId)) {
    throw badRequest('Every non-system Grouping row must reference a groupingId');
  }
  const seenGroupingIds = new Set();
  for (const id of groupingIds) {
    if (seenGroupingIds.has(id)) throw badRequest('The same Grouping cannot be used twice in one layout');
    seenGroupingIds.add(id);
  }

  if (groupingIds.length) {
    const { rows: found } = await query(
      `SELECT GroupingId, AccountType FROM AccountGroupings WHERE GroupId = $1 AND GroupingId = ANY($2::uuid[])`,
      [groupId, groupingIds]
    );
    const accountTypeById = new Map(found.map((r) => [r.groupingid, r.accounttype]));
    const allowedTypes = allowedAccountTypesFor(statement);
    for (const id of groupingIds) {
      const accountType = accountTypeById.get(id);
      if (!accountType) throw badRequest(`Grouping ${id} was not found for this Group`);
      if (!allowedTypes.includes(accountType)) {
        throw badRequest(`Grouping ${id} (${accountType}) is not valid for a ${statement} layout`);
      }
    }
  }

  const systemRows = rows.filter((r) => r.isSystemRow);
  if (systemRows.length > 1) throw badRequest('Only one system row is allowed per layout');
  if (systemRows.length === 1 && statement !== 'BalanceSheet') {
    throw badRequest('The system Net Income row only applies to the Balance Sheet');
  }

  const revenueBaseRows = rows.filter((r) => r.isRevenueBase);
  if (revenueBaseRows.length > 1) throw badRequest('Only one row can be marked as the Revenue base');
  if (revenueBaseRows.length === 1 && statement !== 'PL') {
    throw badRequest('The Revenue base marker only applies to the Profit & Loss');
  }

  rows.forEach((row, i) => {
    if (row.rowType === 'Total' || row.rowType === 'Net') {
      const componentTempIds = row.componentTempIds || [];
      if (row.rowType === 'Total' && componentTempIds.length < 1) {
        throw badRequest(`Row ${i + 1} (${row.label}) needs at least one component`);
      }
      if (row.rowType === 'Net' && componentTempIds.length !== 2) {
        throw badRequest(`Row ${i + 1} (${row.label}) needs exactly two components (a Net is a subtraction)`);
      }
      for (const componentTempId of componentTempIds) {
        const componentIndex = tempIdToIndex.get(componentTempId);
        if (componentIndex === undefined || componentIndex >= i) {
          throw badRequest(
            `Row ${i + 1} (${row.label}) can only reference rows that appear earlier in the layout`
          );
        }
      }
    }
  });
}

async function handleGet(claims, params) {
  const { groupId, statement } = params;
  if (!groupId || !STATEMENTS.includes(statement)) {
    throw badRequest('groupId and a valid statement are required');
  }
  requireGroupAccess(claims, groupId);
  const result = await getReportLayout(groupId, statement);
  return json(200, result);
}

async function handlePut(claims, body) {
  const { groupId, statement, rows } = body;
  if (!groupId || !STATEMENTS.includes(statement)) {
    throw badRequest('groupId and a valid statement are required');
  }
  requireRole(claims, ['Owner', 'Manager']);
  requireGroupAccess(claims, groupId);

  await validateRows(groupId, statement, rows);

  await withTransaction(async (client) => {
    await client.query(`DELETE FROM ReportLayoutRows WHERE GroupId = $1 AND Statement = $2`, [
      groupId,
      statement,
    ]);

    const tempIdToRowId = new Map();
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const { rows: inserted } = await client.query(
        `INSERT INTO ReportLayoutRows
           (GroupId, Statement, RowType, Label, GroupingId, IsSystemRow, IsRevenueBase, SortOrder, UpdatedBy)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING RowId`,
        [
          groupId,
          statement,
          row.rowType,
          row.label,
          row.rowType === 'Grouping' && !row.isSystemRow ? row.groupingId : null,
          Boolean(row.isSystemRow),
          Boolean(row.isRevenueBase),
          i,
          claims.userId,
        ]
      );
      tempIdToRowId.set(row.tempId, inserted[0].rowid);
    }

    for (const row of rows) {
      if (row.rowType !== 'Total' && row.rowType !== 'Net') continue;
      const ownRowId = tempIdToRowId.get(row.tempId);
      for (let c = 0; c < row.componentTempIds.length; c += 1) {
        const componentRowId = tempIdToRowId.get(row.componentTempIds[c]);
        await client.query(
          `INSERT INTO ReportLayoutRowComponents (RowId, ComponentRowId, SortOrder) VALUES ($1, $2, $3)`,
          [ownRowId, componentRowId, c]
        );
      }
    }
  });

  const result = await getReportLayout(groupId, statement);
  return json(200, result);
}

// /api/settings/report-layout  GET  ?groupId=&statement=  -- fetch one Statement's layout
// /api/settings/report-layout  PUT  {groupId, statement, rows}  -- replace the whole layout
exports.handler = withErrorHandling(async (event) => {
  const claims = await requireAuth(event);

  switch (event.httpMethod) {
    case 'GET':
      return handleGet(claims, event.queryStringParameters || {});
    case 'PUT':
      return handlePut(claims, JSON.parse(event.body || '{}'));
    default: {
      const err = new Error(`Unsupported method ${event.httpMethod}`);
      err.statusCode = 405;
      throw err;
    }
  }
});
