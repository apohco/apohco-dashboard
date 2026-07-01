const { requireAuth } = require('../../../shared/verifyToken');
const { requireRole, requireGroupAccess } = require('../../../shared/authorize');
const { query } = require('../../../shared/db');
const { json, withErrorHandling } = require('../../../shared/response');

// /api/settings/account-groupings            GET, POST
// /api/settings/account-groupings/{groupingId} PUT, DELETE
// AccountGroupings apply to both P&L and Balance Sheet accounts (see
// claude.md's Chart of Accounts Setup section).
exports.handler = withErrorHandling(async (event) => {
  const claims = await requireAuth(event);
  const groupingId = event.pathParameters?.groupingId;

  switch (event.httpMethod) {
    case 'GET': {
      const groupId = event.queryStringParameters?.groupId;
      if (!groupId) {
        const err = new Error('groupId is required');
        err.statusCode = 400;
        throw err;
      }
      requireGroupAccess(claims, groupId);

      const accountType = event.queryStringParameters?.accountType;
      const params = [groupId];
      let filter = '';
      if (accountType) {
        filter = 'AND AccountType = $2';
        params.push(accountType);
      }

      const { rows } = await query(
        `SELECT GroupingId, GroupingName, AccountType, CreatedDate
         FROM AccountGroupings
         WHERE GroupId = $1 ${filter}
         ORDER BY GroupingName`,
        params
      );
      return json(200, rows);
    }

    case 'POST': {
      requireRole(claims, ['Owner', 'Manager']);
      const { groupId, groupingName, accountType } = JSON.parse(event.body || '{}');
      if (!groupId || !groupingName || !['PL', 'BalanceSheet'].includes(accountType)) {
        const err = new Error('groupId, groupingName, and a valid accountType are required');
        err.statusCode = 400;
        throw err;
      }
      requireGroupAccess(claims, groupId);

      const { rows } = await query(
        `INSERT INTO AccountGroupings (GroupId, GroupingName, AccountType, CreatedBy)
         VALUES ($1, $2, $3, $4)
         RETURNING GroupingId, GroupingName, AccountType, CreatedDate`,
        [groupId, groupingName, accountType, claims.userId]
      );
      return json(201, rows[0]);
    }

    case 'PUT': {
      requireRole(claims, ['Owner', 'Manager']);
      const { groupId, groupingName } = JSON.parse(event.body || '{}');
      if (!groupId || !groupingName) {
        const err = new Error('groupId and groupingName are required');
        err.statusCode = 400;
        throw err;
      }
      requireGroupAccess(claims, groupId);

      const { rows } = await query(
        `UPDATE AccountGroupings SET GroupingName = $1
         WHERE GroupingId = $2 AND GroupId = $3
         RETURNING GroupingId, GroupingName, AccountType, CreatedDate`,
        [groupingName, groupingId, groupId]
      );
      if (!rows.length) {
        const err = new Error('Grouping not found');
        err.statusCode = 404;
        throw err;
      }
      return json(200, rows[0]);
    }

    case 'DELETE': {
      requireRole(claims, ['Owner', 'Manager']);
      const groupId = event.queryStringParameters?.groupId;
      if (!groupId) {
        const err = new Error('groupId is required');
        err.statusCode = 400;
        throw err;
      }
      requireGroupAccess(claims, groupId);

      try {
        const { rowCount } = await query(
          `DELETE FROM AccountGroupings WHERE GroupingId = $1 AND GroupId = $2`,
          [groupingId, groupId]
        );
        if (!rowCount) {
          const err = new Error('Grouping not found');
          err.statusCode = 404;
          throw err;
        }
      } catch (err) {
        if (err.code === '23503') {
          const conflict = new Error(
            'This Grouping is still assigned to Chart of Accounts mappings and cannot be deleted'
          );
          conflict.statusCode = 409;
          throw conflict;
        }
        throw err;
      }
      return json(204, null);
    }

    default: {
      const err = new Error(`Unsupported method ${event.httpMethod}`);
      err.statusCode = 405;
      throw err;
    }
  }
});
