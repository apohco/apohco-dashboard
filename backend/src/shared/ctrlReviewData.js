// Data access shared by the Controller review functions (ctrlReview,
// ctrlConflicts, ctrlTrends, manageCtrlVendors): settings, entities, runs,
// vendor rules, history and the accounts of a QBO file. Every query is
// scoped by GroupId.
const { query } = require('./db');
const { parseMonth } = require('./monthRanges');
const { accountKey } = require('./accountKey');
const { detectDueToFromAccounts } = require('./reviewEngine');

const DEFAULT_SETTINGS = {
  threshold: 0.9,
  mediumThreshold: 0.7,
  historyMonths: 12,
  // Trend checks.
  splitShiftPoints: 25,
  spikePercent: 50,
  spikeMinAmount: 500,
  recurringMonths: 3,
  baselineMonths: 6,
};
// AI matching (Phase 3). Kept apart from the numeric settings above.
const AI_DEFAULTS = {
  aiEnabled: true,
  aiConfidenceCap: 0.85,
  aiMonthlyBudget: 25,
  aiRedactPatientInfo: true,
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function badRequest(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

const isUuid = (v) => UUID_RE.test(String(v || ''));

// "YYYY-MM" shifted by `delta` months.
function shiftMonth(month, delta) {
  const { year, month: m } = parseMonth(month);
  const i = year * 12 + (m - 1) + delta;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
}

async function loadSettings(groupId, db = { query }) {
  const { rows } = await db.query(
    `SELECT Threshold, MediumThreshold, HistoryMonths, SplitShiftPoints, SpikePercent, SpikeMinAmount, RecurringMonths, BaselineMonths,
            AiEnabled, AiConfidenceCap, AiMonthlyBudget, AiRedactPatientInfo
     FROM CtrlReviewSettings WHERE GroupId = $1`,
    [groupId]
  );
  if (!rows.length) return { ...DEFAULT_SETTINGS, ...AI_DEFAULTS };
  const r = rows[0];
  const num = (v, fallback) => (v === undefined || v === null ? fallback : Number(v));
  const bool = (v, fallback) => (v === undefined || v === null ? fallback : Boolean(v));
  return {
    aiEnabled: bool(r.aienabled, AI_DEFAULTS.aiEnabled),
    aiConfidenceCap: num(r.aiconfidencecap, AI_DEFAULTS.aiConfidenceCap),
    aiMonthlyBudget: num(r.aimonthlybudget, AI_DEFAULTS.aiMonthlyBudget),
    aiRedactPatientInfo: bool(r.airedactpatientinfo, AI_DEFAULTS.aiRedactPatientInfo),
    threshold: Number(r.threshold),
    mediumThreshold: Number(r.mediumthreshold),
    historyMonths: Number(r.historymonths),
    splitShiftPoints: num(r.splitshiftpoints, DEFAULT_SETTINGS.splitShiftPoints),
    spikePercent: num(r.spikepercent, DEFAULT_SETTINGS.spikePercent),
    spikeMinAmount: num(r.spikeminamount, DEFAULT_SETTINGS.spikeMinAmount),
    recurringMonths: num(r.recurringmonths, DEFAULT_SETTINGS.recurringMonths),
    baselineMonths: num(r.baselinemonths, DEFAULT_SETTINGS.baselineMonths),
  };
}

// Trend settings left out of a request keep their defaults.
function validateSettings(body) {
  const pick = (key) => Number(body[key] === undefined || body[key] === null || body[key] === '' ? DEFAULT_SETTINGS[key] : body[key]);
  const s = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) s[key] = pick(key);
  if (!(s.threshold >= 0.5 && s.threshold <= 1)) throw badRequest('threshold must be between 0.5 and 1');
  if (!(s.mediumThreshold >= 0 && s.mediumThreshold <= s.threshold)) {
    throw badRequest('mediumThreshold must be between 0 and threshold');
  }
  const whole = (key, min, max, label) => {
    if (!Number.isInteger(s[key]) || s[key] < min || s[key] > max) throw badRequest(`${label} must be a whole number from ${min} to ${max}`);
  };
  whole('historyMonths', 1, 36, 'historyMonths');
  whole('recurringMonths', 2, 12, 'recurringMonths');
  whole('baselineMonths', 2, 24, 'baselineMonths');
  if (!(s.splitShiftPoints > 0 && s.splitShiftPoints <= 100)) throw badRequest('splitShiftPoints must be more than 0 and at most 100');
  if (!(s.spikePercent > 0 && s.spikePercent <= 10000)) throw badRequest('spikePercent must be more than 0');
  if (!(s.spikeMinAmount >= 0 && s.spikeMinAmount < 1e9)) throw badRequest('spikeMinAmount must be 0 or more');

  // AI settings left out keep their defaults.
  const given = (key) => body[key] !== undefined && body[key] !== null && body[key] !== '';
  for (const key of ['aiEnabled', 'aiRedactPatientInfo']) {
    if (given(key) && typeof body[key] !== 'boolean') throw badRequest(`${key} must be true or false`);
    s[key] = given(key) ? body[key] : AI_DEFAULTS[key];
  }
  s.aiConfidenceCap = given('aiConfidenceCap') ? Number(body.aiConfidenceCap) : AI_DEFAULTS.aiConfidenceCap;
  s.aiMonthlyBudget = given('aiMonthlyBudget') ? Number(body.aiMonthlyBudget) : AI_DEFAULTS.aiMonthlyBudget;
  if (!(s.aiConfidenceCap >= 0.5 && s.aiConfidenceCap <= 1)) throw badRequest('aiConfidenceCap must be between 0.5 and 1');
  if (!(s.aiMonthlyBudget >= 0 && s.aiMonthlyBudget <= 10000)) throw badRequest('aiMonthlyBudget must be from 0 to 10000');
  return s;
}

async function loadEntities(groupId) {
  const { rows } = await query(
    `SELECT e.EntityId, e.EntityName, e.ManagementQBOClassId, c.ClassName AS ManagementClassName, e.Aliases, e.Keywords, e.PracticeQBOId
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
    `SELECT RunId, QBOId, TO_CHAR(Period, 'YYYY-MM') AS month, SnapshotId, Threshold, MediumThreshold, ReviewKind
     FROM CtrlReviewRuns WHERE RunId = $1 AND GroupId = $2`,
    [runId, groupId]
  );
  if (!rows.length) throw badRequest('Review run not found', 404);
  return rows[0];
}

async function loadRules(client, groupId) {
  const { rows } = await client.query(
    `SELECT DISTINCT ON (VendorId) RuleId, VendorId, Version, DefaultEntityId, Hints, RuleText, RuleWins
     FROM CtrlVendorRules WHERE GroupId = $1 ORDER BY VendorId, Version DESC`,
    [groupId]
  );
  return new Map(
    rows.map((r) => [
      r.vendorid,
      {
        ruleId: r.ruleid,
        version: r.version,
        defaultEntityId: r.defaultentityid,
        hints: r.hints || {},
        ruleText: r.ruletext || null,
        ruleWins: Boolean(r.rulewins),
      },
    ])
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

// Account history for a practice file over the months before `month`: the
// latest snapshot of each month, with Paul's latest decision per line.
async function loadAccountHistoryRows(client, groupId, qboId, month, historyMonths) {
  const { rows } = await client.query(
    `WITH snaps AS (
       SELECT DISTINCT ON (Period) SnapshotId FROM CtrlSnapshots
       WHERE GroupId = $1 AND QBOId = $2 AND Period >= $3 AND Period < $4
       ORDER BY Period, PulledAt DESC
     ),
     dec AS (
       SELECT DISTINCT ON (Fingerprint) Fingerprint, Action, TargetAccountCode, TargetAccountName, CounterpartyEntityId
       FROM CtrlDecisions WHERE GroupId = $1 AND QBOId = $2
       ORDER BY Fingerprint, DecidedAt DESC
     )
     SELECT l.PayeeName, l.AccountCode, l.AccountName,
            d.Action, d.TargetAccountCode, d.TargetAccountName, d.CounterpartyEntityId, COUNT(*)::int AS n
     FROM CtrlLedgerLines l
     JOIN snaps s ON s.SnapshotId = l.SnapshotId
     LEFT JOIN dec d ON d.Fingerprint = l.Fingerprint
     GROUP BY l.PayeeName, l.AccountCode, l.AccountName, d.Action, d.TargetAccountCode, d.TargetAccountName, d.CounterpartyEntityId`,
    [groupId, qboId, `${shiftMonth(month, -historyMonths)}-01`, `${month}-01`]
  );
  return rows;
}

// ---- Accounts of one QBO file (account review, Reclassify, Due To/From)

// accountKey -> account type: the dashboard's Chart of Accounts, else the
// type confirmed when a GL was uploaded for the file (latest upload wins).
async function loadAccountTypes(groupId, qboId, db = { query }) {
  const types = new Map();
  const { rows: uploads } = await db.query(
    `SELECT AccountClassifications FROM CtrlUploads
     WHERE GroupId = $1 AND QBOId = $2 AND Status = 'Imported' AND AccountClassifications IS NOT NULL
     ORDER BY ImportedDate`,
    [groupId, qboId]
  );
  for (const u of uploads) for (const [key, type] of Object.entries(u.accountclassifications || {})) types.set(key, type);
  const { rows: coa } = await db.query(
    `SELECT AccountCode, AccountName, Classification FROM ChartOfAccountsMappings
     WHERE GroupId = $1 AND QBOId = $2 AND Classification IS NOT NULL`,
    [groupId, qboId]
  );
  for (const m of coa) types.set(accountKey(m.accountcode || null, m.accountname), m.classification);
  return types;
}

// Every account seen in the file (Chart of Accounts + stored GL lines):
// [{ key, code, name, type }], by code then name.
async function loadFileAccounts(groupId, qboId) {
  const [{ rows: coa }, { rows: seen }, types] = await Promise.all([
    query(`SELECT AccountCode, AccountName FROM ChartOfAccountsMappings WHERE GroupId = $1 AND QBOId = $2`, [groupId, qboId]),
    query(
      `SELECT DISTINCT AccountCode, AccountName FROM CtrlLedgerLines
       WHERE GroupId = $1 AND QBOId = $2 AND COALESCE(AccountName, '') <> ''`,
      [groupId, qboId]
    ),
    loadAccountTypes(groupId, qboId),
  ]);
  const byKey = new Map();
  for (const a of [...coa, ...seen]) {
    if (!a.accountname) continue;
    const key = accountKey(a.accountcode || null, a.accountname);
    if (!byKey.has(key)) byKey.set(key, { key, code: a.accountcode || null, name: a.accountname, type: types.get(key) || 'Unknown' });
  }
  return [...byKey.values()].sort((a, b) => (a.code || '~').localeCompare(b.code || '~') || a.name.localeCompare(b.name));
}

// The account a request names ({ code?, name }), as the file knows it.
async function resolveAccount(groupId, qboId, account) {
  if (!account || typeof account.name !== 'string' || !account.name.trim()) throw badRequest('account (with a name) is required');
  const key = accountKey(account.code ? String(account.code).trim() : null, account.name.trim());
  const found = (await loadFileAccounts(groupId, qboId)).find((a) => a.key === key);
  if (!found) throw badRequest(`"${account.name}" is not an account in this QBO file`);
  return found;
}

// The entity whose own (practice) file this is, when exactly one is.
async function loadOwnerEntityId(groupId, qboId) {
  const { rows } = await query(
    `SELECT EntityId FROM CtrlEntities WHERE GroupId = $1 AND PracticeQBOId = $2 AND IsActive`,
    [groupId, qboId]
  );
  return rows.length === 1 ? rows[0].entityid : null;
}

// counterpartyEntityId -> { accountKey, code, name } for one file.
async function loadDueToFrom(groupId, qboId, db = { query }) {
  const { rows } = await db.query(
    `SELECT CounterpartyEntityId, AccountCode, AccountName FROM CtrlDueToFromAccounts WHERE GroupId = $1 AND QBOId = $2`,
    [groupId, qboId]
  );
  return new Map(
    rows.map((r) => [
      r.counterpartyentityid,
      { accountKey: accountKey(r.accountcode || null, r.accountname), code: r.accountcode || null, name: r.accountname },
    ])
  );
}

// The Due To/From account per other entity: the saved one, else the one
// whose name says "Due from/to <entity>". { saved, detected, effective }.
async function loadEffectiveDueToFrom(groupId, qboId, entities, ownerEntityId, db = { query }) {
  const [saved, accounts] = await Promise.all([loadDueToFrom(groupId, qboId, db), loadFileAccounts(groupId, qboId)]);
  const detected = detectDueToFromAccounts(entities, ownerEntityId, accounts);
  return { saved, detected, effective: new Map([...detected, ...saved]) };
}

// A payee's vendor key in SQL, matching reviewEngine.payeeKey (lowercase,
// runs of anything but a-z0-9 become one space, trimmed).
const payeeKeySql = (col) => `NULLIF(btrim(regexp_replace(lower(COALESCE(${col}, '')), '[^a-z0-9]+', ' ', 'g')), '')`;

// A line's account type (alias `l`): the dashboard's Chart of Accounts,
// else the type confirmed when a GL was uploaded for the file.
const ACCOUNT_TYPE_SQL = `COALESCE(m.Classification, ua.Classification, 'Unknown')`;
const accountTypeJoin = (l) => `
  LEFT JOIN ChartOfAccountsMappings m ON m.QBOId = ${l}.QBOId AND m.AccountCode = ${l}.AccountCode
  LEFT JOIN LATERAL (
    SELECT u.AccountClassifications ->> k.Key AS Classification
    FROM (SELECT CASE WHEN COALESCE(${l}.AccountCode, '') <> '' THEN 'code:' || ${l}.AccountCode
                      ELSE 'name:' || lower(COALESCE(${l}.AccountName, '')) END AS Key) k
    JOIN CtrlUploads u ON u.QBOId = ${l}.QBOId AND u.Status = 'Imported' AND u.AccountClassifications ? k.Key
    ORDER BY u.ImportedDate DESC LIMIT 1
  ) ua ON m.Classification IS NULL`;

// Every QBO file of the Group: { qboId, qboName, isClassBased, ownerEntityId }.
async function loadFiles(groupId, entities) {
  const { rows } = await query(`SELECT QBOId, QBOName, IsClassBased FROM QBOs WHERE GroupId = $1 ORDER BY QBOName`, [groupId]);
  return rows.map((q) => {
    const owners = entities.filter((e) => e.practiceQboId === q.qboid);
    return { qboId: q.qboid, qboName: q.qboname, isClassBased: Boolean(q.isclassbased), ownerEntityId: owners.length === 1 ? owners[0].entityId : null };
  });
}

// payeeKey -> { vendorId, displayName } for every payee name with a profile.
async function loadVendorKeys(groupId) {
  const { rows } = await query(
    `SELECT a.PayeeKey, v.VendorId, v.DisplayName FROM CtrlVendorAliases a JOIN CtrlVendors v ON v.VendorId = a.VendorId
     WHERE a.GroupId = $1`,
    [groupId]
  );
  return new Map(rows.map((r) => [r.payeekey, { vendorId: r.vendorid, displayName: r.displayname }]));
}

// The stored lines of months fromMonth..toMonth (latest snapshot of each
// file and month), each with its account type and Paul's latest decision.
// Optionally limited to some files and/or payee keys (a vendor's aliases).
async function loadStoredLines({ groupId, fromMonth, toMonth, qboIds = null, payeeKeys = null }) {
  const params = [groupId, `${fromMonth}-01`, `${toMonth}-01`];
  const p = (v) => {
    params.push(v);
    return `$${params.length}`;
  };
  const fileFilter = qboIds ? ` AND QBOId = ANY(${p(qboIds)}::uuid[])` : '';
  const payeeFilter = payeeKeys ? ` AND ${payeeKeySql('l.PayeeName')} = ANY(${p(payeeKeys)}::text[])` : '';
  const { rows } = await query(
    `WITH snaps AS (
       SELECT DISTINCT ON (QBOId, Period) SnapshotId, Period FROM CtrlSnapshots
       WHERE GroupId = $1 AND Period >= $2 AND Period <= $3${fileFilter}
       ORDER BY QBOId, Period, PulledAt DESC
     ),
     dec AS (
       SELECT DISTINCT ON (QBOId, Fingerprint) QBOId, Fingerprint, Action, EntityId, Allocations, CounterpartyEntityId,
              TargetAccountCode, TargetAccountName, Scope
       FROM CtrlDecisions WHERE GroupId = $1
       ORDER BY QBOId, Fingerprint, DecidedAt DESC
     )
     SELECT l.LineId, l.QBOId, TO_CHAR(s.Period, 'YYYY-MM') AS month, l.Fingerprint, TO_CHAR(l.TxnDate, 'YYYY-MM-DD') AS TxnDate,
            l.PayeeName, ${payeeKeySql('l.PayeeName')} AS PayeeKey, l.Memo, l.AccountCode, l.AccountName, l.ClassName, l.QBOClassId,
            l.Amount, ${ACCOUNT_TYPE_SQL} AS AccountType,
            d.Action, d.EntityId AS DecisionEntityId, d.Allocations, d.CounterpartyEntityId, d.TargetAccountCode, d.TargetAccountName,
            d.Scope
     FROM CtrlLedgerLines l
     JOIN snaps s ON s.SnapshotId = l.SnapshotId
     LEFT JOIN dec d ON d.QBOId = l.QBOId AND d.Fingerprint = l.Fingerprint
     ${accountTypeJoin('l')}
     WHERE l.GroupId = $1${payeeFilter}`,
    params
  );
  return rows.map((r) => ({
    lineId: r.lineid,
    qboId: r.qboid,
    month: r.month,
    fingerprint: r.fingerprint,
    txnDate: r.txndate,
    payeeName: r.payeename,
    payeeKey: r.payeekey,
    memo: r.memo,
    accountCode: r.accountcode,
    accountName: r.accountname,
    className: r.classname,
    qboClassId: r.qboclassid,
    amount: Number(r.amount),
    accountType: r.accounttype,
    decision: r.action
      ? {
          action: r.action,
          entityId: r.decisionentityid,
          allocations: r.allocations,
          counterpartyEntityId: r.counterpartyentityid,
          targetAccount: r.targetaccountname ? { code: r.targetaccountcode || null, name: r.targetaccountname } : null,
          scope: r.scope || 'Line',
        }
      : null,
  }));
}

// Months (YYYY-MM) with a stored GL, per file: Map qboId -> Set.
async function loadStoredMonths(groupId) {
  const { rows } = await query(
    `SELECT DISTINCT QBOId, TO_CHAR(Period, 'YYYY-MM') AS month FROM CtrlSnapshots WHERE GroupId = $1`,
    [groupId]
  );
  const byFile = new Map();
  for (const r of rows) {
    if (!byFile.has(r.qboid)) byFile.set(r.qboid, new Set());
    byFile.get(r.qboid).add(r.month);
  }
  return byFile;
}

module.exports = {
  DEFAULT_SETTINGS,
  AI_DEFAULTS,
  loadAccountHistoryRows,
  UUID_RE,
  badRequest,
  isUuid,
  shiftMonth,
  loadSettings,
  validateSettings,
  loadEntities,
  loadRun,
  loadRules,
  loadHistoryRows,
  loadAccountTypes,
  loadFileAccounts,
  resolveAccount,
  loadOwnerEntityId,
  loadDueToFrom,
  loadEffectiveDueToFrom,
  payeeKeySql,
  ACCOUNT_TYPE_SQL,
  accountTypeJoin,
  loadFiles,
  loadVendorKeys,
  loadStoredLines,
  loadStoredMonths,
};
