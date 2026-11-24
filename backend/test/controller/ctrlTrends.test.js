jest.mock('../../src/shared/verifyToken', () => ({ requireAuth: jest.fn() }));
jest.mock('../../src/shared/db', () => ({ query: jest.fn(), withTransaction: jest.fn() }));

const { requireAuth } = require('../../src/shared/verifyToken');
const { query } = require('../../src/shared/db');
const { handler, attributeLines } = require('../../src/functions/controller/ctrlTrends');
const { buildEntityResolver } = require('../../src/shared/reviewEngine');
const { CONTROLLER_ADMIN, OWNER, sqlRouter, apiEvent, parseBody } = require('../helpers');

const ENTITIES = [
  { entityId: 'ent-leb', entityName: 'Lebanon', managementQboClassId: 'cls-leb', managementClassName: 'Lebanon', aliases: [], keywords: [] },
  { entityId: 'ent-mil', entityName: 'Milford', managementQboClassId: 'cls-mil', managementClassName: 'Milford', aliases: [], keywords: [] },
];
const line = (over) => ({
  lineId: over.lineId || 'l', qboId: 'mgmt', month: '2026-10', payeeName: 'Kroger', payeeKey: 'kroger', accountCode: '6100', accountName: 'Supplies',
  className: 'Lebanon', qboClassId: 'cls-leb', amount: 100, accountType: 'Expense', decision: null, ...over,
});

describe('attributeLines', () => {
  const files = new Map([
    ['mgmt', { isClassBased: true, ownerEntityId: null }],
    ['mil-file', { isClassBased: false, ownerEntityId: 'ent-mil' }],
  ]);
  const vendorKeys = new Map([['kroger', { vendorId: 'v1', displayName: 'Kroger Co' }]]);
  const accountTypes = new Map([['mil-file', new Map([['code:1500', 'Asset'], ['code:6150', 'Expense']])]]);
  const attr = (lines) => attributeLines({ lines, files, resolve: buildEntityResolver(ENTITIES), vendorKeys, accountTypes });

  test('expense lines only, attributed by class, practice file, or decision', () => {
    const rows = attr([
      line({}),
      line({ accountType: 'Asset' }),
      line({ qboId: 'mil-file', className: '' }),
      line({ qboId: 'mil-file', className: '', decision: { action: 'DueToFrom', counterpartyEntityId: 'ent-leb' } }),
      line({ payeeName: 'Unknown Co', payeeKey: 'unknown co' }),
    ]);
    expect(rows.map((r) => [r.entityId, r.vendorKey, r.vendorName])).toEqual([
      ['ent-leb', 'v:v1', 'Kroger Co'],
      ['ent-mil', 'v:v1', 'Kroger Co'],
      ['ent-leb', 'v:v1', 'Kroger Co'],
      ['ent-leb', 'p:unknown co', 'Unknown Co'],
    ]);
  });

  test('a reclassified line follows its new account (and drops out if that is not an expense)', () => {
    const rows = attr([
      line({ qboId: 'mil-file', decision: { action: 'Reclassify', targetAccount: { code: '6150', name: 'Breakroom' } } }),
      line({ qboId: 'mil-file', decision: { action: 'Reclassify', targetAccount: { code: '1500', name: 'Due From Lebanon' } } }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ accountKey: 'code:6150', accountLabel: '6150 Breakroom' });
  });
});

describe('GET /api/controller/trends', () => {
  const STORED = ['2026-07', '2026-08', '2026-09', '2026-10'].map((month) => ({ qboid: 'mgmt', month }));
  const STORED_LINES = [
    ...['2026-07', '2026-08', '2026-09'].map((month, i) => ({
      lineid: `r${i}`, qboid: 'mgmt', month, fingerprint: `r${i}`, payeename: 'Landlord', payeekey: 'landlord', accountcode: '7000', accountname: 'Rent',
      classname: 'Lebanon', qboclassid: 'cls-leb', amount: '3000', accounttype: 'Expense', action: null,
    })),
    { lineid: 'n', qboid: 'mgmt', month: '2026-10', fingerprint: 'n', payeename: 'New Co', payeekey: 'new co', accountcode: '6100', accountname: 'Supplies', classname: 'Milford', qboclassid: 'cls-mil', amount: '80', accounttype: 'Expense', action: null },
  ];
  function setup() {
    requireAuth.mockResolvedValue(CONTROLLER_ADMIN);
    query.mockImplementation(
      sqlRouter([
        [/FROM CtrlReviewSettings/, { rows: [] }],
        [/SELECT DISTINCT QBOId, TO_CHAR\(Period/, { rows: STORED }],
        [/FROM CtrlEntities e/, { rows: [
          { entityid: 'ent-leb', entityname: 'Lebanon', managementqboclassid: 'cls-leb', managementclassname: 'Lebanon', aliases: [], keywords: [] },
          { entityid: 'ent-mil', entityname: 'Milford', managementqboclassid: 'cls-mil', managementclassname: 'Milford', aliases: [], keywords: [] },
        ] }],
        [/FROM QBOs WHERE GroupId/, { rows: [{ qboid: 'mgmt', qboname: 'APOHCO', isclassbased: true }] }],
        [/WITH snaps AS/, { rows: STORED_LINES }],
        [/MIN\(s.Period\)/, { rows: [{ payeekey: 'landlord', firstmonth: '2026-07' }, { payeekey: 'new co', firstmonth: '2026-10' }] }],
      ])
    );
  }

  test('403 for an Owner', async () => {
    setup();
    requireAuth.mockResolvedValue(OWNER);
    expect((await handler(apiEvent({ method: 'GET', resource: '/api/controller/trends', query: { groupId: 'group-1' } }))).statusCode).toBe(403);
  });

  test('defaults to the latest stored month and returns charts and checks', async () => {
    setup();
    const data = parseBody(await handler(apiEvent({ method: 'GET', resource: '/api/controller/trends', query: { groupId: 'group-1' } })));
    expect(data.month).toBe('2026-10');
    expect(data.months).toEqual(['2026-07', '2026-08', '2026-09', '2026-10']);
    expect(data.settings).toEqual({ splitShiftPoints: 25, spikePercent: 50, spikeMinAmount: 500, recurringMonths: 3, baselineMonths: 6 });
    expect(data.anomalies.map((a) => a.type)).toEqual(['MissingRecurring', 'NewVendor']);
    expect(data.anomalies[0]).toMatchObject({ vendorName: 'Landlord', amount: 3000, qboId: 'mgmt' });
    // The window covers the chart and the baseline.
    const lines = query.mock.calls.find(([sql]) => /WITH snaps AS/.test(sql))[1];
    expect(lines.slice(0, 3)).toEqual(['group-1', '2025-11-01', '2026-10-01']);
  });

  test('bad month', async () => {
    setup();
    expect((await handler(apiEvent({ method: 'GET', resource: '/api/controller/trends', query: { groupId: 'group-1', month: '10/2026' } }))).statusCode).toBe(400);
  });
});
