// Controller Phase 3: the AI queue worker. One SQS message ({ batchId }) is
// one model call: it loads the batch's lines and their context (entities,
// accounts, the vendors' written rules, Paul's recent decisions and the
// past split), asks Claude on Amazon Bedrock, checks the answer and stores
// it. It reads QuickBooks data already stored by the Controller; it never
// calls QuickBooks and never writes to it, and it never records a decision.
const { query } = require('../../../shared/db');
const { insertRows } = require('../../../shared/bulkInsert');
const { accountKey } = require('../../../shared/accountKey');
const { payeeKey, buildEntityResolver } = require('../../../shared/reviewEngine');
const { buildPrompt, parseAnswers, groupKeyOf, AI_ACCOUNT_TYPES } = require('../../../shared/aiMatcher');
const { classify, isRetryable } = require('../../../shared/bedrock');
const { monthSpend } = require('../../../shared/ctrlAiJobs');
const {
  loadSettings,
  loadEntities,
  loadRules,
  loadVendorKeys,
  loadHistoryRows,
  loadAccountHistoryRows,
  loadFileAccounts,
  loadOwnerEntityId,
  loadEffectiveDueToFrom,
  loadAccountTypes,
  payeeKeySql,
} = require('../../../shared/ctrlReviewData');

// Must match maxReceiveCount on the queue's redrive policy (template.yaml).
const MAX_ATTEMPTS = 3;
const MAX_ERROR_LENGTH = 1000;
const EXAMPLES_PER_GROUP = 10;
const db = { query };

const SUGGESTION_COLUMNS = [
  'RunId', 'GroupId', 'LineId', 'JobId', 'SuggestedAction', 'SuggestedEntityId', 'SuggestedAccountCode', 'SuggestedAccountName',
  'Confidence', 'RawConfidence', 'Reason', 'UsedRule', 'Redacted', 'Model',
];

const describeError = (err) => `${err?.status ? `HTTP ${err.status}: ` : ''}${err?.message || 'Unknown error'}`.slice(0, MAX_ERROR_LENGTH);

// ---- Pure helpers (exported for tests)

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// "Milford 14 lines, Lebanon 2 lines" from { label: count }, biggest first.
function tallyText(tally, months) {
  const parts = Object.entries(tally)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([label, n]) => `${label} ${plural(n, 'line')}`);
  return parts.length ? `over the previous ${months} months: ${parts.join(', ')}` : null;
}

// Class review: how a group's earlier lines were split by entity (Paul's
// decision where he made one, else the QuickBooks class).
//   rows: loadHistoryRows output; matches(row) picks the group's rows
function classHistoryText(rows, matches, entities, months) {
  const resolve = buildEntityResolver(entities);
  const name = (id) => entities.find((e) => e.entityId === id)?.entityName || 'a former entity';
  const tally = {};
  for (const r of rows.filter(matches)) {
    let label;
    if (r.action === 'Split') label = 'split between entities';
    else if (['Approve', 'Keep', 'Reassign'].includes(r.action) && r.decisionentityid) label = name(r.decisionentityid);
    else {
      const id = resolve(r.classname, r.qboclassid);
      label = id ? name(id) : r.classname ? `class "${r.classname}" (not linked to an entity)` : 'no class';
    }
    tally[label] = (tally[label] || 0) + r.n;
  }
  return tallyText(tally, months);
}

// Account review: which account a group's earlier lines ended up in.
function accountHistoryText(rows, matches, months) {
  const label = (code, accName) => [code, accName].filter(Boolean).join(' ') || '(no account)';
  const tally = {};
  for (const r of rows.filter(matches)) {
    const moved = ['Reclassify', 'DueToFrom'].includes(r.action) && r.targetaccountname;
    const l = moved ? label(r.targetaccountcode, r.targetaccountname) : label(r.accountcode, r.accountname);
    tally[l] = (tally[l] || 0) + r.n;
  }
  return tallyText(tally, months);
}

// A stored decision as an example outcome for buildPrompt.
function exampleOutcome(kind, d) {
  if (kind === 'Class') {
    if (d.action === 'Split') {
      const total = (d.allocations || []).reduce((s, a) => s + Math.abs(Number(a.amount) || 0), 0);
      return total ? { split: d.allocations.map((a) => ({ entityId: a.entityId, share: Math.abs(Number(a.amount) || 0) / total })) } : null;
    }
    return d.entityid ? { entityId: d.entityid } : null;
  }
  if (d.action === 'Keep' || d.action === 'Approve') return { keep: true };
  if (d.action === 'DueToFrom' && d.counterpartyentityid) return { dueEntityId: d.counterpartyentityid };
  if (d.action === 'Reclassify' && d.targetaccountname) return { accountKey: accountKey(d.targetaccountcode || null, d.targetaccountname) };
  return null;
}

// A vendor's structured rule, in words.
function ruleNote(rule, entities) {
  if (!rule) return null;
  const name = (id) => entities.find((e) => e.entityId === id)?.entityName || 'a former entity';
  const bits = [];
  if (rule.defaultEntityId) bits.push(`defaults to ${name(rule.defaultEntityId)}`);
  for (const k of rule.hints?.keywords || []) if (k.keyword && k.entityId) bits.push(`"${k.keyword}" means ${name(k.entityId)}`);
  return bits.length ? bits.join('; ') : null;
}

// ---- Database

// Atomically marks the batch Running. Returns null when there's nothing to
// do (already finished, or gone), which makes SQS redeliveries harmless.
async function claimBatch(batchId) {
  const { rows } = await query(
    `UPDATE CtrlAiBatches b SET Status = 'Running', Attempts = b.Attempts + 1, StartedDate = now(), Error = NULL
     FROM CtrlAiJobs j
     WHERE b.BatchId = $1 AND b.Status IN ('Queued', 'Running') AND j.JobId = b.JobId
     RETURNING b.BatchId, b.JobId, b.GroupId, b.LineIds, b.Attempts, j.Kind, j.RunId, j.VendorId, j.QBOId, j.Params`,
    [batchId]
  );
  return rows[0] || null;
}

async function finishBatch(batchId, status, { error = null, result = null } = {}) {
  await query(
    `UPDATE CtrlAiBatches SET Status = $2, Error = $3, Result = $4, FinishedDate = now() WHERE BatchId = $1`,
    [batchId, status, error ? String(error).slice(0, MAX_ERROR_LENGTH) : null, result ? JSON.stringify(result) : null]
  );
}

async function logCall(batch, lineCount, call, error) {
  const u = call?.usage || {};
  await query(
    `INSERT INTO CtrlAiCalls (GroupId, JobId, BatchId, Model, LineCount, InputTokens, CacheReadTokens, CacheWriteTokens, OutputTokens,
       CostUsd, DurationMs, StopReason, Error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      batch.groupid, batch.jobid, batch.batchid, call?.model || process.env.AI_MODEL_ID || 'unknown', lineCount,
      u.input_tokens || 0, u.cache_read_input_tokens || 0, u.cache_creation_input_tokens || 0, u.output_tokens || 0,
      call?.costUsd || 0, call?.durationMs || 0, call?.stopReason || null, error ? String(error).slice(0, MAX_ERROR_LENGTH) : null,
    ]
  );
}

// The batch's lines, with the month each belongs to and (review jobs) the
// engine's note.
async function loadBatchLines(batch) {
  const { rows } = await query(
    `SELECT l.LineId, l.Fingerprint, l.QBOId, TO_CHAR(l.TxnDate, 'YYYY-MM-DD') AS TxnDate, l.TxnType, l.DocNum, l.PayeeName, l.Memo,
            l.AccountCode, l.AccountName, l.ClassName, l.QBOClassId, l.Amount, TO_CHAR(sn.Period, 'YYYY-MM') AS Month,
            s.Status, s.Reasons, s.VendorId AS SuggestionVendorId
     FROM CtrlLedgerLines l
     JOIN CtrlSnapshots sn ON sn.SnapshotId = l.SnapshotId
     LEFT JOIN CtrlSuggestions s ON s.RunId = $3 AND s.LineId = l.LineId
     WHERE l.LineId = ANY($1::uuid[]) AND l.GroupId = $2`,
    [batch.lineids, batch.groupid, batch.runid]
  );
  return rows;
}

// Paul's latest decision on earlier lines of the batch's vendors (or, for
// lines without a payee, accounts), newest first. The batch's own lines
// are left out, so a backtest never sees its answers.
async function loadExamples(batch, qboId, payeeKeys, accountKeys, excludeFingerprints) {
  const { rows } = await query(
    `SELECT * FROM (
       SELECT DISTINCT ON (d.Fingerprint) d.Fingerprint, d.Action, d.EntityId, d.Allocations, d.TargetAccountCode, d.TargetAccountName,
              d.CounterpartyEntityId, d.DecidedAt, l.PayeeName, l.Memo, l.AccountCode, l.AccountName, l.TxnType, l.Amount,
              TO_CHAR(l.TxnDate, 'YYYY-MM-DD') AS TxnDate, ${payeeKeySql('l.PayeeName')} AS PKey,
              CASE WHEN COALESCE(l.AccountCode, '') <> '' THEN 'code:' || l.AccountCode
                   ELSE 'name:' || lower(COALESCE(l.AccountName, '')) END AS AKey
       FROM CtrlDecisions d JOIN CtrlLedgerLines l ON l.LineId = d.LineId
       WHERE d.GroupId = $1 AND d.QBOId = $2
         AND (${payeeKeySql('l.PayeeName')} = ANY($3::text[])
              OR (${payeeKeySql('l.PayeeName')} IS NULL
                  AND (CASE WHEN COALESCE(l.AccountCode, '') <> '' THEN 'code:' || l.AccountCode
                            ELSE 'name:' || lower(COALESCE(l.AccountName, '')) END) = ANY($4::text[])))
       ORDER BY d.Fingerprint, d.DecidedAt DESC
     ) x
     WHERE x.Action <> 'Undo' AND NOT (x.Fingerprint = ANY($5::text[]))
     ORDER BY x.DecidedAt DESC
     LIMIT 500`,
    [batch.groupid, qboId, payeeKeys, accountKeys, excludeFingerprints]
  );
  return rows;
}

// Everything buildPrompt needs for one batch.
async function buildContext(batch, settings) {
  const lineRows = await loadBatchLines(batch);
  if (!lineRows.length) return null;
  const qboId = batch.qboid || lineRows[0].qboid;
  const { rows: qboRows } = await query(`SELECT IsClassBased FROM QBOs WHERE QBOId = $1 AND GroupId = $2`, [qboId, batch.groupid]);
  if (!qboRows.length) return null;
  const kind = qboRows[0].isclassbased ? 'Class' : 'Account';

  const [entities, rules, vendorKeys] = await Promise.all([loadEntities(batch.groupid), loadRules(db, batch.groupid), loadVendorKeys(batch.groupid)]);
  const resolve = buildEntityResolver(entities);
  const params = batch.params || {};
  if (batch.kind === 'RuleTest') {
    // The draft rule stands in for the saved one.
    const saved = rules.get(batch.vendorid) || {};
    rules.set(batch.vendorid, { ...saved, ruleText: params.ruleText || null });
  }

  const vendorOf = (r) => r.suggestionvendorid || vendorKeys.get(payeeKey(r.payeename))?.vendorId || null;
  const lines = lineRows.map((r) => {
    const line = {
      lineId: r.lineid,
      fingerprint: r.fingerprint,
      vendorId: vendorOf(r),
      txnDate: r.txndate,
      txnType: r.txntype,
      docNum: r.docnum,
      payeeName: r.payeename,
      memo: r.memo,
      accountCode: r.accountcode,
      accountName: r.accountname,
      className: r.classname,
      amount: Number(r.amount),
      currentEntityId: kind === 'Class' ? resolve(r.classname, r.qboclassid) : null,
      engineNote: batch.kind === 'Review' && r.status ? [r.status, ...(r.reasons || [])].join('; ') : null,
      month: r.month,
    };
    line.groupKey = groupKeyOf(line);
    return line;
  });

  // Payee keys per vendor (all its aliases), for examples and history.
  const keysByVendor = new Map();
  for (const [key, v] of vendorKeys) {
    if (!keysByVendor.has(v.vendorId)) keysByVendor.set(v.vendorId, []);
    keysByVendor.get(v.vendorId).push(key);
  }
  const groupKeys = [...new Set(lines.map((l) => l.groupKey))];
  const vendorIds = groupKeys.filter((k) => k.startsWith('v:')).map((k) => k.slice(2));
  const accountKeys = groupKeys.filter((k) => k.startsWith('a:')).map((k) => k.slice(2));
  const payeeKeys = vendorIds.flatMap((id) => keysByVendor.get(id) || []);
  const payeeToVendor = new Map(vendorIds.flatMap((id) => (keysByVendor.get(id) || []).map((k) => [k, id])));

  // History window: the months before the earliest line's month.
  const month = params.month || lines.map((l) => l.month).sort()[0];
  const historyMonths = settings.historyMonths;
  const [examples, historyRows] = await Promise.all([
    loadExamples(batch, qboId, payeeKeys, accountKeys, lines.map((l) => l.fingerprint)),
    kind === 'Class'
      ? loadHistoryRows(db, batch.groupid, qboId, month, historyMonths)
      : loadAccountHistoryRows(db, batch.groupid, qboId, month, historyMonths),
  ]);

  // History and examples come from the P&L side only, like the lines asked
  // about (a vendor's bank / card lines would just add noise).
  const types = await loadAccountTypes(batch.groupid, qboId);
  const isPl = (code, name) => AI_ACCOUNT_TYPES.includes(types.get(accountKey(code || null, name || '')) || 'Unknown');
  const exampleGroup = (x) => {
    if (!isPl(x.accountcode, x.accountname)) return null;
    return x.pkey ? (payeeToVendor.has(x.pkey) ? `v:${payeeToVendor.get(x.pkey)}` : null) : `a:${x.akey}`;
  };
  const rowMatches = (groupKey) => (r) => {
    if (!isPl(r.accountcode, r.accountname)) return false;
    const k = payeeKey(r.payeename);
    if (groupKey.startsWith('v:')) return Boolean(k) && payeeToVendor.get(k) === groupKey.slice(2);
    return !k && accountKey(r.accountcode || null, r.accountname || '') === groupKey.slice(2);
  };

  const vendorNames = new Map([...vendorKeys.values()].map((v) => [v.vendorId, v.displayName]));
  const groups = groupKeys.map((key) => {
    const first = lines.find((l) => l.groupKey === key);
    const isVendor = key.startsWith('v:');
    const rule = isVendor ? rules.get(key.slice(2)) : null;
    return {
      key,
      vendorName: isVendor ? vendorNames.get(key.slice(2)) || first.payeeName : null,
      accountLabel: isVendor ? null : [first.accountCode, first.accountName].filter(Boolean).join(' '),
      ruleText: rule?.ruleText || null,
      ruleNote: ruleNote(rule, entities),
      history:
        kind === 'Class'
          ? classHistoryText(historyRows, rowMatches(key), entities, historyMonths)
          : accountHistoryText(historyRows, rowMatches(key), historyMonths),
      examples: examples
        .filter((x) => exampleGroup(x) === key)
        .slice(0, EXAMPLES_PER_GROUP)
        .map((x) => ({
          txnDate: x.txndate,
          txnType: x.txntype,
          payeeName: x.payeename,
          memo: x.memo,
          accountCode: x.accountcode,
          accountName: x.accountname,
          amount: Number(x.amount),
          outcome: exampleOutcome(kind, {
            action: x.action,
            entityid: x.entityid,
            allocations: x.allocations,
            targetaccountcode: x.targetaccountcode,
            targetaccountname: x.targetaccountname,
            counterpartyentityid: x.counterpartyentityid,
          }),
        }))
        .filter((x) => x.outcome),
    };
  });

  let ownerEntityId = null;
  let accounts = [];
  let dueToFrom = new Map();
  if (kind === 'Account') {
    ownerEntityId = await loadOwnerEntityId(batch.groupid, qboId);
    accounts = await loadFileAccounts(batch.groupid, qboId);
    dueToFrom = (await loadEffectiveDueToFrom(batch.groupid, qboId, entities, ownerEntityId)).effective;
  }
  return { kind, qboId, entities, ownerEntityId, accounts, dueToFrom, groups, lines };
}

// ---- One batch

async function processBatch(batchId) {
  const batch = await claimBatch(batchId);
  if (!batch) return { batchId, status: 'Skipped (nothing to do)' };
  const lastAttempt = batch.attempts >= MAX_ATTEMPTS;

  const settings = await loadSettings(batch.groupid);
  if (batch.kind === 'Review' && !settings.aiEnabled) {
    await finishBatch(batchId, 'Skipped', { error: 'AI matching was turned off in Review settings' });
    return { batchId, status: 'Skipped' };
  }
  const { spend } = await monthSpend(batch.groupid);
  if (spend >= settings.aiMonthlyBudget) {
    await finishBatch(batchId, 'Skipped', { error: `This month's AI budget ($${settings.aiMonthlyBudget}) has been reached` });
    return { batchId, status: 'Skipped' };
  }

  const ctx = await buildContext(batch, settings);
  if (!ctx) {
    await finishBatch(batchId, 'Failed', { error: 'The lines or their QBO file no longer exist' });
    return { batchId, status: 'Failed' };
  }
  const prompt = buildPrompt({ ...ctx, redact: settings.aiRedactPatientInfo });

  let call;
  try {
    call = await classify(prompt);
  } catch (err) {
    const message = describeError(err);
    console.error('AI call failed', batchId, message);
    await logCall(batch, ctx.lines.length, null, message);
    if (isRetryable(err) && !lastAttempt) throw err; // SQS delivers it again
    await finishBatch(batchId, 'Failed', { error: message });
    return { batchId, status: 'Failed' };
  }
  await logCall(batch, ctx.lines.length, call, null);

  if (call.stopReason === 'refusal') {
    await finishBatch(batchId, 'Failed', { error: 'The model declined to answer this batch' });
    return { batchId, status: 'Failed' };
  }
  const { answers, problems } = parseAnswers(call.text, prompt.refs, {
    kind: ctx.kind,
    cap: settings.aiConfidenceCap,
    ownerEntityId: ctx.ownerEntityId,
    dueToFrom: ctx.dueToFrom,
  });
  if (!answers.length) {
    const error = call.stopReason === 'max_tokens' ? 'The answer was cut off' : problems[0] || 'No answers';
    if (!lastAttempt) throw new Error(error);
    await finishBatch(batchId, 'Failed', { error });
    return { batchId, status: 'Failed' };
  }

  if (batch.kind === 'Review') {
    await insertRows(
      db,
      'CtrlAiSuggestions',
      SUGGESTION_COLUMNS,
      answers.map((a) => [
        batch.runid, batch.groupid, a.lineId, batch.jobid, a.action, a.entityId, a.account?.code || null, a.account?.name || null,
        a.confidence, a.rawConfidence, a.reason, a.usedRule, a.redacted, call.model,
      ]),
      'ON CONFLICT (RunId, LineId) DO NOTHING'
    );
    await finishBatch(batchId, 'Succeeded', { result: { answered: answers.length, problems } });
  } else {
    await finishBatch(batchId, 'Succeeded', { result: { kind: ctx.kind, answers, problems } });
  }
  return { batchId, status: 'Succeeded', answered: answers.length };
}

exports.handler = async (event) => {
  const results = [];
  for (const record of event.Records || []) {
    let batchId;
    try {
      batchId = JSON.parse(record.body).batchId;
    } catch {
      batchId = null;
    }
    if (!batchId) {
      console.error('Ignoring malformed Controller AI message', record.messageId);
      continue;
    }
    results.push(await processBatch(batchId));
  }
  return { results };
};

exports.processBatch = processBatch;
exports.buildContext = buildContext;
exports.claimBatch = claimBatch;
exports.tallyText = tallyText;
exports.classHistoryText = classHistoryText;
exports.accountHistoryText = accountHistoryText;
exports.exampleOutcome = exampleOutcome;
exports.ruleNote = ruleNote;
exports.MAX_ATTEMPTS = MAX_ATTEMPTS;
