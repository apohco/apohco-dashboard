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
