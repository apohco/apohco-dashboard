// Guard: the Accountant role (Phase 5b AJE portal) may use ONLY the
// /api/controller/portal/... routes. Every other API route in template.yaml
// is called here as an accountant and must refuse with 403 before touching
// the database. If this fails, a route has been added that an accountant
// can reach: give it a requireRole() / requireGroupAccess() check.
const fs = require('fs');
const path = require('path');

jest.mock('../../src/shared/verifyToken', () => ({ requireAuth: jest.fn() }));
jest.mock('../../src/shared/db', () => ({ query: jest.fn(), withTransaction: jest.fn(), getPool: jest.fn() }));

const { requireAuth } = require('../../src/shared/verifyToken');
const db = require('../../src/shared/db');

const ROOT = path.join(__dirname, '..', '..');
const G = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';

// Routes authenticated some other way (no Cognito JWT): the QBO OAuth
// redirect is validated by its signed state parameter.
const NOT_JWT = ['src/functions/qbo/qboOAuthCallback/index.handler'];
const PORTAL = 'src/functions/controller/ctrlPortal/index.handler';

// Handler -> [{ path, method }] from template.yaml (a light line parser;
// the template's !Ref tags rule out a plain YAML load).
function apiRoutes() {
  const lines = fs.readFileSync(path.join(ROOT, 'template.yaml'), 'utf8').split(/\r?\n/);
  const out = [];
  let handler = null;
  let pending = null;
  for (const line of lines) {
    const h = line.match(/^\s+Handler:\s+(\S+)/);
    if (h) handler = h[1];
    if (/^  [A-Za-z0-9]+:\s*$/.test(line)) handler = null; // next top-level resource
    const p = line.match(/^\s+Path:\s+(\/api\/\S+)/);
    if (p) pending = p[1];
    const m = line.match(/^\s+Method:\s+(\w+)/);
    if (m && pending && handler) {
      const method = m[1].toUpperCase();
      for (const verb of method === 'ANY' ? ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] : [method]) out.push({ handler, path: pending, method: verb, any: method === 'ANY' });
      pending = null;
    }
  }
  return out;
}

const routes = apiRoutes();
const guarded = routes.filter((r) => !NOT_JWT.includes(r.handler) && r.handler !== PORTAL);

function eventFor({ path: resource, method }) {
  const params = Object.fromEntries([...resource.matchAll(/\{(\w+)\}/g)].map(([, name]) => [name, name === 'action' ? 'disable' : ID]));
  return {
    httpMethod: method,
    resource,
    headers: { Authorization: 'Bearer accountant-token' },
    queryStringParameters: { groupId: G, qboId: ID, month: '2026-10', statement: 'PL', reportViewId: ID },
    pathParameters: Object.keys(params).length ? params : null,
    body: JSON.stringify({
      groupId: G, qboId: ID, month: '2026-10', entityType: 'qbo', entityId: ID, statement: 'PL', reportViewId: ID, viewName: 'x',
      rows: [{ tempId: 't1', rowType: 'Grouping', label: 'x', groupingId: ID }],
      periods: [{ label: 'Oct', startDate: '2026-10-01', endDate: '2026-10-31' }],
    }),
  };
}

const loadHandler = (handler) => require(path.join(ROOT, handler.replace(/\.handler$/, ''))).handler;

beforeEach(() => {
  db.query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  db.withTransaction.mockReset().mockImplementation(async (fn) => fn({ query: db.query }));
});

test('the template parse found the dashboard, Controller and portal routes', () => {
  expect(guarded.length).toBeGreaterThan(60);
  expect(routes.filter((r) => r.handler === PORTAL).map((r) => r.path)).toEqual(
    expect.arrayContaining(['/api/controller/portal/reports', '/api/controller/portal/entries/{entryId}/status'])
  );
  expect(guarded.some((r) => r.path === '/api/profit-and-loss' || r.path.includes('profit'))).toBe(true);
});

describe.each([
  ['an accountant (no groupId)', { userId: 'u-acct', username: 'cpa', role: 'Accountant', groupId: null, groups: [] }],
  ['an accountant carrying a stray groupId', { userId: 'u-acct', username: 'cpa', role: 'Accountant', groupId: G, groups: [] }],
  ['an accountant in the ControllerOwner group', { userId: 'u-acct', username: 'cpa', role: 'Accountant', groupId: G, groups: ['ControllerOwner'] }],
])('%s', (_, claims) => {
  test.each(guarded.map((r) => [`${r.method} ${r.path}`, r]))('%s is refused', async (_name, route) => {
    requireAuth.mockResolvedValue(claims);
    const res = await loadHandler(route.handler)(eventFor(route));
    // 405: a verb an "any" route doesn't implement, refused before any data access.
    expect(route.any && res.statusCode === 405 ? 403 : res.statusCode).toBe(403);
    expect(db.query).not.toHaveBeenCalled();
  });
});
