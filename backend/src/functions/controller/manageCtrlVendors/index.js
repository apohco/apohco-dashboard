const { authorizeController } = require('../../../shared/controllerAuth');
const { requireGroupAccess } = require('../../../shared/authorize');
const { query, withTransaction } = require('../../../shared/db');
const { json, withErrorHandling } = require('../../../shared/response');
const { recordAudit } = require('../../../shared/audit');
const { buildEntityResolver, lineEntities, testRule } = require('../../../shared/reviewEngine');
const { aiAgreement } = require('../../../shared/ctrlAiJobs');
const {
  loadEntities,
  loadFiles,
  loadSettings,
  loadStoredLines,
  loadStoredMonths,
  payeeKeySql,
  accountTypeJoin,
  ACCOUNT_TYPE_SQL,
  shiftMonth,
} = require('../../../shared/ctrlReviewData');

const EARLIEST_MONTH = '2000-01';
const LATEST_MONTH = '9999-12';
const MAX_CORRECTIONS = 100;
const RULE_TEST_SAMPLE = 50;

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
  const stats = await loadVendorStats(groupId);
  return json(200, {
    entities: entities.map((e) => ({ entityId: e.entityid, entityName: e.entityname })),
    vendors: rows.map((r) => ({
      vendorId: r.vendorid,
      displayName: r.displayname,
      watchMode: r.watchmode,
      splitTemplate: r.splittemplate,
      aliases: r.aliases,
      stats: stats.get(r.vendorid) || { spend12: 0, lineCount12: 0, reviewed: 0, decided: 0, reviewedPct: null, avgConfidence: null },
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

// Per vendor, over the latest 12 stored months: expense spend and line
// count (latest snapshot of each file and month), and from the latest
// review run of each file and month: lines reviewed, lines decided and
// the average confidence.
async function loadVendorStats(groupId) {
  const { rows: spend } = await query(
    `WITH snaps AS (
       SELECT DISTINCT ON (QBOId, Period) SnapshotId FROM CtrlSnapshots
       WHERE GroupId = $1 AND Period > (SELECT MAX(Period) FROM CtrlSnapshots WHERE GroupId = $1) - interval '12 months'
       ORDER BY QBOId, Period, PulledAt DESC
     )
     SELECT a.VendorId, COUNT(*)::int AS LineCount,
            COALESCE(SUM(l.Amount) FILTER (WHERE ${ACCOUNT_TYPE_SQL} = 'Expense'), 0) AS Spend
     FROM CtrlLedgerLines l
     JOIN snaps s ON s.SnapshotId = l.SnapshotId
     JOIN CtrlVendorAliases a ON a.GroupId = $1 AND a.PayeeKey = ${payeeKeySql('l.PayeeName')}
     ${accountTypeJoin('l')}
     WHERE l.GroupId = $1
     GROUP BY a.VendorId`,
    [groupId]
  );
  const { rows: review } = await query(
    `WITH runs AS (
       SELECT DISTINCT ON (QBOId, Period) RunId, QBOId FROM CtrlReviewRuns
       WHERE GroupId = $1 AND Period > (SELECT MAX(Period) FROM CtrlReviewRuns WHERE GroupId = $1) - interval '12 months'
       ORDER BY QBOId, Period, RunDate DESC
     ),
     dec AS (
       SELECT DISTINCT ON (QBOId, Fingerprint) QBOId, Fingerprint, Action FROM CtrlDecisions
       WHERE GroupId = $1 ORDER BY QBOId, Fingerprint, DecidedAt DESC
     )
     SELECT s.VendorId, COUNT(*)::int AS Reviewed,
            COUNT(*) FILTER (WHERE d.Action IS NOT NULL AND d.Action <> 'Undo')::int AS Decided,
            AVG(s.Confidence) AS AvgConfidence
     FROM CtrlSuggestions s
     JOIN runs r ON r.RunId = s.RunId
     LEFT JOIN dec d ON d.QBOId = r.QBOId AND d.Fingerprint = s.Fingerprint
     WHERE s.VendorId IS NOT NULL
     GROUP BY s.VendorId`,
    [groupId]
  );
  const stats = new Map();
  const get = (id) => {
    if (!stats.has(id)) stats.set(id, { spend12: 0, lineCount12: 0, reviewed: 0, decided: 0, reviewedPct: null, avgConfidence: null });
    return stats.get(id);
  };
  for (const r of spend) Object.assign(get(r.vendorid), { spend12: Math.round(Number(r.spend) * 100) / 100, lineCount12: r.linecount });
  for (const r of review) {
    Object.assign(get(r.vendorid), {
      reviewed: r.reviewed,
      decided: r.decided,
      reviewedPct: r.reviewed ? Math.round((r.decided / r.reviewed) * 1000) / 1000 : null,
      avgConfidence: r.avgconfidence === null ? null : Math.round(Number(r.avgconfidence) * 1000) / 1000,
    });
  }
  return stats;
}

async function loadProfileVendor(groupId, vendorId) {
  if (!UUID_RE.test(vendorId || '')) throw badRequest('Vendor not found', 404);
  const { rows } = await query(
    `SELECT VendorId, DisplayName, WatchMode, SplitTemplate, MergedIntoVendorId FROM CtrlVendors WHERE VendorId = $1 AND GroupId = $2`,
    [vendorId, groupId]
  );
  if (!rows.length || rows[0].mergedintovendorid) throw badRequest('Vendor not found', 404);
  const { rows: aliases } = await query(
    `SELECT PayeeKey, PayeeName FROM CtrlVendorAliases WHERE VendorId = $1 AND GroupId = $2 ORDER BY PayeeName`,
    [vendorId, groupId]
  );
  return { vendor: rows[0], aliases };
}

const correctionText = {
  Reassign: 'Set entity',
  Split: 'Split',
  Reclassify: 'Reclassified',
  DueToFrom: 'Due To/From',
};

// GET /api/controller/vendors/{vendorId}?groupId=
// The full profile: rule versions, entity split and spend by month,
// approval rate and every correction.
async function handleProfile(groupId, vendorId) {
  const { vendor, aliases } = await loadProfileVendor(groupId, vendorId);
  const keys = aliases.map((a) => a.payeekey);
  const entities = await loadEntities(groupId);
  const files = new Map((await loadFiles(groupId, entities)).map((f) => [f.qboId, f]));
  const resolve = buildEntityResolver(entities);

  const { rows: versions } = await query(
    `SELECT r.RuleId, r.Version, r.DefaultEntityId, r.Hints, r.RuleText, r.RuleWins, r.CreatedDate, u.Username AS CreatedBy
     FROM CtrlVendorRules r LEFT JOIN Users u ON u.UserId = r.CreatedBy
     WHERE r.VendorId = $1 AND r.GroupId = $2 ORDER BY r.Version DESC`,
    [vendorId, groupId]
  );

  const lines = keys.length ? await loadStoredLines({ groupId, fromMonth: EARLIEST_MONTH, toMonth: LATEST_MONTH, payeeKeys: keys }) : [];
  // Spend (expense lines) by month and entity, after Paul's decisions.
  const byMonth = new Map();
  // Approval rate is about the suggestions Paul answered, so lines relabeled
  // by "rule wins and relabel history" are counted on their own.
  const outcome = { approved: 0, corrected: 0, relabeled: 0, open: 0 };
  for (const line of lines) {
    const action = line.decision && line.decision.action !== 'Undo' ? line.decision.action : null;
    if (action && line.decision.scope === 'Relabel') outcome.relabeled += 1;
    else if (action === 'Approve' || action === 'Keep') outcome.approved += 1;
    else if (action) outcome.corrected += 1;
    else outcome.open += 1;
    if (line.accountType !== 'Expense') continue;
    const file = files.get(line.qboId) || { isClassBased: true, ownerEntityId: null };
    for (const part of lineEntities(line, file, line.decision, resolve)) {
      const key = `${line.month}|${part.entityId || ''}`;
      byMonth.set(key, (byMonth.get(key) || 0) + part.amount);
    }
  }
  const entitySplit = [...byMonth].map(([key, amount]) => {
    const [month, entityId] = key.split('|');
    return { month, entityId: entityId || null, amount: Math.round(amount * 100) / 100 };
  });
  entitySplit.sort((a, b) => a.month.localeCompare(b.month) || String(a.entityId).localeCompare(String(b.entityId)));
  const decided = outcome.approved + outcome.corrected;

  const corrections = keys.length
    ? (
        await query(
          `SELECT d.DecisionId, d.Action, d.EntityId, d.Allocations, d.CounterpartyEntityId, d.TargetAccountCode, d.TargetAccountName,
                  d.Scope, d.Resolution, d.Note, d.DecidedAt, u.Username AS DecidedBy, q.QBOName,
                  TO_CHAR(l.TxnDate, 'YYYY-MM-DD') AS TxnDate, l.Memo, l.Amount, l.ClassName, l.AccountCode, l.AccountName
           FROM CtrlDecisions d
           JOIN CtrlLedgerLines l ON l.LineId = d.LineId
           JOIN QBOs q ON q.QBOId = d.QBOId
           LEFT JOIN Users u ON u.UserId = d.DecidedBy
           WHERE d.GroupId = $1 AND d.Action IN ('Reassign', 'Split', 'Reclassify', 'DueToFrom') AND d.Scope = 'Line'
             AND ${payeeKeySql('l.PayeeName')} = ANY($2::text[])
           ORDER BY d.DecidedAt DESC
           LIMIT ${MAX_CORRECTIONS}`,
          [groupId, keys]
        )
      ).rows
    : [];
  // Each "relabel history" as one row: when, by whom, to which entity, how
  // many lines and dollars, and whether adjusting entries were requested.
  const relabels = keys.length
    ? (
        await query(
          `SELECT d.RunId, d.EntityId, d.RequestAje, MIN(d.DecidedAt) AS DecidedAt, MIN(u.Username) AS DecidedBy,
                  COUNT(*)::int AS LineCount, COALESCE(SUM(ABS(l.Amount)), 0) AS Amount,
                  TO_CHAR(MIN(l.TxnDate), 'YYYY-MM') AS FromMonth, TO_CHAR(MAX(l.TxnDate), 'YYYY-MM') AS ToMonth
           FROM CtrlDecisions d
           JOIN CtrlLedgerLines l ON l.LineId = d.LineId
           LEFT JOIN Users u ON u.UserId = d.DecidedBy
           WHERE d.GroupId = $1 AND d.Scope = 'Relabel' AND ${payeeKeySql('l.PayeeName')} = ANY($2::text[])
           GROUP BY d.RunId, d.EntityId, d.RequestAje
           ORDER BY MIN(d.DecidedAt) DESC`,
          [groupId, keys]
        )
      ).rows
    : [];

  return json(200, {
    vendor: {
      vendorId: vendor.vendorid,
      displayName: vendor.displayname,
      watchMode: vendor.watchmode,
      splitTemplate: vendor.splittemplate,
      aliases: aliases.map((a) => a.payeename),
    },
    entities: entities.map((e) => ({ entityId: e.entityId, entityName: e.entityName })),
    ruleVersions: versions.map((r) => ({
      ruleId: r.ruleid,
      version: r.version,
      defaultEntityId: r.defaultentityid,
      keywords: r.hints?.keywords || [],
      ruleText: r.ruletext,
      ruleWins: Boolean(r.rulewins),
      createdDate: r.createddate,
      createdBy: r.createdby,
    })),
    entitySplit,
    lineCount: lines.length,
    outcome: { ...outcome, approvalRate: decided ? Math.round((outcome.approved / decided) * 1000) / 1000 : null },
    ai: await aiAgreement(groupId, { vendorId: vendor.vendorid }),
    relabels: relabels.map((r) => ({
      runId: r.runid,
      entityId: r.entityid,
      requestAje: Boolean(r.requestaje),
      decidedAt: r.decidedat,
      decidedBy: r.decidedby,
      lineCount: r.linecount,
      amount: Math.round(Number(r.amount) * 100) / 100,
      fromMonth: r.frommonth,
      toMonth: r.tomonth,
    })),
    corrections: corrections.map((c) => ({
      decisionId: c.decisionid,
      action: c.action,
      actionText: correctionText[c.action],
      entityId: c.entityid,
      allocations: c.allocations,
      counterpartyEntityId: c.counterpartyentityid,
      targetAccount: c.targetaccountname ? { code: c.targetaccountcode || null, name: c.targetaccountname } : null,
      scope: c.scope,
      resolution: c.resolution,
      note: c.note,
      decidedAt: c.decidedat,
      decidedBy: c.decidedby,
      qboName: c.qboname,
      txnDate: c.txndate,
      memo: c.memo,
      amount: Number(c.amount),
      className: c.classname,
      account: [c.accountcode, c.accountname].filter(Boolean).join(' '),
    })),
  });
}

// POST /api/controller/vendors/{vendorId}/rules/test
//   { groupId, rule: { defaultEntityId, keywords }, months: 3..12 }
// How the proposed rule would treat the vendor's lines in the class-based
// files over the last `months` stored months. Nothing is saved.
async function handleRuleTest(groupId, vendorId, body) {
  const months = body.months === undefined ? 12 : Number(body.months);
  if (!Number.isInteger(months) || months < 3 || months > 12) throw badRequest('months must be a whole number from 3 to 12');
  const entities = await loadEntities(groupId);
  const { rule } = validateVendorBody({ rule: body.rule || {} }, new Set(entities.map((e) => e.entityId)));
  const { aliases } = await loadProfileVendor(groupId, vendorId);
  const files = (await loadFiles(groupId, entities)).filter((f) => f.isClassBased);
  const stored = await loadStoredMonths(groupId);
  const latest = files.flatMap((f) => [...(stored.get(f.qboId) || [])]).sort().pop();
  const empty = { months, fromMonth: null, toMonth: null, lineCount: 0, wouldChange: 0, changeAmount: 0, unchanged: 0, noEntity: 0, splits: 0, conflictsWithHistory: 0, history: null, changes: [] };
  if (!latest || !aliases.length) return json(200, empty);
  const fromMonth = shiftMonth(latest, -(months - 1));
  const lines = await loadStoredLines({
    groupId, fromMonth, toMonth: latest, qboIds: files.map((f) => f.qboId), payeeKeys: aliases.map((a) => a.payeekey),
  });
  const settings = await loadSettings(groupId);
  const result = testRule({
    lines,
    rule: { defaultEntityId: rule.defaultEntityId, hints: { keywords: rule.keywords } },
    files: new Map(files.map((f) => [f.qboId, f])),
    resolve: buildEntityResolver(entities),
    threshold: settings.threshold,
  });
  return json(200, { months, fromMonth, toMonth: latest, ...result, changes: result.changes.slice(0, RULE_TEST_SAMPLE) });
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
    if (event.resource === '/api/controller/vendors/{vendorId}') return handleProfile(groupId, event.pathParameters?.vendorId);
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
  if (event.httpMethod === 'POST' && event.resource.endsWith('/rules/test')) return handleRuleTest(body.groupId, vendorId, body);
  throw badRequest('Unknown vendor route', 404);
});

exports.validateVendorBody = validateVendorBody;
exports.sameRule = sameRule;
