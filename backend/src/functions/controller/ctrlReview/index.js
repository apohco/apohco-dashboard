const { authorizeController } = require('../../../shared/controllerAuth');
const { requireGroupAccess } = require('../../../shared/authorize');
const { query, withTransaction } = require('../../../shared/db');
const { json, withErrorHandling } = require('../../../shared/response');
const { parseMonth } = require('../../../shared/monthRanges');
const { buildBatchInsert, insertRows, chunk } = require('../../../shared/bulkInsert');
const { recordAudit } = require('../../../shared/audit');
const {
  STATUSES,
  payeeKey,
  buildEntityResolver,
  buildHistory,
  classifyLines,
  decisionEntity,
  validateAllocations,
  countStatuses,
} = require('../../../shared/reviewEngine');

const DEFAULT_SETTINGS = { threshold: 0.9, mediumThreshold: 0.7, historyMonths: 12 };
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const MAX_DECISIONS_PER_REQUEST = 10000;
const ACCOUNT_TYPES = ['Asset', 'Liability', 'Equity', 'Revenue', 'Expense', 'Unknown'];
const BULK_ACTIONS = ['Approve', 'Keep', 'Reassign'];
const LINE_ACTIONS = [...BULK_ACTIONS, 'Split', 'Undo'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Review order: what most needs attention first.
const STATUS_ORDER = `CASE s.Status WHEN 'Conflict' THEN 0 WHEN 'LikelyMisclassified' THEN 1 WHEN 'Unclassified' THEN 2
  WHEN 'NeedsEvidence' THEN 3 ELSE 4 END`;

function badRequest(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

const isUuid = (v) => UUID_RE.test(String(v || ''));
const csv = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);
const likePattern = (s) => `%${String(s).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

// "YYYY-MM" shifted by `delta` months.
function shiftMonth(month, delta) {
  const { year, month: m } = parseMonth(month);
  const i = year * 12 + (m - 1) + delta;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
}

async function loadSettings(groupId, db = { query }) {
  const { rows } = await db.query(
    `SELECT Threshold, MediumThreshold, HistoryMonths FROM CtrlReviewSettings WHERE GroupId = $1`,
    [groupId]
  );
  if (!rows.length) return { ...DEFAULT_SETTINGS };
  return {
    threshold: Number(rows[0].threshold),
    mediumThreshold: Number(rows[0].mediumthreshold),
    historyMonths: Number(rows[0].historymonths),
  };
}

function validateSettings(body) {
  const threshold = Number(body.threshold);
  const mediumThreshold = Number(body.mediumThreshold);
  const historyMonths = Number(body.historyMonths);
  if (!(threshold >= 0.5 && threshold <= 1)) throw badRequest('threshold must be between 0.5 and 1');
  if (!(mediumThreshold >= 0 && mediumThreshold <= threshold)) {
    throw badRequest('mediumThreshold must be between 0 and threshold');
  }
  if (!Number.isInteger(historyMonths) || historyMonths < 1 || historyMonths > 36) {
    throw badRequest('historyMonths must be a whole number from 1 to 36');
  }
  return { threshold, mediumThreshold, historyMonths };
}

async function loadEntities(groupId) {
  const { rows } = await query(
    `SELECT e.EntityId, e.EntityName, e.ManagementQBOClassId, c.ClassName AS ManagementClassName, e.Aliases, e.Keywords
     FROM CtrlEntities e LEFT JOIN QBOClasses c ON c.QBOClassId = e.ManagementQBOClassId
     WHERE e.GroupId = $1 AND e.IsActive
     ORDER BY e.EntityName`,
    [groupId]
  );
  return rows.map((r) => ({
    entityId: r.entityid,
    entityName: r.entityname,
    managementQboClassId: r.managementqboclassid,
    managementClassName: r.managementclassname,
    aliases: r.aliases || [],
    keywords: r.keywords || [],
  }));
}

async function loadRun(groupId, runId) {
  if (!isUuid(runId)) throw badRequest('Review run not found', 404);
  const { rows } = await query(
    `SELECT RunId, QBOId, TO_CHAR(Period, 'YYYY-MM') AS month, SnapshotId, Threshold, MediumThreshold
     FROM CtrlReviewRuns WHERE RunId = $1 AND GroupId = $2`,
    [runId, groupId]
  );
  if (!rows.length) throw badRequest('Review run not found', 404);
  return rows[0];
}

// Payee key -> vendor id for every payee on `lines`, creating a vendor
// profile (and alias) for any payee seen for the first time.
async function ensureVendors(client, groupId, payeeNames) {
  const wanted = new Map();
  for (const name of payeeNames) {
    const key = payeeKey(name);
    if (key && !wanted.has(key)) wanted.set(key, String(name).trim().slice(0, 255));
  }
  const vendorByKey = new Map();
  if (!wanted.size) return vendorByKey;

  const { rows: existing } = await client.query(
    `SELECT PayeeKey, VendorId FROM CtrlVendorAliases WHERE GroupId = $1 AND PayeeKey = ANY($2::text[])`,
    [groupId, [...wanted.keys()]]
  );
  for (const r of existing) vendorByKey.set(r.payeekey, r.vendorid);

  const missing = [...wanted.entries()].filter(([key]) => !vendorByKey.has(key));
  for (const batch of chunk(missing, 500)) {
    const { sql, params } = buildBatchInsert('CtrlVendors', ['GroupId', 'DisplayName'], batch.map(([, name]) => [groupId, name]));
    // A payee whose name matches an existing profile's name joins it.
    const { rows: vendors } = await client.query(
      `${sql} ON CONFLICT (GroupId, DisplayName) DO UPDATE SET DisplayName = EXCLUDED.DisplayName
       RETURNING VendorId, DisplayName`,
      params
    );
    const byName = new Map(vendors.map((v) => [v.displayname, v.vendorid]));
    const aliases = batch.map(([key, name]) => [groupId, byName.get(name), key, name]);
    await insertRows(client, 'CtrlVendorAliases', ['GroupId', 'VendorId', 'PayeeKey', 'PayeeName'], aliases, 'ON CONFLICT (GroupId, PayeeKey) DO NOTHING');
    for (const [key, name] of batch) vendorByKey.set(key, byName.get(name));
  }
  return vendorByKey;
}

async function loadRules(client, groupId) {
  const { rows } = await client.query(
    `SELECT DISTINCT ON (VendorId) RuleId, VendorId, Version, DefaultEntityId, Hints
     FROM CtrlVendorRules WHERE GroupId = $1 ORDER BY VendorId, Version DESC`,
    [groupId]
  );
  return new Map(
    rows.map((r) => [r.vendorid, { ruleId: r.ruleid, version: r.version, defaultEntityId: r.defaultentityid, hints: r.hints || {} }])
  );
}

// Weighted class history for this file over the months before `month`:
// the latest snapshot of each month, with Paul's latest decision on each
// line replacing the line's QuickBooks class.
async function loadHistoryRows(client, groupId, qboId, month, historyMonths) {
  const { rows } = await client.query(
    `WITH snaps AS (
       SELECT DISTINCT ON (Period) SnapshotId FROM CtrlSnapshots
       WHERE GroupId = $1 AND QBOId = $2 AND Period >= $3 AND Period < $4
       ORDER BY Period, PulledAt DESC
     ),
     dec AS (
       SELECT DISTINCT ON (Fingerprint) Fingerprint, Action, EntityId, Allocations
       FROM CtrlDecisions WHERE GroupId = $1 AND QBOId = $2
       ORDER BY Fingerprint, DecidedAt DESC
     )
     SELECT l.PayeeName, l.AccountCode, l.ClassName, l.QBOClassId,
            d.Action, d.EntityId AS DecisionEntityId, d.Allocations, COUNT(*)::int AS n
     FROM CtrlLedgerLines l
     JOIN snaps s ON s.SnapshotId = l.SnapshotId
     LEFT JOIN dec d ON d.Fingerprint = l.Fingerprint
     GROUP BY l.PayeeName, l.AccountCode, l.ClassName, l.QBOClassId, d.Action, d.EntityId, d.Allocations`,
    [groupId, qboId, `${shiftMonth(month, -historyMonths)}-01`, `${month}-01`]
  );
  return rows;
}

// POST /api/controller/review/runs  { groupId, qboId, month }
async function handleRun(claims, body) {
  const { groupId, qboId, month } = body;
  if (!groupId || !qboId || !month) throw badRequest('groupId, qboId and month are required');
  requireGroupAccess(claims, groupId);
  if (!parseMonth(month)) throw badRequest('month must be formatted YYYY-MM');

  const { rows: qboRows } = await query(
    `SELECT QBOId, QBOName, IsClassBased FROM QBOs WHERE QBOId = $1 AND GroupId = $2`,
    [qboId, groupId]
  );
  if (!qboRows.length) throw badRequest('QBO not found for this Group', 404);
  if (!qboRows[0].isclassbased) {
    throw badRequest(`${qboRows[0].qboname} doesn't use classes, so there are no class assignments to review`);
  }

  const { rows: snapRows } = await query(
    `SELECT SnapshotId FROM CtrlSnapshots WHERE GroupId = $1 AND QBOId = $2 AND Period = $3
     ORDER BY PulledAt DESC LIMIT 1`,
    [groupId, qboId, `${month}-01`]
  );
  if (!snapRows.length) throw badRequest('No General Ledger is stored for that month yet; pull or upload it first', 404);
  const snapshotId = snapRows[0].snapshotid;

  const settings = await loadSettings(groupId);
  const entities = await loadEntities(groupId);
  if (!entities.length) throw badRequest('Add your entities (Controller → Entities) before running a review');
  const { rows: lineRows } = await query(
    `SELECT LineId, Fingerprint, PayeeName, Memo, AccountCode, ClassName, QBOClassId
     FROM CtrlLedgerLines WHERE SnapshotId = $1 AND GroupId = $2`,
    [snapshotId, groupId]
  );

  const result = await withTransaction(async (client) => {
    const vendorByKey = await ensureVendors(client, groupId, lineRows.map((l) => l.payeename).filter(Boolean));
    const rules = await loadRules(client, groupId);
    const resolve = buildEntityResolver(entities);
    const historyRows = await loadHistoryRows(client, groupId, qboId, month, settings.historyMonths);
    const history = buildHistory(
      historyRows.map((r) => ({
        vendorId: vendorByKey.get(payeeKey(r.payeename)) || null,
        accountCode: r.accountcode,
        entityId: resolve(r.classname, r.qboclassid),
        decisionAction: r.action,
        decisionEntityId: r.decisionentityid,
        allocations: r.allocations,
        count: r.n,
      }))
    );

    const results = classifyLines({
      lines: lineRows.map((l) => ({
        lineId: l.lineid,
        fingerprint: l.fingerprint,
        vendorId: vendorByKey.get(payeeKey(l.payeename)) || null,
        payeeName: l.payeename,
        memo: l.memo,
        accountCode: l.accountcode,
        className: l.classname,
        qboClassId: l.qboclassid,
      })),
      entities,
      rules,
      history,
      threshold: settings.threshold,
      mediumThreshold: settings.mediumThreshold,
    });
    const statusCounts = countStatuses(results);

    const { rows: runRows } = await client.query(
      `INSERT INTO CtrlReviewRuns (GroupId, QBOId, Period, SnapshotId, Threshold, MediumThreshold, HistoryMonths, LineCount, StatusCounts, RunBy)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING RunId, RunDate`,
      [
        groupId, qboId, `${month}-01`, snapshotId, settings.threshold, settings.mediumThreshold,
        settings.historyMonths, results.length, JSON.stringify(statusCounts), claims.userId,
      ]
    );
    const run = runRows[0];
    if (results.length) {
      await insertRows(
        client,
        'CtrlSuggestions',
        ['RunId', 'GroupId', 'LineId', 'Fingerprint', 'VendorId', 'CurrentEntityId', 'SuggestedEntityId', 'Confidence', 'Status', 'Source', 'Reasons', 'RuleId'],
        results.map((r) => [
          run.runid, groupId, r.lineId, r.fingerprint, r.vendorId, r.currentEntityId, r.suggestedEntityId,
          r.confidence, r.status, r.source, JSON.stringify(r.reasons), r.ruleId,
        ])
      );
    }
    await recordAudit(
      {
        groupId, userId: claims.userId, action: 'ctrl.review.run', targetType: 'CtrlReviewRun', targetId: run.runid,
        details: { qboId, month, snapshotId, lineCount: results.length, statusCounts, ...settings },
      },
      client
    );
    return { runId: run.runid, runDate: run.rundate, statusCounts, lineCount: results.length };
  });

  return json(201, { ...result, qboId, month, snapshotId });
}

// GET /api/controller/review/runs?groupId=&qboId=&month=
async function handleListRuns(groupId, qs) {
  if (!qs.qboId || !parseMonth(qs.month)) throw badRequest('qboId and month (YYYY-MM) are required');
  const { rows: runs } = await query(
    `SELECT r.RunId, r.RunDate, r.LineCount, r.StatusCounts, r.SnapshotId, r.Threshold
     FROM CtrlReviewRuns r WHERE r.GroupId = $1 AND r.QBOId = $2 AND r.Period = $3
     ORDER BY r.RunDate DESC LIMIT 20`,
    [groupId, qs.qboId, `${qs.month}-01`]
  );
  const { rows: snaps } = await query(
    `SELECT SnapshotId, PulledAt, Source FROM CtrlSnapshots WHERE GroupId = $1 AND QBOId = $2 AND Period = $3
     ORDER BY PulledAt DESC LIMIT 1`,
    [groupId, qs.qboId, `${qs.month}-01`]
  );
  const latestSnapshot = snaps[0] || null;
  return json(200, {
    latestSnapshot: latestSnapshot
      ? { snapshotId: latestSnapshot.snapshotid, pulledAt: latestSnapshot.pulledat, source: latestSnapshot.source }
      : null,
    runs: runs.map((r) => ({
      runId: r.runid,
      runDate: r.rundate,
      lineCount: r.linecount,
      statusCounts: r.statuscounts,
      threshold: Number(r.threshold),
      // A newer pull/upload of the month exists: run the review again.
      isStale: Boolean(latestSnapshot && latestSnapshot.snapshotid !== r.snapshotid),
    })),
  });
}

// Filters shared by the queue and "select all matching" bulk decisions.
function parseFilters(src = {}) {
  const f = {
    statuses: csv(src.status),
    reviewState: src.reviewState || 'all',
    accountTypes: csv(src.accountType),
    account: src.account?.trim() || null,
    vendor: src.vendor?.trim() || null,
    entityId: src.entityId || null,
    search: src.search?.trim() || null,
  };
  if (f.statuses.some((s) => !STATUSES.includes(s))) throw badRequest(`status must be among ${STATUSES.join(', ')}`);
  if (!['all', 'open', 'decided'].includes(f.reviewState)) throw badRequest('reviewState must be all, open or decided');
  if (f.accountTypes.some((t) => !ACCOUNT_TYPES.includes(t))) throw badRequest(`accountType must be among ${ACCOUNT_TYPES.join(', ')}`);
  if (f.entityId && !isUuid(f.entityId)) throw badRequest('entityId is not valid');
  return f;
}

// WHERE clauses for parseFilters' output against the queue query's
// aliases (s, l, v, m, d), with parameters numbered from `start`.
function buildFilterSql(f, start) {
  const clauses = [];
  const params = [];
  const p = (value) => {
    params.push(value);
    return `$${start + params.length - 1}`;
  };
  if (f.statuses.length) clauses.push(`s.Status = ANY(${p(f.statuses)}::text[])`);
  if (f.reviewState === 'open') clauses.push('d.Fingerprint IS NULL');
  if (f.reviewState === 'decided') clauses.push('d.Fingerprint IS NOT NULL');
  if (f.accountTypes.length) clauses.push(`COALESCE(m.Classification, 'Unknown') = ANY(${p(f.accountTypes)}::text[])`);
  if (f.account) {
    const x = p(likePattern(f.account));
    clauses.push(`(l.AccountCode ILIKE ${x} OR l.AccountName ILIKE ${x})`);
  }
  if (f.vendor) {
    const x = p(likePattern(f.vendor));
    clauses.push(`(v.DisplayName ILIKE ${x} OR l.PayeeName ILIKE ${x})`);
  }
  if (f.entityId) {
    const x = p(f.entityId);
    clauses.push(`(s.SuggestedEntityId = ${x} OR s.CurrentEntityId = ${x} OR d.EntityId = ${x})`);
  }
  if (f.search) clauses.push(`l.Memo ILIKE ${p(likePattern(f.search))}`);
  return { sql: clauses.map((c) => ` AND ${c}`).join(''), params };
}

// The queue's FROM clause. Parameters: $1 groupId, $2 runId, $3 qboId.
const QUEUE_FROM = `
  FROM CtrlSuggestions s
  JOIN CtrlLedgerLines l ON l.LineId = s.LineId
  LEFT JOIN CtrlVendors v ON v.VendorId = s.VendorId
  LEFT JOIN ChartOfAccountsMappings m ON m.QBOId = l.QBOId AND m.AccountCode = l.AccountCode
  LEFT JOIN (
    SELECT DISTINCT ON (Fingerprint) Fingerprint, Action, EntityId, Allocations, DecidedAt
    FROM CtrlDecisions WHERE GroupId = $1 AND QBOId = $3
    ORDER BY Fingerprint, DecidedAt DESC
  ) d ON d.Fingerprint = s.Fingerprint AND d.Action <> 'Undo'
  WHERE s.RunId = $2 AND s.GroupId = $1`;

// GET /api/controller/review/lines?groupId=&runId=&status=&reviewState=
//   &accountType=&account=&vendor=&entityId=&search=&limit=&offset=
async function handleLines(groupId, qs) {
  const run = await loadRun(groupId, qs.runId);
  const filters = parseFilters(qs);
  const limit = qs.limit === undefined ? DEFAULT_LIMIT : Number(qs.limit);
  const offset = qs.offset === undefined ? 0 : Number(qs.offset);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw badRequest(`limit must be between 1 and ${MAX_LIMIT}`);
  if (!Number.isInteger(offset) || offset < 0) throw badRequest('offset must be 0 or more');

  const base = [groupId, run.runid, run.qboid];
  const where = buildFilterSql(filters, base.length + 1);
  const params = [...base, ...where.params];

  const { rows: summaryRows } = await query(
    `SELECT s.Status, (d.Fingerprint IS NOT NULL) AS decided, COUNT(*)::int AS n, COALESCE(SUM(ABS(l.Amount)), 0) AS amount
     ${QUEUE_FROM} GROUP BY s.Status, (d.Fingerprint IS NOT NULL)`,
    base
  );
  const { rows: filtered } = await query(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(ABS(l.Amount)), 0) AS amount ${QUEUE_FROM}${where.sql}`,
    params
  );
  const { rows } = await query(
    `SELECT s.LineId, s.Fingerprint, s.VendorId, s.CurrentEntityId, s.SuggestedEntityId, s.Confidence, s.Status, s.Source, s.Reasons,
            TO_CHAR(l.TxnDate, 'YYYY-MM-DD') AS TxnDate, l.TxnType, l.DocNum, l.PayeeName, l.Memo, l.AccountCode, l.AccountName,
            l.ClassName, l.SplitAccount, l.Debit, l.Credit, l.Amount,
            v.DisplayName AS VendorName, v.WatchMode, v.SplitTemplate, COALESCE(m.Classification, 'Unknown') AS AccountType,
            d.Action AS DecisionAction, d.EntityId AS DecisionEntityId, d.Allocations, d.DecidedAt
     ${QUEUE_FROM}${where.sql}
     ORDER BY ${STATUS_ORDER}, ABS(l.Amount) DESC, l.TxnDate, s.LineId
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );

  const summary = Object.fromEntries(STATUSES.map((st) => [st, { count: 0, open: 0, amount: 0 }]));
  for (const r of summaryRows) {
    const entry = summary[r.status];
    entry.count += r.n;
    entry.amount += Number(r.amount);
    if (!r.decided) entry.open += r.n;
  }

  return json(200, {
    run: { runId: run.runid, qboId: run.qboid, month: run.month, threshold: Number(run.threshold), mediumThreshold: Number(run.mediumthreshold) },
    entities: (await loadEntities(groupId)).map((e) => ({ entityId: e.entityId, entityName: e.entityName })),
    summary,
    total: filtered[0].n,
    totalAmount: Number(filtered[0].amount),
    lines: rows.map((r) => ({
      lineId: r.lineid,
      fingerprint: r.fingerprint,
      txnDate: r.txndate,
      txnType: r.txntype,
      docNum: r.docnum,
      payeeName: r.payeename,
      vendorId: r.vendorid,
      vendorName: r.vendorname,
      watchMode: Boolean(r.watchmode),
      splitTemplate: r.splittemplate,
      memo: r.memo,
      accountCode: r.accountcode,
      accountName: r.accountname,
      accountType: r.accounttype,
      className: r.classname,
      splitAccount: r.splitaccount,
      debit: Number(r.debit),
      credit: Number(r.credit),
      amount: Number(r.amount),
      currentEntityId: r.currententityid,
      suggestedEntityId: r.suggestedentityid,
      confidence: Number(r.confidence),
      status: r.status,
      source: r.source,
      reasons: r.reasons,
      decision: r.decisionaction
        ? { action: r.decisionaction, entityId: r.decisionentityid, allocations: r.allocations, decidedAt: r.decidedat }
        : null,
    })),
  });
}

// POST /api/controller/review/decisions
//   One or more lines: { groupId, runId, action, lineIds, entityId?, allocations?, note? }
//   Everything matching a filter: { groupId, runId, action, filter, expectedCount, entityId? }
//     (skips lines already decided and lines from watch-mode vendors).
async function handleDecisions(claims, body) {
  const run = await loadRun(body.groupId, body.runId);
  const { action } = body;
  const byFilter = Boolean(body.filter);
  if (!LINE_ACTIONS.includes(action)) throw badRequest(`action must be one of ${LINE_ACTIONS.join(', ')}`);
  if (byFilter && !BULK_ACTIONS.includes(action)) throw badRequest(`Only ${BULK_ACTIONS.join(', ')} can be applied to a whole filter`);
  if (!byFilter && (!Array.isArray(body.lineIds) || !body.lineIds.length || !body.lineIds.every(isUuid))) {
    throw badRequest('lineIds (or filter) is required');
  }
  if (action === 'Split' && body.lineIds.length !== 1) throw badRequest('Split one line at a time');

  const entities = await loadEntities(body.groupId);
  const entityIds = new Set(entities.map((e) => e.entityId));
  if (action === 'Reassign' && !entityIds.has(body.entityId)) throw badRequest('entityId must be an active entity in this Group');
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 2000) || null : null;

  const base = [body.groupId, run.runid, run.qboid];
  let rows;
  if (byFilter) {
    const filters = parseFilters(body.filter);
    const where = buildFilterSql(filters, base.length + 1);
    ({ rows } = await query(
      `SELECT s.LineId, s.Fingerprint, s.CurrentEntityId, s.SuggestedEntityId, l.Amount, v.WatchMode,
              (d.Fingerprint IS NOT NULL) AS decided
       ${QUEUE_FROM}${where.sql}`,
      [...base, ...where.params]
    ));
    // The user confirmed a count; if the set changed since, stop.
    if (rows.length !== Number(body.expectedCount)) {
      throw badRequest(`The filtered lines changed (now ${rows.length}); refresh and try again`, 409);
    }
  } else {
    ({ rows } = await query(
      `SELECT s.LineId, s.Fingerprint, s.CurrentEntityId, s.SuggestedEntityId, l.Amount, v.WatchMode,
              (d.Fingerprint IS NOT NULL) AS decided
       ${QUEUE_FROM} AND s.LineId = ANY($4::uuid[])`,
      [...base, body.lineIds]
    ));
    if (rows.length !== new Set(body.lineIds).size) throw badRequest('Some lines are not in this review run', 404);
  }
  if (rows.length > MAX_DECISIONS_PER_REQUEST) throw badRequest(`At most ${MAX_DECISIONS_PER_REQUEST} lines per request`);

  const skipped = { alreadyDecided: 0, watchMode: 0, nothingToApply: 0 };
  const decisions = [];
  for (const r of rows) {
    if (byFilter && r.decided) {
      skipped.alreadyDecided += 1;
      continue;
    }
    if (byFilter && r.watchmode) {
      skipped.watchMode += 1;
      continue;
    }
    let entityId = null;
    let allocations = null;
    if (action === 'Split') {
      const problem = validateAllocations(body.allocations, r.amount, entityIds);
      if (problem) throw badRequest(problem);
      allocations = body.allocations.map((a) => ({ entityId: a.entityId, amount: Math.round(Number(a.amount) * 100) / 100 }));
    } else if (action !== 'Undo') {
      entityId = decisionEntity(action, { currentEntityId: r.currententityid, suggestedEntityId: r.suggestedentityid }, body.entityId);
      if (!entityId) {
        skipped.nothingToApply += 1;
        continue;
      }
    } else if (!r.decided) {
      skipped.nothingToApply += 1;
      continue;
    }
    decisions.push([
      body.groupId, run.qboid, r.fingerprint, r.lineid, run.runid, action, entityId,
      allocations ? JSON.stringify(allocations) : null, note, claims.userId,
    ]);
  }

  await withTransaction(async (client) => {
    if (decisions.length) {
      await insertRows(
        client,
        'CtrlDecisions',
        ['GroupId', 'QBOId', 'Fingerprint', 'LineId', 'RunId', 'Action', 'EntityId', 'Allocations', 'Note', 'DecidedBy'],
        decisions
      );
    }
    await recordAudit(
      {
        groupId: body.groupId, userId: claims.userId, action: `ctrl.review.decision.${action.toLowerCase()}`,
        targetType: 'CtrlReviewRun', targetId: run.runid,
        details: { decided: decisions.length, skipped, byFilter, entityId: body.entityId || null, lineIds: byFilter ? undefined : body.lineIds },
      },
      client
    );
  });

  return json(200, { decided: decisions.length, skipped });
}

exports.handler = withErrorHandling(async (event) => {
  const claims = await authorizeController(event);
  const { resource, httpMethod } = event;

  if (httpMethod === 'GET') {
    const qs = event.queryStringParameters || {};
    if (!qs.groupId) throw badRequest('groupId is required');
    requireGroupAccess(claims, qs.groupId);
    if (resource.endsWith('/settings')) return json(200, await loadSettings(qs.groupId));
    if (resource.endsWith('/runs')) return handleListRuns(qs.groupId, qs);
    if (resource.endsWith('/lines')) return handleLines(qs.groupId, qs);
    throw badRequest('Unknown review route', 404);
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    throw badRequest('Request body must be JSON');
  }

  if (httpMethod === 'POST' && resource.endsWith('/runs')) return handleRun(claims, body);
  if (!body.groupId) throw badRequest('groupId is required');
  requireGroupAccess(claims, body.groupId);

  if (httpMethod === 'PUT' && resource.endsWith('/settings')) {
    const settings = validateSettings(body);
    await query(
      `INSERT INTO CtrlReviewSettings (GroupId, Threshold, MediumThreshold, HistoryMonths, UpdatedBy)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (GroupId) DO UPDATE SET Threshold = EXCLUDED.Threshold, MediumThreshold = EXCLUDED.MediumThreshold,
         HistoryMonths = EXCLUDED.HistoryMonths, UpdatedBy = EXCLUDED.UpdatedBy, LastUpdated = now()`,
      [body.groupId, settings.threshold, settings.mediumThreshold, settings.historyMonths, claims.userId]
    );
    await recordAudit({ groupId: body.groupId, userId: claims.userId, action: 'ctrl.review.settings', details: settings });
    return json(200, settings);
  }
  if (httpMethod === 'POST' && resource.endsWith('/decisions')) return handleDecisions(claims, body);
  throw badRequest('Unknown review route', 404);
});

exports.parseFilters = parseFilters;
exports.buildFilterSql = buildFilterSql;
exports.validateSettings = validateSettings;
exports.shiftMonth = shiftMonth;
