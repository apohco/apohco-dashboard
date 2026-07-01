const { requireAuth } = require('../../../shared/verifyToken');
const { requireGroupAccess } = require('../../../shared/authorize');
const { query } = require('../../../shared/db');
const { json, withErrorHandling } = require('../../../shared/response');
const {
  resolveEntity,
  getLastSyncedAt,
  queryPeriodActivity,
  queryCumulativeBalance,
  displayAmount,
} = require('../../../shared/reportHelpers');

function dayBefore(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function getCashFlowMappingsByGrouping(groupId) {
  const { rows } = await query(
    `SELECT ag.GroupingId, ag.GroupingName, ag.AccountType, cfm.CashFlowCategory
     FROM AccountGroupings ag
     JOIN CashFlowMappings cfm ON cfm.GroupingId = ag.GroupingId AND cfm.GroupId = ag.GroupId
     WHERE ag.GroupId = $1`,
    [groupId]
  );
  const map = new Map();
  for (const row of rows) {
    map.set(row.groupingid, {
      groupingName: row.groupingname,
      accountType: row.accounttype,
      category: row.cashflowcategory,
    });
  }
  return map;
}

function sumByGroupingId(rows, classification) {
  const totals = new Map();
  for (const row of rows) {
    if (row.classification !== classification) continue;
    const current = totals.get(row.groupingid) || 0;
    totals.set(row.groupingid, current + displayAmount(classification, row.rawsum));
  }
  return totals;
}

// POST /api/reports/cash-flow
// Body: { groupId, entityType, entityId, periods: [{label, startDate, endDate}], detailLevel }
// Cash Flow Category (Operations/Investing/Financing) comes from the
// per-Grouping CashFlowMappings assigned in Settings. P&L groupings
// contribute their period activity; Balance Sheet groupings contribute
// their change in balance over the period (increase in an asset uses
// cash, increase in a liability/equity provides cash). Groupings without a
// CashFlowMapping are excluded — this is a simplified direct mapping, not
// full indirect-method GAAP reconciliation.
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
  const cashFlowMappings = await getCashFlowMappingsByGrouping(groupId);

  const categories = { Operations: {}, Investing: {}, Financing: {} };
  for (const category of Object.keys(categories)) {
    categories[category] = { groupings: new Map(), totalsByPeriod: {} };
  }

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

    const beginBsRows = await queryCumulativeBalance(
      groupId,
      entities,
      ['Asset', 'Liability', 'Equity'],
      dayBefore(period.startDate)
    );
    const endBsRows = await queryCumulativeBalance(
      groupId,
      entities,
      ['Asset', 'Liability', 'Equity'],
      period.endDate
    );

    // groupingId -> contribution for this period, tagged with its assigned category
    const contributions = new Map();

    for (const [groupingId, amount] of revenueTotals) {
      contributions.set(groupingId, amount); // revenue increases cash
    }
    for (const [groupingId, amount] of expenseTotals) {
      contributions.set(groupingId, (contributions.get(groupingId) || 0) - amount); // expense decreases cash
    }

    for (const classification of ['Asset', 'Liability', 'Equity']) {
      const beginTotals = sumByGroupingId(beginBsRows, classification);
      const endTotals = sumByGroupingId(endBsRows, classification);
      const groupingIds = new Set([...beginTotals.keys(), ...endTotals.keys()]);
      for (const groupingId of groupingIds) {
        const delta = (endTotals.get(groupingId) || 0) - (beginTotals.get(groupingId) || 0);
        const contribution = classification === 'Asset' ? -delta : delta;
        contributions.set(groupingId, (contributions.get(groupingId) || 0) + contribution);
      }
    }

    for (const [groupingId, amount] of contributions) {
      const mapping = cashFlowMappings.get(groupingId);
      if (!mapping) continue; // no CashFlowMapping assigned yet — excluded until configured

      const section = categories[mapping.category];
      if (!section.groupings.has(groupingId)) {
        section.groupings.set(groupingId, {
          groupingId,
          groupingName: mapping.groupingName,
          subtotalsByPeriod: {},
        });
      }
      section.groupings.get(groupingId).subtotalsByPeriod[period.label] = amount;
      section.totalsByPeriod[period.label] = (section.totalsByPeriod[period.label] || 0) + amount;
    }
  }

  const result = {};
  for (const [category, section] of Object.entries(categories)) {
    result[category.toLowerCase()] = {
      groupings: [...section.groupings.values()].sort((a, b) =>
        a.groupingName.localeCompare(b.groupingName)
      ),
      totalsByPeriod: section.totalsByPeriod,
    };
  }

  const netCashChangeByPeriod = {};
  for (const period of periods) {
    netCashChangeByPeriod[period.label] =
      (result.operations.totalsByPeriod[period.label] || 0) +
      (result.investing.totalsByPeriod[period.label] || 0) +
      (result.financing.totalsByPeriod[period.label] || 0);
  }

  return json(200, {
    periods,
    detailLevel,
    lastSyncedAt: await getLastSyncedAt(entities),
    ...result,
    netCashChangeByPeriod,
  });
});
