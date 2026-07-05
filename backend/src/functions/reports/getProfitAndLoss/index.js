const { requireAuth } = require('../../../shared/verifyToken');
const { requireGroupAccess } = require('../../../shared/authorize');
const { json, withErrorHandling } = require('../../../shared/response');
const {
  resolveEntity,
  getLastSyncedAt,
  queryPeriodActivity,
  displayAmount,
  getReportLayout,
  evaluateReportLayout,
} = require('../../../shared/reportHelpers');

// Reduces this period's Revenue/Expense line items into the two maps
// evaluateReportLayout needs: total amount per Grouping (per period), and
// the underlying accounts per Grouping (for detail-level rendering).
// Accounts with no assigned Grouping are kept under a `null` key so
// evaluateReportLayout can still surface them via unassignedTotal instead
// of silently vanishing.
function buildAmountsByGroupingId(periods, rowsByPeriodLabel) {
  const amountsByGroupingIdPerPeriod = new Map();
  const accountsByGroupingIdMap = new Map();

  for (const period of periods) {
    for (const row of rowsByPeriodLabel.get(period.label) || []) {
      const groupingId = row.groupingid || null;
      const amount = displayAmount(row.classification, row.rawsum);

      if (!amountsByGroupingIdPerPeriod.has(groupingId)) amountsByGroupingIdPerPeriod.set(groupingId, {});
      const byPeriod = amountsByGroupingIdPerPeriod.get(groupingId);
      byPeriod[period.label] = (byPeriod[period.label] || 0) + amount;

      if (!accountsByGroupingIdMap.has(groupingId)) accountsByGroupingIdMap.set(groupingId, new Map());
      const accounts = accountsByGroupingIdMap.get(groupingId);
      const acctKey = row.accountcode || row.accountname;
      if (!accounts.has(acctKey)) {
        accounts.set(acctKey, { accountCode: row.accountcode, accountName: row.accountname, amountsByPeriod: {} });
      }
      accounts.get(acctKey).amountsByPeriod[period.label] = amount;
    }
  }

  const accountsByGroupingId = new Map(
    [...accountsByGroupingIdMap.entries()].map(([groupingId, m]) => [groupingId, [...m.values()]])
  );
  return { amountsByGroupingIdPerPeriod, accountsByGroupingId };
}

// POST /api/reports/profit-and-loss
// Body: { groupId, entityType, entityId, periods: [{label, startDate, endDate}], detailLevel }
// Row order/subtotals come entirely from this Group's configured PL Report
// Layout (Settings > Report Layout) -- see reportHelpers.evaluateReportLayout.
// Returns { configured: false } if no layout has been set up yet.
exports.handler = withErrorHandling(async (event) => {
  const claims = await requireAuth(event);
  const { groupId, entityType, entityId, periods, detailLevel = 'summary' } = JSON.parse(
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

  const layout = await getReportLayout(groupId, 'PL');
  if (!layout.configured) {
    return json(200, { periods, detailLevel, lastSyncedAt, configured: false });
  }

  const rowsByPeriodLabel = new Map();
  for (const period of periods) {
    const rows = await queryPeriodActivity(
      groupId,
      entities,
      ['Revenue', 'Expense'],
      period.startDate,
      period.endDate
    );
    rowsByPeriodLabel.set(period.label, rows);
  }

  const { amountsByGroupingIdPerPeriod, accountsByGroupingId } = buildAmountsByGroupingId(
    periods,
    rowsByPeriodLabel
  );

  const evaluated = evaluateReportLayout(layout.rows, periods, amountsByGroupingIdPerPeriod, {
    accountsByGroupingId: detailLevel === 'detail' ? accountsByGroupingId : undefined,
  });

  return json(200, {
    periods,
    detailLevel,
    lastSyncedAt,
    ...evaluated,
  });
});
