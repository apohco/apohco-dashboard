jest.mock('../../src/shared/verifyToken', () => ({ requireAuth: jest.fn() }));
jest.mock('../../src/shared/db', () => ({ query: jest.fn(), withTransaction: jest.fn() }));

const { requireAuth } = require('../../src/shared/verifyToken');
const { query, withTransaction } = require('../../src/shared/db');
const { handler } = require('../../src/functions/controller/ctrlConflicts');
const { CONTROLLER_ADMIN, OWNER, sqlRouter, apiEvent, parseBody } = require('../helpers');

const RUN_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const L1 = '11111111-1111-1111-1111-111111111111';
const L2 = '22222222-2222-2222-2222-222222222222';
const ENTITY_ROWS = [
  { entityid: 'ent-leb', entityname: 'Lebanon', managementqboclassid: 'cls-leb', managementclassname: 'Lebanon', aliases: [], keywords: [] },
  { entityid: 'ent-mil', entityname: 'Milford', managementqboclassid: 'cls-mil', managementclassname: 'Milford', aliases: [], keywords: [] },
];
const RUN = { runid: RUN_ID, qboid: 'qbo-mgmt', month: '2026-10', snapshotid: 's', threshold: '0.9', mediumthreshold: '0.7', reviewkind: 'Class' };
// A Kroger conflict: class Milford; rule v2 says Lebanon; history says Milford.
const conflict = (over = {}) => ({
  lineid: L1, fingerprint: 'f1', vendorid: 'v-kroger', currententityid: 'ent-mil', suggestedentityid: 'ent-leb', confidence: '0.95',
  reasons: ['Conflict: ...'], txndate: '2026-10-03', payeename: 'Kroger', memo: 'breakroom', accountcode: '6100', accountname: 'Supplies',
  classname: 'Milford', qboclassid: 'cls-mil', amount: '42.10', vendorname: 'Kroger', decisionaction: null, ...over,
});
const RULE = { ruleid: 'r2', vendorid: 'v-kroger', version: 2, defaultentityid: 'ent-leb', hints: { keywords: [] }, ruletext: 'Kroger is Lebanon', rulewins: false };
// September: two Kroger lines in Milford, one already Lebanon.
const SEPT_LINES = [
  { lineid: 'old-1', qboid: 'qbo-mgmt', month: '2026-09', fingerprint: 'o1', payeename: 'Kroger', payeekey: 'kroger', memo: '', classname: 'Milford', qboclassid: 'cls-mil', amount: '10', accounttype: 'Expense' },
  { lineid: 'old-2', qboid: 'qbo-mgmt', month: '2026-09', fingerprint: 'o2', payeename: 'Kroger', payeekey: 'kroger', memo: '', classname: 'Milford', qboclassid: 'cls-mil', amount: '-5', accounttype: 'Expense' },
  { lineid: 'old-3', qboid: 'qbo-mgmt', month: '2026-09', fingerprint: 'o3', payeename: 'Kroger', payeekey: 'kroger', memo: '', classname: 'Lebanon', qboclassid: 'cls-leb', amount: '7', accounttype: 'Expense' },
];

let client;
function setup({ run = RUN, conflicts = [conflict()], rule = RULE } = {}) {
  requireAuth.mockResolvedValue(CONTROLLER_ADMIN);
  query.mockImplementation(
    sqlRouter([
      [/FROM CtrlReviewRuns WHERE RunId/, { rows: [run] }],
      [/FROM CtrlEntities e/, { rows: ENTITY_ROWS }],
      [/FROM CtrlReviewSettings/, { rows: [] }],
      [/s.Status = 'Conflict'/, (sql, params) => ({ rows: params[3] ? conflicts.filter((c) => c.lineid === params[3]) : conflicts })],
      [/FROM CtrlVendorRules/, { rows: rule ? [rule] : [] }],
      [/FROM CtrlVendorAliases a JOIN CtrlVendors/, { rows: [{ payeekey: 'kroger', vendorid: 'v-kroger', displayname: 'Kroger' }] }],
      [/SELECT PayeeKey FROM CtrlVendorAliases/, { rows: [{ payeekey: 'kroger' }] }],
      // History: 19 Kroger lines in Milford.
      [/WITH snaps AS \(\s+SELECT DISTINCT ON \(Period\)/, { rows: [{ payeename: 'Kroger', accountcode: '6100', classname: 'Milford', qboclassid: 'cls-mil', action: null, n: 19 }] }],
      [/WITH snaps AS \(\s+SELECT DISTINCT ON \(QBOId, Period\)/, { rows: SEPT_LINES }],
    ])
  );
  client = {
    query: sqlRouter([[/SELECT Version, DefaultEntityId, Hints, RuleText FROM CtrlVendorRules/, { rows: [{ version: 2, defaultentityid: 'ent-leb', hints: { keywords: [] }, ruletext: 'Kroger is Lebanon' }] }]]),
  };
  withTransaction.mockImplementation((fn) => fn(client));
}
const inserts = (table) => client.query.mock.calls.filter(([sql]) => new RegExp(`INSERT INTO ${table}`).test(sql)).map(([, p]) => p);
const post = (lineId, action, body) =>
  handler(apiEvent({ method: 'POST', resource: `/api/controller/conflicts/{lineId}/${action}`, path: { lineId }, body: { groupId: 'group-1', runId: RUN_ID, ...body } }));

test('403 for an Owner', async () => {
  setup();
  requireAuth.mockResolvedValue(OWNER);
  expect((await handler(apiEvent({ method: 'GET', resource: '/api/controller/conflicts', query: { groupId: 'group-1', runId: RUN_ID } }))).statusCode).toBe(403);
});

test('lists conflicts with the rule and the history side by side', async () => {
  setup();
  const data = parseBody(await handler(apiEvent({ method: 'GET', resource: '/api/controller/conflicts', query: { groupId: 'group-1', runId: RUN_ID } })));
  expect(data.conflicts).toHaveLength(1);
  expect(data.conflicts[0]).toMatchObject({
    lineId: L1, vendorName: 'Kroger', amount: 42.1,
    rule: { version: 2, text: 'Kroger is Lebanon', entityId: 'ent-leb', ruleWins: false },
    history: { scope: 'account', total: 19, shares: [{ entityId: 'ent-mil', weight: 19, share: 1 }] },
  });
});

test('an account review has no rule conflicts', async () => {
  setup({ run: { ...RUN, reviewkind: 'Account' } });
  const data = parseBody(await handler(apiEvent({ method: 'GET', resource: '/api/controller/conflicts', query: { groupId: 'group-1', runId: RUN_ID } })));
  expect(data.conflicts).toEqual([]);
  expect((await post(L1, 'resolve', { resolution: 'LineOnly', entityId: 'ent-leb' })).statusCode).toBe(400);
});

test('preview shows what relabeling history would change (nothing saved)', async () => {
  setup();
  const data = parseBody(await post(L1, 'preview', {}));
  expect(data).toMatchObject({ count: 2, amount: 15, months: ['2026-09'], previouslyDecided: 0, skippedSplits: 0, ruleVersion: 2 });
  expect(data.sample.map((s) => [s.lineId, s.fromEntityId, s.toEntityId])).toEqual([['old-1', 'ent-mil', 'ent-leb'], ['old-2', 'ent-mil', 'ent-leb']]);
  expect(withTransaction).not.toHaveBeenCalled();
});

describe('resolve', () => {
  test('this transaction only: one decision, any entity', async () => {
    setup();
    const res = await post(L1, 'resolve', { resolution: 'LineOnly', entityId: 'ent-mil' });
    expect(parseBody(res)).toEqual({ resolution: 'LineOnly', decided: 1, relabeled: 0, ruleVersion: null });
    // Milford is the current class, so it is a Keep.
    expect(inserts('CtrlDecisions')[0]).toEqual(['group-1', 'qbo-mgmt', 'f1', L1, RUN_ID, 'Keep', 'ent-mil', null, 'user-paul', 'Line', true, 'LineOnly']);
    expect(inserts('CtrlVendorRules')).toEqual([]);
  });

  test('rule wins: a new rule version that takes priority, and this month\'s open conflicts follow the rule', async () => {
    setup({ conflicts: [conflict(), conflict({ lineid: L2, fingerprint: 'f2' }), conflict({ lineid: '33333333-3333-3333-3333-333333333333', fingerprint: 'f3', decisionaction: 'Keep' })] });
    const res = await post(L1, 'resolve', { resolution: 'RuleWins' });
    expect(parseBody(res)).toEqual({ resolution: 'RuleWins', ruleVersion: 3, decided: 2, relabeled: 0 });
    const ruleInsert = client.query.mock.calls.find(([sql]) => /INSERT INTO CtrlVendorRules/.test(sql));
    expect(ruleInsert[0]).toMatch(/true/);
    expect(ruleInsert[1]).toEqual(['group-1', 'v-kroger', 3, 'ent-leb', '{"keywords":[]}', 'Kroger is Lebanon', 'user-paul']);
    const d = inserts('CtrlDecisions')[0];
    expect(d.slice(0, 12)).toEqual(['group-1', 'qbo-mgmt', 'f1', L1, RUN_ID, 'Reassign', 'ent-leb', null, 'user-paul', 'Line', true, 'RuleWins']);
    expect(d.slice(12, 14)).toEqual(['group-1', 'qbo-mgmt']);
  });

  test('a rule that already takes priority gets no new version', async () => {
    setup({ rule: { ...RULE, rulewins: true } });
    const res = await post(L1, 'resolve', { resolution: 'RuleWins' });
    expect(parseBody(res).ruleVersion).toBe(2);
    expect(inserts('CtrlVendorRules')).toEqual([]);
  });

  test('rule wins and relabel: earlier lines get Relabel decisions, with the AJE request Paul chose', async () => {
    setup();
    const res = await post(L1, 'resolve', { resolution: 'RuleWinsRelabel', expectedRelabelCount: 2, requestAje: true });
    expect(parseBody(res)).toEqual({ resolution: 'RuleWinsRelabel', ruleVersion: 3, decided: 1, relabeled: 2 });
    const [, relabel] = inserts('CtrlDecisions');
    expect(relabel.slice(0, 12)).toEqual(['group-1', 'qbo-mgmt', 'o1', 'old-1', RUN_ID, 'Reassign', 'ent-leb', null, 'user-paul', 'Relabel', true, 'RuleWinsRelabel']);
    expect(relabel.slice(12, 24)).toEqual(['group-1', 'qbo-mgmt', 'o2', 'old-2', RUN_ID, 'Reassign', 'ent-leb', null, 'user-paul', 'Relabel', true, 'RuleWinsRelabel']);
  });

  test('relabel without the AJE request stores RequestAje false', async () => {
    setup();
    await post(L1, 'resolve', { resolution: 'RuleWinsRelabel', expectedRelabelCount: 2 });
    expect(inserts('CtrlDecisions')[1][10]).toBe(false);
  });

  test('relabel stops if the lines changed since the preview', async () => {
    setup();
    const res = await post(L1, 'resolve', { resolution: 'RuleWinsRelabel', expectedRelabelCount: 5 });
    expect(res.statusCode).toBe(409);
    expect(withTransaction).not.toHaveBeenCalled();
  });

  test('validation', async () => {
    setup();
    expect((await post(L1, 'resolve', { resolution: 'Whatever' })).statusCode).toBe(400);
    expect((await post(L1, 'resolve', { resolution: 'LineOnly', entityId: 'ent-x' })).statusCode).toBe(400);
    expect((await post(L2, 'resolve', { resolution: 'LineOnly', entityId: 'ent-leb' })).statusCode).toBe(404);
    setup({ rule: null });
    expect((await post(L1, 'resolve', { resolution: 'RuleWins' })).statusCode).toBe(400);
  });
});

test('never writes to the dashboard tables or QuickBooks', () => {
  const src = require('fs').readFileSync(require.resolve('../../src/functions/controller/ctrlConflicts'), 'utf8');
  expect(src).not.toMatch(/(INSERT INTO|UPDATE|DELETE FROM)\s+(RawTransactions|ChartOfAccountsMappings|QBOClasses|QBOs)\b/i);
  expect(src).not.toMatch(/qboClient/);
});
