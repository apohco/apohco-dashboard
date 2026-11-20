jest.mock('../../src/shared/db', () => ({ query: jest.fn() }));
jest.mock('../../src/shared/qboTokens', () => ({
  getValidAccessToken: jest.fn(),
  isRefreshTokenRejected: jest.requireActual('../../src/shared/qboTokens').isRefreshTokenRejected,
}));

const { query } = require('../../src/shared/db');
const { getValidAccessToken } = require('../../src/shared/qboTokens');
const { handler } = require('../../src/functions/qbo/refreshQBOTokens');
const { sqlRouter } = require('../helpers');

beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => {}));
afterEach(() => console.error.mockRestore());

test('force-refreshes every API-connected file and keeps going after a failure', async () => {
  query.mockImplementation(
    sqlRouter([
      [/FROM QBOs WHERE RefreshToken IS NOT NULL/, {
        rows: [
          { qboid: 'a', groupid: 'g', qboname: 'A' },
          { qboid: 'b', groupid: 'g', qboname: 'B' },
          { qboid: 'c', groupid: 'g', qboname: 'C' },
        ],
      }],
    ])
  );
  getValidAccessToken
    .mockResolvedValueOnce('t')
    .mockRejectedValueOnce({ response: { status: 400, data: { error: 'invalid_grant' } } })
    .mockResolvedValueOnce('t');

  await expect(handler()).resolves.toEqual({ refreshed: 2, failed: 1 });
  expect(getValidAccessToken.mock.calls).toEqual([
    ['a', { forceRefresh: true }],
    ['b', { forceRefresh: true }],
    ['c', { forceRefresh: true }],
  ]);

  const audit = query.mock.calls.find(([sql]) => /INSERT INTO CtrlAuditLog/.test(sql));
  expect(audit[1]).toEqual(expect.arrayContaining(['g', 'qbo.token_refresh_failed', 'QBO', 'b']));
  expect(JSON.parse(audit[1][5]).reason).toMatch(/reconnect/);
});

test('does nothing when no files are connected', async () => {
  query.mockImplementation(sqlRouter([]));
  await expect(handler()).resolves.toEqual({ refreshed: 0, failed: 0 });
  expect(getValidAccessToken).not.toHaveBeenCalled();
});
