const { computeTrends, addMonths } = require('../../src/shared/trendEngine');

const SETTINGS = { splitShiftPoints: 25, spikePercent: 50, spikeMinAmount: 500, recurringMonths: 3, baselineMonths: 6 };
const MONTHS = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'];
const STORED = new Set(MONTHS);
const row = (over) => ({ qboId: 'q1', entityId: 'leb', vendorKey: 'v:kroger', vendorName: 'Kroger', accountKey: 'code:6100', accountLabel: '6100 Supplies', amount: 100, ...over });
const everyMonth = (over, months = MONTHS.slice(0, 6)) => months.map((month) => row({ month, ...over }));
const run = (rows, extra = {}) => computeTrends({ rows, month: '2026-10', settings: SETTINGS, storedMonths: STORED, ...extra });
const ofType = (out, type) => out.anomalies.filter((a) => a.type === type);

test('addMonths', () => {
  expect(addMonths('2026-01', -1)).toBe('2025-12');
  expect(addMonths('2026-10', 3)).toBe('2027-01');
});

test('charts cover the stored months up to the month, by entity', () => {
  const out = run([...everyMonth({ amount: 200 }), row({ month: '2026-10', amount: 50, entityId: null })]);
  expect(out.months).toEqual(MONTHS);
  expect(out.baselineMonths).toEqual(['2026-09', '2026-08', '2026-07', '2026-06', '2026-05', '2026-04']);
  expect(out.entitySpend).toContainEqual({ month: '2026-10', entityId: null, amount: 50 });
  expect(out.vendorSplits[0]).toMatchObject({ vendorKey: 'v:kroger', total: 1250 });
});

describe('split shift', () => {
  test('a vendor moving from Lebanon to Milford is flagged', () => {
    const out = run([...everyMonth({ amount: 300 }), row({ month: '2026-10', entityId: 'mil', amount: 300 })]);
    expect(ofType(out, 'SplitShift')).toEqual([
      expect.objectContaining({ vendorKey: 'v:kroger', points: expect.any(Number), amount: 300, qboId: 'q1' }),
    ]);
    expect(Math.abs(ofType(out, 'SplitShift')[0].points)).toBe(100);
  });

  test('a small move, or too little spend, is not', () => {
    const steady = [...everyMonth({ amount: 300 }), row({ month: '2026-10', amount: 240 }), row({ month: '2026-10', entityId: 'mil', amount: 60 })];
    expect(ofType(run(steady), 'SplitShift')).toEqual([]); // 20 points
    const tiny = [...everyMonth({ amount: 300 }), row({ month: '2026-10', entityId: 'mil', amount: 50 })];
    expect(ofType(run(tiny), 'SplitShift')).toEqual([]); // under $100
  });
});

describe('spend spike', () => {
  test('50% and $500 above the baseline average', () => {
    const out = run([...everyMonth({ amount: 1000 }), row({ month: '2026-10', amount: 1600 })]);
    expect(ofType(out, 'SpendSpike')).toEqual([
      expect.objectContaining({ entityId: 'leb', accountKey: 'code:6100', accountLabel: '6100 Supplies', amount: 1600, baseline: 1000, increase: 600, percent: 60 }),
    ]);
  });

  test('not when the increase is under $500, or under 50%', () => {
    expect(ofType(run([...everyMonth({ amount: 100 }), row({ month: '2026-10', amount: 400 })]), 'SpendSpike')).toEqual([]);
    expect(ofType(run([...everyMonth({ amount: 2000 }), row({ month: '2026-10', amount: 2600 })]), 'SpendSpike')).toEqual([]);
  });

  test('months without spend count as zero in the baseline', () => {
    const out = run([row({ month: '2026-09', amount: 600 }), row({ month: '2026-10', amount: 700 })]);
    expect(ofType(out, 'SpendSpike')[0]).toMatchObject({ baseline: 100, increase: 600 });
  });
});

test('a new vendor is flagged in its first stored month only', () => {
  const rows = [row({ month: '2026-10', vendorKey: 'v:new', vendorName: 'New Co', amount: 80 })];
  expect(ofType(run(rows, { firstSeen: new Map([['v:new', '2026-10']]) }), 'NewVendor')).toEqual([
    expect.objectContaining({ vendorKey: 'v:new', vendorName: 'New Co', amount: 80 }),
  ]);
  expect(ofType(run(rows, { firstSeen: new Map([['v:new', '2026-02']]) }), 'NewVendor')).toEqual([]);
});

describe('missing recurring charge', () => {
  test('present each of the previous 3 months, absent now', () => {
    const out = run(everyMonth({ vendorKey: 'v:rent', vendorName: 'Landlord', amount: 3000 }, ['2026-07', '2026-08', '2026-09']));
    expect(ofType(out, 'MissingRecurring')).toEqual([expect.objectContaining({ vendorKey: 'v:rent', amount: 3000, months: 3 })]);
  });

  test('not when a month was skipped, or the month has no stored GL', () => {
    expect(ofType(run(everyMonth({ vendorKey: 'v:rent' }, ['2026-07', '2026-09'])), 'MissingRecurring')).toEqual([]);
    const notStored = new Set(MONTHS.slice(0, 6));
    expect(ofType(run(everyMonth({ vendorKey: 'v:rent' }, ['2026-07', '2026-08', '2026-09']), { storedMonths: notStored }), 'MissingRecurring')).toEqual([]);
  });

  test('the setting controls how many months make a charge recurring', () => {
    const rows = everyMonth({ vendorKey: 'v:rent' }, ['2026-08', '2026-09']);
    expect(ofType(run(rows), 'MissingRecurring')).toEqual([]);
    expect(ofType(run(rows, { settings: { ...SETTINGS, recurringMonths: 2 } }), 'MissingRecurring')).toHaveLength(1);
  });
});

test('anomalies are ordered by amount', () => {
  const out = run([
    ...everyMonth({ amount: 1000 }),
    row({ month: '2026-10', amount: 1600 }),
    row({ month: '2026-10', vendorKey: 'v:new', vendorName: 'New', amount: 5000, accountKey: 'code:7000', accountLabel: '7000 Other' }),
  ], { firstSeen: new Map([['v:new', '2026-10']]) });
  expect(out.anomalies.map((a) => a.amount)).toEqual([...out.anomalies.map((a) => a.amount)].sort((a, b) => b - a));
  expect(out.anomalies[0].amount).toBe(5000);
});
