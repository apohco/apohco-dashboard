jest.mock('../../src/shared/verifyToken', () => ({ requireAuth: jest.fn() }));
jest.mock('../../src/shared/db', () => ({ query: jest.fn(), withTransaction: jest.fn() }));

const { requireAuth } = require('../../src/shared/verifyToken');
const { query, withTransaction } = require('../../src/shared/db');
const { handler, validateEntityBody, cleanList } = require('../../src/functions/controller/manageCtrlEntities');
const { CONTROLLER_ADMIN, OWNER, sqlRouter, apiEvent, parseBody, sqlOf } = require('../helpers');

const entityRow = { entityid: 'e1', entityname: 'Lebanon', aliases: ['Leb'], keywords: [], isactive: true };
let client;

function setup({ refsInGroup = true, clientRoutes = [] } = {}) {
  requireAuth.mockResolvedValue(CONTROLLER_ADMIN);
  query.mockImplementation(
    sqlRouter([
      [/SELECT 1 FROM/, { rows: refsInGroup ? [{}] : [] }],
      [/FROM CtrlEntities e/, { rows: [entityRow] }],
    ])
  );
  client = { query: sqlRouter(clientRoutes) };
  withTransaction.mockImplementation((fn) => fn(client));
}

describe('validation helpers', () => {
  test('cleanList trims, drops blanks and case-insensitive duplicates', () => {
    expect(cleanList([' Leb ', 'leb', '', 'Lebanon'], 'aliases')).toEqual(['Leb', 'Lebanon']);
    expect(cleanList(undefined, 'aliases')).toEqual([]);
    expect(() => cleanList('Leb', 'aliases')).toThrow(/list/);
    expect(() => cleanList(Array.from({ length: 51 }, (_, i) => `a${i}`), 'aliases')).toThrow(/at most/);
  });

  test('validateEntityBody requires a name and defaults the rest', () => {
    expect(() => validateEntityBody({ entityName: '  ' })).toThrow(/required/);
    expect(validateEntityBody({ entityName: ' Milford ' })).toEqual({
      entityName: 'Milford', practiceQboId: null, managementQboClassId: null, consolidationGroupId: null,
      aliases: [], keywords: [], isActive: true,
    });
    expect(() => validateEntityBody({ entityName: 'x', isActive: 'yes' })).toThrow(/isActive/);
  });
});

describe('access', () => {
  test('403 for an Owner', async () => {
    setup();
    requireAuth.mockResolvedValue(OWNER);
    const res = await handler(apiEvent({ method: 'GET', query: { groupId: 'group-1' } }));
    expect(res.statusCode).toBe(403);
  });
});

describe('GET', () => {
  test('lists entities with dropdown options, all scoped to the Group', async () => {
    setup();
    const res = await handler(apiEvent({ method: 'GET', query: { groupId: 'group-1' } }));
    const data = parseBody(res);
    expect(res.statusCode).toBe(200);
    expect(data.entities[0]).toMatchObject({ entityId: 'e1', entityName: 'Lebanon', aliases: ['Leb'] });
    expect(data.options).toEqual({ qbos: [], classes: [], consolidationGroups: [] });
    expect(query.mock.calls.every(([, params]) => params[0] === 'group-1')).toBe(true);
  });
});

describe('POST', () => {
  const post = (body) => apiEvent({ method: 'POST', body: { groupId: 'group-1', ...body } });

  test('creates an entity and audits it in the same transaction', async () => {
    setup({ clientRoutes: [[/INSERT INTO CtrlEntities/, { rows: [{ entityid: 'e1' }] }]] });
    const res = await handler(post({ entityName: 'Lebanon', practiceQboId: 'qbo-2', aliases: ['Leb'] }));
    expect(res.statusCode).toBe(201);
    expect(parseBody(res).entityId).toBe('e1');
    expect(sqlOf(client.query)).toEqual([expect.stringMatching(/INSERT INTO CtrlEntities/), expect.stringMatching(/INSERT INTO CtrlAuditLog/)]);
  });

  test('400 when a referenced QBO belongs to another Group', async () => {
    setup({ refsInGroup: false });
    const res = await handler(post({ entityName: 'Lebanon', practiceQboId: 'qbo-other' }));
    expect(res.statusCode).toBe(400);
    expect(withTransaction).not.toHaveBeenCalled();
  });

  test('409 for a duplicate name', async () => {
    setup({
      clientRoutes: [[/INSERT INTO CtrlEntities/, () => { throw Object.assign(new Error('dup'), { code: '23505' }); }]],
    });
    expect((await handler(post({ entityName: 'Lebanon' }))).statusCode).toBe(409);
  });
});

describe('PUT / DELETE', () => {
  test('PUT 404 when the entity is not in the Group', async () => {
    setup({ clientRoutes: [[/UPDATE CtrlEntities/, { rowCount: 0 }]] });
    const res = await handler(apiEvent({ method: 'PUT', path: { entityId: 'e9' }, body: { groupId: 'group-1', entityName: 'X' } }));
    expect(res.statusCode).toBe(404);
  });

  test('PUT updates and returns the entity', async () => {
    setup({ clientRoutes: [[/UPDATE CtrlEntities/, { rowCount: 1 }]] });
    const res = await handler(apiEvent({ method: 'PUT', path: { entityId: 'e1' }, body: { groupId: 'group-1', entityName: 'Lebanon' } }));
    expect(res.statusCode).toBe(200);
    expect(client.query.mock.calls[0][1].slice(0, 3)).toEqual(['group-1', 'e1', 'Lebanon']);
  });

  test('DELETE removes and audits', async () => {
    setup({ clientRoutes: [[/DELETE FROM CtrlEntities/, { rows: [{ entityname: 'Lebanon' }] }]] });
    const res = await handler(apiEvent({ method: 'DELETE', path: { entityId: 'e1' }, query: { groupId: 'group-1' } }));
    expect(res.statusCode).toBe(204);
    expect(sqlOf(client.query)[1]).toMatch(/INSERT INTO CtrlAuditLog/);
  });

  test('405 for an unsupported method', async () => {
    setup();
    const res = await handler(apiEvent({ method: 'PATCH', path: { entityId: 'e1' }, query: { groupId: 'group-1' } }));
    expect(res.statusCode).toBe(405);
  });
});
