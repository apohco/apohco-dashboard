const { authorizeController } = require('../../../shared/controllerAuth');
const { requireGroupAccess } = require('../../../shared/authorize');
const { query, withTransaction } = require('../../../shared/db');
const { json, withErrorHandling } = require('../../../shared/response');
const { recordAudit } = require('../../../shared/audit');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_KEYWORDS = 100;
const MAX_RULE_TEXT = 5000;

function badRequest(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

async function activeEntityIds(groupId) {
  const { rows } = await query(`SELECT EntityId, EntityName FROM CtrlEntities WHERE GroupId = $1 AND IsActive ORDER BY EntityName`, [groupId]);
  return rows;
}

// Validates the editable parts of a vendor. Returns the cleaned values.
function validateVendorBody(body, entityIds) {
  const out = {};
  if (body.displayName !== undefined) {
    const name = typeof body.displayName === 'string' ? body.displayName.trim() : '';
    if (!name || name.length > 255) throw badRequest('displayName must be 1 to 255 characters');
    out.displayName = name;
  }
  if (body.watchMode !== undefined) {
    if (typeof body.watchMode !== 'boolean') throw badRequest('watchMode must be true or false');
    out.watchMode = body.watchMode;
  }
  if (body.splitTemplate !== undefined) {
    if (body.splitTemplate === null || (Array.isArray(body.splitTemplate) && !body.splitTemplate.length)) {
      out.splitTemplate = null;
    } else {
      if (!Array.isArray(body.splitTemplate) || body.splitTemplate.length < 2) throw badRequest('A split template needs at least two entities');
      const seen = new Set();
      let total = 0;
      for (const s of body.splitTemplate) {
        if (!entityIds.has(s?.entityId) || seen.has(s.entityId)) throw badRequest('Each split entity must be a different active entity');
        seen.add(s.entityId);
        const pct = Number(s.percent);
        if (!(pct > 0)) throw badRequest('Split percentages must be more than zero');
        total += Math.round(pct * 100);
      }
      if (total !== 10000) throw badRequest('Split percentages must add up to 100');
      out.splitTemplate = body.splitTemplate.map((s) => ({ entityId: s.entityId, percent: Number(s.percent) }));
    }
  }
  if (body.rule !== undefined) {
    const r = body.rule || {};
    const defaultEntityId = r.defaultEntityId || null;
    if (defaultEntityId && !entityIds.has(defaultEntityId)) throw badRequest('defaultEntityId must be an active entity');
    const keywords = (Array.isArray(r.keywords) ? r.keywords : [])
      .map((k) => ({ keyword: String(k?.keyword ?? '').trim(), entityId: k?.entityId }))
      .filter((k) => k.keyword);
    if (keywords.length > MAX_KEYWORDS) throw badRequest(`At most ${MAX_KEYWORDS} keywords`);
    for (const k of keywords) {
      if (k.keyword.length < 3 || k.keyword.length > 100) throw badRequest('Keywords must be 3 to 100 characters');
      if (!entityIds.has(k.entityId)) throw badRequest(`Keyword "${k.keyword}" needs an active entity`);
    }
    const ruleText = typeof r.ruleText === 'string' ? r.ruleText.trim() : '';
    if (ruleText.length > MAX_RULE_TEXT) throw badRequest(`Rule text must be ${MAX_RULE_TEXT} characters or fewer`);
    out.rule = { defaultEntityId, keywords, ruleText: ruleText || null };
  }
  return out;
}

const sameRule = (latest, rule) =>
  Boolean(latest) &&
  (latest.defaultentityid || null) === rule.defaultEntityId &&
  (latest.ruletext || null) === rule.ruleText &&
  JSON.stringify(latest.hints?.keywords || []) === JSON.stringify(rule.keywords);

// GET /api/controller/vendors?groupId=
async function handleList(groupId) {
  const { rows } = await query(
    `SELECT v.VendorId, v.DisplayName, v.WatchMode, v.SplitTemplate,
            COALESCE((SELECT json_agg(a.PayeeName ORDER BY a.PayeeName) FROM CtrlVendorAliases a WHERE a.VendorId = v.VendorId), '[]') AS aliases,
            r.RuleId, r.Version, r.DefaultEntityId, r.Hints, r.RuleText, r.CreatedDate AS RuleDate
     FROM CtrlVendors v
     LEFT JOIN LATERAL (
       SELECT * FROM CtrlVendorRules r WHERE r.VendorId = v.VendorId ORDER BY r.Version DESC LIMIT 1
     ) r ON true
     WHERE v.GroupId = $1 AND v.MergedIntoVendorId IS NULL
     ORDER BY v.DisplayName`,
    [groupId]
  );
  const entities = await activeEntityIds(groupId);
  return json(200, {
    entities: entities.map((e) => ({ entityId: e.entityid, entityName: e.entityname })),
    vendors: rows.map((r) => ({
      vendorId: r.vendorid,
      displayName: r.displayname,
      watchMode: r.watchmode,
      splitTemplate: r.splittemplate,
      aliases: r.aliases,
      rule: r.ruleid
        ? {
            ruleId: r.ruleid,
            version: r.version,
            defaultEntityId: r.defaultentityid,
            keywords: r.hints?.keywords || [],
            ruleText: r.ruletext,
            createdDate: r.ruledate,
          }
        : null,
    })),
  });
}

async function loadVendor(client, groupId, vendorId, lock = false) {
  if (!UUID_RE.test(vendorId || '')) throw badRequest('Vendor not found', 404);
  const { rows } = await client.query(
    `SELECT VendorId, DisplayName, MergedIntoVendorId FROM CtrlVendors WHERE VendorId = $1 AND GroupId = $2${lock ? ' FOR UPDATE' : ''}`,
    [vendorId, groupId]
  );
  if (!rows.length || rows[0].mergedintovendorid) throw badRequest('Vendor not found', 404);
  return rows[0];
}

// PUT /api/controller/vendors/{vendorId}
//   { groupId, displayName?, watchMode?, splitTemplate?, rule?: { defaultEntityId, keywords, ruleText } }
// A changed rule is saved as a new version; earlier versions are kept.
async function handleUpdate(claims, vendorId, body) {
  const entities = await activeEntityIds(body.groupId);
  const values = validateVendorBody(body, new Set(entities.map((e) => e.entityid)));

  const result = await withTransaction(async (client) => {
    await loadVendor(client, body.groupId, vendorId, true);
    const sets = [];
    const params = [vendorId];
    const set = (col, value) => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };
    if (values.displayName !== undefined) set('DisplayName', values.displayName);
    if (values.watchMode !== undefined) set('WatchMode', values.watchMode);
    if (values.splitTemplate !== undefined) set('SplitTemplate', values.splitTemplate ? JSON.stringify(values.splitTemplate) : null);
    if (sets.length) {
      params.push(claims.userId);
      try {
        await client.query(
          `UPDATE CtrlVendors SET ${sets.join(', ')}, UpdatedBy = $${params.length}, LastUpdated = now() WHERE VendorId = $1`,
          params
        );
      } catch (err) {
        if (err.code === '23505') throw badRequest('Another vendor already has that name; merge them instead', 409);
        throw err;
      }
    }

    let newVersion = null;
    if (values.rule) {
      const { rows: latest } = await client.query(
        `SELECT Version, DefaultEntityId, Hints, RuleText FROM CtrlVendorRules WHERE VendorId = $1 ORDER BY Version DESC LIMIT 1`,
        [vendorId]
      );
      if (!sameRule(latest[0], values.rule)) {
        newVersion = (latest[0]?.version || 0) + 1;
        await client.query(
          `INSERT INTO CtrlVendorRules (GroupId, VendorId, Version, DefaultEntityId, Hints, RuleText, CreatedBy)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            body.groupId, vendorId, newVersion, values.rule.defaultEntityId,
            JSON.stringify({ keywords: values.rule.keywords }), values.rule.ruleText, claims.userId,
          ]
        );
      }
    }
    await recordAudit(
      {
        groupId: body.groupId, userId: claims.userId, action: 'ctrl.vendor.updated', targetType: 'CtrlVendor', targetId: vendorId,
        details: { ...values, ruleVersion: newVersion },
      },
      client
    );
    return { ruleVersion: newVersion };
  });
  return json(200, { vendorId, ...result });
}

// POST /api/controller/vendors/{vendorId}/merge  { groupId, fromVendorId }
// Moves every payee name of fromVendorId onto this vendor. The merged
// profile is kept (marked merged) so past suggestions still resolve.
async function handleMerge(claims, vendorId, body) {
  if (!body.fromVendorId || body.fromVendorId === vendorId) throw badRequest('fromVendorId must be a different vendor');
  await withTransaction(async (client) => {
    await loadVendor(client, body.groupId, vendorId, true);
    const from = await loadVendor(client, body.groupId, body.fromVendorId, true);
    const { rowCount } = await client.query(`UPDATE CtrlVendorAliases SET VendorId = $1 WHERE VendorId = $2`, [vendorId, from.vendorid]);
    await client.query(
      `UPDATE CtrlVendors SET MergedIntoVendorId = $1, UpdatedBy = $3, LastUpdated = now() WHERE VendorId = $2`,
      [vendorId, from.vendorid, claims.userId]
    );
    await recordAudit(
      {
        groupId: body.groupId, userId: claims.userId, action: 'ctrl.vendor.merged', targetType: 'CtrlVendor', targetId: vendorId,
        details: { fromVendorId: from.vendorid, fromName: from.displayname, aliasesMoved: rowCount },
      },
      client
    );
  });
  return json(200, { vendorId, mergedVendorId: body.fromVendorId });
}

exports.handler = withErrorHandling(async (event) => {
  const claims = await authorizeController(event);
  if (event.httpMethod === 'GET') {
    const groupId = event.queryStringParameters?.groupId;
    if (!groupId) throw badRequest('groupId is required');
    requireGroupAccess(claims, groupId);
    return handleList(groupId);
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    throw badRequest('Request body must be JSON');
  }
  if (!body.groupId) throw badRequest('groupId is required');
  requireGroupAccess(claims, body.groupId);
  const vendorId = event.pathParameters?.vendorId;

  if (event.httpMethod === 'PUT' && event.resource === '/api/controller/vendors/{vendorId}') return handleUpdate(claims, vendorId, body);
  if (event.httpMethod === 'POST' && event.resource.endsWith('/merge')) return handleMerge(claims, vendorId, body);
  throw badRequest('Unknown vendor route', 404);
});

exports.validateVendorBody = validateVendorBody;
exports.sameRule = sameRule;
