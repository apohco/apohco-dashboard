const { requireAuth } = require('../../../shared/verifyToken');
const { requireGroupAccess } = require('../../../shared/authorize');
const { json, withErrorHandling } = require('../../../shared/response');
const {
  resolveEntity,
  getLastSyncedAt,
  queryPeriodActivity,
  displayAmount,
} = require('../../../shared/reportHelpers');

// Builds { groupings: [{groupingId, groupingName, subtotalsByPeriod, accounts?}], totalsByPeriod }
// for one P&L section (Income or Expense) from the per-period line-item rows.
function buildSection(periods, rowsByPeriodLabel, classification, detailLevel) {
  const groupingMap = new Map(); // groupingId (or 'ungrouped') -> { groupingId, groupingName, accounts: Map }

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

// POST /api/reports/profit-and-loss
// Body: { groupId, entityType, entityId, periods: [{label, startDate, endDate}], detailLevel }
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

  const income = buildSection(periods, rowsByPeriodLabel, 'Revenue', detailLevel);
  const expenses = buildSection(periods, rowsByPeriodLabel, 'Expense', detailLevel);

  const netIncomeByPeriod = {};
  for (const period of periods) {
    netIncomeByPeriod[period.label] =
      (income.totalsByPeriod[period.label] || 0) - (expenses.totalsByPeriod[period.label] || 0);
  }

  return json(200, {
    periods,
    detailLevel,
    lastSyncedAt: await getLastSyncedAt(entities),
    income,
    expenses,
    netIncomeByPeriod,
  });
});
