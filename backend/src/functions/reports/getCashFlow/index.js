const { requireAuth } = require('../../../shared/verifyToken');
const { requireGroupAccess } = require('../../../shared/authorize');
const { json, withErrorHandling } = require('../../../shared/response');
const {
  resolveEntity,
  getLastSyncedAt,
  queryPeriodActivity,
  queryCumulativeBalance,
  displayAmount,
  resolveReportView,
  getReportLayout,
  evaluateReportLayout,
} = require('../../../shared/reportHelpers');

function dayBefore(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function sumByGroupingId(rows, classification) {
  const totals = new Map();
  for (const row of rows) {
    if (row.classification !== classification) continue;
    const key = row.groupingid || null;
    totals.set(key, (totals.get(key) || 0) + displayAmount(classification, row.rawsum));
  }
  return totals;
}

// POST /api/reports/cash-flow
// Body: { groupId, entityType, entityId, periods: [{label, startDate, endDate}], detailLevel, reportViewId? }
// Row order/subtotals come from the requested Report View (Settings >
// Report Layout); reportViewId is optional, omitted resolves to the
// CashFlow statement's default view. Grouping rows may reference either PL
// Groupings (whose contribution is this period's P&L activity) or
// BalanceSheet Groupings (whose contribution is the period-over-period
// change in balance -- an asset increase uses cash, a liability/equity
// increase provides cash); this is a simplified direct mapping, not full
// indirect-method GAAP reconciliation. Category rollups like "Cash from
// Operations" are just ordinary user-labeled Total rows in that view, not
// a separate mechanism. Returns { configured: false } if no view/layout
// has been set up yet.
exports.handler = withErrorHandling(async (event) => {
  const claims = await requireAuth(event);
  const { groupId, entityType, entityId, periods, detailLevel = 'summary', reportViewId } = JSON.parse(
    event.body || '{}'
  );

  if (!groupId || !entityType || !entityId || !Array.isArray(periods) || !periods.length) {
    const err = new Error('groupId, entityType, entityId, and periods[] are required');
    err.statusCode = 400;
    throw err;
  }
  requireGroupAccess(claims, groupId);

  const entities = await resolveEntity(groupId, entityType, entityId);
  const lastSyncedAt = await getLastSyncedAt(entities);

  const resolvedViewId = await resolveReportView(groupId, 'CashFlow', reportViewId);
  const layout = await getReportLayout(resolvedViewId);
  if (!layout.configured) {
    return json(200, { periods, detailLevel, lastSyncedAt, configured: false });
  }

  const amountsByGroupingIdPerPeriod = new Map();
  const addToGrouping = (groupingId, periodLabel, amount) => {
    const key = groupingId || null;
    if (!amountsByGroupingIdPerPeriod.has(key)) amountsByGroupingIdPerPeriod.set(key, {});
    const byPeriod = amountsByGroupingIdPerPeriod.get(key);
    byPeriod[periodLabel] = (byPeriod[periodLabel] || 0) + amount;
  };

  for (const period of periods) {
    const plRows = await queryPeriodActivity(
      groupId,
      entities,
      ['Revenue', 'Expense'],
      period.startDate,
      period.endDate
    );
    const revenueTotals = sumByGroupingId(plRows, 'Revenue');
    const expenseTotals = sumByGroupingId(plRows, 'Expense');
    for (const [groupingId, amount] of revenueTotals) addToGrouping(groupingId, period.label, amount);
    for (const [groupingId, amount] of expenseTotals) addToGrouping(groupingId, period.label, -amount);

    const beginBsRows = await queryCumulativeBalance(
      groupId,
      entities,
      ['Asset', 'Liability', 'Equity'],
      dayBefore(period.startDate)
    );
    const endBsRows = await queryCumulativeBalance(groupId, entities, ['Asset', 'Liability', 'Equity'], period.endDate);

    for (const classification of ['Asset', 'Liability', 'Equity']) {
      const beginTotals = sumByGroupingId(beginBsRows, classification);
      const endTotals = sumByGroupingId(endBsRows, classification);
      const groupingIds = new Set([...beginTotals.keys(), ...endTotals.keys()]);
      for (const groupingId of groupingIds) {
        const delta = (endTotals.get(groupingId) || 0) - (beginTotals.get(groupingId) || 0);
        const contribution = classification === 'Asset' ? -delta : delta;
        addToGrouping(groupingId, period.label, contribution);
      }
    }
  }

  const evaluated = evaluateReportLayout(layout.rows, periods, amountsByGroupingIdPerPeriod);

  return json(200, {
    periods,
    detailLevel,
    lastSyncedAt,
    ...evaluated,
  });
});
