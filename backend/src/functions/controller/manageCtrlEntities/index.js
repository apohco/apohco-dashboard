const { authorizeController } = require('../../../shared/controllerAuth');
const { requireGroupAccess } = require('../../../shared/authorize');
const { query, withTransaction } = require('../../../shared/db');
const { json, withErrorHandling } = require('../../../shared/response');
const { recordAudit } = require('../../../shared/audit');

const MAX_NAME_LENGTH = 255;
const MAX_LIST_ITEMS = 50;
const MAX_LIST_ITEM_LENGTH = 100;

function badRequest(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

// Trims, drops blanks and case-insensitive duplicates.
function cleanList(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw badRequest(`${field} must be a list of text values`);
  }
  const seen = new Set();
  const out = [];
  for (const raw of value) {
    const v = raw.trim();
    if (!v || seen.has(v.toLowerCase())) continue;
    if (v.length > MAX_LIST_ITEM_LENGTH) throw badRequest(`Each ${field} entry must be ${MAX_LIST_ITEM_LENGTH} characters or fewer`);
    seen.add(v.toLowerCase());
    out.push(v);
  }
  if (out.length > MAX_LIST_ITEMS) throw badRequest(`${field} can have at most ${MAX_LIST_ITEMS} entries`);
  return out;
}

function validateEntityBody(body) {
  const entityName = typeof body.entityName === 'string' ? body.entityName.trim() : '';
  if (!entityName) throw badRequest('entityName is required');
  if (entityName.length > MAX_NAME_LENGTH) throw badRequest(`entityName must be ${MAX_NAME_LENGTH} characters or fewer`);
  if (body.isActive !== undefined && typeof body.isActive !== 'boolean') throw badRequest('isActive must be true or false');

  return {
    entityName,
    practiceQboId: body.practiceQboId || null,
    managementQboClassId: body.managementQboClassId || null,
    consolidationGroupId: body.consolidationGroupId || null,
    aliases: cleanList(body.aliases, 'aliases'),
    keywords: cleanList(body.keywords, 'keywords'),
    isActive: body.isActive ?? true,
  };
}

// Every referenced QBO / class / consolidation group must belong to this
// Group, so an entity can never point into another tenant's data.
async function assertReferencesInGroup(groupId, e) {
  if (e.practiceQboId) {
    const { rows } = await query(`SELECT 1 FROM QBOs WHERE QBOId = $1 AND GroupId = $2`, [e.practiceQboId, groupId]);
    if (!rows.length) throw badRequest('practiceQboId is not a QBO in this Group');
  }
  if (e.managementQboClassId) {
    const { rows } = await query(
      `SELECT 1 FROM QBOClasses c JOIN QBOs q ON q.QBOId = c.QBOId WHERE c.QBOClassId = $1 AND q.GroupId = $2`,
      [e.managementQboClassId, groupId]
    );
    if (!rows.length) throw badRequest('managementQboClassId is not a class in this Group');
  }
  if (e.consolidationGroupId) {
    const { rows } = await query(
      `SELECT 1 FROM ConsolidationGroups WHERE ConsolidationGroupId = $1 AND GroupId = $2`,
      [e.consolidationGroupId, groupId]
    );
    if (!rows.length) throw badRequest('consolidationGroupId is not a Consolidation Group in this Group');
  }
}

const ENTITY_SELECT = `
  SELECT e.EntityId, e.EntityName, e.PracticeQBOId, pq.QBOName AS PracticeQBOName,
         e.ManagementQBOClassId, c.ClassName AS ManagementClassName, mq.QBOName AS ManagementQBOName,
         e.ConsolidationGroupId, cg.ConsolidationGroupName, e.Aliases, e.Keywords, e.IsActive,
         e.CreatedDate, e.LastUpdated
  FROM CtrlEntities e
  LEFT JOIN QBOs pq ON pq.QBOId = e.PracticeQBOId
  LEFT JOIN QBOClasses c ON c.QBOClassId = e.ManagementQBOClassId
  LEFT JOIN QBOs mq ON mq.QBOId = c.QBOId
  LEFT JOIN ConsolidationGroups cg ON cg.ConsolidationGroupId = e.ConsolidationGroupId`;

function shapeEntity(r) {
  return {
    entityId: r.entityid,
    entityName: r.entityname,
    practiceQboId: r.practiceqboid,
    practiceQboName: r.practiceqboname,
    managementQboClassId: r.managementqboclassid,
    managementClassName: r.managementclassname,
    managementQboName: r.managementqboname,
    consolidationGroupId: r.consolidationgroupid,
    consolidationGroupName: r.consolidationgroupname,
    aliases: r.aliases || [],
    keywords: r.keywords || [],
    isActive: r.isactive,
    createdDate: r.createddate,
    lastUpdated: r.lastupdated,
  };
}

async function loadEntity(groupId, entityId) {
  const { rows } = await query(`${ENTITY_SELECT} WHERE e.GroupId = $1 AND e.EntityId = $2`, [groupId, entityId]);
  if (!rows.length) throw badRequest('Entity not found', 404);
  return shapeEntity(rows[0]);
}

function rethrowUnique(err) {
  if (err.code === '23505') throw badRequest('An entity with that name already exists in this Group', 409);
  throw err;
}

async function handleList(groupId) {
  const [{ rows: entities }, { rows: qbos }, { rows: classes }, { rows: consolidationGroups }] = await Promise.all([
    query(`${ENTITY_SELECT} WHERE e.GroupId = $1 ORDER BY e.EntityName`, [groupId]),
    query(`SELECT QBOId, QBOName, IsClassBased FROM QBOs WHERE GroupId = $1 ORDER BY QBOName`, [groupId]),
    query(
      `SELECT c.QBOClassId, c.ClassName, c.QBOId, q.QBOName
       FROM QBOClasses c JOIN QBOs q ON q.QBOId = c.QBOId
       WHERE q.GroupId = $1 ORDER BY q.QBOName, c.ClassName`,
      [groupId]
    ),
    query(
      `SELECT ConsolidationGroupId, ConsolidationGroupName FROM ConsolidationGroups
       WHERE GroupId = $1 ORDER BY ConsolidationGroupName`,
      [groupId]
    ),
  ]);

  return json(200, {
    entities: entities.map(shapeEntity),
    options: {
      qbos: qbos.map((q) => ({ qboId: q.qboid, qboName: q.qboname, isClassBased: q.isclassbased })),
      classes: classes.map((c) => ({
        qboClassId: c.qboclassid,
        className: c.classname,
        qboId: c.qboid,
        qboName: c.qboname,
      })),
      consolidationGroups: consolidationGroups.map((g) => ({
        consolidationGroupId: g.consolidationgroupid,
        consolidationGroupName: g.consolidationgroupname,
      })),
    },
  });
}

async function handleCreate(groupId, body, claims) {
  const e = validateEntityBody(body);
  await assertReferencesInGroup(groupId, e);

  const entityId = await withTransaction(async (client) => {
    const { rows } = await client
      .query(
        `INSERT INTO CtrlEntities (GroupId, EntityName, PracticeQBOId, ManagementQBOClassId, ConsolidationGroupId,
                                   Aliases, Keywords, IsActive, CreatedBy, UpdatedBy)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
         RETURNING EntityId`,
        [groupId, e.entityName, e.practiceQboId, e.managementQboClassId, e.consolidationGroupId,
          e.aliases, e.keywords, e.isActive, claims.userId]
      )
      .catch(rethrowUnique);
    const id = rows[0].entityid;
    await recordAudit(
      { groupId, userId: claims.userId, action: 'ctrl.entity.created', targetType: 'CtrlEntity', targetId: id, details: e },
      client
    );
    return id;
  });

  return json(201, await loadEntity(groupId, entityId));
}

async function handleUpdate(groupId, entityId, body, claims) {
  const e = validateEntityBody(body);
  await assertReferencesInGroup(groupId, e);

  await withTransaction(async (client) => {
    const { rowCount } = await client
      .query(
        `UPDATE CtrlEntities
         SET EntityName = $3, PracticeQBOId = $4, ManagementQBOClassId = $5, ConsolidationGroupId = $6,
             Aliases = $7, Keywords = $8, IsActive = $9, UpdatedBy = $10, LastUpdated = now()
         WHERE GroupId = $1 AND EntityId = $2`,
        [groupId, entityId, e.entityName, e.practiceQboId, e.managementQboClassId, e.consolidationGroupId,
          e.aliases, e.keywords, e.isActive, claims.userId]
      )
      .catch(rethrowUnique);
    if (!rowCount) throw badRequest('Entity not found', 404);
    await recordAudit(
      { groupId, userId: claims.userId, action: 'ctrl.entity.updated', targetType: 'CtrlEntity', targetId: entityId, details: e },
      client
    );
  });

  return json(200, await loadEntity(groupId, entityId));
}

async function handleDelete(groupId, entityId, claims) {
  await withTransaction(async (client) => {
    const { rows } = await client.query(
      `DELETE FROM CtrlEntities WHERE GroupId = $1 AND EntityId = $2 RETURNING EntityName`,
      [groupId, entityId]
    );
    if (!rows.length) throw badRequest('Entity not found', 404);
    await recordAudit(
      {
        groupId,
        userId: claims.userId,
        action: 'ctrl.entity.deleted',
        targetType: 'CtrlEntity',
        targetId: entityId,
        details: { entityName: rows[0].entityname },
      },
      client
    );
  });
  return json(204, null);
}

// /api/controller/entities             GET (list + dropdown options), POST
// /api/controller/entities/{entityId}  PUT, DELETE
// groupId comes from the query string (GET, DELETE) or the body (POST, PUT).
exports.handler = withErrorHandling(async (event) => {
  const claims = await authorizeController(event);
  const method = event.httpMethod;
  const body = method === 'POST' || method === 'PUT' ? JSON.parse(event.body || '{}') : {};
  const groupId = method === 'POST' || method === 'PUT' ? body.groupId : event.queryStringParameters?.groupId;
  if (!groupId) throw badRequest('groupId is required');
  requireGroupAccess(claims, groupId);

  const entityId = event.pathParameters?.entityId;

  if (!entityId) {
    if (method === 'GET') return handleList(groupId);
    if (method === 'POST') return handleCreate(groupId, body, claims);
  } else {
    if (method === 'PUT') return handleUpdate(groupId, entityId, body, claims);
    if (method === 'DELETE') return handleDelete(groupId, entityId, claims);
  }
  throw badRequest(`${method} is not supported on this route`, 405);
});

exports.validateEntityBody = validateEntityBody;
exports.cleanList = cleanList;
