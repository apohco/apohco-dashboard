// Controller Phase 2b: trends across every stored month.
//
// GET /api/controller/trends?groupId=&month=YYYY-MM (default: latest stored)
//   Spend by entity by month, the entity split of the top vendors, and the
//   trend checks for `month` (see shared/trendEngine.js).
//
// Spend is expense lines from the latest snapshot of each file and month:
// the management file by class (or Paul's decision), each practice file to
// its own entity, and lines marked Due To/From to the other entity.
// Lines reclassified out of an expense account drop out.
const { authorizeController } = require('../../../shared/controllerAuth');
const { requireGroupAccess } = require('../../../shared/authorize');
const { query } = require('../../../shared/db');
const { json, withErrorHandling } = require('../../../shared/response');
const { parseMonth } = require('../../../shared/monthRanges');
const { accountKey } = require('../../../shared/accountKey');
const { buildEntityResolver, lineEntities } = require('../../../shared/reviewEngine');
const { computeTrends, addMonths } = require('../../../shared/trendEngine');
const {
  badRequest,
  loadSettings,
  loadEntities,
  loadFiles,
  loadVendorKeys,
  loadStoredLines,
  loadStoredMonths,
  loadAccountTypes,
  payeeKeySql,
} = require('../../../shared/ctrlReviewData');

const CHART_MONTHS = 12;

// Expense rows for the trend engine, with Paul's decisions applied.
function attributeLines({ lines, files, resolve, vendorKeys, accountTypes }) {
  const rows = [];
  for (const line of lines) {
    let type = line.accountType;
    let acct = { code: line.accountCode, name: line.accountName };
    const d = line.decision && line.decision.action !== 'Undo' ? line.decision : null;
    if (d && d.action === 'Reclassify' && d.targetAccount) {
      acct = d.targetAccount;
      type = accountTypes.get(line.qboId)?.get(accountKey(acct.code || null, acct.name)) || type;
    }
    if (type !== 'Expense') continue;
    const file = files.get(line.qboId) || { isClassBased: true, ownerEntityId: null };
    const vendor = line.payeeKey ? vendorKeys.get(line.payeeKey) : null;
    const vendorKey = vendor ? `v:${vendor.vendorId}` : line.payeeKey ? `p:${line.payeeKey}` : null;
    for (const part of lineEntities(line, file, d, resolve)) {
      rows.push({
        month: line.month,
        qboId: line.qboId,
        entityId: part.entityId,
        vendorKey,
        vendorName: vendor ? vendor.displayName : line.payeeName,
        accountKey: accountKey(acct.code || null, acct.name),
        accountLabel: [acct.code, acct.name].filter(Boolean).join(' '),
        amount: part.amount,
      });
    }
  }
  return rows;
}

// vendorKey -> first month the vendor appears anywhere in the stored GLs.
async function loadFirstSeen(groupId, vendorKeys) {
  const { rows } = await query(
    `SELECT ${payeeKeySql('l.PayeeName')} AS PayeeKey, TO_CHAR(MIN(s.Period), 'YYYY-MM') AS FirstMonth
     FROM CtrlLedgerLines l JOIN CtrlSnapshots s ON s.SnapshotId = l.SnapshotId
     WHERE l.GroupId = $1 AND COALESCE(l.PayeeName, '') <> ''
     GROUP BY 1`,
    [groupId]
  );
  const first = new Map();
  for (const r of rows) {
    if (!r.payeekey) continue;
    const vendor = vendorKeys.get(r.payeekey);
    const key = vendor ? `v:${vendor.vendorId}` : `p:${r.payeekey}`;
    if (!first.has(key) || r.firstmonth < first.get(key)) first.set(key, r.firstmonth);
  }
  return first;
}

async function handleTrends(groupId, qs) {
  const settings = await loadSettings(groupId);
  const stored = await loadStoredMonths(groupId);
  const storedMonths = new Set([...stored.values()].flatMap((set) => [...set]));
  const latest = [...storedMonths].sort().pop() || null;
  const month = qs.month || latest;
  const entities = await loadEntities(groupId);
  const fileList = await loadFiles(groupId, entities);
  const base = {
    settings: {
      splitShiftPoints: settings.splitShiftPoints, spikePercent: settings.spikePercent, spikeMinAmount: settings.spikeMinAmount,
      recurringMonths: settings.recurringMonths, baselineMonths: settings.baselineMonths,
    },
    latestMonth: latest,
    entities: entities.map((e) => ({ entityId: e.entityId, entityName: e.entityName })),
    files: fileList.map((f) => ({ qboId: f.qboId, qboName: f.qboName, isClassBased: f.isClassBased })),
  };
  if (!month) return json(200, { ...base, month: null, months: [], entitySpend: [], vendorSplits: [], anomalies: [] });
  if (!parseMonth(month)) throw badRequest('month must be formatted YYYY-MM');

  const lookback = Math.max(CHART_MONTHS - 1, settings.baselineMonths, settings.recurringMonths);
  const lines = await loadStoredLines({ groupId, fromMonth: addMonths(month, -lookback), toMonth: month });
  const vendorKeys = await loadVendorKeys(groupId);
  const accountTypes = new Map();
  for (const f of fileList) accountTypes.set(f.qboId, await loadAccountTypes(groupId, f.qboId));
  const rows = attributeLines({
    lines,
    files: new Map(fileList.map((f) => [f.qboId, f])),
    resolve: buildEntityResolver(entities),
    vendorKeys,
    accountTypes,
  });
  const result = computeTrends({
    rows,
    month,
    chartMonths: CHART_MONTHS,
    settings,
    firstSeen: await loadFirstSeen(groupId, vendorKeys),
    storedMonths,
  });
  return json(200, { ...base, month, ...result });
}

exports.handler = withErrorHandling(async (event) => {
  const claims = await authorizeController(event);
  const qs = event.queryStringParameters || {};
  if (!qs.groupId) throw badRequest('groupId is required');
  requireGroupAccess(claims, qs.groupId);
  if (event.httpMethod !== 'GET') throw badRequest('Unknown trends route', 404);
  return handleTrends(qs.groupId, qs);
});

exports.attributeLines = attributeLines;
