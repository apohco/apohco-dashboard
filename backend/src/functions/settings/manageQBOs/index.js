const { v4: uuidv4 } = require('uuid');
const { requireAuth } = require('../../../shared/verifyToken');
const { requireRole, requireGroupAccess } = require('../../../shared/authorize');
const { query } = require('../../../shared/db');
const { json, withErrorHandling } = require('../../../shared/response');

// /api/settings/qbos       GET   (any authenticated role in the Group — also used
//                                 to populate entity selectors on report pages)
//                          POST  (SoftwareRep/SoftwareAdmin only) — create a QBO
//                                 record without the OAuth flow, for Manual Upload
// /api/settings/qbos/{id}  PATCH, DELETE (SoftwareRep/SoftwareAdmin only, per
//                                 claude.md's QBO API Setup section)
exports.handler = withErrorHandling(async (event) => {
  const claims = await requireAuth(event);
  const qboId = event.pathParameters?.qboId;

  switch (event.httpMethod) {
    case 'GET': {
      const groupId = event.queryStringParameters?.groupId;
      if (!groupId) {
        const err = new Error('groupId is required');
        err.statusCode = 400;
        throw err;
      }
      requireGroupAccess(claims, groupId);

      const { rows: qbos } = await query(
        `SELECT QBOId, QBOName, RealmId, IsClassBased, CreatedDate,
                (AccessToken IS NOT NULL) AS IsApiConnected
         FROM QBOs WHERE GroupId = $1 ORDER BY QBOName`,
        [groupId]
      );

      for (const qbo of qbos) {
        const { rows: classes } = await query(
          `SELECT QBOClassId, ClassName, ClassId FROM QBOClasses WHERE QBOId = $1 ORDER BY ClassName`,
          [qbo.qboid]
        );
        qbo.classes = classes;
      }

      return json(200, qbos);
    }

    case 'POST': {
      requireRole(claims, ['SoftwareRep', 'SoftwareAdmin']);
      const { groupId, qboName, isClassBased, classNames } = JSON.parse(event.body || '{}');
      if (!groupId || !qboName) {
        const err = new Error('groupId and qboName are required');
        err.statusCode = 400;
        throw err;
      }
      requireGroupAccess(claims, groupId);

      // No OAuth tokens for a manually-created QBO — RealmId is NOT NULL/
      // UNIQUE(GroupId, RealmId) though, so synthesize a placeholder that
      // can never collide with a real QBO realm ID.
      const syntheticRealmId = `MANUAL-${uuidv4()}`;

      const { rows } = await query(
        `INSERT INTO QBOs (GroupId, QBOName, RealmId, IsClassBased, CreatedBy)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING QBOId, QBOName, RealmId, IsClassBased, CreatedDate,
                   (AccessToken IS NOT NULL) AS IsApiConnected`,
        [groupId, qboName, syntheticRealmId, Boolean(isClassBased), claims.userId]
      );
      const qbo = rows[0];

      qbo.classes = [];
      if (isClassBased && Array.isArray(classNames)) {
        for (const className of classNames) {
          const name = String(className).trim();
          if (!name) continue;
          const { rows: classRows } = await query(
            `INSERT INTO QBOClasses (QBOId, ClassName, ClassId) VALUES ($1, $2, $3)
             RETURNING QBOClassId, ClassName, ClassId`,
            [qbo.qboid, name, `MANUAL-${uuidv4()}`]
          );
          qbo.classes.push(classRows[0]);
        }
      }

      return json(201, qbo);
    }

    case 'PATCH': {
      requireRole(claims, ['SoftwareRep', 'SoftwareAdmin']);
      const { groupId, qboName, isClassBased } = JSON.parse(event.body || '{}');
      if (!groupId) {
        const err = new Error('groupId is required');
        err.statusCode = 400;
        throw err;
      }
      requireGroupAccess(claims, groupId);

      const { rows } = await query(
        `UPDATE QBOs SET
           QBOName = COALESCE($1, QBOName),
           IsClassBased = COALESCE($2, IsClassBased)
         WHERE QBOId = $3 AND GroupId = $4
         RETURNING QBOId, QBOName, RealmId, IsClassBased, CreatedDate,
                   (AccessToken IS NOT NULL) AS IsApiConnected`,
        [qboName ?? null, typeof isClassBased === 'boolean' ? isClassBased : null, qboId, groupId]
      );
      if (!rows.length) {
        const err = new Error('QBO not found');
        err.statusCode = 404;
        throw err;
      }
      return json(200, rows[0]);
    }

    case 'DELETE': {
      requireRole(claims, ['SoftwareRep', 'SoftwareAdmin']);
      const groupId = event.queryStringParameters?.groupId;
      if (!groupId) {
        const err = new Error('groupId is required');
        err.statusCode = 400;
        throw err;
      }
      requireGroupAccess(claims, groupId);

      const { rowCount } = await query(`DELETE FROM QBOs WHERE QBOId = $1 AND GroupId = $2`, [
        qboId,
        groupId,
      ]);
      if (!rowCount) {
        const err = new Error('QBO not found');
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
