const { requireAuth } = require('../../../shared/verifyToken');
const { requireRole } = require('../../../shared/authorize');
const { query, withTransaction } = require('../../../shared/db');
const { json, withErrorHandling } = require('../../../shared/response');

// /api/settings/groups            GET, POST
// /api/settings/groups/{groupId}  PUT, DELETE
// Platform-level: creates/manages Group Practices (tenants) themselves —
// distinct from everything else in ../settings, which operates *within* an
// existing Group. SoftwareAdmin only, per claude.md's platform-level role.
exports.handler = withErrorHandling(async (event) => {
  const claims = await requireAuth(event);
  requireRole(claims, ['SoftwareAdmin']);

  const groupId = event.pathParameters?.groupId;

  switch (event.httpMethod) {
    case 'GET': {
      const { rows } = await query(
        `SELECT
           g.GroupId, g.GroupName, g.CreatedDate, g.CreatedBy,
           (SELECT COUNT(*) FROM QBOs q WHERE q.GroupId = g.GroupId) AS qbocount,
           (SELECT COUNT(*) FROM GroupUsers gu WHERE gu.GroupId = g.GroupId) AS usercount
         FROM Groups g
         ORDER BY g.GroupName`
      );
      return json(200, rows);
    }

    case 'POST': {
      const { groupName, initialOwnerUserId } = JSON.parse(event.body || '{}');
      if (!groupName) {
        const err = new Error('groupName is required');
        err.statusCode = 400;
        throw err;
      }

      if (initialOwnerUserId) {
        const { rows: userRows } = await query(`SELECT UserId FROM Users WHERE UserId = $1`, [
          initialOwnerUserId,
        ]);
        if (!userRows.length) {
          const err = new Error(
            'That user was not found. They must complete their first sign-in before being assigned as an Owner.'
          );
          err.statusCode = 400;
          throw err;
        }
      }

      const created = await withTransaction(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO Groups (GroupName, CreatedBy) VALUES ($1, $2)
           RETURNING GroupId, GroupName, CreatedDate, CreatedBy`,
          [groupName, claims.userId]
        );
        const group = rows[0];

        if (initialOwnerUserId) {
          await client.query(
            `INSERT INTO GroupUsers (GroupId, UserId, Role) VALUES ($1, $2, 'Owner')`,
            [group.groupid, initialOwnerUserId]
          );
        }

        return group;
      });

      return json(201, created);
    }

    case 'PUT': {
      const { groupName } = JSON.parse(event.body || '{}');
      if (!groupName) {
        const err = new Error('groupName is required');
        err.statusCode = 400;
        throw err;
      }

      const { rows } = await query(
        `UPDATE Groups SET GroupName = $1 WHERE GroupId = $2
         RETURNING GroupId, GroupName, CreatedDate, CreatedBy`,
        [groupName, groupId]
      );
      if (!rows.length) {
        const err = new Error('Group not found');
        err.statusCode = 404;
        throw err;
      }
      return json(200, rows[0]);
    }

    case 'DELETE': {
      const force = event.queryStringParameters?.force === 'true';

      const { rows: existing } = await query(`SELECT GroupId FROM Groups WHERE GroupId = $1`, [
        groupId,
      ]);
      if (!existing.length) {
        const err = new Error('Group not found');
        err.statusCode = 404;
        throw err;
      }

      const { rows: counts } = await query(
        `SELECT
           (SELECT COUNT(*) FROM QBOs WHERE GroupId = $1) AS qbocount,
           (SELECT COUNT(*) FROM GroupUsers WHERE GroupId = $1) AS usercount`,
        [groupId]
      );
      const { qbocount, usercount } = counts[0];

      if (!force && (Number(qbocount) > 0 || Number(usercount) > 0)) {
        return json(409, {
          message:
            'This Group still has connected QBOs and/or assigned users. Deleting it will remove all of their data. Retry with ?force=true to proceed.',
          qboCount: Number(qbocount),
          userCount: Number(usercount),
          requiresForce: true,
        });
      }

      await query(`DELETE FROM Groups WHERE GroupId = $1`, [groupId]);
      return json(204, null);
    }

    default: {
      const err = new Error(`Unsupported method ${event.httpMethod}`);
      err.statusCode = 405;
      throw err;
    }
  }
});
