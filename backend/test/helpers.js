// Test helpers shared by the backend unit tests.

const CONTROLLER_ADMIN = {
  userId: 'user-paul',
  username: 'paul',
  role: 'SoftwareAdmin',
  groupId: null,
  groups: ['ControllerOwner'],
};

const PLAIN_ADMIN = { ...CONTROLLER_ADMIN, userId: 'user-other-admin', groups: [] };
const OWNER = { userId: 'user-owner', role: 'Owner', groupId: 'group-1', groups: [] };

// A jest.fn() standing in for pg's query(): the first route whose regex
// matches the SQL decides the result (an object, or a function of
// (sql, params) returning one, which may throw). Unmatched SQL returns no
// rows. Every call is recorded on fn.mock.calls as usual.
function sqlRouter(routes = []) {
  return jest.fn(async (sql, params) => {
    for (const [pattern, result] of routes) {
      if (pattern.test(sql)) return typeof result === 'function' ? result(sql, params) : result;
    }
    return { rows: [], rowCount: 0 };
  });
}

// Minimal API Gateway (REST, proxy) event.
function apiEvent({ method = 'GET', resource = '/', query = null, path = null, body } = {}) {
  return {
    httpMethod: method,
    resource,
    headers: { Authorization: 'Bearer test-token' },
    queryStringParameters: query,
    pathParameters: path,
    body: body === undefined ? null : JSON.stringify(body),
  };
}

const parseBody = (res) => (res.body ? JSON.parse(res.body) : null);

// SQL text of every call made through a jest.fn query mock.
const sqlOf = (mockFn) => mockFn.mock.calls.map(([sql]) => sql);

module.exports = { CONTROLLER_ADMIN, PLAIN_ADMIN, OWNER, sqlRouter, apiEvent, parseBody, sqlOf };
