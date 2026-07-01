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
      `SELECT cgq.QBOId, cgq.QBOClassId
       FROM ConsolidationGroupQBOs cgq
       JOIN QBOs q ON q.QBOId = cgq.QBOId
       WHERE cgq.ConsolidationGroupId = $1 AND q.GroupId = $2`,
      [entityId, groupId]
    );
    return rows.map((r) => ({ qboId: r.qboid, qboClassId: r.qboclassid }));
  }

  const err = new Error("entityType must be 'qbo' or 'consolidationGroup'");
  err.statusCode = 400;
  throw err;
}

// Builds a parenthesized SQL OR-clause matching any of the resolved
// entities against a RawTransactions-aliased table, starting bound
// parameters at $<startIndex>. Returns the fragment, its params, and the
// next free parameter index so callers can keep building the query.
function buildEntityWhereClause(entities, startIndex, alias = 'rt') {
  const clauses = [];
  const params = [];
  let idx = startIndex;

  for (const entity of entities) {
    if (entity.qboClassId === null) {
      clauses.push(`(${alias}.QBOId = $${idx})`);
      params.push(entity.qboId);
      idx += 1;
    } else {
      clauses.push(`(${alias}.QBOId = $${idx} AND ${alias}.QBOClassId = $${idx + 1})`);
      params.push(entity.qboId, entity.qboClassId);
      idx += 2;
    }
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

module.exports = {
  resolveEntity,
  buildEntityWhereClause,
  getLastSyncedAt,
  queryPeriodActivity,
  queryCumulativeBalance,
  displayAmount,
};
