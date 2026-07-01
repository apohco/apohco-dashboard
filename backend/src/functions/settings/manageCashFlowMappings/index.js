const { requireAuth } = require('../../../shared/verifyToken');
const { requireRole, requireGroupAccess } = require('../../../shared/authorize');
const { query, withTransaction } = require('../../../shared/db');
const { json, withErrorHandling } = require('../../../shared/response');

// /api/settings/cash-flow-mappings   GET, PUT
// GET returns every Grouping (P&L and Balance Sheet) for the Group along
// with its current CashFlowCategory (null if unassigned), for the Cash
// Flow Configuration screen.
exports.handler = withErrorHandling(async (event) => {
  const claims = await requireAuth(event);

  switch (event.httpMethod) {
    case 'GET': {
      const groupId = event.queryStringParameters?.groupId;
      if (!groupId) {
        const err = new Error('groupId is required');
        err.statusCode = 400;
        throw err;
      }
      requireGroupAccess(claims, groupId);

      const { rows } = await query(
        `SELECT ag.GroupingId, ag.GroupingName, ag.AccountType, cfm.CashFlowCategory
         FROM AccountGroupings ag
         LEFT JOIN CashFlowMappings cfm ON cfm.GroupingId = ag.GroupingId AND cfm.GroupId = ag.GroupId
         WHERE ag.GroupId = $1
         ORDER BY ag.AccountType, ag.GroupingName`,
        [groupId]
      );
      return json(200, rows);
    }

    case 'PUT': {
      requireRole(claims, ['Owner', 'Manager']);
      const { groupId, mappings } = JSON.parse(event.body || '{}');
      if (!groupId || !Array.isArray(mappings)) {
        const err = new Error('groupId and mappings[] are required');
        err.statusCode = 400;
        throw err;
      }
      requireGroupAccess(claims, groupId);

      await withTransaction(async (client) => {
        for (const m of mappings) {
          if (!m.cashFlowCategory) {
            await client.query(
              `DELETE FROM CashFlowMappings WHERE GroupId = $1 AND GroupingId = $2`,
              [groupId, m.groupingId]
            );
            continue;
          }

          await client.query(
            `INSERT INTO CashFlowMappings (GroupId, GroupingId, CashFlowCategory, UpdatedBy)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (GroupId, GroupingId) DO UPDATE SET
               CashFlowCategory = EXCLUDED.CashFlowCategory,
               UpdatedBy = EXCLUDED.UpdatedBy`,
            [groupId, m.groupingId, m.cashFlowCategory, claims.userId]
          );
        }
      });

      return json(200, { updated: mappings.length });
    }

    default: {
      const err = new Error(`Unsupported method ${event.httpMethod}`);
      err.statusCode = 405;
      throw err;
    }
  }
});
