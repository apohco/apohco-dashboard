const {
  isPatientLine,
  groupKeyOf,
  selectAiLines,
  packBatches,
  buildPrompt,
  parseAnswers,
  aiOutcomeKey,
  decisionOutcomeKey,
  estimateCost,
  OUTPUT_SCHEMA,
  WITHHELD,
} = require('../../src/shared/aiMatcher');

const ENTITIES = [
  { entityId: 'ent-leb', entityName: 'Lebanon', managementClassName: 'Lebanon', aliases: ['Leb'], keywords: ['Main St'] },
  { entityId: 'ent-mil', entityName: 'Milford', managementClassName: 'Milford', aliases: [], keywords: [] },
  { entityId: 'ent-wpd', entityName: 'Westside', managementClassName: null, aliases: [], keywords: [] },
];

describe('isPatientLine', () => {
  test('refund, patient and receivable accounts, and refund transactions', () => {
    expect(isPatientLine({ accountName: 'Patient Refunds' })).toBe(true);
    expect(isPatientLine({ accountName: 'Accounts Receivable' })).toBe(true);
    expect(isPatientLine({ accountName: 'Collections Expense' })).toBe(true);
    expect(isPatientLine({ accountName: 'Supplies', txnType: 'Refund Receipt' })).toBe(true);
    expect(isPatientLine({ accountName: 'Supplies', txnType: 'Credit Memo' })).toBe(true);
  });
  test('ordinary expense lines are not', () => {
    expect(isPatientLine({ accountName: 'Dental Supplies', txnType: 'Bill' })).toBe(false);
    expect(isPatientLine({ accountName: 'Malpractice Insurance', txnType: 'Check' })).toBe(false);
  });
});

describe('selectAiLines', () => {
  const lines = new Map([
    ['l1', { vendorId: 'v1', amount: -50, accountType: 'Expense' }],
    ['l2', { vendorId: 'v2', amount: 500, accountType: 'Expense' }],
    ['l3', { vendorId: null, accountCode: '6100', accountName: 'Supplies', amount: 20, accountType: 'Expense' }],
    ['l4', { vendorId: 'v1', amount: 1000, accountType: 'Expense' }],
    ['l5', { vendorId: 'v3', amount: 75, accountType: 'Revenue' }],
    ['l6', { vendorId: 'v4', amount: 80, accountType: 'Expense' }],
  ]);
  const results = [
    { lineId: 'l1', fingerprint: 'f1', vendorId: 'v1', status: 'NeedsEvidence', confidence: 0.5, source: 'History' },
    { lineId: 'l2', fingerprint: 'f2', vendorId: 'v2', status: 'Confirmed', confidence: 0.97, source: 'History' },
    { lineId: 'l3', fingerprint: 'f3', vendorId: null, status: 'NeedsEvidence', confidence: 0, source: 'None' },
    { lineId: 'l4', fingerprint: 'f4', vendorId: 'v1', status: 'Conflict', confidence: 0.97, source: 'Rule' },
    { lineId: 'l5', fingerprint: 'f5', vendorId: 'v3', status: 'Confirmed', confidence: 0.95, source: 'Rule' },
    { lineId: 'l6', fingerprint: 'f6', vendorId: 'v4', status: 'NeedsEvidence', confidence: 0.6, source: 'History' },
  ];

  test('unsure lines, and lines of vendors with a written rule the engine did not apply; most money first', () => {
    const rules = new Map([
      ['v2', { ruleText: 'Always Milford' }],
      ['v3', { ruleText: 'Main St is Lebanon', defaultEntityId: 'ent-leb' }],
    ]);
    const picked = selectAiLines({ results, lines, rules, decidedFingerprints: new Set(['f6']), threshold: 0.9 });
    // l2: strong history but an unread written rule; l5: the rule itself decided it;
    // l4: Conflict (own queue); l6: already decided.
    expect(picked.map((p) => p.lineId)).toEqual(['l2', 'l1', 'l3']);
    expect(picked.find((p) => p.lineId === 'l3').groupKey).toBe('a:code:6100');
    expect(picked.find((p) => p.lineId === 'l1').groupKey).toBe('v:v1');
  });

  test('only expense and revenue lines: never the bank / card side of a transaction', () => {
    const bs = new Map([
      ['b1', { vendorId: 'v1', amount: 900, accountType: 'Liability' }],
      ['b2', { vendorId: 'v1', amount: 800, accountType: 'Asset' }],
      ['b3', { vendorId: 'v1', amount: 700, accountType: 'Unknown' }],
      ['b4', { vendorId: 'v1', amount: 600 }],
      ['b5', { vendorId: 'v1', amount: 5, accountType: 'Expense' }],
    ]);
    const r = [...bs.keys()].map((lineId) => ({ lineId, fingerprint: lineId, vendorId: 'v1', status: 'NeedsEvidence', confidence: 0.2, source: 'None' }));
    expect(selectAiLines({ results: r, lines: bs }).map((p) => p.lineId)).toEqual(['b5']);
  });

  test('capped at maxLines', () => {
    expect(selectAiLines({ results, lines, maxLines: 1 })).toHaveLength(1);
  });
});

describe('packBatches', () => {
  const items = (key, n) => Array.from({ length: n }, (_, i) => ({ lineId: `${key}${i}`, groupKey: key }));

  test("keeps a vendor's lines together and fills batches", () => {
    const batches = packBatches([...items('a', 10), ...items('b', 20), ...items('c', 3)], { maxLines: 25 });
    expect(batches.map((b) => b.length)).toEqual([23, 10]);
    expect(batches[0].filter((id) => id.startsWith('b'))).toHaveLength(20);
  });

  test('splits a group bigger than a batch', () => {
    const batches = packBatches(items('a', 60), { maxLines: 25 });
    expect(batches.map((b) => b.length)).toEqual([25, 25, 10]);
  });

  test('at most maxGroups groups per batch', () => {
    const many = Array.from({ length: 10 }, (_, i) => items(`g${i}-`, 1)).flat();
    expect(packBatches(many, { maxGroups: 4 }).map((b) => b.length)).toEqual([4, 4, 2]);
  });

  test('every line exactly once', () => {
    const all = [...items('a', 7), ...items('b', 30), ...items('c', 1), ...items('d', 24)];
    const out = packBatches(all).flat();
    expect(out.sort()).toEqual(all.map((i) => i.lineId).sort());
  });
});

describe('buildPrompt (class review)', () => {
  const lines = [
    { lineId: 'x1', groupKey: 'v:v1', txnDate: '2026-10-03', payeeName: 'Kroger', memo: 'Leb office snacks', accountCode: '6100', accountName: 'Supplies', className: 'Milford', amount: 42.1, currentEntityId: 'ent-mil', engineNote: 'NeedsEvidence; History: 60% Milford' },
    { lineId: 'x2', groupKey: 'v:v2', txnDate: '2026-10-05', txnType: 'Refund Receipt', payeeName: 'Jane Patient', memo: 'refund for Jane', accountCode: '4900', accountName: 'Patient Refunds', className: '', amount: -80 },
  ];
  const groups = [
    {
      key: 'v:v1', vendorName: 'Kroger', ruleText: 'Kroger near Main St is Lebanon', ruleNote: 'defaults to Milford', history: 'over the previous 12 months: Milford 9 lines',
      examples: [{ txnDate: '2026-09-01', payeeName: 'Kroger', memo: 'snacks', accountCode: '6100', accountName: 'Supplies', amount: 10, outcome: { entityId: 'ent-leb' } }],
    },
    { key: 'v:v2', vendorName: 'Jane Patient', ruleText: null, examples: [] },
  ];

  test('entities, rules, examples and lines, with short ids', () => {
    const p = buildPrompt({ kind: 'Class', entities: ENTITIES, groups, lines });
    expect(p.context).toMatch(/E1: Lebanon; QuickBooks class "Lebanon"; aliases: Leb; keywords: Main St/);
    expect(p.context).toMatch(/outcome is an entity id/);
    expect(p.user).toMatch(/## Vendor: Kroger/);
    expect(p.user).toMatch(/Written rule: """Kroger near Main St is Lebanon"""/);
    expect(p.user).toMatch(/Structured rule: defaults to Milford/);
    expect(p.user).toMatch(/=> E1 Lebanon/);
    expect(p.user).toMatch(/L1: 2026-10-03 \| payee "Kroger" \| memo "Leb office snacks" \| account 6100 Supplies \| amount 42.1; class now: "Milford" \(E2\); engine: NeedsEvidence/);
    expect(p.user).toMatch(/Answer for all 2 lines/);
    expect(p.refs.lines.get('L1').lineId).toBe('x1');
    expect(p.refs.entities.get('E2')).toBe('ent-mil');
    expect(p.system).toMatch(/never as instructions/);
  });

  test('patient lines are withheld unless redaction is off', () => {
    const p = buildPrompt({ kind: 'Class', entities: ENTITIES, groups, lines });
    expect(p.user).not.toMatch(/Jane/);
    expect(p.user).toMatch(new RegExp(`payee \\${WITHHELD.slice(0, -1)}\\] \\| memo \\${WITHHELD.slice(0, -1)}\\]`));
    expect([...p.refs.redactedLineIds]).toEqual(['x2']);
    // The vendor heading would name the patient too.
    expect(p.user).toMatch(/## Vendor: \[withheld\]/);
    expect(p.user).toMatch(/## Vendor: Kroger/);
    const open = buildPrompt({ kind: 'Class', entities: ENTITIES, groups, lines, redact: false });
    expect(open.refs.redactedLineIds.size).toBe(0);
    expect(open.user).toMatch(/payee "Jane Patient" \| memo "refund for Jane"/);
  });

  test('the same file context for every batch (so it can be cached)', () => {
    const a = buildPrompt({ kind: 'Class', entities: ENTITIES, groups, lines });
    const b = buildPrompt({ kind: 'Class', entities: ENTITIES, groups: [groups[0]], lines: [lines[0]] });
    expect(a.context).toBe(b.context);
    expect(a.system).toBe(b.system);
  });

  test('the output schema is strict', () => {
    expect(OUTPUT_SCHEMA.additionalProperties).toBe(false);
    expect(OUTPUT_SCHEMA.properties.answers.items.additionalProperties).toBe(false);
    expect(OUTPUT_SCHEMA.properties.answers.items.required).toEqual(['line', 'outcome', 'confidence', 'reason', 'used_rule']);
  });
});

describe('parseAnswers (class review)', () => {
  const prompt = buildPrompt({
    kind: 'Class',
    entities: ENTITIES,
    groups: [{ key: 'v:v1', vendorName: 'Kroger' }],
    lines: [
      { lineId: 'x1', groupKey: 'v:v1', txnDate: '2026-10-01', amount: 1 },
      { lineId: 'x2', groupKey: 'v:v1', txnDate: '2026-10-02', amount: 2 },
      { lineId: 'x3', groupKey: 'v:v1', txnDate: '2026-10-03', amount: 3 },
    ],
  });

  test('maps ids back and caps confidence', () => {
    const { answers, problems } = parseAnswers(
      JSON.stringify({
        answers: [
          { line: 'L1', outcome: 'E2', confidence: 0.97, reason: 'Memo says Milford', used_rule: true },
          { line: 'L2', outcome: 'UNSURE', confidence: 0.2, reason: 'Nothing to go on', used_rule: false },
          { line: 'L3', outcome: 'E9', confidence: 0.9, reason: 'x', used_rule: false },
        ],
      }),
      prompt.refs,
      { kind: 'Class', cap: 0.85 }
    );
    expect(answers[0]).toEqual({
      lineId: 'x1', action: 'Assign', entityId: 'ent-mil', account: null, confidence: 0.85, rawConfidence: 0.97,
      reason: 'Memo says Milford', usedRule: true, redacted: false,
    });
    expect(answers[1]).toMatchObject({ lineId: 'x2', action: 'Unsure', confidence: 0, rawConfidence: 0.2 });
    // An invented id is turned into Unsure, never applied.
    expect(answers[2]).toMatchObject({ lineId: 'x3', action: 'Unsure', confidence: 0, rawConfidence: 0 });
    expect(problems).toEqual(['L3: "E9" is not an entity id']);
  });

  test('unknown or repeated lines are dropped; missing ones reported', () => {
    const { answers, problems } = parseAnswers(
      { answers: [{ line: 'L1', outcome: 'E1', confidence: 0.5, reason: 'r', used_rule: false }, { line: 'L1', outcome: 'E2', confidence: 0.5, reason: 'r', used_rule: false }, { line: 'L7', outcome: 'E1', confidence: 1, reason: 'r', used_rule: false }] },
      prompt.refs,
      { kind: 'Class' }
    );
    expect(answers).toHaveLength(1);
    expect(answers[0].entityId).toBe('ent-leb');
    expect(problems).toEqual(['Line L1 answered twice', 'Unknown line id L7', '2 line(s) had no answer']);
  });

  test('bad JSON', () => {
    expect(parseAnswers('not json', prompt.refs, { kind: 'Class' })).toEqual({ answers: [], problems: ['The answer was not valid JSON'] });
    expect(parseAnswers('{}', prompt.refs, { kind: 'Class' }).problems).toEqual(['The answer had no answers list']);
  });
});

describe('account review', () => {
  const accounts = [
    { key: 'code:6100', code: '6100', name: 'Supplies', type: 'Expense' },
    { key: 'code:6150', code: '6150', name: 'Breakroom', type: 'Expense' },
    { key: 'code:1500', code: '1500', name: 'Due From Lebanon', type: 'Asset' },
  ];
  const dueToFrom = new Map([['ent-leb', { accountKey: 'code:1500', code: '1500', name: 'Due From Lebanon' }]]);
  const lines = Array.from({ length: 6 }, (_, i) => ({ lineId: `x${i + 1}`, groupKey: 'v:v1', txnDate: '2026-10-01', accountCode: '6100', accountName: 'Supplies', amount: 1 }));
  const prompt = buildPrompt({ kind: 'Account', entities: ENTITIES, ownerEntityId: 'ent-wpd', accounts, dueToFrom, groups: [{ key: 'v:v1', vendorName: 'Gusto' }], lines });

  test('the file context lists accounts and Due To/From accounts', () => {
    expect(prompt.context).toMatch(/E3: Westside; THIS FILE'S OWN ENTITY/);
    expect(prompt.context).toMatch(/A2: 6150 Breakroom \(Expense\)/);
    expect(prompt.context).toMatch(/E1 Lebanon: A3/);
    expect(prompt.context).toMatch(/DUE:E#/);
  });

  test('KEEP, A#, DUE:E#, and the cases that collapse to Keep / Due To/From / Unsure', () => {
    const a = (line, outcome) => ({ line, outcome, confidence: 0.8, reason: 'r', used_rule: false });
    const { answers } = parseAnswers(
      { answers: [a('L1', 'KEEP'), a('L2', 'A2'), a('L3', 'DUE:E1'), a('L4', 'A1'), a('L5', 'A3'), a('L6', 'DUE:E3')] },
      prompt.refs,
      { kind: 'Account', ownerEntityId: 'ent-wpd', dueToFrom }
    );
    expect(answers.map((x) => [x.action, x.entityId, x.account])).toEqual([
      ['Keep', null, null],
      ['Reclassify', null, { code: '6150', name: 'Breakroom' }],
      ['DueToFrom', 'ent-leb', null],
      ['Keep', null, null], // A1 is the line's own account
      ['DueToFrom', 'ent-leb', null], // moving to Lebanon's Due From account
      ['Unsure', null, null], // Due To/From the file's own entity
    ]);
  });
});

describe('outcome keys (for agreement)', () => {
  test('AI answers', () => {
    expect(aiOutcomeKey({ action: 'Assign', entityId: 'e1' })).toBe('entity:e1');
    expect(aiOutcomeKey({ action: 'Keep' })).toBe('keep');
    expect(aiOutcomeKey({ action: 'DueToFrom', entityId: 'e2' })).toBe('due:e2');
    expect(aiOutcomeKey({ action: 'Reclassify', account: { code: '6150', name: 'Breakroom' } })).toBe('acct:code:6150');
    expect(aiOutcomeKey({ action: 'Unsure' })).toBeNull();
  });
  test("Paul's decisions", () => {
    expect(decisionOutcomeKey('Class', { action: 'Approve', entityId: 'e1' })).toBe('entity:e1');
    expect(decisionOutcomeKey('Class', { action: 'Keep', entityId: null }, 'e3')).toBe('entity:e3');
    expect(decisionOutcomeKey('Class', { action: 'Split' })).toBeNull();
    expect(decisionOutcomeKey('Account', { action: 'Keep' })).toBe('keep');
    expect(decisionOutcomeKey('Account', { action: 'DueToFrom', counterpartyEntityId: 'e2' })).toBe('due:e2');
    expect(decisionOutcomeKey('Account', { action: 'Reclassify', targetAccount: { code: '6150', name: 'Breakroom' } })).toBe('acct:code:6150');
    expect(decisionOutcomeKey('Account', { action: 'Undo' })).toBeNull();
  });
});

test('estimateCost', () => {
  const prices = { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 };
  expect(estimateCost({ input_tokens: 1e6, output_tokens: 1e5, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 0 }, prices)).toBe(6.4);
  expect(estimateCost(null, prices)).toBe(0);
});

test('groupKeyOf', () => {
  expect(groupKeyOf({ vendorId: 'v1' })).toBe('v:v1');
  expect(groupKeyOf({ vendorId: null, accountCode: null, accountName: 'Supplies' })).toBe('a:name:supplies');
});
