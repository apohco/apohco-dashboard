const {
  buildEntityResolver,
  buildHistory,
  classifyLines,
  historyBreakdown,
  lineEntities,
  relabelCandidates,
  testRule,
  DECISION_WEIGHT,
} = require('../../src/shared/reviewEngine');

const LEB = 'ent-leb';
const MIL = 'ent-mil';
const ENTITIES = [
  { entityId: LEB, entityName: 'Lebanon', managementQboClassId: 'cls-leb', managementClassName: 'Lebanon', aliases: [], keywords: [] },
  { entityId: MIL, entityName: 'Milford', managementQboClassId: 'cls-mil', managementClassName: 'Milford', aliases: [], keywords: ['Route 50'] },
];
const resolve = buildEntityResolver(ENTITIES);
const MGMT = { isClassBased: true, ownerEntityId: null };
const PRACTICE = { isClassBased: false, ownerEntityId: MIL };

describe('rule wins from now on', () => {
  const line = { lineId: 'l1', fingerprint: 'f1', vendorId: 'v1', payeeName: 'Kroger', memo: '', accountCode: '6100', className: 'Milford', qboClassId: 'cls-mil' };
  const history = buildHistory([{ vendorId: 'v1', accountCode: '6100', entityId: MIL, count: 19 }]);
  const rule = (ruleWins) => new Map([['v1', { ruleId: 'r2', version: 2, defaultEntityId: LEB, hints: {}, ruleWins }]]);

  test('without it, a rule and strong history that disagree are a Conflict', () => {
    expect(classifyLines({ lines: [line], entities: ENTITIES, rules: rule(false), history })[0].status).toBe('Conflict');
  });

  test('with it, the rule decides and history is only mentioned', () => {
    const [r] = classifyLines({ lines: [line], entities: ENTITIES, rules: rule(true), history });
    expect(r).toMatchObject({ status: 'LikelyMisclassified', suggestedEntityId: LEB, source: 'Rule' });
    expect(r.reasons).toContain('History says Milford, but rule v2 takes priority');
  });
});

describe('lineEntities', () => {
  const base = { amount: 100, className: 'Lebanon', qboClassId: 'cls-leb' };
  test('class, decisions, splits and Due To/From', () => {
    expect(lineEntities(base, MGMT, null, resolve)).toEqual([{ entityId: LEB, amount: 100 }]);
    expect(lineEntities(base, MGMT, { action: 'Reassign', entityId: MIL }, resolve)).toEqual([{ entityId: MIL, amount: 100 }]);
    expect(lineEntities(base, MGMT, { action: 'Undo' }, resolve)).toEqual([{ entityId: LEB, amount: 100 }]);
    expect(lineEntities({ ...base, amount: -100 }, MGMT, { action: 'Split', allocations: [{ entityId: LEB, amount: 60 }, { entityId: MIL, amount: 40 }] }, resolve)).toEqual([
      { entityId: LEB, amount: -60 },
      { entityId: MIL, amount: -40 },
    ]);
    expect(lineEntities(base, PRACTICE, { action: 'DueToFrom', counterpartyEntityId: LEB }, resolve)).toEqual([{ entityId: LEB, amount: 100 }]);
  });

  test("a practice file's lines belong to its entity; an unclassified management line to no one", () => {
    expect(lineEntities({ amount: 5, className: '' }, PRACTICE, { action: 'Keep', entityId: null }, resolve)).toEqual([{ entityId: MIL, amount: 5 }]);
    expect(lineEntities({ amount: 5, className: '' }, MGMT, null, resolve)).toEqual([{ entityId: null, amount: 5 }]);
  });
});

test('historyBreakdown lists every entity with its weight and share', () => {
  const history = buildHistory([
    { vendorId: 'v1', accountCode: '6100', entityId: MIL, count: 6 },
    { vendorId: 'v1', accountCode: '6100', entityId: LEB, count: 1, decisionAction: 'Reassign', decisionEntityId: LEB },
  ]);
  expect(historyBreakdown(history, 'v1', '6100')).toEqual({
    scope: 'account',
    total: 6 + DECISION_WEIGHT,
    shares: [{ entityId: MIL, weight: 6, share: 0.667 }, { entityId: LEB, weight: 3, share: 0.333 }],
  });
  expect(historyBreakdown(history, 'v-none', '6100')).toBeNull();
});

describe('relabelCandidates', () => {
  const rule = { defaultEntityId: LEB, hints: { keywords: [{ keyword: 'Route 50', entityId: MIL }] } };
  const l = (over) => ({ lineId: over.lineId, month: '2026-09', amount: 10, memo: '', payeeName: 'Kroger', className: 'Milford', qboClassId: 'cls-mil', decision: null, ...over });

  test('relabels lines that disagree with the rule, honoring keywords, and leaves splits alone', () => {
    const out = relabelCandidates({
      lines: [
        l({ lineId: 'a' }), // Milford -> Lebanon (default)
        l({ lineId: 'b', memo: 'Route 50 store' }), // keyword says Milford: unchanged
        l({ lineId: 'c', className: 'Lebanon', qboClassId: 'cls-leb' }), // already Lebanon
        l({ lineId: 'd', decision: { action: 'Reassign', entityId: MIL } }), // decided Milford -> Lebanon
        l({ lineId: 'e', decision: { action: 'Split', allocations: [] } }),
      ],
      rule,
      file: MGMT,
      resolve,
    });
    expect(out.relabel.map((r) => [r.line.lineId, r.fromEntityId, r.toEntityId])).toEqual([
      ['a', MIL, LEB],
      ['d', MIL, LEB],
    ]);
    expect(out).toMatchObject({ skippedSplits: 1, previouslyDecided: 1 });
  });
});

describe('testRule', () => {
  const files = new Map([['q-mgmt', MGMT]]);
  const l = (over) => ({ lineId: over.lineId, qboId: 'q-mgmt', month: '2026-09', txnDate: '2026-09-02', amount: 20, memo: '', payeeName: 'Kroger', className: 'Milford', qboClassId: 'cls-mil', decision: null, ...over });

  test('counts what would change and flags changes against strong history', () => {
    const lines = [
      ...Array.from({ length: 9 }, (_, i) => l({ lineId: `m${i}` })), // 9 x Milford
      l({ lineId: 'k', memo: 'Route 50' }),
      l({ lineId: 's', decision: { action: 'Split', allocations: [] } }),
    ];
    const out = testRule({ lines, rule: { defaultEntityId: LEB, hints: { keywords: [{ keyword: 'Route 50', entityId: MIL }] } }, files, resolve, threshold: 0.9 });
    expect(out).toMatchObject({ lineCount: 11, wouldChange: 9, unchanged: 1, noEntity: 0, splits: 1, changeAmount: 180, conflictsWithHistory: 9 });
    expect(out.history).toEqual({ entityId: MIL, confidence: 0.909 });
    expect(out.changes[0]).toMatchObject({ fromEntityId: MIL, toEntityId: LEB, via: 'default entity', conflictsWithHistory: true });
  });

  test('a rule with no default only touches keyword lines', () => {
    const out = testRule({ lines: [l({ lineId: 'a' }), l({ lineId: 'b', memo: 'Route 50' })], rule: { defaultEntityId: null, hints: { keywords: [{ keyword: 'Route 50', entityId: LEB }] } }, files, resolve });
    expect(out).toMatchObject({ wouldChange: 1, noEntity: 1 });
    expect(out.changes[0].via).toBe('keyword "Route 50"');
  });
});
