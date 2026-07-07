const { requireAuth } = require('../../../shared/verifyToken');
const { requireRole, requireGroupAccess } = require('../../../shared/authorize');
const { query, withTransaction } = require('../../../shared/db');
const { json, withErrorHandling } = require('../../../shared/response');

async function fetchConsolidationGroups(groupId, consolidationGroupId = null) {
  const params = [groupId];
  let filter = '';
  if (consolidationGroupId) {
    filter = 'AND cg.ConsolidationGroupId = $2';
    params.push(consolidationGroupId);
  }

  const { rows: groups } = await query(
    `SELECT ConsolidationGroupId, ConsolidationGroupName, CreatedDate
     FROM ConsolidationGroups cg
     WHERE cg.GroupId = $1 ${filter}
     ORDER BY ConsolidationGroupName`,
    params
  );

  for (const group of groups) {
    const { rows: qbos } = await query(
      `SELECT cgq.Id, cgq.QBOId, q.QBOName, cgq.QBOClassId, qc.ClassName,
              ARRAY_REMOVE(ARRAY_AGG(cge.AccountCode), NULL) AS excludedaccountcodes
       FROM ConsolidationGroupQBOs cgq
       JOIN QBOs q ON q.QBOId = cgq.QBOId
       LEFT JOIN QBOClasses qc ON qc.QBOClassId = cgq.QBOClassId
       LEFT JOIN ConsolidationGroupQBOExclusions cge ON cge.ConsolidationGroupQBOId = cgq.Id
       WHERE cgq.ConsolidationGroupId = $1
       GROUP BY cgq.Id, cgq.QBOId, q.QBOName, cgq.QBOClassId, qc.ClassName`,
      [group.consolidationgroupid]
    );
    group.qbos = qbos;
  }

  return groups;
}

// Excluded accounts are keyed per ConsolidationGroupQBOs row (per QBO/class
// *within this specific Consolidation Group*), not globally per QBO -- the
// same QBO can be excluded differently in a different Consolidation Group,
// and ON DELETE CASCADE from ConsolidationGroupQBOs means the delete-then-
// reinsert below automatically cleans up stale exclusions with no extra code.
async function replaceQbos(client, consolidationGroupId, qbos) {
  await client.query(`DELETE FROM ConsolidationGroupQBOs WHERE ConsolidationGroupId = $1`, [
    consolidationGroupId,
  ]);
  for (const item of qbos || []) {
    const { rows } = await client.query(
      `INSERT INTO ConsolidationGroupQBOs (ConsolidationGroupId, QBOId, QBOClassId)
       VALUES ($1, $2, $3)
       RETURNING Id`,
      [consolidationGroupId, item.qboId, item.qboClassId || null]
    );
    const cgqId = rows[0].id;
    for (const accountCode of item.excludedAccountCodes || []) {
      await client.query(
        `INSERT INTO ConsolidationGroupQBOExclusions (ConsolidationGroupQBOId, AccountCode) VALUES ($1, $2)`,
        [cgqId, accountCode]
      );
    }
  }
}

// /api/settings/consolidation-groups                       GET, POST
// /api/settings/consolidation-groups/{consolidationGroupId} PUT, DELETE
// Body for POST/PUT: { groupId, consolidationGroupName, qbos: [{ qboId, qboClassId?, excludedAccountCodes? }] }
// qboClassId omitted/null means "whole QBO" (see ConsolidationGroupQBOs schema note).
// excludedAccountCodes (optional) lists AccountCodes to drop from that
// QBO/class's contribution within this Consolidation Group only -- e.g. to
// eliminate an intercompany Management Fee without affecting that QBO's
// own standalone report.
exports.handler = withErrorHandling(async (event) => {
  const claims = await requireAuth(event);
  const consolidationGroupId = event.pathParameters?.consolidationGroupId;

  switch (event.httpMethod) {
    case 'GET': {
      const groupId = event.queryStringParameters?.groupId;
      if (!groupId) {
        const err = new Error('groupId is required');
        err.statusCode = 400;
        throw err;
      }
      requireGroupAccess(claims, groupId);
      return json(200, await fetchConsolidationGroups(groupId));
    }

    case 'POST': {
      requireRole(claims, ['Owner', 'Manager']);
      const { groupId, consolidationGroupName, qbos } = JSON.parse(event.body || '{}');
      if (!groupId || !consolidationGroupName) {
        const err = new Error('groupId and consolidationGroupName are required');
        err.statusCode = 400;
        throw err;
      }
      requireGroupAccess(claims, groupId);

      const newId = await withTransaction(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO ConsolidationGroups (GroupId, ConsolidationGroupName, CreatedBy)
           VALUES ($1, $2, $3) RETURNING ConsolidationGroupId`,
          [groupId, consolidationGroupName, claims.userId]
        );
        const id = rows[0].consolidationgroupid;
        await replaceQbos(client, id, qbos);
        return id;
      });

      const [created] = await fetchConsolidationGroups(groupId, newId);
      return json(201, created);
    }

    case 'PUT': {
      requireRole(claims, ['Owner', 'Manager']);
      const { groupId, consolidationGroupName, qbos } = JSON.parse(event.body || '{}');
      if (!groupId || !consolidationGroupName) {
        const err = new Error('groupId and consolidationGroupName are required');
        err.statusCode = 400;
        throw err;
      }
      requireGroupAccess(claims, groupId);

      await withTransaction(async (client) => {
        const { rowCount } = await client.query(
          `UPDATE ConsolidationGroups SET ConsolidationGroupName = $1
           WHERE ConsolidationGroupId = $2 AND GroupId = $3`,
          [consolidationGroupName, consolidationGroupId, groupId]
        );
        if (!rowCount) {
          const err = new Error('Consolidation Group not found');
          err.statusCode = 404;
          throw err;
        }
        await replaceQbos(client, consolidationGroupId, qbos);
      });

      const [updated] = await fetchConsolidationGroups(groupId, consolidationGroupId);
      return json(200, updated);
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

      const { rowCount } = await query(
        `DELETE FROM ConsolidationGroups WHERE ConsolidationGroupId = $1 AND GroupId = $2`,
        [consolidationGroupId, groupId]
      );
      if (!rowCount) {
        const err = new Error('Consolidation Group not found');
        err.statusCode = 404;
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
