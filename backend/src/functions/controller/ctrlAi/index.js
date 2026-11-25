// Controller Phase 3: AI matching jobs and usage.
//
//   GET  /api/controller/ai/status?groupId=&runId=   the run's latest AI pass
//   POST /api/controller/ai/jobs                     start a job:
//        { kind: 'Review', runId }                    (re)run the AI pass on lines
//                                                     without an AI answer yet
//        { kind: 'RuleTest', vendorId, ruleText, qboId?, months? }
//        { kind: 'Backtest', qboId, month? }          re-ask up to 50 decided lines
//   GET  /api/controller/ai/jobs/{jobId}?groupId=    progress, and the results of
//                                                     a RuleTest / Backtest
//   GET  /api/controller/ai/usage?groupId=           spend, budget, agree rate
//
// The AI only suggests; nothing here records a decision or touches
// QuickBooks.
const { authorizeController } = require('../../../shared/controllerAuth');
const { requireGroupAccess } = require('../../../shared/authorize');
const { query, withTransaction } = require('../../../shared/db');
const { json, withErrorHandling } = require('../../../shared/response');
const { recordAudit } = require('../../../shared/audit');
const { buildEntityResolver } = require('../../../shared/reviewEngine');
const { packBatches, aiOutcomeKey, decisionOutcomeKey, AI_ACCOUNT_TYPES } = require('../../../shared/aiMatcher');
const { monthSpend, createJob, queueBatches, startReviewAiJob, jobStatus, aiAgreement, liveDecision } = require('../../../shared/ctrlAiJobs');
const {
  badRequest,
  isUuid,
  shiftMonth,
  loadSettings,
  loadEntities,
  loadRun,
  loadRules,
  loadVendorKeys,
  loadStoredLines,
  loadStoredMonths,
} = require('../../../shared/ctrlReviewData');

const RULE_TEST_MAX_LINES = 40;
const BACKTEST_LINES = 50;
const MAX_RULE_TEXT = 4000;

const latestMonth = (months) => [...months].sort().pop() || null;

// The line's current outcome as an outcome key (its decision, else the
// QuickBooks class / its account as it is).
function currentOutcomeKey(kind, line, resolve) {
  const currentEntityId = kind === 'Class' ? resolve(line.className, line.qboClassId) : null;
  const d = liveDecision(line.decision);
  if (d) return d.action === 'Split' ? 'split' : decisionOutcomeKey(kind, d, currentEntityId);
  if (kind === 'Class') return currentEntityId ? `entity:${currentEntityId}` : null;
  return 'keep';
}

// ---- Status of a run's AI pass

async function handleStatus(groupId, qs) {
  const run = await loadRun(groupId, qs.runId);
  const settings = await loadSettings(groupId);
  const { rows } = await query(
    `SELECT JobId FROM CtrlAiJobs WHERE GroupId = $1 AND RunId = $2 AND Kind = 'Review' ORDER BY CreatedDate DESC LIMIT 1`,
    [groupId, run.runid]
  );
  const { rows: answered } = await query(
    `SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE SuggestedAction <> 'Unsure')::int AS suggested
     FROM CtrlAiSuggestions WHERE RunId = $1 AND GroupId = $2`,
    [run.runid, groupId]
  );
  const { spend } = await monthSpend(groupId);
  return json(200, {
    enabled: settings.aiEnabled,
    confidenceCap: settings.aiConfidenceCap,
    monthSpend: spend,
    monthlyBudget: settings.aiMonthlyBudget,
    answered: answered[0].n,
    suggested: answered[0].suggested,
    job: rows.length ? await jobStatus(groupId, rows[0].jobid) : null,
  });
}

// ---- Starting jobs

async function startReview(claims, body) {
  const run = await loadRun(body.groupId, body.runId);
  const settings = await loadSettings(body.groupId);
  const rules = await loadRules({ query }, body.groupId);
  const result = await startReviewAiJob({
    groupId: body.groupId,
    run: { runId: run.runid, qboId: run.qboid },
    settings,
    rules,
    userId: claims.userId,
    onlyMissing: true,
  });
  if (result.skipped) throw badRequest(result.skipped, 409);
  await recordAudit({
    groupId: body.groupId, userId: claims.userId, action: 'ctrl.ai.start', targetType: 'CtrlReviewRun', targetId: run.runid,
    details: { kind: 'Review', ...result },
  });
  return json(202, result);
}

async function startRuleTest(claims, body) {
  if (!isUuid(body.vendorId)) throw badRequest('vendorId is required');
  const ruleText = typeof body.ruleText === 'string' ? body.ruleText.trim() : '';
  if (!ruleText) throw badRequest('Write the rule to test first');
  if (ruleText.length > MAX_RULE_TEXT) throw badRequest(`The rule is too long (at most ${MAX_RULE_TEXT} characters)`);
  const months = body.months === undefined ? 3 : Number(body.months);
  if (!Number.isInteger(months) || months < 1 || months > 12) throw badRequest('months must be from 1 to 12');

  const { rows: v } = await query(`SELECT VendorId FROM CtrlVendors WHERE VendorId = $1 AND GroupId = $2`, [body.vendorId, body.groupId]);
  if (!v.length) throw badRequest('Vendor not found', 404);
  const vendorKeys = await loadVendorKeys(body.groupId);
  const payeeKeys = [...vendorKeys].filter(([, x]) => x.vendorId === body.vendorId).map(([k]) => k);
  if (!payeeKeys.length) throw badRequest('This vendor has no lines yet');

  const stored = await loadStoredMonths(body.groupId);
  const toMonth = latestMonth([...stored.values()].flatMap((s) => [...s]));
  if (!toMonth) throw badRequest('No General Ledger is stored yet');
  const lines = await loadStoredLines({ groupId: body.groupId, fromMonth: shiftMonth(toMonth, -(months - 1)), toMonth, payeeKeys });
  // The file named, else the one with most of this vendor's lines.
  const count = new Map();
  for (const l of lines) count.set(l.qboId, (count.get(l.qboId) || 0) + 1);
  const qboId = body.qboId || [...count].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (body.qboId && !isUuid(body.qboId)) throw badRequest('qboId is not valid');
  const picked = lines
    .filter((l) => l.qboId === qboId && AI_ACCOUNT_TYPES.includes(l.accountType))
    .sort((a, b) => b.txnDate.localeCompare(a.txnDate) || Math.abs(b.amount) - Math.abs(a.amount))
    .slice(0, RULE_TEST_MAX_LINES);
  if (!picked.length) throw badRequest(`No lines for this vendor in the last ${months} month(s)`);

  return startJob(claims, body.groupId, {
    kind: 'RuleTest', vendorId: body.vendorId, qboId,
    params: { ruleText, months },
    batches: packBatches(picked.map((l) => ({ lineId: l.lineId, groupKey: 'vendor' }))),
  });
}

async function startBacktest(claims, body) {
  if (!isUuid(body.qboId)) throw badRequest('qboId is required');
  const { rows: q } = await query(`SELECT QBOId FROM QBOs WHERE QBOId = $1 AND GroupId = $2`, [body.qboId, body.groupId]);
  if (!q.length) throw badRequest('QBO not found for this Group', 404);
  // The month asked for, else the latest month with decided lines.
  let month = body.month;
  if (!month) {
    const { rows } = await query(
      `SELECT TO_CHAR(MAX(sn.Period), 'YYYY-MM') AS month FROM CtrlDecisions d
       JOIN CtrlLedgerLines l ON l.LineId = d.LineId JOIN CtrlSnapshots sn ON sn.SnapshotId = l.SnapshotId
       WHERE d.GroupId = $1 AND d.QBOId = $2 AND d.Scope = 'Line' AND d.Action NOT IN ('Undo', 'Split')`,
      [body.groupId, body.qboId]
    );
    month = rows[0]?.month;
  }
  if (!month || !/^\d{4}-\d{2}$/.test(month)) throw badRequest('No decided lines to check against yet');
  const lines = (await loadStoredLines({ groupId: body.groupId, fromMonth: month, toMonth: month, qboIds: [body.qboId] }))
    .filter((l) => {
      const d = liveDecision(l.decision);
      return d && d.action !== 'Split' && d.scope === 'Line' && AI_ACCOUNT_TYPES.includes(l.accountType);
    })
    // A fixed, spread-out sample: ordered by fingerprint (a hash).
    .sort((a, b) => a.fingerprint.localeCompare(b.fingerprint))
    .slice(0, BACKTEST_LINES);
  if (!lines.length) throw badRequest(`No decided lines in ${month}`);
  return startJob(claims, body.groupId, {
    kind: 'Backtest', qboId: body.qboId,
    params: { month },
    batches: packBatches(lines.map((l) => ({ lineId: l.lineId, groupKey: l.payeeKey ? `v:${l.payeeKey}` : `a:${l.accountCode || l.accountName}` }))),
  });
}

async function startJob(claims, groupId, spec) {
  const settings = await loadSettings(groupId);
  const { spend } = await monthSpend(groupId);
  if (spend >= settings.aiMonthlyBudget) throw badRequest("This month's AI budget has been reached (Review → Settings)", 409);
  const job = await withTransaction((client) => createJob(client, { groupId, ...spec, userId: claims.userId }));
  const failed = await queueBatches(job.batchIds);
  await recordAudit({
    groupId, userId: claims.userId, action: 'ctrl.ai.start', targetType: 'CtrlAiJob', targetId: job.jobId,
    details: { kind: spec.kind, vendorId: spec.vendorId, qboId: spec.qboId, lineCount: job.lineCount, failedToQueue: failed.length },
  });
  return json(202, { jobId: job.jobId, kind: spec.kind, lineCount: job.lineCount, batchCount: job.batchIds.length, failedToQueue: failed.length });
}

// ---- A job's progress and results

async function handleJob(groupId, jobId) {
  if (!isUuid(jobId)) throw badRequest('Job not found', 404);
  const status = await jobStatus(groupId, jobId);
  if (!status) throw badRequest('Job not found', 404);
  if (status.kind === 'Review') return json(200, status);

  const { rows: batches } = await query(`SELECT Result FROM CtrlAiBatches WHERE JobId = $1 AND Status = 'Succeeded'`, [jobId]);
  const answers = new Map();
  let kind = null;
  for (const b of batches) {
    kind = b.result?.kind || kind;
    for (const a of b.result?.answers || []) answers.set(a.lineId, a);
  }
  const entities = await loadEntities(groupId);
  const resolve = buildEntityResolver(entities);
  const months = status.kind === 'Backtest' ? [status.params.month, status.params.month] : null;
  const lineIds = [...answers.keys()];
  let lines = [];
  if (lineIds.length) {
    const { rows } = await query(
      `SELECT MIN(TO_CHAR(sn.Period, 'YYYY-MM')) AS a, MAX(TO_CHAR(sn.Period, 'YYYY-MM')) AS b FROM CtrlLedgerLines l
       JOIN CtrlSnapshots sn ON sn.SnapshotId = l.SnapshotId WHERE l.LineId = ANY($1::uuid[]) AND l.GroupId = $2`,
      [lineIds, groupId]
    );
    const [from, to] = months || [rows[0].a, rows[0].b];
    const wanted = new Set(lineIds);
    lines = (await loadStoredLines({ groupId, fromMonth: from, toMonth: to, qboIds: [status.qboId] })).filter((l) => wanted.has(l.lineId));
  }

  const results = lines.map((l) => {
    const a = answers.get(l.lineId);
    const current = currentOutcomeKey(kind, l, resolve);
    const ai = aiOutcomeKey(a);
    return {
      lineId: l.lineId,
      month: l.month,
      txnDate: l.txnDate,
      payeeName: l.payeeName,
      memo: l.memo,
      accountCode: l.accountCode,
      accountName: l.accountName,
      amount: l.amount,
      current,
      currentEntityId: kind === 'Class' ? resolve(l.className, l.qboClassId) : null,
      decided: Boolean(liveDecision(l.decision)),
      ai: { action: a.action, entityId: a.entityId, account: a.account, confidence: a.rawConfidence, reason: a.reason, usedRule: a.usedRule },
      aiOutcome: ai,
      matches: ai !== null && ai === current,
    };
  });
  results.sort((x, y) => Number(x.matches) - Number(y.matches) || y.txnDate.localeCompare(x.txnDate));

  const answeredSure = results.filter((r) => r.aiOutcome !== null);
  const summary = {
    lines: results.length,
    unsure: results.length - answeredSure.length,
    agree: answeredSure.filter((r) => r.matches).length,
    disagree: answeredSure.filter((r) => !r.matches).length,
  };
  // How often the AI is right at each confidence level (calibration).
  if (status.kind === 'Backtest') {
    const band = (c) => (c >= 0.9 ? 'High' : c >= 0.7 ? 'Medium' : 'Low');
    summary.byConfidence = ['High', 'Medium', 'Low'].map((level) => {
      const inBand = answeredSure.filter((r) => band(r.ai.confidence) === level);
      return { level, lines: inBand.length, agree: inBand.filter((r) => r.matches).length };
    });
  }
  return json(200, { ...status, reviewKind: kind, entities: entities.map((e) => ({ entityId: e.entityId, entityName: e.entityName })), summary, results });
}

// ---- Usage: spend and how often Paul agreed with the AI

async function handleUsage(groupId) {
  const settings = await loadSettings(groupId);
  const { spend, calls } = await monthSpend(groupId);
  const { rows: months } = await query(
    `SELECT TO_CHAR(date_trunc('month', CreatedDate), 'YYYY-MM') AS month, COALESCE(SUM(CostUsd), 0) AS cost, COUNT(*)::int AS calls,
            COALESCE(SUM(LineCount), 0)::int AS lines
     FROM CtrlAiCalls WHERE GroupId = $1 AND CreatedDate >= date_trunc('month', now()) - interval '5 months'
     GROUP BY 1 ORDER BY 1`,
    [groupId]
  );
  return json(200, {
    enabled: settings.aiEnabled,
    confidenceCap: settings.aiConfidenceCap,
    monthlyBudget: settings.aiMonthlyBudget,
    redactPatientInfo: settings.aiRedactPatientInfo,
    monthSpend: spend,
    monthCalls: calls,
    months: months.map((m) => ({ month: m.month, costUsd: Number(m.cost), calls: m.calls, lines: m.lines })),
    agreement: await aiAgreement(groupId),
  });
}

exports.handler = withErrorHandling(async (event) => {
  const claims = await authorizeController(event);
  const { resource, httpMethod } = event;
  if (httpMethod === 'GET') {
    const qs = event.queryStringParameters || {};
    if (!qs.groupId) throw badRequest('groupId is required');
    requireGroupAccess(claims, qs.groupId);
    if (resource.endsWith('/status')) return handleStatus(qs.groupId, qs);
    if (resource.endsWith('/usage')) return handleUsage(qs.groupId);
    if (resource.endsWith('/{jobId}')) return handleJob(qs.groupId, event.pathParameters?.jobId);
    throw badRequest('Unknown AI route', 404);
  }
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    throw badRequest('Request body must be JSON');
  }
  if (!body.groupId) throw badRequest('groupId is required');
  requireGroupAccess(claims, body.groupId);
  if (httpMethod === 'POST' && resource.endsWith('/jobs')) {
    if (body.kind === 'Review') return startReview(claims, body);
    if (body.kind === 'RuleTest') return startRuleTest(claims, body);
    if (body.kind === 'Backtest') return startBacktest(claims, body);
    throw badRequest('kind must be Review, RuleTest or Backtest');
  }
  throw badRequest('Unknown AI route', 404);
});

exports.currentOutcomeKey = currentOutcomeKey;
