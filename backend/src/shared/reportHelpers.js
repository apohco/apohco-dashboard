const { query } = require('./db');

// Resolves a report's "entity" selector (a single QBO, or a Consolidation
// Group) into the list of {qboId, qboClassId} pairs whose RawTransactions
// should be included. qboClassId === null means "whole QBO" (per
// ConsolidationGroupQBOs' documented convention). Mirrors the consolidation
// logic described in claude.md: parent-QBO class-filtered transactions are
// unioned with a location's standalone QBO transactions.
async function resolveEntity(groupId, entityType, entityId) {
  if (entityType === 'qbo') {
    const { rows } = await query(`SELECT QBOId FROM QBOs WHERE QBOId = $1 AND GroupId = $2`, [
      entityId,
      groupId,
    ]);
    if (!rows.length) {
      const err = new Error('QBO not found for this Group');
      err.statusCode = 404;
      throw err;
    }
    return [{ qboId: entityId, qboClassId: null }];
  }

  if (entityType === 'consolidationGroup') {
    const { rows: cgRows } = await query(
      `SELECT ConsolidationGroupId FROM ConsolidationGroups WHERE ConsolidationGroupId = $1 AND GroupId = $2`,
      [entityId, groupId]
    );
    if (!cgRows.length) {
      const err = new Error('Consolidation Group not found for this Group');
      err.statusCode = 404;
      throw err;
    }

    const { rows } = await query(
      `SELECT cgq.QBOId, cgq.QBOClassId,
              ARRAY_REMOVE(ARRAY_AGG(cge.AccountCode), NULL) AS excludedaccountcodes
       FROM ConsolidationGroupQBOs cgq
       JOIN QBOs q ON q.QBOId = cgq.QBOId
       LEFT JOIN ConsolidationGroupQBOExclusions cge ON cge.ConsolidationGroupQBOId = cgq.Id
       WHERE cgq.ConsolidationGroupId = $1 AND q.GroupId = $2
       GROUP BY cgq.QBOId, cgq.QBOClassId`,
      [entityId, groupId]
    );
    return rows.map((r) => ({
      qboId: r.qboid,
      qboClassId: r.qboclassid,
      excludedAccountCodes: r.excludedaccountcodes || [],
    }));
  }

  const err = new Error("entityType must be 'qbo' or 'consolidationGroup'");
  err.statusCode = 400;
  throw err;
}

// Builds a parenthesized SQL OR-clause matching any of the resolved
// entities against a RawTransactions-aliased table, starting bound
// parameters at $<startIndex>. Returns the fragment, its params, and the
// next free parameter index so callers can keep building the query. An
// entity carrying `excludedAccountCodes` (set only for Consolidation Group
// members -- see resolveEntity) gets an extra AND NOT clause scoped to just
// that entity, so excluding an account from one QBO within one
// Consolidation Group never affects that QBO's standalone report or its
// membership in a different Consolidation Group.
function buildEntityWhereClause(entities, startIndex, alias = 'rt') {
  const clauses = [];
  const params = [];
  let idx = startIndex;

  for (const entity of entities) {
    const parts = [];
    if (entity.qboClassId === null) {
      parts.push(`${alias}.QBOId = $${idx}`);
      params.push(entity.qboId);
      idx += 1;
    } else {
      parts.push(`${alias}.QBOId = $${idx} AND ${alias}.QBOClassId = $${idx + 1}`);
      params.push(entity.qboId, entity.qboClassId);
      idx += 2;
    }
    if (entity.excludedAccountCodes?.length) {
      parts.push(`${alias}.AccountCode <> ALL($${idx}::text[])`);
      params.push(entity.excludedAccountCodes);
      idx += 1;
    }
    clauses.push(`(${parts.join(' AND ')})`);
  }

  return { sql: `(${clauses.join(' OR ')})`, params, nextIndex: idx };
}

async function getLastSyncedAt(entities) {
  if (!entities.length) return null;
  const qboIds = [...new Set(entities.map((e) => e.qboId))];
  const { rows } = await query(
    `SELECT MAX(PulledDate) AS lastsynced FROM RawTransactions WHERE QBOId = ANY($1::uuid[])`,
    [qboIds]
  );
  return rows[0]?.lastsynced || null;
}

// Sums RawTransactions.Amount per account (with its Grouping, if assigned),
// restricted to the given entity set and Classification(s) — Classification
// (Revenue/Expense for P&L, Asset/Liability/Equity for Balance Sheet) comes
// straight from QBO's Account.Classification, so this works even for
// accounts that haven't been assigned a Grouping yet (they surface as
// "Ungrouped" in the report rather than being silently dropped).
async function queryLineItems(groupId, entities, classifications, dateClauseSql, dateParams) {
  if (!entities.length) return [];

  const { sql: entitySql, params: entityParams, nextIndex } = buildEntityWhereClause(entities, 3);
  const dateSql = dateClauseSql(nextIndex);

  const { rows } = await query(
    `SELECT
       coam.GroupingId AS groupingid,
       ag.GroupingName AS groupingname,
       coam.AccountCode AS accountcode,
       coam.AccountName AS accountname,
       coam.Classification AS classification,
       SUM(rt.Amount) AS rawsum
     FROM RawTransactions rt
     JOIN ChartOfAccountsMappings coam ON coam.QBOId = rt.QBOId AND coam.AccountCode = rt.AccountCode
     LEFT JOIN AccountGroupings ag ON ag.GroupingId = coam.GroupingId
     WHERE rt.GroupId = $1
       AND coam.Classification = ANY($2::text[])
       AND ${entitySql}
       AND ${dateSql}
     GROUP BY coam.GroupingId, ag.GroupingName, coam.AccountCode, coam.AccountName, coam.Classification`,
    [groupId, classifications, ...entityParams, ...dateParams]
  );

  return rows;
}

async function queryPeriodActivity(groupId, entities, classifications, startDate, endDate) {
  return queryLineItems(
    groupId,
    entities,
    classifications,
    (idx) => `rt.TransactionDate BETWEEN $${idx} AND $${idx + 1}`,
    [startDate, endDate]
  );
}

async function queryCumulativeBalance(groupId, entities, classifications, asOfDate) {
  return queryLineItems(
    groupId,
    entities,
    classifications,
    (idx) => `rt.TransactionDate <= $${idx}`,
    [asOfDate]
  );
}

// Credit-normal accounts (Revenue, Liability, Equity) store negative Amount
// (Debit - Credit) for their "natural" activity; flipping the sign here
// gives reports the conventional positive display (e.g. Revenue shown
// positive, a Liability balance shown positive).
function displayAmount(classification, rawSum) {
  const creditNormal = ['Revenue', 'Liability', 'Equity'];
  const amount = Number(rawSum) || 0;
  return creditNormal.includes(classification) ? -amount : amount;
}

// Resolves which Report View a request should use: the explicitly
// requested `reportViewId` (validated against groupId+statement so a
// caller can't cross into another Group's or Statement's view), or -- when
// omitted -- the statement's IsDefault view. Returns null if no view
// exists yet (unconfigured), letting callers show an empty/prompt state.
async function resolveReportView(groupId, statement, reportViewId) {
  if (reportViewId) {
    const { rows } = await query(
      `SELECT ReportViewId FROM ReportViews WHERE ReportViewId = $1 AND GroupId = $2 AND Statement = $3`,
      [reportViewId, groupId, statement]
    );
    if (!rows.length) {
      const err = new Error('Report View not found for this Group/Statement');
      err.statusCode = 404;
      throw err;
    }
    return reportViewId;
  }

  const { rows } = await query(
    `SELECT ReportViewId FROM ReportViews WHERE GroupId = $1 AND Statement = $2 AND IsDefault = true`,
    [groupId, statement]
  );
  return rows[0]?.reportviewid || null;
}

// Fetches one Report View's ordered rows, each carrying its Total/Net
// component references (also ordered — for a Net row, the first component
// is the positive operand, the second is subtracted). Returns
// configured: false when reportViewId is null (nothing set up yet) or has
// no rows, so callers can show an empty/prompt state instead of guessing a
// fallback structure.
async function getReportLayout(reportViewId) {
  if (!reportViewId) return { configured: false, rows: [] };

  const { rows } = await query(
    `SELECT RowId, RowType, Label, GroupingId, IsSystemRow, IsRevenueBase, SortOrder
     FROM ReportLayoutRows
     WHERE ReportViewId = $1
     ORDER BY SortOrder`,
    [reportViewId]
  );
  if (!rows.length) return { configured: false, rows: [] };

  const rowIds = rows.map((r) => r.rowid);
  const { rows: componentRows } = await query(
    `SELECT RowId, ComponentRowId, SortOrder
     FROM ReportLayoutRowComponents
     WHERE RowId = ANY($1::uuid[])
     ORDER BY RowId, SortOrder`,
    [rowIds]
  );
  const componentsByRowId = new Map();
  for (const c of componentRows) {
    if (!componentsByRowId.has(c.rowid)) componentsByRowId.set(c.rowid, []);
    componentsByRowId.get(c.rowid).push(c.componentrowid);
  }

  return {
    configured: true,
    rows: rows.map((r) => ({
      rowId: r.rowid,
      rowType: r.rowtype,
      label: r.label,
      groupingId: r.groupingid,
      isSystemRow: r.issystemrow,
      isRevenueBase: r.isrevenuebase,
      componentRowIds: componentsByRowId.get(r.rowid) || [],
    })),
  };
}

// Evaluates a fetched Report Layout against this period's per-Grouping
// amounts, producing the flat ordered row list a report response returns.
// Pure function (no DB access) so it's easy to reason about/test in
// isolation from getReportLayout's fetch. `amountsByGroupingIdPerPeriod` is
// a Map<groupingId, {[periodLabel]: amount}>; `accountsByGroupingId` is a
// Map<groupingId, accounts[]> for detail-level rendering;
// `netIncomeByPeriod` (Balance Sheet only) supplies the value for the
// IsSystemRow "Net Income (current year)" row, which has no real
// GroupingId to look up.
function evaluateReportLayout(
  layoutRows,
  periods,
  amountsByGroupingIdPerPeriod,
  { netIncomeByPeriod, accountsByGroupingId } = {}
) {
  const valuesByRowId = new Map();
  const usedGroupingIds = new Set();

  const resultRows = layoutRows.map((row) => {
    const valuesByPeriod = {};

    if (row.rowType === 'Grouping') {
      if (row.groupingId) usedGroupingIds.add(row.groupingId);
      for (const period of periods) {
        valuesByPeriod[period.label] = row.isSystemRow
          ? netIncomeByPeriod?.[period.label] || 0
          : amountsByGroupingIdPerPeriod.get(row.groupingId)?.[period.label] || 0;
      }
    } else if (row.rowType === 'Total') {
      for (const period of periods) {
        valuesByPeriod[period.label] = row.componentRowIds.reduce(
          (sum, componentRowId) => sum + (valuesByRowId.get(componentRowId)?.[period.label] || 0),
          0
        );
      }
    } else if (row.rowType === 'Net') {
      const [positiveId, negativeId] = row.componentRowIds;
      for (const period of periods) {
        const positive = valuesByRowId.get(positiveId)?.[period.label] || 0;
        const negative = valuesByRowId.get(negativeId)?.[period.label] || 0;
        valuesByPeriod[period.label] = positive - negative;
      }
    }

    valuesByRowId.set(row.rowId, valuesByPeriod);

    return {
      rowId: row.rowId,
      rowType: row.rowType,
      label: row.label,
      isRevenueBase: row.isRevenueBase,
      valuesByPeriod,
      ...(row.rowType === 'Grouping' && !row.isSystemRow && accountsByGroupingId
        ? { accounts: accountsByGroupingId.get(row.groupingId) || [] }
        : {}),
    };
  });

  const unassignedTotal = {};
  for (const period of periods) {
    let total = 0;
    for (const [groupingId, amountsByPeriod] of amountsByGroupingIdPerPeriod) {
      if (!usedGroupingIds.has(groupingId)) total += amountsByPeriod[period.label] || 0;
    }
    unassignedTotal[period.label] = total;
  }

  return { configured: true, rows: resultRows, unassignedTotal };
}

module.exports = {
  resolveEntity,
  buildEntityWhereClause,
  getLastSyncedAt,
  queryPeriodActivity,
  queryCumulativeBalance,
  displayAmount,
  resolveReportView,
  getReportLayout,
  evaluateReportLayout,
};
