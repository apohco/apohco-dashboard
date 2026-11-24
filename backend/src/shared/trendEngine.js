// Controller Phase 2b: trends and trend checks over the stored history.
// Pure (no database); ctrlTrends loads and attributes the lines.
//
// Input rows are expense lines already attributed to an entity (Paul's
// decisions applied): { month, qboId, entityId|null, vendorKey|null,
// vendorName, accountKey, accountLabel, amount } where amount is spend
// (debit - credit).
//
// Checks for the month under review (thresholds from Review settings):
//   SplitShift        a vendor's share for an entity moved >= splitShiftPoints
//                     percentage points vs its baseline share
//   SpendSpike        an entity's spend in an account is >= spikePercent above
//                     its baseline monthly average and >= spikeMinAmount more
//   NewVendor         a vendor's first month in the stored history
//   MissingRecurring  a vendor with spend in each of the previous
//                     recurringMonths months has none this month
// The baseline is the previous baselineMonths months that have a stored GL.

// A vendor needs this much spend in the month before its split is judged,
// so a single small charge doesn't read as a "shift".
const MIN_SPLIT_SHIFT_SPEND = 100;
const MIN_BASELINE_MONTHS = 2;
const TOP_VENDORS = 12;

function addMonths(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const i = y * 12 + (m - 1) + delta;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
}

const round2 = (n) => Math.round(n * 100) / 100;
const entityKey = (id) => id || '';

// nested[a][b] += v
function add(map, a, b, v) {
  if (!map.has(a)) map.set(a, new Map());
  const inner = map.get(a);
  inner.set(b, (inner.get(b) || 0) + v);
}
const get = (map, a, b) => map.get(a)?.get(b) || 0;

// The file holding most of a key's spend in a month (for drill-down links).
function topFile(byFile) {
  let best = null;
  for (const [qboId, amount] of byFile || []) if (!best || Math.abs(amount) > Math.abs(best[1])) best = [qboId, amount];
  return best ? best[0] : null;
}

function computeTrends({ rows, month, chartMonths = 12, settings, firstSeen = new Map(), storedMonths = new Set() }) {
  const s = settings;
  const months = [];
  for (let i = chartMonths - 1; i >= 0; i--) {
    const m = addMonths(month, -i);
    if (storedMonths.has(m) || m === month) months.push(m);
  }
  const baseline = [];
  for (let i = 1; i <= s.baselineMonths; i++) {
    const m = addMonths(month, -i);
    if (storedMonths.has(m)) baseline.push(m);
  }

  const entitySpend = new Map(); // month -> entity -> amount
  const vendorMonth = new Map(); // vendorKey -> month -> amount
  const vendorEntity = new Map(); // `${vendorKey}|${month}` -> entity -> amount
  const vendorFile = new Map(); // `${vendorKey}|${month}` -> qboId -> amount
  const acctMonth = new Map(); // `${entity}|${accountKey}` -> month -> amount
  const acctFile = new Map(); // `${entity}|${accountKey}|${month}` -> qboId -> amount
  const vendorNames = new Map();
  const accountLabels = new Map();

  for (const r of rows) {
    const e = entityKey(r.entityId);
    add(entitySpend, r.month, e, r.amount);
    const ak = `${e}|${r.accountKey}`;
    add(acctMonth, ak, r.month, r.amount);
    add(acctFile, `${ak}|${r.month}`, r.qboId, r.amount);
    accountLabels.set(r.accountKey, r.accountLabel);
    if (r.vendorKey) {
      add(vendorMonth, r.vendorKey, r.month, r.amount);
      add(vendorEntity, `${r.vendorKey}|${r.month}`, e, r.amount);
      add(vendorFile, `${r.vendorKey}|${r.month}`, r.qboId, r.amount);
      if (!vendorNames.has(r.vendorKey)) vendorNames.set(r.vendorKey, r.vendorName);
    }
  }

  const anomalies = [];
  const vendorTotal = (v, m) => get(vendorMonth, v, m);

  // Split shift.
  for (const v of vendorMonth.keys()) {
    const cur = vendorTotal(v, month);
    if (cur < MIN_SPLIT_SHIFT_SPEND) continue;
    const baseMonths = baseline.filter((m) => vendorTotal(v, m) > 0);
    if (baseMonths.length < MIN_BASELINE_MONTHS) continue;
    const baseTotal = baseMonths.reduce((sum, m) => sum + vendorTotal(v, m), 0);
    const curShares = vendorEntity.get(`${v}|${month}`) || new Map();
    const baseShares = new Map();
    for (const m of baseMonths) for (const [e, amt] of vendorEntity.get(`${v}|${m}`) || []) baseShares.set(e, (baseShares.get(e) || 0) + amt);
    let best = null;
    for (const e of new Set([...curShares.keys(), ...baseShares.keys()])) {
      const c = (curShares.get(e) || 0) / cur;
      const b = (baseShares.get(e) || 0) / baseTotal;
      const diff = (c - b) * 100;
      if (!best || Math.abs(diff) > Math.abs(best.diff)) best = { e, c, b, diff };
    }
    if (best && Math.abs(best.diff) >= s.splitShiftPoints) {
      anomalies.push({
        type: 'SplitShift', vendorKey: v, vendorName: vendorNames.get(v), entityId: best.e || null,
        currentShare: Math.round(best.c * 1000) / 1000, baselineShare: Math.round(best.b * 1000) / 1000,
        points: Math.round(best.diff * 10) / 10, amount: round2(cur), qboId: topFile(vendorFile.get(`${v}|${month}`)),
      });
    }
  }

  // Spend spike (entity + account).
  if (baseline.length >= MIN_BASELINE_MONTHS) {
    for (const [ak, byMonth] of acctMonth) {
      const cur = byMonth.get(month) || 0;
      if (cur <= 0) continue;
      const avg = baseline.reduce((sum, m) => sum + (byMonth.get(m) || 0), 0) / baseline.length;
      if (cur >= avg * (1 + s.spikePercent / 100) && cur - avg >= s.spikeMinAmount) {
        const [e, ...rest] = ak.split('|');
        const accountKey = rest.join('|');
        anomalies.push({
          type: 'SpendSpike', entityId: e || null, accountKey, accountLabel: accountLabels.get(accountKey),
          amount: round2(cur), baseline: round2(avg), increase: round2(cur - avg),
          percent: avg > 0 ? Math.round(((cur - avg) / avg) * 1000) / 10 : null,
          qboId: topFile(acctFile.get(`${ak}|${month}`)),
        });
      }
    }
  }

  // New vendor / missing recurring charge.
  for (const v of vendorMonth.keys()) {
    const cur = vendorTotal(v, month);
    if (cur > 0 && firstSeen.get(v) === month) {
      anomalies.push({ type: 'NewVendor', vendorKey: v, vendorName: vendorNames.get(v), amount: round2(cur), qboId: topFile(vendorFile.get(`${v}|${month}`)) });
    }
    if (cur === 0 && storedMonths.has(month)) {
      const prev = Array.from({ length: s.recurringMonths }, (_, i) => addMonths(month, -(i + 1)));
      if (prev.every((m) => storedMonths.has(m) && vendorTotal(v, m) > 0)) {
        const avg = prev.reduce((sum, m) => sum + vendorTotal(v, m), 0) / prev.length;
        anomalies.push({
          type: 'MissingRecurring', vendorKey: v, vendorName: vendorNames.get(v), amount: round2(avg), months: prev.length,
          qboId: topFile(vendorFile.get(`${v}|${prev[0]}`)),
        });
      }
    }
  }
  anomalies.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

  // Charts.
  const entitySpendRows = [];
  for (const m of months) for (const [e, amt] of entitySpend.get(m) || []) entitySpendRows.push({ month: m, entityId: e || null, amount: round2(amt) });
  const chartSet = new Set(months);
  const vendorTotals = [...vendorMonth].map(([v, byMonth]) => [v, [...byMonth].filter(([m]) => chartSet.has(m)).reduce((sum, [, a]) => sum + a, 0)]);
  vendorTotals.sort((a, b) => b[1] - a[1]);
  const vendorSplits = vendorTotals
    .filter(([, total]) => total > 0)
    .slice(0, TOP_VENDORS)
    .map(([v, total]) => ({
      vendorKey: v,
      vendorName: vendorNames.get(v),
      total: round2(total),
      rows: months.flatMap((m) => [...(vendorEntity.get(`${v}|${m}`) || [])].map(([e, amt]) => ({ month: m, entityId: e || null, amount: round2(amt) }))),
    }));

  return { months, baselineMonths: baseline, entitySpend: entitySpendRows, vendorSplits, anomalies };
}

module.exports = { computeTrends, addMonths, MIN_SPLIT_SHIFT_SPEND };
