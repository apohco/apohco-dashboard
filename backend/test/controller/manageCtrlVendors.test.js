jest.mock('../../src/shared/verifyToken', () => ({ requireAuth: jest.fn() }));
jest.mock('../../src/shared/db', () => ({ query: jest.fn(), withTransaction: jest.fn() }));

const { requireAuth } = require('../../src/shared/verifyToken');
const { query, withTransaction } = require('../../src/shared/db');
const { handler, validateVendorBody, sameRule } = require('../../src/functions/controller/manageCtrlVendors');
const { CONTROLLER_ADMIN, OWNER, sqlRouter, apiEvent, parseBody, sqlOf } = require('../helpers');

const V1 = '11111111-1111-1111-1111-111111111111';
const V2 = '22222222-2222-2222-2222-222222222222';
const ENTITY_IDS = new Set(['ent-leb', 'ent-mil']);

let client;
function setup({ latestRule = null, vendors = { [V1]: 'Kroger', [V2]: 'KROGER #2' } } = {}) {
  requireAuth.mockResolvedValue(CONTROLLER_ADMIN);
  query.mockImplementation(
    sqlRouter([
      [/FROM CtrlEntities/, { rows: [{ entityid: 'ent-leb', entityname: 'Lebanon' }, { entityid: 'ent-mil', entityname: 'Milford' }] }],
      [/FROM CtrlVendors v/, { rows: [{ vendorid: V1, displayname: 'Kroger', watchmode: false, splittemplate: null, aliases: ['Kroger', 'KROGER #2'], ruleid: 'r1', version: 1, defaultentityid: 'ent-leb', hints: { keywords: [] }, ruletext: 'Mostly Lebanon' }] }],
    ])
  );
  client = {
    query: sqlRouter([
      [/SELECT VendorId, DisplayName, MergedIntoVendorId FROM CtrlVendors/, (sql, params) => ({ rows: vendors[params[0]] ? [{ vendorid: params[0], displayname: vendors[params[0]], mergedintovendorid: null }] : [] })],
      [/FROM CtrlVendorRules/, { rows: latestRule ? [latestRule] : [] }],
      [/UPDATE CtrlVendorAliases/, { rowCount: 2 }],
    ]),
  };
  withTransaction.mockImplementation((fn) => fn(client));
}
const put = (vendorId, body) =>
  handler(apiEvent({ method: 'PUT', resource: '/api/controller/vendors/{vendorId}', path: { vendorId }, body: { groupId: 'group-1', ...body } }));

describe('validation', () => {
  test('split template must use different entities and add up to 100%', () => {
    expect(validateVendorBody({ splitTemplate: [{ entityId: 'ent-leb', percent: 60 }, { entityId: 'ent-mil', percent: 40 }] }, ENTITY_IDS).splitTemplate).toHaveLength(2);
    expect(validateVendorBody({ splitTemplate: [] }, ENTITY_IDS).splitTemplate).toBeNull();
    expect(() => validateVendorBody({ splitTemplate: [{ entityId: 'ent-leb', percent: 60 }, { entityId: 'ent-mil', percent: 30 }] }, ENTITY_IDS)).toThrow(/100/);
    expect(() => validateVendorBody({ splitTemplate: [{ entityId: 'ent-leb', percent: 50 }, { entityId: 'ent-leb', percent: 50 }] }, ENTITY_IDS)).toThrow(/different/);
  });

  test('rule keywords need an entity and 3+ characters; blanks are dropped', () => {
    const { rule } = validateVendorBody({ rule: { keywords: [{ keyword: ' Main St ', entityId: 'ent-leb' }, { keyword: '', entityId: '' }], ruleText: '  ' } }, ENTITY_IDS);
    expect(rule).toEqual({ defaultEntityId: null, keywords: [{ keyword: 'Main St', entityId: 'ent-leb' }], ruleText: null });
    expect(() => validateVendorBody({ rule: { keywords: [{ keyword: 'ab', entityId: 'ent-leb' }] } }, ENTITY_IDS)).toThrow(/3 to 100/);
    expect(() => validateVendorBody({ rule: { defaultEntityId: 'nope' } }, ENTITY_IDS)).toThrow(/active entity/);
  });

  test('sameRule compares the saved rule with the new one', () => {
    const rule = { defaultEntityId: 'ent-leb', keywords: [], ruleText: 'x' };
    expect(sameRule({ defaultentityid: 'ent-leb', hints: { keywords: [] }, ruletext: 'x' }, rule)).toBe(true);
    expect(sameRule({ defaultentityid: 'ent-mil', hints: { keywords: [] }, ruletext: 'x' }, rule)).toBe(false);
    expect(sameRule(undefined, rule)).toBe(false);
  });
});

test('403 for an Owner', async () => {
  setup();
  requireAuth.mockResolvedValue(OWNER);
  expect((await handler(apiEvent({ method: 'GET', resource: '/api/controller/vendors', query: { groupId: 'group-1' } }))).statusCode).toBe(403);
});

test('lists vendors with their aliases and current rule', async () => {
  setup();
  const data = parseBody(await handler(apiEvent({ method: 'GET', resource: '/api/controller/vendors', query: { groupId: 'group-1' } })));
  expect(data.vendors[0]).toMatchObject({ vendorId: V1, aliases: ['Kroger', 'KROGER #2'], rule: { version: 1, defaultEntityId: 'ent-leb', ruleText: 'Mostly Lebanon' } });
  expect(data.entities).toHaveLength(2);
});

describe('PUT /api/controller/vendors/{vendorId}', () => {
  test('a changed rule is saved as the next version', async () => {
    setup({ latestRule: { version: 3, defaultentityid: 'ent-leb', hints: { keywords: [] }, ruletext: null } });
    const res = await put(V1, { watchMode: true, rule: { defaultEntityId: 'ent-mil', keywords: [], ruleText: '' } });
    expect(parseBody(res)).toEqual({ vendorId: V1, ruleVersion: 4 });
    const insert = client.query.mock.calls.find(([sql]) => /INSERT INTO CtrlVendorRules/.test(sql));
    expect(insert[1].slice(2, 4)).toEqual([4, 'ent-mil']);
    expect(sqlOf(client.query).some((s) => /UPDATE CtrlVendors SET WatchMode/.test(s))).toBe(true);
  });

  test('an unchanged rule adds no version', async () => {
    setup({ latestRule: { version: 3, defaultentityid: 'ent-leb', hints: { keywords: [] }, ruletext: null } });
    const res = await put(V1, { rule: { defaultEntityId: 'ent-leb', keywords: [], ruleText: '' } });
    expect(parseBody(res).ruleVersion).toBeNull();
    expect(sqlOf(client.query).some((s) => /INSERT INTO CtrlVendorRules/.test(s))).toBe(false);
  });

  test('unknown vendor is a 404', async () => {
    setup();
    expect((await put('33333333-3333-3333-3333-333333333333', { watchMode: true })).statusCode).toBe(404);
  });
});

describe('Phase 2b: stats, profile and rule test', () => {
  const stored = (over) => ({
    lineid: over.lineid, qboid: 'qbo-mgmt', month: '2026-09', fingerprint: over.lineid, txndate: '2026-09-02', payeename: 'Kroger', payeekey: 'kroger',
    memo: '', accountcode: '6100', accountname: 'Supplies', classname: 'Milford', qboclassid: 'cls-mil', amount: '50', accounttype: 'Expense', action: null, ...over,
  });
  const LINES = [
    stored({ lineid: 'a' }),
    stored({ lineid: 'b', month: '2026-10', action: 'Reassign', decisionentityid: 'ent-leb' }),
    stored({ lineid: 'c', month: '2026-10', action: 'Approve', decisionentityid: 'ent-mil' }),
    stored({ lineid: 'd', month: '2026-10', accounttype: 'Asset', accountname: 'Checking', amount: '-150' }),
    stored({ lineid: 'e', accounttype: 'Asset', accountname: 'Checking', action: 'Reassign', decisionentityid: 'ent-leb', scope: 'Relabel' }),
  ];
  function profileSetup() {
    setup();
    query.mockImplementation(
      sqlRouter([
        [/FROM CtrlEntities e/, { rows: [
          { entityid: 'ent-leb', entityname: 'Lebanon', managementqboclassid: 'cls-leb', managementclassname: 'Lebanon', aliases: [], keywords: [] },
          { entityid: 'ent-mil', entityname: 'Milford', managementqboclassid: 'cls-mil', managementclassname: 'Milford', aliases: [], keywords: [] },
        ] }],
        [/FROM CtrlEntities/, { rows: [{ entityid: 'ent-leb', entityname: 'Lebanon' }, { entityid: 'ent-mil', entityname: 'Milford' }] }],
        [/FROM CtrlVendors WHERE VendorId/, { rows: [{ vendorid: V1, displayname: 'Kroger', watchmode: false, splittemplate: null, mergedintovendorid: null }] }],
        [/SELECT PayeeKey, PayeeName FROM CtrlVendorAliases/, { rows: [{ payeekey: 'kroger', payeename: 'Kroger' }] }],
        [/FROM QBOs WHERE GroupId/, { rows: [{ qboid: 'qbo-mgmt', qboname: 'APOHCO', isclassbased: true }] }],
        [/FROM CtrlVendorRules r LEFT JOIN Users/, { rows: [
          { ruleid: 'r2', version: 2, defaultentityid: 'ent-leb', hints: { keywords: [] }, ruletext: 'v2', rulewins: true, createddate: 'd2', createdby: 'paul' },
          { ruleid: 'r1', version: 1, defaultentityid: 'ent-mil', hints: { keywords: [] }, ruletext: 'v1', rulewins: false, createddate: 'd1', createdby: 'paul' },
        ] }],
        [/SELECT DISTINCT QBOId, TO_CHAR\(Period/, { rows: [{ qboid: 'qbo-mgmt', month: '2026-09' }, { qboid: 'qbo-mgmt', month: '2026-10' }] }],
        [/WITH snaps AS/, { rows: LINES }],
        [/d.Scope = 'Relabel'/, { rows: [{ runid: 'run-1', entityid: 'ent-leb', requestaje: false, decidedat: 'now', decidedby: 'paul', linecount: 37, amount: '4210.5', frommonth: '2026-01', tomonth: '2026-09' }] }],
        [/FROM CtrlDecisions d/, { rows: [{ decisionid: 'd1', action: 'Reassign', entityid: 'ent-leb', scope: 'Line', decidedat: 'now', decidedby: 'paul', qboname: 'APOHCO', txndate: '2026-10-02', memo: '', amount: '50', classname: 'Milford', accountcode: '6100', accountname: 'Supplies' }] }],
        [/FROM CtrlReviewSettings/, { rows: [] }],
      ])
    );
  }

  test('the list carries 12-month spend and review stats', async () => {
    setup();
    query.mockImplementation(
      sqlRouter([
        [/FROM CtrlEntities/, { rows: [] }],
        [/COUNT\(\*\)::int AS LineCount/, { rows: [{ vendorid: V1, linecount: 12, spend: '345.678' }] }],
        [/AS Reviewed/, { rows: [{ vendorid: V1, reviewed: 10, decided: 4, avgconfidence: '0.8123' }] }],
        [/FROM CtrlVendors v/, { rows: [{ vendorid: V1, displayname: 'Kroger', aliases: [], ruleid: null }, { vendorid: V2, displayname: 'Other', aliases: [], ruleid: null }] }],
      ])
    );
    const data = parseBody(await handler(apiEvent({ method: 'GET', resource: '/api/controller/vendors', query: { groupId: 'group-1' } })));
    expect(data.vendors[0].stats).toEqual({ spend12: 345.68, lineCount12: 12, reviewed: 10, decided: 4, reviewedPct: 0.4, avgConfidence: 0.812 });
    expect(data.vendors[1].stats).toMatchObject({ spend12: 0, reviewedPct: null });
  });

  test('profile: rule versions, expense split by month after decisions, approval rate, corrections', async () => {
    profileSetup();
    const res = await handler(apiEvent({ method: 'GET', resource: '/api/controller/vendors/{vendorId}', path: { vendorId: V1 }, query: { groupId: 'group-1' } }));
    const data = parseBody(res);
    expect(res.statusCode).toBe(200);
    expect(data.ruleVersions.map((r) => [r.version, r.ruleWins])).toEqual([[2, true], [1, false]]);
    // The Asset (bank) side is not spend.
    expect(data.entitySplit).toEqual([
      { month: '2026-09', entityId: 'ent-mil', amount: 50 },
      { month: '2026-10', entityId: 'ent-leb', amount: 50 },
      { month: '2026-10', entityId: 'ent-mil', amount: 50 },
    ]);
    // The relabeled line is counted on its own, not as a correction.
    expect(data.outcome).toEqual({ approved: 1, corrected: 1, relabeled: 1, open: 2, approvalRate: 0.5 });
    expect(data.relabels).toEqual([{ runId: 'run-1', entityId: 'ent-leb', requestAje: false, decidedAt: 'now', decidedBy: 'paul', lineCount: 37, amount: 4210.5, fromMonth: '2026-01', toMonth: '2026-09' }]);
    const corrections = query.mock.calls.find(([sql]) => /LIMIT 100/.test(sql))[0];
    expect(corrections).toMatch(/d.Scope = 'Line'/);
    expect(data.corrections[0]).toMatchObject({ action: 'Reassign', actionText: 'Set entity', decidedBy: 'paul', amount: 50 });
  });

  test('rule test previews the last N months of class-based files without saving', async () => {
    profileSetup();
    const res = await handler(apiEvent({
      method: 'POST', resource: '/api/controller/vendors/{vendorId}/rules/test', path: { vendorId: V1 },
      body: { groupId: 'group-1', months: 3, rule: { defaultEntityId: 'ent-leb', keywords: [] } },
    }));
    const data = parseBody(res);
    expect(res.statusCode).toBe(200);
    expect(data).toMatchObject({ months: 3, fromMonth: '2026-08', toMonth: '2026-10', lineCount: 5, wouldChange: 3, unchanged: 2 });
    const lines = query.mock.calls.find(([sql]) => /WITH snaps AS/.test(sql))[1];
    expect(lines.slice(0, 3)).toEqual(['group-1', '2026-08-01', '2026-10-01']);
    expect(withTransaction).not.toHaveBeenCalled();
  });

  test('rule test validation', async () => {
    profileSetup();
    const send = (body) => handler(apiEvent({ method: 'POST', resource: '/api/controller/vendors/{vendorId}/rules/test', path: { vendorId: V1 }, body: { groupId: 'group-1', ...body } }));
    expect((await send({ months: 2 })).statusCode).toBe(400);
    expect((await send({ rule: { defaultEntityId: 'nope' } })).statusCode).toBe(400);
  });
});

describe('merge', () => {
  const merge = (vendorId, fromVendorId) =>
    handler(apiEvent({ method: 'POST', resource: '/api/controller/vendors/{vendorId}/merge', path: { vendorId }, body: { groupId: 'group-1', fromVendorId } }));

  test('moves the aliases and marks the other profile merged (nothing deleted)', async () => {
    setup();
    const res = await merge(V1, V2);
    expect(res.statusCode).toBe(200);
    const sql = sqlOf(client.query);
    expect(sql.some((s) => /UPDATE CtrlVendorAliases SET VendorId/.test(s))).toBe(true);
    expect(sql.some((s) => /SET MergedIntoVendorId/.test(s))).toBe(true);
    expect(sql.some((s) => /DELETE/.test(s))).toBe(false);
  });

  test('cannot merge a vendor into itself', async () => {
    setup();
    expect((await merge(V1, V1)).statusCode).toBe(400);
  });
});
