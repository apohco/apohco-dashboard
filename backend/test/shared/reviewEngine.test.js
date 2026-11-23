const {
  payeeKey,
  containsTerm,
  buildEntityResolver,
  buildEntityTerms,
  scoreTally,
  buildHistory,
  historySuggestion,
  classifyLines,
  decisionEntity,
  validateAllocations,
  countStatuses,
  DECISION_WEIGHT,
} = require('../../src/shared/reviewEngine');

const LEB = 'ent-lebanon';
const MIL = 'ent-milford';
const LAW = 'ent-lawrenceburg';
const ENTITIES = [
  { entityId: LEB, entityName: 'Lebanon', managementQboClassId: 'cls-leb', managementClassName: 'Lebanon', aliases: ['Leb'], keywords: ['Main St'] },
  { entityId: MIL, entityName: 'Milford', managementQboClassId: 'cls-mil', managementClassName: 'Milford Dental', aliases: [], keywords: ['Route 50'] },
  { entityId: LAW, entityName: 'Lawrenceburg', managementQboClassId: 'cls-law', managementClassName: 'Lawrenceburg', aliases: ['Lawrenceberg'], keywords: [] },
];

const line = (over = {}) => ({
  lineId: 'l1', fingerprint: 'f1', vendorId: 'v-kroger', payeeName: 'Kroger', memo: '', accountCode: '6100', className: '', qboClassId: null,
  ...over,
});
// History where every past line for this vendor/account went to `entityId`.
const historyOf = (entityId, count, vendorId = 'v-kroger', accountCode = '6100') =>
  buildHistory([{ vendorId, accountCode, entityId, count }]);
const classify = (lines, opts = {}) => classifyLines({ lines, entities: ENTITIES, threshold: 0.9, mediumThreshold: 0.7, ...opts });

describe('helpers', () => {
  test('payeeKey normalizes case, punctuation and spacing', () => {
    expect(payeeKey('  AMZN Mktp  US*2K4 ')).toBe('amzn mktp us 2k4');
    expect(payeeKey('Kroger #123')).toBe(payeeKey('KROGER 123'));
    expect(payeeKey('  ')).toBeNull();
  });

  test('containsTerm matches whole words only, case-insensitive, 3+ characters', () => {
    expect(containsTerm('Delivered to 12 Main St, Lebanon', 'main st')).toBe(true);
    expect(containsTerm('Mainstream supply', 'Main')).toBe(false);
    expect(containsTerm('Leb office', 'Le')).toBe(false);
    expect(containsTerm('', 'Leb')).toBe(false);
  });

  test('entity resolver: linked class id, class name, entity name, alias, sub-class', () => {
    const resolve = buildEntityResolver(ENTITIES);
    expect(resolve('anything', 'cls-mil')).toBe(MIL);
    expect(resolve('Milford Dental', null)).toBe(MIL);
    expect(resolve('LEBANON', null)).toBe(LEB);
    expect(resolve('Lawrenceberg', null)).toBe(LAW);
    expect(resolve('Ohio:Milford Dental', null)).toBe(MIL);
    expect(resolve('Admin', null)).toBeNull();
    expect(resolve('', null)).toBeNull();
  });

  test('scoreTally: share scaled by n/(n+1)', () => {
    expect(scoreTally({})).toBeNull();
    expect(scoreTally({ a: 9 })).toMatchObject({ entityId: 'a', share: 1, total: 9, confidence: 0.9 });
    const mixed = scoreTally({ a: 15, b: 4 });
    expect(mixed.entityId).toBe('a');
    expect(mixed.confidence).toBeCloseTo((15 / 19) * (19 / 20));
  });

  test('history: decisions outweigh plain lines, splits share their weight, undo is ignored', () => {
    const h = buildHistory([
      { vendorId: 'v', accountCode: '6100', entityId: LEB, count: 2 },
      { vendorId: 'v', accountCode: '6100', entityId: LEB, decisionAction: 'Reassign', decisionEntityId: MIL, count: 1 },
      { vendorId: 'v', accountCode: '6200', entityId: null, decisionAction: 'Split', allocations: [{ entityId: LEB, amount: 75 }, { entityId: MIL, amount: 25 }], count: 1 },
      { vendorId: 'v', accountCode: '6100', entityId: LEB, decisionAction: 'Undo', count: 1 },
      { vendorId: null, accountCode: '6100', entityId: LEB, count: 50 },
    ]).get('v');
    expect(h.byAccount.get('6100')).toEqual({ [LEB]: 3, [MIL]: DECISION_WEIGHT });
    expect(h.overall[LEB]).toBeCloseTo(3 + 0.75 * DECISION_WEIGHT);
    expect(h.overall[MIL]).toBeCloseTo(DECISION_WEIGHT + 0.25 * DECISION_WEIGHT);
  });

  test('history prefers the same account once it has enough weight', () => {
    const h = buildHistory([
      { vendorId: 'v', accountCode: '6100', entityId: LEB, count: 5 },
      { vendorId: 'v', accountCode: '6200', entityId: MIL, count: 20 },
      { vendorId: 'v', accountCode: '6300', entityId: LEB, count: 2 },
    ]);
    expect(historySuggestion(h, 'v', '6100')).toMatchObject({ entityId: LEB, scope: 'account' });
    // Too little history on 6300: falls back to the vendor overall.
    expect(historySuggestion(h, 'v', '6300')).toMatchObject({ entityId: MIL, scope: 'vendor' });
    expect(historySuggestion(h, 'nobody', '6100')).toBeNull();
  });
});

describe('classifyLines statuses', () => {
  test('Confirmed: class agrees with strong history', () => {
    const [r] = classify([line({ className: 'Lebanon' })], { history: historyOf(LEB, 19) });
    expect(r).toMatchObject({ status: 'Confirmed', source: 'History', currentEntityId: LEB, suggestedEntityId: LEB, confidenceLevel: 'High' });
    expect(r.confidence).toBe(0.95);
    expect(r.reasons[0]).toMatch(/History: 100% of 19 weighted past lines for this vendor and account went to Lebanon/);
  });

  test('LikelyMisclassified: class disagrees with strong history', () => {
    const [r] = classify([line({ className: 'Milford Dental' })], { history: historyOf(LEB, 19) });
    expect(r).toMatchObject({ status: 'LikelyMisclassified', currentEntityId: MIL, suggestedEntityId: LEB });
  });

  test('Unclassified: no class, suggestion still offered', () => {
    const [r] = classify([line()], { history: historyOf(LEB, 19) });
    expect(r).toMatchObject({ status: 'Unclassified', suggestedEntityId: LEB });
  });

  test('NeedsEvidence: history below the threshold, even when it agrees', () => {
    const [r] = classify([line({ className: 'Lebanon' })], { history: historyOf(LEB, 4) });
    expect(r).toMatchObject({ status: 'NeedsEvidence', confidence: 0.8, confidenceLevel: 'Medium' });
  });

  test('NeedsEvidence with no signal at all; the reasons say why', () => {
    const [r] = classify([line({ vendorId: null, payeeName: null, className: 'Admin' })]);
    expect(r).toMatchObject({ status: 'NeedsEvidence', suggestedEntityId: null, confidence: 0, confidenceLevel: null, source: 'None' });
    expect(r.reasons).toEqual(['Class "Admin" isn\'t linked to an entity', 'No payee on this line']);
  });

  test('the threshold is a setting', () => {
    const [r] = classify([line({ className: 'Lebanon' })], { history: historyOf(LEB, 4), threshold: 0.8 });
    expect(r.status).toBe('Confirmed');
  });

  test('a misspelled class resolves through the entity alias', () => {
    const [r] = classify([line({ className: 'Lawrenceberg' })], { history: historyOf(LAW, 19) });
    expect(r).toMatchObject({ status: 'Confirmed', currentEntityId: LAW });
  });
});

describe('rules and keywords', () => {
  const rules = new Map([
    ['v-kroger', { ruleId: 'r2', version: 2, defaultEntityId: LEB, hints: { keywords: [{ keyword: 'Route 50', entityId: MIL }] } }],
  ]);

  test('a vendor keyword beats the vendor default', () => {
    const [r] = classify([line({ memo: 'Store on Route 50', className: 'Milford Dental' })], { rules });
    expect(r).toMatchObject({ status: 'Confirmed', source: 'Rule', suggestedEntityId: MIL, confidence: 0.97, ruleId: 'r2' });
    expect(r.reasons[0]).toBe('Rule v2: "Route 50" means Milford');
  });

  test('the vendor default applies when no keyword matches', () => {
    const [r] = classify([line({ className: 'Milford Dental' })], { rules });
    expect(r).toMatchObject({ status: 'LikelyMisclassified', source: 'Rule', suggestedEntityId: LEB, confidence: 0.95 });
  });

  test('Conflict: the rule and strong history disagree', () => {
    const [r] = classify([line({ className: 'Lebanon' })], { rules, history: historyOf(MIL, 19) });
    expect(r).toMatchObject({ status: 'Conflict', suggestedEntityId: LEB });
    expect(r.reasons).toContain('Conflict: the rule says Lebanon, history says Milford');
  });

  test('weak history against a rule is not a conflict', () => {
    const [r] = classify([line({ className: 'Lebanon' })], { rules, history: historyOf(MIL, 3) });
    expect(r.status).toBe('Confirmed');
  });

  test('an entity keyword in the memo is used when there is no rule', () => {
    const [r] = classify([line({ vendorId: 'v-other', memo: 'Delivery to Main St office', className: 'Lebanon' })]);
    expect(r).toMatchObject({ status: 'Confirmed', source: 'Keyword', suggestedEntityId: LEB, confidence: 0.92 });
  });

  test('terms shared by several entities are ignored, and the longest match wins', () => {
    const entities = [
      { entityId: 'west', entityName: 'Westside', aliases: ['Petr Vaughan DDS', 'LLC'], keywords: [] },
      { entityId: 'leb', entityName: 'Lebanon', aliases: ['Lebanon Petr Vaughan DDS', 'LLC'], keywords: ['600 Columbus Ave'] },
    ];
    expect(buildEntityTerms(entities).map((t) => t.term)).not.toContain('LLC');
    const [r] = classifyLines({ lines: [line({ vendorId: 'v-x', memo: 'Invoice to Lebanon Petr Vaughan DDS LLC', className: 'Westside' })], entities });
    expect(r).toMatchObject({ source: 'Keyword', suggestedEntityId: 'leb', status: 'LikelyMisclassified' });
  });

  test('an entity name alone in the memo is a medium hint, not enough to flag a line', () => {
    const [r] = classify([line({ vendorId: 'v-other', memo: 'Lunch for Milford staff', className: 'Lebanon' })]);
    expect(r).toMatchObject({ source: 'Keyword', suggestedEntityId: MIL, confidence: 0.85, status: 'NeedsEvidence' });
  });

  test('keywords for two entities in one memo give no keyword signal', () => {
    const [r] = classify([line({ vendorId: 'v-other', memo: 'Split Leb and Milford', className: 'Lebanon' })]);
    expect(r.source).toBe('None');
  });
});

describe('decisions and splits', () => {
  test('decisionEntity', () => {
    const s = { currentEntityId: MIL, suggestedEntityId: LEB };
    expect(decisionEntity('Approve', s)).toBe(LEB);
    expect(decisionEntity('Approve', { currentEntityId: MIL, suggestedEntityId: null })).toBe(MIL);
    expect(decisionEntity('Approve', { currentEntityId: null, suggestedEntityId: null })).toBeNull();
    expect(decisionEntity('Keep', s)).toBe(MIL);
    expect(decisionEntity('Reassign', s, LAW)).toBe(LAW);
  });

  test('validateAllocations', () => {
    const ids = new Set([LEB, MIL, LAW]);
    expect(validateAllocations([{ entityId: LEB, amount: 60 }, { entityId: MIL, amount: 40.1 }], -100.1, ids)).toBeNull();
    expect(validateAllocations([{ entityId: LEB, amount: 100 }], 100, ids)).toMatch(/at least two/);
    expect(validateAllocations([{ entityId: LEB, amount: 50 }, { entityId: LEB, amount: 50 }], 100, ids)).toMatch(/once/);
    expect(validateAllocations([{ entityId: LEB, amount: 50 }, { entityId: 'x', amount: 50 }], 100, ids)).toMatch(/entity from this Group/);
    expect(validateAllocations([{ entityId: LEB, amount: 100 }, { entityId: MIL, amount: 0 }], 100, ids)).toMatch(/more than zero/);
    expect(validateAllocations([{ entityId: LEB, amount: 50 }, { entityId: MIL, amount: 49.99 }], 100, ids)).toMatch(/add up to 100.00 \(they add up to 99.99\)/);
  });

  test('countStatuses', () => {
    expect(countStatuses([{ status: 'Confirmed' }, { status: 'Confirmed' }, { status: 'Conflict' }])).toEqual({
      Unclassified: 0, Confirmed: 2, LikelyMisclassified: 0, Conflict: 1, NeedsEvidence: 0,
    });
  });
});
