const { requireAuth } = require('../../../shared/verifyToken');
const { requireRole, requireGroupAccess } = require('../../../shared/authorize');
const { query, withTransaction } = require('../../../shared/db');
const { json, withErrorHandling } = require('../../../shared/response');
const { getReportLayout } = require('../../../shared/reportHelpers');

const STATEMENTS = ['PL', 'BalanceSheet', 'CashFlow'];

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

async function requireOwnedView(reportViewId, groupId, statement = null) {
  const params = [reportViewId, groupId];
  let statementFilter = '';
  if (statement) {
    statementFilter = 'AND Statement = $3';
    params.push(statement);
  }
  const { rows } = await query(
    `SELECT ReportViewId, Statement, IsDefault FROM ReportViews WHERE ReportViewId = $1 AND GroupId = $2 ${statementFilter}`,
    params
  );
  if (!rows.length) {
    const err = new Error('Report View not found for this Group');
    err.statusCode = 404;
    throw err;
  }
  return rows[0];
}

async function handleGet(claims, params) {
  const { groupId, statement } = params;
  if (!groupId || !STATEMENTS.includes(statement)) {
    throw badRequest('groupId and a valid statement are required');
  }
  requireGroupAccess(claims, groupId);

  const { rows } = await query(
    `SELECT ReportViewId, ViewName, IsDefault, SortOrder
     FROM ReportViews
     WHERE GroupId = $1 AND Statement = $2
     ORDER BY SortOrder, ViewName`,
    [groupId, statement]
  );
  return json(
    200,
    rows.map((r) => ({
      reportViewId: r.reportviewid,
      viewName: r.viewname,
      isDefault: r.isdefault,
      sortOrder: r.sortorder,
    }))
  );
}

// Copies a source view's rows + components into a freshly-created target
// view, inside the caller's transaction. Reuses the same temp-id-map
// insert pattern manageReportLayout's PUT already uses for a whole-layout
// replace, just sourced from getReportLayout's already-fetched rows
// instead of a client-submitted array.
async function cloneRowsInto(client, targetReportViewId, groupId, statement, claims, sourceViewId) {
  const source = await getReportLayout(sourceViewId);
  if (!source.configured) return;

  const oldRowIdToNewRowId = new Map();
  for (let i = 0; i < source.rows.length; i += 1) {
    const row = source.rows[i];
    const { rows: inserted } = await client.query(
      `INSERT INTO ReportLayoutRows
         (ReportViewId, GroupId, Statement, RowType, Label, GroupingId, IsSystemRow, IsRevenueBase, SortOrder, UpdatedBy)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING RowId`,
      [
        targetReportViewId,
        groupId,
        statement,
        row.rowType,
        row.label,
        row.groupingId,
        row.isSystemRow,
        row.isRevenueBase,
        i,
        claims.userId,
      ]
    );
    oldRowIdToNewRowId.set(row.rowId, inserted[0].rowid);
  }

  for (const row of source.rows) {
    if (row.rowType !== 'Total' && row.rowType !== 'Net') continue;
    const newOwnRowId = oldRowIdToNewRowId.get(row.rowId);
    for (let c = 0; c < row.componentRowIds.length; c += 1) {
      const newComponentRowId = oldRowIdToNewRowId.get(row.componentRowIds[c]);
      await client.query(
        `INSERT INTO ReportLayoutRowComponents (RowId, ComponentRowId, SortOrder) VALUES ($1, $2, $3)`,
        [newOwnRowId, newComponentRowId, c]
      );
    }
  }
}

async function handlePost(claims, body) {
  const { groupId, statement, viewName, cloneFromReportViewId } = body;
  if (!groupId || !STATEMENTS.includes(statement) || !viewName || !String(viewName).trim()) {
    throw badRequest('groupId, a valid statement, and viewName are required');
  }
  requireRole(claims, ['Owner', 'Manager']);
  requireGroupAccess(claims, groupId);

  if (cloneFromReportViewId) {
    await requireOwnedView(cloneFromReportViewId, groupId, statement);
  }

  const created = await withTransaction(async (client) => {
    const { rows: existing } = await client.query(
      `SELECT COUNT(*)::int AS count, COALESCE(MAX(SortOrder), -1) AS maxsortorder
       FROM ReportViews WHERE GroupId = $1 AND Statement = $2`,
      [groupId, statement]
    );
    const isFirst = existing[0].count === 0;
    const sortOrder = existing[0].maxsortorder + 1;

    const { rows: inserted } = await client.query(
      `INSERT INTO ReportViews (GroupId, Statement, ViewName, IsDefault, SortOrder, CreatedBy)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ReportViewId, ViewName, IsDefault, SortOrder`,
      [groupId, statement, viewName.trim(), isFirst, sortOrder, claims.userId]
    );
    const view = inserted[0];

    if (cloneFromReportViewId) {
      await cloneRowsInto(client, view.reportviewid, groupId, statement, claims, cloneFromReportViewId);
    }

    return view;
  });

  return json(201, {
    reportViewId: created.reportviewid,
    viewName: created.viewname,
    isDefault: created.isdefault,
    sortOrder: created.sortorder,
  });
}

async function handlePut(claims, reportViewId, body) {
  const { groupId, viewName, setDefault } = body;
  if (!groupId) throw badRequest('groupId is required');
  requireRole(claims, ['Owner', 'Manager']);
  requireGroupAccess(claims, groupId);

  const view = await requireOwnedView(reportViewId, groupId);

  await withTransaction(async (client) => {
    if (viewName && String(viewName).trim()) {
      await client.query(`UPDATE ReportViews SET ViewName = $1 WHERE ReportViewId = $2 AND GroupId = $3`, [
        viewName.trim(),
        reportViewId,
        groupId,
      ]);
    }
    if (setDefault) {
      await client.query(
        `UPDATE ReportViews SET IsDefault = false WHERE GroupId = $1 AND Statement = $2 AND IsDefault = true`,
        [groupId, view.statement]
      );
      await client.query(`UPDATE ReportViews SET IsDefault = true WHERE ReportViewId = $1 AND GroupId = $2`, [
        reportViewId,
        groupId,
      ]);
    }
  });

  const { rows } = await query(
    `SELECT ReportViewId, ViewName, IsDefault, SortOrder FROM ReportViews WHERE ReportViewId = $1`,
    [reportViewId]
  );
  return json(200, {
    reportViewId: rows[0].reportviewid,
    viewName: rows[0].viewname,
    isDefault: rows[0].isdefault,
    sortOrder: rows[0].sortorder,
  });
}

async function handleDelete(claims, reportViewId, params) {
  const { groupId } = params;
  if (!groupId) throw badRequest('groupId is required');
  requireRole(claims, ['Owner', 'Manager']);
  requireGroupAccess(claims, groupId);

  const view = await requireOwnedView(reportViewId, groupId);

  await withTransaction(async (client) => {
    await client.query(`DELETE FROM ReportViews WHERE ReportViewId = $1 AND GroupId = $2`, [
      reportViewId,
      groupId,
    ]);

    if (view.isdefault) {
      const { rows: remaining } = await client.query(
        `SELECT ReportViewId FROM ReportViews WHERE GroupId = $1 AND Statement = $2 ORDER BY SortOrder, ViewName LIMIT 1`,
        [groupId, view.statement]
      );
      if (remaining.length) {
        await client.query(`UPDATE ReportViews SET IsDefault = true WHERE ReportViewId = $1`, [
          remaining[0].reportviewid,
        ]);
      }
    }
  });

  return json(204, null);
}

// /api/settings/report-views                  GET, POST
// /api/settings/report-views/{reportViewId}    PUT, DELETE
// Body for POST: { groupId, statement, viewName, cloneFromReportViewId? }
// Body for PUT:  { groupId, viewName?, setDefault? }
exports.handler = withErrorHandling(async (event) => {
  const claims = await requireAuth(event);
  const reportViewId = event.pathParameters?.reportViewId;

  switch (event.httpMethod) {
    case 'GET':
      return handleGet(claims, event.queryStringParameters || {});
    case 'POST':
      return handlePost(claims, JSON.parse(event.body || '{}'));
    case 'PUT':
      return handlePut(claims, reportViewId, JSON.parse(event.body || '{}'));
    case 'DELETE':
      return handleDelete(claims, reportViewId, event.queryStringParameters || {});
    default: {
      const err = new Error(`Unsupported method ${event.httpMethod}`);
      err.statusCode = 405;
      throw err;
    }
  }
});
