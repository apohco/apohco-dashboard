const { requireAuth } = require('../../../shared/verifyToken');
const { requireGroupAccess } = require('../../../shared/authorize');
const { json, withErrorHandling } = require('../../../shared/response');
const {
  resolveEntity,
  getLastSyncedAt,
  queryCumulativeBalance,
  queryPeriodActivity,
  displayAmount,
} = require('../../../shared/reportHelpers');

function buildSection(periods, rowsByPeriodLabel, classification, detailLevel) {
  const groupingMap = new Map();

  for (const period of periods) {
    const rows = (rowsByPeriodLabel.get(period.label) || []).filter(
      (r) => r.classification === classification
    );

    for (const row of rows) {
      const key = row.groupingid || 'ungrouped';
      if (!groupingMap.has(key)) {
        groupingMap.set(key, {
          groupingId: row.groupingid || null,
          groupingName: row.groupingname || 'Ungrouped',
          accounts: new Map(),
        });
      }
      const grouping = groupingMap.get(key);

      const acctKey = row.accountcode || row.accountname;
      if (!grouping.accounts.has(acctKey)) {
        grouping.accounts.set(acctKey, {
          accountCode: row.accountcode,
          accountName: row.accountname,
          amountsByPeriod: {},
        });
      }
      grouping.accounts.get(acctKey).amountsByPeriod[period.label] = displayAmount(
        classification,
        row.rawsum
      );
    }
  }

  const groupings = [...groupingMap.values()].map((g) => {
    const accounts = [...g.accounts.values()];
    const subtotalsByPeriod = {};
    for (const period of periods) {
      subtotalsByPeriod[period.label] = accounts.reduce(
        (sum, a) => sum + (a.amountsByPeriod[period.label] || 0),
        0
      );
    }
    return {
      groupingId: g.groupingId,
      groupingName: g.groupingName,
      subtotalsByPeriod,
      ...(detailLevel === 'detail' ? { accounts } : {}),
    };
  });

  groupings.sort((a, b) => a.groupingName.localeCompare(b.groupingName));

  const totalsByPeriod = {};
  for (const period of periods) {
    totalsByPeriod[period.label] = groupings.reduce(
      (sum, g) => sum + (g.subtotalsByPeriod[period.label] || 0),
      0
    );
  }

  return { groupings, totalsByPeriod };
}

function fiscalYearStart(asOfDate) {
  return `${asOfDate.slice(0, 4)}-01-01`;
}

// POST /api/reports/balance-sheet
// Body: { groupId, entityType, entityId, periods: [{label, asOfDate}], detailLevel }
// Balances are cumulative-since-inception as of each period's asOfDate.
// Equity includes a computed "Net Income" line (current-fiscal-year P&L
// activity through asOfDate) since APOHCO doesn't book a year-end closing
// entry into retained earnings mid-year — this mirrors how QBO itself
// presents an interim Balance Sheet.
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

  const rowsByPeriodLabel = new Map();
  const netIncomeByPeriod = {};
  for (const period of periods) {
    const rows = await queryCumulativeBalance(
      groupId,
      entities,
      ['Asset', 'Liability', 'Equity'],
      period.asOfDate
    );
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

  const assets = buildSection(periods, rowsByPeriodLabel, 'Asset', detailLevel);
  const liabilities = buildSection(periods, rowsByPeriodLabel, 'Liability', detailLevel);
  const equity = buildSection(periods, rowsByPeriodLabel, 'Equity', detailLevel);

  equity.groupings.push({
    groupingId: null,
    groupingName: 'Net Income (current year)',
    subtotalsByPeriod: netIncomeByPeriod,
  });
  for (const period of periods) {
    equity.totalsByPeriod[period.label] =
      (equity.totalsByPeriod[period.label] || 0) + netIncomeByPeriod[period.label];
  }

  const liabilitiesAndEquityByPeriod = {};
  for (const period of periods) {
    liabilitiesAndEquityByPeriod[period.label] =
      (liabilities.totalsByPeriod[period.label] || 0) + (equity.totalsByPeriod[period.label] || 0);
  }

  return json(200, {
    periods,
    detailLevel,
    lastSyncedAt: await getLastSyncedAt(entities),
    assets,
    liabilities,
    equity,
    totalAssetsByPeriod: assets.totalsByPeriod,
    totalLiabilitiesAndEquityByPeriod: liabilitiesAndEquityByPeriod,
  });
});
