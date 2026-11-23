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
  buildAccountHistory,
  classifyAccountLines,
  dueAccountEntity,
  detectDueToFromAccounts,
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

describe('account review (files without classes)', () => {
  // Milford's own file: Lebanon and Lawrenceburg are "other entities".
  const acctLine = (over = {}) => ({
    lineId: 'l1', fingerprint: 'f1', vendorId: 'v-kroger', payeeName: 'Kroger', memo: '', accountType: 'Expense',
    accountKey: 'code:6100', accountCode: '6100', accountName: 'Supplies', ...over,
  });
  const hist = (rows) =>
    buildAccountHistory(
      rows.map((r) => ({ vendorId: 'v-kroger', accountType: 'Expense', accountKey: 'code:6100', accountCode: '6100', accountName: 'Supplies', ...r }))
    );
  const DUE = new Map([[LEB, { accountKey: 'code:1500', code: '1500', name: 'Due From Lebanon' }]]);
  const classify = (lines, history, extra = {}) =>
    classifyAccountLines({ lines, entities: ENTITIES, ownerEntityId: MIL, dueToFrom: DUE, history, threshold: 0.9, mediumThreshold: 0.7, ...extra });

  test('history: plain lines count once, decisions three times, by vendor and account type', () => {
    const { tallies, labels } = hist([
      { count: 4 },
      { count: 2, decisionAction: 'Reclassify', targetAccountKey: 'code:6150', targetAccountCode: '6150', targetAccountName: 'Breakroom' },
      { count: 1, decisionAction: 'DueToFrom', counterpartyEntityId: LEB },
      { count: 1, decisionAction: 'Keep' },
      { count: 5, accountType: 'Asset', accountKey: 'code:1000', accountCode: '1000', accountName: 'Checking' },
      { count: 9, vendorId: null },
    ]);
    expect(tallies.get('v-kroger|Expense')).toEqual({ 'acct:code:6100': 4 + DECISION_WEIGHT, 'acct:code:6150': 2 * DECISION_WEIGHT, [`due:${LEB}`]: DECISION_WEIGHT });
    // The bank side of the same purchases is tallied separately.
    expect(tallies.get('v-kroger|Asset')).toEqual({ 'acct:code:1000': 5 });
    expect(labels.get('code:6150')).toEqual({ code: '6150', name: 'Breakroom' });
  });

  test('strong history elsewhere suggests Reclassify; matching history confirms', () => {
    const history = hist([{ count: 19, accountKey: 'code:6150', accountCode: '6150', accountName: 'Breakroom' }]);
    const [moved, kept] = classify([acctLine(), acctLine({ lineId: 'l2', accountKey: 'code:6150', accountCode: '6150', accountName: 'Breakroom' })], history);
    expect(moved).toMatchObject({
      status: 'LikelyMisclassified', source: 'History', suggestedAction: 'Reclassify', suggestedAccountCode: '6150',
      suggestedAccountName: 'Breakroom', confidence: 0.95, currentEntityId: MIL, suggestedEntityId: null,
    });
    expect(moved.reasons[0]).toBe('History: 100% of 19 weighted past Expense lines for this vendor went to 6150 Breakroom');
    expect(kept).toMatchObject({ status: 'Confirmed', suggestedAction: 'Keep' });
  });

  test("another entity's keyword in the memo suggests Due To/From that entity", () => {
    const [r] = classify([acctLine({ memo: 'Main St office supplies' })], hist([]));
    expect(r).toMatchObject({
      status: 'LikelyMisclassified', source: 'Keyword', suggestedAction: 'DueToFrom', suggestedEntityId: LEB,
      suggestedAccountCode: '1500', suggestedAccountName: 'Due From Lebanon', confidence: 0.92,
    });
  });

  test("the file's own entity is never suggested, and a line already in the Due To/From account is confirmed", () => {
    expect(classify([acctLine({ memo: 'Route 50 order' })], hist([]))[0]).toMatchObject({ status: 'NeedsEvidence', suggestedAction: null, source: 'None' });
    const [r] = classify([acctLine({ memo: 'Main St', accountKey: 'code:1500', accountCode: '1500', accountName: 'Due From Lebanon' })], hist([]));
    expect(r).toMatchObject({ status: 'Confirmed', suggestedAction: 'Keep' });
  });

  test('a Due To/From suggestion without a set-up account says so', () => {
    const [r] = classify([acctLine({ memo: 'Lawrenceberg lunch' })], hist([]));
    expect(r).toMatchObject({ suggestedAction: 'DueToFrom', suggestedEntityId: LAW, suggestedAccountName: null });
    expect(r.reasons).toContain('Set the Due To/From account for Lawrenceburg to approve this');
  });

  test('stronger history beats a weak entity-name mention; two strong signals that disagree are a Conflict', () => {
    const strongHere = hist([{ count: 19 }]);
    // "Lebanon" alone is a bare name (85%); history says 6100 at 95%.
    expect(classify([acctLine({ memo: 'Lebanon' })], strongHere)[0]).toMatchObject({ status: 'Confirmed', source: 'History', suggestedAction: 'Keep' });
    // A keyword (92%) against 95% history elsewhere.
    const strongElsewhere = hist([{ count: 19, accountKey: 'code:6150', accountCode: '6150', accountName: 'Breakroom' }]);
    const [r] = classify([acctLine({ memo: 'Main St' })], strongElsewhere);
    expect(r.status).toBe('Conflict');
    expect(r.reasons).toContain('Conflict: the memo says Due To/From Lebanon, history says 6150 Breakroom');
  });

  test('thin history stays below the threshold', () => {
    const [r] = classify([acctLine()], hist([{ count: 2, accountKey: 'code:6150', accountCode: '6150', accountName: 'Breakroom' }]));
    expect(r).toMatchObject({ status: 'NeedsEvidence', suggestedAction: 'Reclassify', confidenceLevel: 'Low' });
  });
  test('Due To/From accounts are recognized by name, using entity names, aliases and keywords', () => {
    const terms = buildEntityTerms(ENTITIES);
    expect(dueAccountEntity(terms, '114008 Due from Lebanon')).toBe(LEB);
    expect(dueAccountEntity(terms, '274005 Due to Milford Pediatric Dentistry')).toBe(MIL);
    // The misspelled alias still finds Lawrenceburg.
    expect(dueAccountEntity(terms, 'Due from Lawrenceberg')).toBe(LAW);
    expect(dueAccountEntity(terms, 'Due to Benco')).toBeNull();
    expect(dueAccountEntity(terms, 'Dues, Licenses & Subscriptions')).toBeNull();
    expect(dueAccountEntity(terms, 'Lebanon Rent')).toBeNull();
  });

  test('detectDueToFromAccounts prefers "Due from" and skips the file\'s own entity', () => {
    const found = detectDueToFromAccounts(ENTITIES, MIL, [
      { key: 'code:274008', code: '274008', name: 'Due to Lebanon' },
      { key: 'code:114008', code: '114008', name: 'Due from Lebanon' },
      { key: 'code:114009', code: '114009', name: 'Due from Milford' },
      { key: 'code:274010', code: '274010', name: 'Due to Lawrenceberg' },
    ]);
    expect([...found.keys()].sort()).toEqual([LAW, LEB].sort());
    expect(found.get(LEB)).toEqual({ accountKey: 'code:114008', code: '114008', name: 'Due from Lebanon' });
    expect(found.get(LAW).name).toBe('Due to Lawrenceberg');
  });

  test('a line in a "Due to <entity>" account counts as Due To/From that entity, and so does its history', () => {
    const dueTo = { accountKey: 'code:274008', accountCode: '274008', accountName: 'Due to Lebanon', accountType: 'Liability' };
    const history = hist([{ count: 19, ...dueTo }]);
    // Saved default for Lebanon is the "Due From" account; the line sits in "Due to".
    const [r] = classify([acctLine({ ...dueTo, memo: 'Main St' })], history);
    expect(r).toMatchObject({ status: 'Confirmed', suggestedAction: 'Keep' });
    expect(r.reasons).toContain('History: 100% of 19 weighted past Liability lines for this vendor went to Due To/From Lebanon');
  });
});
