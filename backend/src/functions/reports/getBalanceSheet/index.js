const { requireAuth } = require('../../../shared/verifyToken');
const { requireGroupAccess } = require('../../../shared/authorize');
const { json, withErrorHandling } = require('../../../shared/response');
const {
  resolveEntity,
  getLastSyncedAt,
  queryCumulativeBalance,
  queryPeriodActivity,
  displayAmount,
  getReportLayout,
  evaluateReportLayout,
} = require('../../../shared/reportHelpers');

// Reduces this as-of-date's Asset/Liability/Equity balances into the two
// maps evaluateReportLayout needs: cumulative balance per Grouping (per
// period), and the underlying accounts per Grouping (for detail-level
// rendering). Accounts with no assigned Grouping are kept under a `null`
// key so evaluateReportLayout can still surface them via unassignedTotal.
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

function fiscalYearStart(asOfDate) {
  return `${asOfDate.slice(0, 4)}-01-01`;
}

// POST /api/reports/balance-sheet
// Body: { groupId, entityType, entityId, periods: [{label, asOfDate}], detailLevel }
// Balances are cumulative-since-inception as of each period's asOfDate.
// Row order/subtotals come from this Group's configured BalanceSheet
// Report Layout. That layout's one system row ("Net Income (current
// year)") is fed the same YTD P&L computation this report always used --
// APOHCO doesn't book a year-end closing entry into retained earnings
// mid-year, so this mirrors how QBO itself presents an interim Balance
// Sheet. Returns { configured: false } if no layout has been set up yet.
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

  const layout = await getReportLayout(groupId, 'BalanceSheet');
  if (!layout.configured) {
    return json(200, { periods, detailLevel, lastSyncedAt, configured: false });
  }

  const rowsByPeriodLabel = new Map();
  const netIncomeByPeriod = {};
  for (const period of periods) {
    const rows = await queryCumulativeBalance(groupId, entities, ['Asset', 'Liability', 'Equity'], period.asOfDate);
    rowsByPeriodLabel.set(period.label, rows);

    const ytdActivity = await queryPeriodActivity(
      groupId,
      entities,
      ['Revenue', 'Expense'],
      fiscalYearStart(period.asOfDate),
      period.asOfDate
    );
    const revenue = ytdActivity
      .filter((r) => r.classification === 'Revenue')
      .reduce((sum, r) => sum + displayAmount('Revenue', r.rawsum), 0);
    const expense = ytdActivity
      .filter((r) => r.classification === 'Expense')
      .reduce((sum, r) => sum + displayAmount('Expense', r.rawsum), 0);
    netIncomeByPeriod[period.label] = revenue - expense;
  }

  const { amountsByGroupingIdPerPeriod, accountsByGroupingId } = buildAmountsByGroupingId(
    periods,
    rowsByPeriodLabel
  );

  const evaluated = evaluateReportLayout(layout.rows, periods, amountsByGroupingIdPerPeriod, {
    netIncomeByPeriod,
    accountsByGroupingId: detailLevel === 'detail' ? accountsByGroupingId : undefined,
  });

  return json(200, {
    periods,
    detailLevel,
    lastSyncedAt,
    ...evaluated,
  });
});
