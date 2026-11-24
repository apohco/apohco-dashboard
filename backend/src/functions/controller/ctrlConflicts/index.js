// Controller Phase 2b: the conflicts queue. A conflict is a line where
// Paul's vendor rule and strong history point to different entities
// (class review of the management file). Paul resolves each one:
//
//   LineOnly         this transaction only (any entity he picks)
//   RuleWins         the rule takes priority from now on: a new rule
//                    version with RuleWins, and this month's open conflict
//                    lines for the vendor follow the rule
//   RuleWinsRelabel  as RuleWins, plus every earlier line of the vendor
//                    that disagrees with the rule is relabeled (decisions
//                    with Scope 'Relabel'; RequestAje only if Paul asks)
//
// Database only: nothing is written to QuickBooks.
const { authorizeController } = require('../../../shared/controllerAuth');
const { requireGroupAccess } = require('../../../shared/authorize');
const { query, withTransaction } = require('../../../shared/db');
const { json, withErrorHandling } = require('../../../shared/response');
const { insertRows } = require('../../../shared/bulkInsert');
const { recordAudit } = require('../../../shared/audit');
const {
  payeeKey,
  buildEntityResolver,
  buildHistory,
  historyBreakdown,
  ruleSuggestion,
  relabelCandidates,
} = require('../../../shared/reviewEngine');
const {
  badRequest,
  isUuid,
  loadSettings,
  loadEntities,
  loadRun,
  loadRules,
  loadHistoryRows,
  loadVendorKeys,
  loadStoredLines,
  loadOwnerEntityId,
} = require('../../../shared/ctrlReviewData');

const RESOLUTIONS = ['LineOnly', 'RuleWins', 'RuleWinsRelabel'];
const SAMPLE_SIZE = 25;
const EARLIEST_MONTH = '2000-01';

// Conflict lines of a run (optionally one line), with the latest decision.
async function loadConflictLines(groupId, run, lineId = null) {
  const params = [groupId, run.runid, run.qboid];
  if (lineId) params.push(lineId);
  const { rows } = await query(
    `SELECT s.LineId, s.Fingerprint, s.VendorId, s.CurrentEntityId, s.SuggestedEntityId, s.Confidence, s.Reasons,
            TO_CHAR(l.TxnDate, 'YYYY-MM-DD') AS TxnDate, l.TxnType, l.DocNum, l.PayeeName, l.Memo, l.AccountCode, l.AccountName,
            l.ClassName, l.QBOClassId, l.Amount, v.DisplayName AS VendorName,
            d.Action AS DecisionAction, d.EntityId AS DecisionEntityId, d.Resolution
     FROM CtrlSuggestions s
     JOIN CtrlLedgerLines l ON l.LineId = s.LineId
     LEFT JOIN CtrlVendors v ON v.VendorId = s.VendorId
     LEFT JOIN (
       SELECT DISTINCT ON (Fingerprint) Fingerprint, Action, EntityId, Resolution
       FROM CtrlDecisions WHERE GroupId = $1 AND QBOId = $3
       ORDER BY Fingerprint, DecidedAt DESC
     ) d ON d.Fingerprint = s.Fingerprint AND d.Action <> 'Undo'
     WHERE s.RunId = $2 AND s.GroupId = $1 AND s.Status = 'Conflict'${lineId ? ' AND s.LineId = $4' : ''}
     ORDER BY ABS(l.Amount) DESC, l.TxnDate, s.LineId`,
    params
  );
  return rows;
}

function requireClassRun(run) {
  if ((run.reviewkind || 'Class') !== 'Class') {
    throw badRequest('Conflicts between a vendor rule and history only arise on class-based files; resolve this line in Review');
  }
}

// GET /api/controller/conflicts?groupId=&runId=
async function handleList(groupId, qs) {
  const run = await loadRun(groupId, qs.runId);
  const entities = await loadEntities(groupId);
  const base = {
    run: { runId: run.runid, qboId: run.qboid, month: run.month, reviewKind: run.reviewkind || 'Class' },
    entities: entities.map((e) => ({ entityId: e.entityId, entityName: e.entityName })),
  };
  if (base.run.reviewKind !== 'Class') return json(200, { ...base, conflicts: [] });

  const rows = await loadConflictLines(groupId, run);
  if (!rows.length) return json(200, { ...base, conflicts: [] });

  const db = { query };
  const settings = await loadSettings(groupId);
  const rules = await loadRules(db, groupId);
  const vendorKeys = await loadVendorKeys(groupId);
  const resolve = buildEntityResolver(entities);
  const historyRows = await loadHistoryRows(db, groupId, run.qboid, run.month, settings.historyMonths);
  const history = buildHistory(
    historyRows.map((r) => ({
      vendorId: vendorKeys.get(payeeKey(r.payeename))?.vendorId || null,
      accountCode: r.accountcode,
      entityId: resolve(r.classname, r.qboclassid),
      decisionAction: r.action,
      decisionEntityId: r.decisionentityid,
      allocations: r.allocations,
      count: r.n,
    }))
  );

  const conflicts = rows.map((r) => {
    const rule = r.vendorid ? rules.get(r.vendorid) : null;
    const hit = rule ? ruleSuggestion(rule, { memo: r.memo, payeeName: r.payeename }) : null;
    return {
      lineId: r.lineid,
      txnDate: r.txndate,
      txnType: r.txntype,
      docNum: r.docnum,
      vendorId: r.vendorid,
      vendorName: r.vendorname || r.payeename,
      memo: r.memo,
      accountCode: r.accountcode,
      accountName: r.accountname,
      className: r.classname,
      amount: Number(r.amount),
      currentEntityId: r.currententityid,
      reasons: r.reasons,
      decision: r.decisionaction ? { action: r.decisionaction, entityId: r.decisionentityid, resolution: r.resolution } : null,
      rule: rule
        ? {
            ruleId: rule.ruleId,
            version: rule.version,
            text: rule.ruleText,
            defaultEntityId: rule.defaultEntityId,
            keywords: rule.hints?.keywords || [],
            entityId: hit?.entityId || null,
            matchedKeyword: hit?.kind === 'keyword' ? hit.keyword : null,
            ruleWins: rule.ruleWins,
          }
        : null,
      history: historyBreakdown(history, r.vendorid, r.accountcode),
    };
  });
  return json(200, { ...base, conflicts });
}

// The vendor's earlier lines (before the run's month) in the run's file
// that the rule would relabel.
async function computeRelabel(groupId, run, vendorId, rule, entities) {
  const { rows: aliases } = await query(`SELECT PayeeKey FROM CtrlVendorAliases WHERE GroupId = $1 AND VendorId = $2`, [groupId, vendorId]);
  if (!aliases.length) return { relabel: [], skippedSplits: 0, previouslyDecided: 0 };
  const lines = (
    await loadStoredLines({
      groupId,
      fromMonth: EARLIEST_MONTH,
      toMonth: run.month,
      qboIds: [run.qboid],
      payeeKeys: aliases.map((a) => a.payeekey),
    })
  ).filter((l) => l.month < run.month);
  return relabelCandidates({
    lines,
    rule,
    file: { isClassBased: true, ownerEntityId: await loadOwnerEntityId(groupId, run.qboid) },
    resolve: buildEntityResolver(entities),
  });
}

// Loads the conflict line and the vendor's current rule, which must name
// an entity for the line (that is what "rule wins" applies).
async function loadConflictContext(groupId, runId, lineId) {
  const run = await loadRun(groupId, runId);
  requireClassRun(run);
  if (!isUuid(lineId)) throw badRequest('Conflict not found', 404);
  const [line] = await loadConflictLines(groupId, run, lineId);
  if (!line) throw badRequest('Conflict not found in this review run', 404);
  const entities = await loadEntities(groupId);
  const rule = line.vendorid ? (await loadRules({ query }, groupId)).get(line.vendorid) : null;
  const hit = rule ? ruleSuggestion(rule, { memo: line.memo, payeeName: line.payeename }) : null;
  return { run, line, entities, rule, ruleEntityId: hit?.entityId || null };
}

// POST /api/controller/conflicts/{lineId}/preview  { groupId, runId }
// What "Rule wins and relabel history" would change.
async function handlePreview(groupId, lineId, body) {
  const { run, line, entities, rule, ruleEntityId } = await loadConflictContext(groupId, body.runId, lineId);
  if (!ruleEntityId) throw badRequest("This vendor's rule doesn't name an entity for this line");
  const { relabel, skippedSplits, previouslyDecided } = await computeRelabel(groupId, run, line.vendorid, rule, entities);
  const byMonth = {};
  for (const r of relabel) byMonth[r.line.month] = (byMonth[r.line.month] || 0) + 1;
  return json(200, {
    vendorId: line.vendorid,
    ruleVersion: rule.version,
    count: relabel.length,
    amount: Math.round(relabel.reduce((s, r) => s + Math.abs(r.line.amount), 0) * 100) / 100,
    months: Object.keys(byMonth).sort(),
    byMonth,
    previouslyDecided,
    skippedSplits,
    sample: relabel.slice(0, SAMPLE_SIZE).map((r) => ({
      lineId: r.line.lineId,
      month: r.line.month,
      txnDate: r.line.txnDate,
      memo: r.line.memo,
      account: [r.line.accountCode, r.line.accountName].filter(Boolean).join(' '),
      amount: r.line.amount,
      fromEntityId: r.fromEntityId,
      toEntityId: r.toEntityId,
    })),
  });
}

const DECISION_COLUMNS = [
  'GroupId', 'QBOId', 'Fingerprint', 'LineId', 'RunId', 'Action', 'EntityId', 'Note', 'DecidedBy', 'Scope', 'RequestAje', 'Resolution',
];

// POST /api/controller/conflicts/{lineId}/resolve
//   { groupId, runId, resolution, entityId? (LineOnly), requestAje?, expectedRelabelCount? (RuleWinsRelabel), note? }
async function handleResolve(claims, groupId, lineId, body) {
  const { resolution } = body;
  if (!RESOLUTIONS.includes(resolution)) throw badRequest(`resolution must be one of ${RESOLUTIONS.join(', ')}`);
  const { run, line, entities, rule, ruleEntityId } = await loadConflictContext(groupId, body.runId, lineId);
  const entityIds = new Set(entities.map((e) => e.entityId));
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 2000) || null : null;
  const decide = (l, entityId, scope = 'Line', requestAje = true) => [
    groupId, run.qboid, l.fingerprint, l.lineid, run.runid, entityId === l.currententityid ? 'Keep' : 'Reassign', entityId,
    note, claims.userId, scope, requestAje, resolution,
  ];

  if (resolution === 'LineOnly') {
    if (!entityIds.has(body.entityId)) throw badRequest('entityId must be an active entity in this Group');
    await withTransaction(async (client) => {
      await insertRows(client, 'CtrlDecisions', DECISION_COLUMNS, [decide(line, body.entityId)]);
      await recordAudit(
        {
          groupId, userId: claims.userId, action: 'ctrl.conflict.resolve', targetType: 'CtrlLedgerLine', targetId: line.lineid,
          details: { resolution, runId: run.runid, entityId: body.entityId },
        },
        client
      );
    });
    return json(200, { resolution, decided: 1, relabeled: 0, ruleVersion: null });
  }

  if (!ruleEntityId) throw badRequest("This vendor's rule doesn't name an entity for this line");
  const relabelPlan = resolution === 'RuleWinsRelabel' ? await computeRelabel(groupId, run, line.vendorid, rule, entities) : null;
  if (relabelPlan && Number(body.expectedRelabelCount) !== relabelPlan.relabel.length) {
    throw badRequest(`The lines to relabel changed (now ${relabelPlan.relabel.length}); preview again`, 409);
  }
  const requestAje = Boolean(body.requestAje);

  // This month's open conflict lines for the vendor follow the rule too.
  const open = (await loadConflictLines(groupId, run)).filter((r) => r.vendorid === line.vendorid && !r.decisionaction);
  const thisMonth = open
    .map((r) => ({ r, hit: ruleSuggestion(rule, { memo: r.memo, payeeName: r.payeename }) }))
    .filter((x) => x.hit && entityIds.has(x.hit.entityId))
    .map((x) => decide(x.r, x.hit.entityId));

  const result = await withTransaction(async (client) => {
    let ruleVersion = rule.version;
    if (!rule.ruleWins) {
      const { rows: latest } = await client.query(
        `SELECT Version, DefaultEntityId, Hints, RuleText FROM CtrlVendorRules WHERE VendorId = $1 AND GroupId = $2
         ORDER BY Version DESC LIMIT 1 FOR UPDATE`,
        [line.vendorid, groupId]
      );
      ruleVersion = latest[0].version + 1;
      await client.query(
        `INSERT INTO CtrlVendorRules (GroupId, VendorId, Version, DefaultEntityId, Hints, RuleText, RuleWins, CreatedBy)
         VALUES ($1, $2, $3, $4, $5, $6, true, $7)`,
        [groupId, line.vendorid, ruleVersion, latest[0].defaultentityid, JSON.stringify(latest[0].hints || {}), latest[0].ruletext, claims.userId]
      );
    }
    if (thisMonth.length) await insertRows(client, 'CtrlDecisions', DECISION_COLUMNS, thisMonth);
    const relabelRows = (relabelPlan?.relabel || []).map(({ line: l, toEntityId }) => [
      groupId, run.qboid, l.fingerprint, l.lineId, run.runid, 'Reassign', toEntityId, note, claims.userId, 'Relabel', requestAje, resolution,
    ]);
    if (relabelRows.length) await insertRows(client, 'CtrlDecisions', DECISION_COLUMNS, relabelRows);
    await recordAudit(
      {
        groupId, userId: claims.userId, action: 'ctrl.conflict.resolve', targetType: 'CtrlVendor', targetId: line.vendorid,
        details: {
          resolution, runId: run.runid, lineId: line.lineid, ruleVersion, decided: thisMonth.length,
          relabeled: relabelRows.length, requestAje: relabelPlan ? requestAje : undefined,
        },
      },
      client
    );
    return { ruleVersion, decided: thisMonth.length, relabeled: relabelRows.length };
  });
  return json(200, { resolution, ...result });
}

exports.handler = withErrorHandling(async (event) => {
  const claims = await authorizeController(event);
  if (event.httpMethod === 'GET') {
    const qs = event.queryStringParameters || {};
    if (!qs.groupId) throw badRequest('groupId is required');
    requireGroupAccess(claims, qs.groupId);
    return handleList(qs.groupId, qs);
  }
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    throw badRequest('Request body must be JSON');
  }
  if (!body.groupId) throw badRequest('groupId is required');
  requireGroupAccess(claims, body.groupId);
  const lineId = event.pathParameters?.lineId;
  if (event.httpMethod === 'POST' && event.resource.endsWith('/preview')) return handlePreview(body.groupId, lineId, body);
  if (event.httpMethod === 'POST' && event.resource.endsWith('/resolve')) return handleResolve(claims, body.groupId, lineId, body);
  throw badRequest('Unknown conflicts route', 404);
});
