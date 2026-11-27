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
  buildAccountHistory,
  classifyAccountLines,
} = require('../../../shared/reviewEngine');
const { accountKey } = require('../../../shared/accountKey');
const { startReviewAiJob } = require('../../../shared/ctrlAiJobs');
const { enqueueEvidenceBatches } = require('../../../shared/ctrlQueue');
const {
  badRequest,
  isUuid,
  shiftMonth,
  loadSettings,
  validateSettings,
  loadEntities,
  loadRun,
  loadRules,
  loadHistoryRows,
  loadAccountHistoryRows,
  loadAccountTypes,
  loadFileAccounts,
  resolveAccount,
  loadOwnerEntityId,
  loadEffectiveDueToFrom,
  ACCOUNT_TYPE_SQL,
  accountTypeJoin,
} = require('../../../shared/ctrlReviewData');

const csv = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);
const likePattern = (s) => `%${String(s).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const MAX_DECISIONS_PER_REQUEST = 10000;
const ACCOUNT_TYPES = ['Asset', 'Liability', 'Equity', 'Revenue', 'Expense', 'Unknown'];
// AcceptAi: apply the AI's suggestion (recorded as the concrete action it
// stands for, marked SuggestionSource 'AI').
const BULK_ACTIONS = ['Approve', 'AcceptAi', 'Keep', 'Reassign', 'Reclassify', 'DueToFrom'];
const AI_FILTERS = ['suggested', 'unsure', 'none'];
const EVIDENCE_FILTERS = ['found', 'none', 'unsearched', 'saved'];
// "Search All" (evidence): lines per job and per worker message.
const EVIDENCE_MAX_LINES = 300;
const EVIDENCE_BATCH = 10;
// Entity assignment only makes sense where lines carry classes.
const CLASS_ONLY_ACTIONS = ['Reassign', 'Split'];
const LINE_ACTIONS = [...BULK_ACTIONS, 'Split', 'Undo'];
// Review order: what most needs attention first.
const STATUS_ORDER = `CASE s.Status WHEN 'Conflict' THEN 0 WHEN 'LikelyMisclassified' THEN 1 WHEN 'Unclassified' THEN 2
  WHEN 'NeedsEvidence' THEN 3 ELSE 4 END`;

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

async function saveDueToFrom(db, groupId, qboId, counterpartyEntityId, account, userId) {
  await db.query(
    `INSERT INTO CtrlDueToFromAccounts (GroupId, QBOId, CounterpartyEntityId, AccountCode, AccountName, UpdatedBy)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (QBOId, CounterpartyEntityId) DO UPDATE SET AccountCode = EXCLUDED.AccountCode,
       AccountName = EXCLUDED.AccountName, UpdatedBy = EXCLUDED.UpdatedBy, LastUpdated = now()`,
    [groupId, qboId, counterpartyEntityId, account.code, account.name, userId]
  );
}

// Class review (the management file): which entity each line belongs to.
async function classifyClassRun(client, { groupId, qboId, month, settings, entities, lineRows, vendorByKey }) {
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
  return classifyLines({
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
}

// Account review (practice files): right account, or another entity's.
async function classifyAccountRun(client, { groupId, qboId, month, settings, entities, lineRows, vendorByKey }) {
  const types = await loadAccountTypes(groupId, qboId, client);
  const typeOf = (code, name) => types.get(accountKey(code || null, name)) || 'Unknown';
  const ownerEntityId = await loadOwnerEntityId(groupId, qboId);
  const { effective: dueToFrom } = await loadEffectiveDueToFrom(groupId, qboId, entities, ownerEntityId, client);
  const historyRows = await loadAccountHistoryRows(client, groupId, qboId, month, settings.historyMonths);
  const history = buildAccountHistory(
    historyRows.map((r) => ({
      vendorId: vendorByKey.get(payeeKey(r.payeename)) || null,
      accountType: typeOf(r.accountcode, r.accountname),
      accountKey: accountKey(r.accountcode || null, r.accountname),
      accountCode: r.accountcode,
      accountName: r.accountname,
      decisionAction: r.action,
      targetAccountKey: r.targetaccountname ? accountKey(r.targetaccountcode || null, r.targetaccountname) : null,
      targetAccountCode: r.targetaccountcode,
      targetAccountName: r.targetaccountname,
      counterpartyEntityId: r.counterpartyentityid,
      count: r.n,
    }))
  );
  return classifyAccountLines({
    lines: lineRows.map((l) => ({
      lineId: l.lineid,
      fingerprint: l.fingerprint,
      vendorId: vendorByKey.get(payeeKey(l.payeename)) || null,
      payeeName: l.payeename,
      memo: l.memo,
      accountType: typeOf(l.accountcode, l.accountname),
      accountKey: accountKey(l.accountcode || null, l.accountname),
      accountCode: l.accountcode,
      accountName: l.accountname,
    })),
    entities,
    ownerEntityId,
    dueToFrom,
    history,
    threshold: settings.threshold,
    mediumThreshold: settings.mediumThreshold,
  });
}

// POST /api/controller/review/runs  { groupId, qboId, month }
// A class-based file gets a class review; any other file an account review.
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
  const reviewKind = qboRows[0].isclassbased ? 'Class' : 'Account';

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
    `SELECT LineId, Fingerprint, PayeeName, Memo, AccountCode, AccountName, ClassName, QBOClassId
     FROM CtrlLedgerLines WHERE SnapshotId = $1 AND GroupId = $2`,
    [snapshotId, groupId]
  );

  const result = await withTransaction(async (client) => {
    const vendorByKey = await ensureVendors(client, groupId, lineRows.map((l) => l.payeename).filter(Boolean));
    const input = { groupId, qboId, month, settings, entities, lineRows, vendorByKey };
    const results = reviewKind === 'Class' ? await classifyClassRun(client, input) : await classifyAccountRun(client, input);
    const statusCounts = countStatuses(results);

    const { rows: runRows } = await client.query(
      `INSERT INTO CtrlReviewRuns (GroupId, QBOId, Period, SnapshotId, Threshold, MediumThreshold, HistoryMonths, LineCount, StatusCounts, RunBy, ReviewKind)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING RunId, RunDate`,
      [
        groupId, qboId, `${month}-01`, snapshotId, settings.threshold, settings.mediumThreshold,
        settings.historyMonths, results.length, JSON.stringify(statusCounts), claims.userId, reviewKind,
      ]
    );
    const run = runRows[0];
    if (results.length) {
      await insertRows(
        client,
        'CtrlSuggestions',
        ['RunId', 'GroupId', 'LineId', 'Fingerprint', 'VendorId', 'CurrentEntityId', 'SuggestedEntityId', 'Confidence', 'Status', 'Source', 'Reasons', 'RuleId',
          'SuggestedAction', 'SuggestedAccountCode', 'SuggestedAccountName'],
        results.map((r) => [
          run.runid, groupId, r.lineId, r.fingerprint, r.vendorId, r.currentEntityId, r.suggestedEntityId,
          r.confidence, r.status, r.source, JSON.stringify(r.reasons), r.ruleId,
          r.suggestedAction || null, r.suggestedAccountCode || null, r.suggestedAccountName || null,
        ])
      );
    }
    await recordAudit(
      {
        groupId, userId: claims.userId, action: 'ctrl.review.run', targetType: 'CtrlReviewRun', targetId: run.runid,
        details: { qboId, month, snapshotId, reviewKind, lineCount: results.length, statusCounts, ...settings },
      },
      client
    );
    return { runId: run.runid, runDate: run.rundate, reviewKind, statusCounts, lineCount: results.length };
  });

  // The AI pass runs in the background (ctrlAiWorker). A problem starting
  // it never fails the review itself.
  let ai;
  try {
    const rules = await loadRules({ query }, groupId);
    ai = await startReviewAiJob({ groupId, run: { runId: result.runId, qboId }, settings, rules, userId: claims.userId });
  } catch (err) {
    console.error('Could not start the AI pass:', err.message);
    ai = { skipped: 'The AI pass could not be started; start it again from the Review queue' };
  }

  return json(201, { ...result, qboId, month, snapshotId, ai });
}

// GET /api/controller/review/runs?groupId=&qboId=&month=
async function handleListRuns(groupId, qs) {
  if (!qs.qboId || !parseMonth(qs.month)) throw badRequest('qboId and month (YYYY-MM) are required');
  const { rows: runs } = await query(
    `SELECT r.RunId, r.RunDate, r.LineCount, r.StatusCounts, r.SnapshotId, r.Threshold, r.ReviewKind
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
      reviewKind: r.reviewkind,
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
    ai: src.ai || null,
    evidence: src.evidence || null,
  };
  if (f.ai && !AI_FILTERS.includes(f.ai)) throw badRequest(`ai must be one of ${AI_FILTERS.join(', ')}`);
  if (f.evidence && !EVIDENCE_FILTERS.includes(f.evidence)) throw badRequest(`evidence must be one of ${EVIDENCE_FILTERS.join(', ')}`);
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
  if (f.accountTypes.length) clauses.push(`${ACCOUNT_TYPE_SQL} = ANY(${p(f.accountTypes)}::text[])`);
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
    clauses.push(`(s.SuggestedEntityId = ${x} OR s.CurrentEntityId = ${x} OR d.EntityId = ${x} OR d.CounterpartyEntityId = ${x})`);
  }
  if (f.search) clauses.push(`l.Memo ILIKE ${p(likePattern(f.search))}`);
  // ai: 'suggested' (the AI proposed something), 'unsure', 'none' (not sent / no answer yet)
  if (f.ai === 'suggested') clauses.push(`a.SuggestedAction IS NOT NULL AND a.SuggestedAction <> 'Unsure'`);
  if (f.ai === 'unsure') clauses.push(`a.SuggestedAction = 'Unsure'`);
  if (f.ai === 'none') clauses.push('a.LineId IS NULL');
  // evidence: 'found' (candidates), 'none' (searched, nothing found), 'unsearched'
  if (f.evidence === 'found') clauses.push('ev.n > 0');
  if (f.evidence === 'none') clauses.push('es.Fingerprint IS NOT NULL AND ev.n = 0');
  if (f.evidence === 'unsearched') clauses.push('es.Fingerprint IS NULL');
  if (f.evidence === 'saved') clauses.push('sv.saved > 0');
  return { sql: clauses.map((c) => ` AND ${c}`).join(''), params };
}


// The queue's FROM clause. Parameters: $1 groupId, $2 runId, $3 qboId.
const QUEUE_FROM = `
  FROM CtrlSuggestions s
  JOIN CtrlLedgerLines l ON l.LineId = s.LineId
  LEFT JOIN CtrlVendors v ON v.VendorId = s.VendorId
  ${accountTypeJoin('l')}
  LEFT JOIN (
    SELECT DISTINCT ON (Fingerprint) Fingerprint, Action, EntityId, Allocations, DecidedAt,
           TargetAccountCode, TargetAccountName, CounterpartyEntityId
    FROM CtrlDecisions WHERE GroupId = $1 AND QBOId = $3
    ORDER BY Fingerprint, DecidedAt DESC
  ) d ON d.Fingerprint = s.Fingerprint AND d.Action <> 'Undo'
  LEFT JOIN CtrlAiSuggestions a ON a.RunId = s.RunId AND a.LineId = s.LineId
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS n, MAX(c.Score) AS best, (ARRAY_AGG(c.EntityHintId ORDER BY c.Score DESC))[1] AS hint
    FROM CtrlEvidenceCandidates c WHERE c.GroupId = $1 AND c.QBOId = $3 AND c.Fingerprint = s.Fingerprint
  ) ev ON true
  LEFT JOIN CtrlEvidenceSearches es ON es.QBOId = $3 AND es.Fingerprint = s.Fingerprint
  LEFT JOIN LATERAL (
    SELECT COUNT(*) FILTER (WHERE x.Status = 'Saved')::int AS saved FROM CtrlEvidenceSaved x WHERE x.QBOId = $3 AND x.Fingerprint = s.Fingerprint
  ) sv ON true
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
            s.SuggestedAction, s.SuggestedAccountCode, s.SuggestedAccountName,
            TO_CHAR(l.TxnDate, 'YYYY-MM-DD') AS TxnDate, l.TxnType, l.DocNum, l.PayeeName, l.Memo, l.AccountCode, l.AccountName,
            l.ClassName, l.SplitAccount, l.Debit, l.Credit, l.Amount,
            v.DisplayName AS VendorName, v.WatchMode, v.SplitTemplate, ${ACCOUNT_TYPE_SQL} AS AccountType,
            d.Action AS DecisionAction, d.EntityId AS DecisionEntityId, d.Allocations, d.DecidedAt,
            d.TargetAccountCode, d.TargetAccountName, d.CounterpartyEntityId,
            a.SuggestedAction AS AiAction, a.SuggestedEntityId AS AiEntityId, a.SuggestedAccountCode AS AiAccountCode,
            a.SuggestedAccountName AS AiAccountName, a.Confidence AS AiConfidence, a.Reason AS AiReason, a.UsedRule AS AiUsedRule,
            a.Redacted AS AiRedacted, ev.n AS EvidenceCount, ev.best AS EvidenceBest, ev.hint AS EvidenceHint,
            es.SearchedAt AS EvidenceSearchedAt, sv.saved AS EvidenceSaved
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
    run: {
      runId: run.runid,
      qboId: run.qboid,
      month: run.month,
      reviewKind: run.reviewkind || 'Class',
      threshold: Number(run.threshold),
      mediumThreshold: Number(run.mediumthreshold),
    },
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
      suggestedAction: r.suggestedaction || null,
      suggestedAccount: r.suggestedaccountname ? { code: r.suggestedaccountcode || null, name: r.suggestedaccountname } : null,
      confidence: Number(r.confidence),
      status: r.status,
      source: r.source,
      reasons: r.reasons,
      ai: r.aiaction
        ? {
            action: r.aiaction,
            entityId: r.aientityid || null,
            account: r.aiaccountname ? { code: r.aiaccountcode || null, name: r.aiaccountname } : null,
            confidence: Number(r.aiconfidence),
            reason: r.aireason,
            usedRule: Boolean(r.aiusedrule),
            redacted: Boolean(r.airedacted),
          }
        : null,
      evidence: {
        count: r.evidencecount || 0,
        best: r.evidencebest === null || r.evidencebest === undefined ? null : Number(r.evidencebest),
        entityHintId: r.evidencehint || null,
        searchedAt: r.evidencesearchedat || null,
        saved: r.evidencesaved || 0,
      },
      decision: r.decisionaction
        ? {
            action: r.decisionaction,
            entityId: r.decisionentityid,
            allocations: r.allocations,
            targetAccount: r.targetaccountname ? { code: r.targetaccountcode || null, name: r.targetaccountname } : null,
            counterpartyEntityId: r.counterpartyentityid || null,
            decidedAt: r.decidedat,
          }
        : null,
    })),
  });
}

// POST /api/controller/review/decisions
//   One or more lines: { groupId, runId, action, lineIds, entityId?, allocations?,
//                        account?, counterpartyEntityId?, note? }
//   Everything matching a filter: { groupId, runId, action, filter, expectedCount, ... }
//     (skips lines already decided and lines from watch-mode vendors).
//
// Actions:
//   Approve     apply the suggestion (on an account review it is recorded
//               as the Keep / Reclassify / DueToFrom it stands for)
//   Keep        the line is right as it is
//   Reassign    (class review) the line belongs to entityId
//   Split       (class review, one line) allocations across entities
//   Reclassify  move the line to `account` ({ code?, name }) in this file
//   DueToFrom   the line belongs to counterpartyEntityId: move it to this
//               file's Due To/From account for that entity -- `account` if
//               given (saved as the default unless rememberAccount is
//               false), else the saved default, else the account named
//               "Due from/to <entity>"
//   Undo        clear the line's decision
async function handleDecisions(claims, body) {
  const run = await loadRun(body.groupId, body.runId);
  const kind = run.reviewkind || 'Class';
  const { action } = body;
  const byFilter = Boolean(body.filter);
  if (!LINE_ACTIONS.includes(action)) throw badRequest(`action must be one of ${LINE_ACTIONS.join(', ')}`);
  if (byFilter && !BULK_ACTIONS.includes(action)) throw badRequest(`Only ${BULK_ACTIONS.join(', ')} can be applied to a whole filter`);
  if (kind === 'Account' && CLASS_ONLY_ACTIONS.includes(action)) {
    throw badRequest('This file has no classes; use Reclassify or Due To/From instead');
  }
  if (!byFilter && (!Array.isArray(body.lineIds) || !body.lineIds.length || !body.lineIds.every(isUuid))) {
    throw badRequest('lineIds (or filter) is required');
  }
  if (action === 'Split' && body.lineIds.length !== 1) throw badRequest('Split one line at a time');

  const entities = await loadEntities(body.groupId);
  const entityIds = new Set(entities.map((e) => e.entityId));
  const entityName = (id) => entities.find((e) => e.entityId === id)?.entityName || 'that entity';
  if (action === 'Reassign' && !entityIds.has(body.entityId)) throw badRequest('entityId must be an active entity in this Group');
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 2000) || null : null;

  // The account the line moves to (Reclassify / DueToFrom).
  let target = null;
  let saveMapping = false;
  const needsDueToFrom = action === 'DueToFrom' || (kind === 'Account' && (action === 'Approve' || action === 'AcceptAi'));
  const ownerEntityId = needsDueToFrom ? await loadOwnerEntityId(body.groupId, run.qboid) : null;
  // Each other entity's Due To/From account (saved, else found by name).
  const dueToFrom = needsDueToFrom
    ? (await loadEffectiveDueToFrom(body.groupId, run.qboid, entities, ownerEntityId)).effective
    : new Map();
  if (action === 'Reclassify') target = await resolveAccount(body.groupId, run.qboid, body.account);
  if (action === 'DueToFrom') {
    if (!entityIds.has(body.counterpartyEntityId)) throw badRequest('counterpartyEntityId must be an active entity in this Group');
    if (body.counterpartyEntityId === ownerEntityId) {
      throw badRequest('This QBO file already belongs to that entity; choose another entity');
    }
    if (body.account) {
      // Used for these lines; saved as the default unless rememberAccount is false.
      target = await resolveAccount(body.groupId, run.qboid, body.account);
      saveMapping = body.rememberAccount !== false;
    } else {
      const mapped = dueToFrom.get(body.counterpartyEntityId);
      if (!mapped) throw badRequest(`Choose the Due To/From account for ${entityName(body.counterpartyEntityId)} in this file first`);
      target = { key: mapped.accountKey, code: mapped.code, name: mapped.name };
    }
  }

  const base = [body.groupId, run.runid, run.qboid];
  const columns = `s.LineId, s.Fingerprint, s.CurrentEntityId, s.SuggestedEntityId, s.SuggestedAction, s.SuggestedAccountCode,
              s.SuggestedAccountName, l.AccountCode, l.AccountName, l.Amount, v.WatchMode, (d.Fingerprint IS NOT NULL) AS decided,
              a.SuggestedAction AS AiAction, a.SuggestedEntityId AS AiEntityId, a.SuggestedAccountCode AS AiAccountCode,
              a.SuggestedAccountName AS AiAccountName`;
  let rows;
  if (byFilter) {
    const filters = parseFilters(body.filter);
    const where = buildFilterSql(filters, base.length + 1);
    ({ rows } = await query(`SELECT ${columns} ${QUEUE_FROM}${where.sql}`, [...base, ...where.params]));
    // The user confirmed a count; if the set changed since, stop.
    if (rows.length !== Number(body.expectedCount)) {
      throw badRequest(`The filtered lines changed (now ${rows.length}); refresh and try again`, 409);
    }
  } else {
    ({ rows } = await query(`SELECT ${columns} ${QUEUE_FROM} AND s.LineId = ANY($4::uuid[])`, [...base, body.lineIds]));
    if (rows.length !== new Set(body.lineIds).size) throw badRequest('Some lines are not in this review run', 404);
  }
  if (rows.length > MAX_DECISIONS_PER_REQUEST) throw badRequest(`At most ${MAX_DECISIONS_PER_REQUEST} lines per request`);

  const skipped = { alreadyDecided: 0, watchMode: 0, nothingToApply: 0, noDueToFromAccount: 0 };
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
    const lineKey = accountKey(r.accountcode || null, r.accountname);
    // What gets recorded for this line (null: nothing to apply).
    let d = null;
    if (action === 'Undo') {
      if (r.decided) d = { action };
    } else if (action === 'Split') {
      const problem = validateAllocations(body.allocations, r.amount, entityIds);
      if (problem) throw badRequest(problem);
      d = { action, allocations: body.allocations.map((a) => ({ entityId: a.entityId, amount: Math.round(Number(a.amount) * 100) / 100 })) };
    } else if (action === 'Reclassify' || action === 'DueToFrom') {
      if (lineKey !== target.key) d = { action, target, counterpartyEntityId: action === 'DueToFrom' ? body.counterpartyEntityId : null };
    } else if (kind === 'Account') {
      // Approve applies the engine's suggestion, AcceptAi the AI's.
      const sug = action === 'AcceptAi'
        ? { action: r.aiaction, entityId: r.aientityid, code: r.aiaccountcode, name: r.aiaccountname }
        : { action: r.suggestedaction, entityId: r.suggestedentityid, code: r.suggestedaccountcode, name: r.suggestedaccountname };
      const suggested = action === 'Keep' ? 'Keep' : sug.action;
      if (suggested === 'Keep') {
        d = { action: 'Keep' };
      } else if (suggested === 'Reclassify' && sug.name) {
        const key = accountKey(sug.code || null, sug.name);
        d = key === lineKey
          ? { action: 'Keep' }
          : { action: 'Reclassify', target: { key, code: sug.code || null, name: sug.name } };
      } else if (suggested === 'DueToFrom' && sug.entityId) {
        const mapped = dueToFrom.get(sug.entityId);
        if (!mapped) {
          skipped.noDueToFromAccount += 1;
          continue;
        }
        d = mapped.accountKey === lineKey
          ? { action: 'Keep' }
          : {
              action: 'DueToFrom',
              target: { key: mapped.accountKey, code: mapped.code, name: mapped.name },
              counterpartyEntityId: sug.entityId,
            };
      }
    } else if (action === 'AcceptAi') {
      // Class review: the AI's entity, recorded as an approval of it.
      if (r.aiaction === 'Assign' && r.aientityid && entityIds.has(r.aientityid)) d = { action: 'Approve', entityId: r.aientityid };
    } else {
      const entityId = decisionEntity(action, { currentEntityId: r.currententityid, suggestedEntityId: r.suggestedentityid }, body.entityId);
      if (entityId) d = { action, entityId };
    }
    if (!d) {
      skipped.nothingToApply += 1;
      continue;
    }
    const suggestionSource = action === 'AcceptAi' ? 'AI' : action === 'Approve' ? 'Engine' : null;
    decisions.push([
      body.groupId, run.qboid, r.fingerprint, r.lineid, run.runid, d.action, d.entityId || null,
      d.allocations ? JSON.stringify(d.allocations) : null, note, claims.userId,
      d.target ? d.target.code || null : null, d.target ? d.target.name : null, d.counterpartyEntityId || null, suggestionSource,
    ]);
  }

  await withTransaction(async (client) => {
    if (saveMapping) await saveDueToFrom(client, body.groupId, run.qboid, body.counterpartyEntityId, target, claims.userId);
    if (decisions.length) {
      await insertRows(
        client,
        'CtrlDecisions',
        [
          'GroupId', 'QBOId', 'Fingerprint', 'LineId', 'RunId', 'Action', 'EntityId', 'Allocations', 'Note', 'DecidedBy',
          'TargetAccountCode', 'TargetAccountName', 'CounterpartyEntityId', 'SuggestionSource',
        ],
        decisions
      );
    }
    await recordAudit(
      {
        groupId: body.groupId, userId: claims.userId, action: `ctrl.review.decision.${action.toLowerCase()}`,
        targetType: 'CtrlReviewRun', targetId: run.runid,
        details: {
          decided: decisions.length, skipped, byFilter, entityId: body.entityId || null,
          targetAccount: target ? { code: target.code, name: target.name } : undefined,
          counterpartyEntityId: body.counterpartyEntityId || undefined,
          dueToFromAccountSaved: saveMapping || undefined,
          lineIds: byFilter ? undefined : body.lineIds,
        },
      },
      client
    );
  });

  return json(200, { decided: decisions.length, skipped });
}

// POST /api/controller/review/evidence-search
//   { groupId, runId, lineIds } | { groupId, runId, filter, expectedCount }
// "Search All": searches the opted-in mailboxes for these lines in the
// background (ctrlEvidenceWorker), up to EVIDENCE_MAX_LINES, most money first.
async function handleEvidenceSearch(claims, body) {
  const run = await loadRun(body.groupId, body.runId);
  const base = [body.groupId, run.runid, run.qboid];
  let rows;
  if (body.filter) {
    const where = buildFilterSql(parseFilters(body.filter), base.length + 1);
    ({ rows } = await query(`SELECT s.LineId, ABS(l.Amount) AS amt ${QUEUE_FROM}${where.sql}`, [...base, ...where.params]));
    if (rows.length !== Number(body.expectedCount)) {
      throw badRequest(`The filtered lines changed (now ${rows.length}); refresh and try again`, 409);
    }
  } else {
    if (!Array.isArray(body.lineIds) || !body.lineIds.length || !body.lineIds.every(isUuid)) throw badRequest('lineIds (or filter) is required');
    ({ rows } = await query(`SELECT s.LineId, ABS(l.Amount) AS amt ${QUEUE_FROM} AND s.LineId = ANY($4::uuid[])`, [...base, body.lineIds]));
  }
  const { rows: sources } = await query(`SELECT 1 FROM CtrlGoogleSources WHERE GroupId = $1 AND Kind IN ('Mailbox', 'Folder') AND Enabled LIMIT 1`, [body.groupId]);
  if (!sources.length) throw badRequest('No mailbox or invoice folder is switched on yet (Controller → Google Workspace)', 409);
  if (!rows.length) throw badRequest('No lines to search', 409);

  const lineIds = rows
    .sort((a, b) => Number(b.amt) - Number(a.amt))
    .slice(0, EVIDENCE_MAX_LINES)
    .map((r) => r.lineid);
  const batches = chunk(lineIds, EVIDENCE_BATCH);
  const job = await withTransaction(async (client) => {
    const { rows: j } = await client.query(
      `INSERT INTO CtrlEvidenceJobs (GroupId, RunId, LineCount, CreatedBy) VALUES ($1, $2, $3, $4) RETURNING JobId`,
      [body.groupId, run.runid, lineIds.length, claims.userId]
    );
    const batchIds = [];
    for (const ids of batches) {
      const { rows: b } = await client.query(
        `INSERT INTO CtrlEvidenceBatches (JobId, GroupId, LineIds) VALUES ($1, $2, $3::uuid[]) RETURNING BatchId`,
        [j[0].jobid, body.groupId, ids]
      );
      batchIds.push(b[0].batchid);
    }
    await recordAudit(
      { groupId: body.groupId, userId: claims.userId, action: 'ctrl.evidence.searchall', targetType: 'CtrlReviewRun', targetId: run.runid, details: { lines: lineIds.length } },
      client
    );
    return { jobId: j[0].jobid, batchIds };
  });
  let failed;
  try {
    failed = await enqueueEvidenceBatches(job.batchIds);
  } catch (err) {
    console.error('Evidence enqueue failed:', err.message);
    failed = job.batchIds;
  }
  if (failed.length) {
    await query(`UPDATE CtrlEvidenceBatches SET Status = 'Failed', Error = 'Could not be queued', FinishedDate = now() WHERE BatchId = ANY($1::uuid[])`, [failed]);
  }
  return json(202, { jobId: job.jobId, lineCount: lineIds.length, skipped: rows.length - lineIds.length, batchCount: job.batchIds.length, failedToQueue: failed.length });
}

// GET /api/controller/review/accounts?groupId=&qboId=
// The file's accounts (for Reclassify) and its Due To/From accounts.
async function handleAccounts(groupId, qs) {
  if (!isUuid(qs.qboId)) throw badRequest('qboId is required');
  const { rows } = await query(`SELECT QBOId FROM QBOs WHERE QBOId = $1 AND GroupId = $2`, [qs.qboId, groupId]);
  if (!rows.length) throw badRequest('QBO not found for this Group', 404);
  const [accounts, ownerEntityId, entities] = await Promise.all([
    loadFileAccounts(groupId, qs.qboId),
    loadOwnerEntityId(groupId, qs.qboId),
    loadEntities(groupId),
  ]);
  const { saved, detected } = await loadEffectiveDueToFrom(groupId, qs.qboId, entities, ownerEntityId);
  const list = (map) => [...map].map(([entityId, a]) => ({ entityId, account: { code: a.code, name: a.name } }));
  return json(200, {
    ownerEntityId,
    accounts: accounts.map((a) => ({ code: a.code, name: a.name, type: a.type })),
    // Saved defaults, and accounts named "Due from/to <entity>" (used when
    // nothing is saved).
    dueToFrom: list(saved),
    detectedDueToFrom: list(detected),
  });
}

// PUT /api/controller/review/due-to-from
//   { groupId, qboId, counterpartyEntityId, account: { code?, name } | null }
// Sets (or, with account null, clears) which account in this file holds
// Due To/From counterpartyEntityId. Past decisions keep the account they used.
async function handleSaveDueToFrom(claims, body) {
  if (!isUuid(body.qboId)) throw badRequest('qboId is required');
  const { rows } = await query(`SELECT QBOId FROM QBOs WHERE QBOId = $1 AND GroupId = $2`, [body.qboId, body.groupId]);
  if (!rows.length) throw badRequest('QBO not found for this Group', 404);
  const entities = await loadEntities(body.groupId);
  if (!entities.some((e) => e.entityId === body.counterpartyEntityId)) {
    throw badRequest('counterpartyEntityId must be an active entity in this Group');
  }
  if (body.counterpartyEntityId === (await loadOwnerEntityId(body.groupId, body.qboId))) {
    throw badRequest('This QBO file belongs to that entity');
  }
  const account = body.account ? await resolveAccount(body.groupId, body.qboId, body.account) : null;
  await withTransaction(async (client) => {
    if (account) {
      await saveDueToFrom(client, body.groupId, body.qboId, body.counterpartyEntityId, account, claims.userId);
    } else {
      await client.query(
        `DELETE FROM CtrlDueToFromAccounts WHERE GroupId = $1 AND QBOId = $2 AND CounterpartyEntityId = $3`,
        [body.groupId, body.qboId, body.counterpartyEntityId]
      );
    }
    await recordAudit(
      {
        groupId: body.groupId, userId: claims.userId, action: 'ctrl.review.duetofrom', targetType: 'QBO', targetId: body.qboId,
        details: { counterpartyEntityId: body.counterpartyEntityId, account: account ? { code: account.code, name: account.name } : null },
      },
      client
    );
  });
  return json(200, {
    counterpartyEntityId: body.counterpartyEntityId,
    account: account ? { code: account.code, name: account.name } : null,
  });
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
    if (resource.endsWith('/accounts')) return handleAccounts(qs.groupId, qs);
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
      `INSERT INTO CtrlReviewSettings (GroupId, Threshold, MediumThreshold, HistoryMonths, UpdatedBy,
         SplitShiftPoints, SpikePercent, SpikeMinAmount, RecurringMonths, BaselineMonths,
         AiEnabled, AiConfidenceCap, AiMonthlyBudget, AiRedactPatientInfo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (GroupId) DO UPDATE SET Threshold = EXCLUDED.Threshold, MediumThreshold = EXCLUDED.MediumThreshold,
         HistoryMonths = EXCLUDED.HistoryMonths, UpdatedBy = EXCLUDED.UpdatedBy, LastUpdated = now(),
         SplitShiftPoints = EXCLUDED.SplitShiftPoints, SpikePercent = EXCLUDED.SpikePercent,
         SpikeMinAmount = EXCLUDED.SpikeMinAmount, RecurringMonths = EXCLUDED.RecurringMonths,
         BaselineMonths = EXCLUDED.BaselineMonths, AiEnabled = EXCLUDED.AiEnabled, AiConfidenceCap = EXCLUDED.AiConfidenceCap,
         AiMonthlyBudget = EXCLUDED.AiMonthlyBudget, AiRedactPatientInfo = EXCLUDED.AiRedactPatientInfo`,
      [
        body.groupId, settings.threshold, settings.mediumThreshold, settings.historyMonths, claims.userId,
        settings.splitShiftPoints, settings.spikePercent, settings.spikeMinAmount, settings.recurringMonths, settings.baselineMonths,
        settings.aiEnabled, settings.aiConfidenceCap, settings.aiMonthlyBudget, settings.aiRedactPatientInfo,
      ]
    );
    await recordAudit({ groupId: body.groupId, userId: claims.userId, action: 'ctrl.review.settings', details: settings });
    return json(200, settings);
  }
  if (httpMethod === 'POST' && resource.endsWith('/decisions')) return handleDecisions(claims, body);
  if (httpMethod === 'POST' && resource.endsWith('/evidence-search')) return handleEvidenceSearch(claims, body);
  if (httpMethod === 'PUT' && resource.endsWith('/due-to-from')) return handleSaveDueToFrom(claims, body);
  throw badRequest('Unknown review route', 404);
});

exports.parseFilters = parseFilters;
exports.buildFilterSql = buildFilterSql;
exports.validateSettings = validateSettings;
exports.shiftMonth = shiftMonth;
