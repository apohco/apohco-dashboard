const { requireAuth } = require('../../../shared/verifyToken');
const { requireRole, requireGroupAccess } = require('../../../shared/authorize');
const { query, withTransaction } = require('../../../shared/db');
const { json, withErrorHandling } = require('../../../shared/response');
const { VALID_CLASSIFICATIONS } = require('../../../shared/fileParser');

// /api/settings/chart-of-accounts   GET, PUT
// The account list itself is kept current by syncQBOData (which
// upserts ChartOfAccountsMappings on every sync, preserving existing
// GroupingId assignments). This function reads that reconciled list and
// saves Grouping assignments made in the Chart of Accounts Setup screen.
exports.handler = withErrorHandling(async (event) => {
  const claims = await requireAuth(event);

  switch (event.httpMethod) {
    case 'GET': {
      const { groupId, qboId } = event.queryStringParameters || {};
      if (!groupId || !qboId) {
        const err = new Error('groupId and qboId are required');
        err.statusCode = 400;
        throw err;
      }
      requireGroupAccess(claims, groupId);

      const { rows } = await query(
        `SELECT MappingId, AccountCode, AccountName, Classification, GroupingId, LastUpdated
         FROM ChartOfAccountsMappings
         WHERE GroupId = $1 AND QBOId = $2
         ORDER BY AccountCode`,
        [groupId, qboId]
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

      for (const m of mappings) {
        if (m.classification && !VALID_CLASSIFICATIONS.includes(m.classification)) {
          const err = new Error(`classification must be one of ${VALID_CLASSIFICATIONS.join(', ')}`);
          err.statusCode = 400;
          throw err;
        }
      }

      // classification is optional in the payload -- omitted for a plain
      // Grouping-only save (the common case), included when the user
      // corrects a misclassified account (see Chart of Accounts Setup).
      await withTransaction(async (client) => {
        for (const m of mappings) {
          if (m.classification) {
            await client.query(
              `UPDATE ChartOfAccountsMappings
               SET GroupingId = $1, Classification = $2, LastUpdated = now(), UpdatedBy = $3
               WHERE MappingId = $4 AND GroupId = $5`,
              [m.groupingId || null, m.classification, claims.userId, m.mappingId, groupId]
            );
          } else {
            await client.query(
              `UPDATE ChartOfAccountsMappings
               SET GroupingId = $1, LastUpdated = now(), UpdatedBy = $2
               WHERE MappingId = $3 AND GroupId = $4`,
              [m.groupingId || null, claims.userId, m.mappingId, groupId]
            );
          }
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
