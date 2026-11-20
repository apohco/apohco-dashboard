jest.mock('../../src/shared/db', () => ({ withTransaction: jest.fn() }));
jest.mock('../../src/shared/crypto', () => ({
  encrypt: jest.fn(async (v) => `enc(${v})`),
  decrypt: jest.fn(async (v) => v.replace(/^enc\((.*)\)$/, '$1')),
}));
jest.mock('../../src/shared/qboClient', () => ({ refreshAccessToken: jest.fn() }));

const { withTransaction } = require('../../src/shared/db');
const { refreshAccessToken } = require('../../src/shared/qboClient');
const { getValidAccessToken, isRefreshTokenRejected } = require('../../src/shared/qboTokens');
const { sqlRouter } = require('../helpers');

const NOW = Date.parse('2026-11-19T12:00:00Z');
const now = () => NOW;

function setup(qboRow) {
  const client = { query: sqlRouter([[/FOR UPDATE/, { rows: qboRow ? [qboRow] : [] }]]) };
  withTransaction.mockImplementation((fn) => fn(client));
  return client;
}

const row = (expiresInMs) => ({
  qboid: 'qbo-1',
  accesstoken: 'enc(old-access)',
  refreshtoken: 'enc(old-refresh)',
  tokenexpiry: new Date(NOW + expiresInMs).toISOString(),
});

describe('getValidAccessToken', () => {
  test('locks the QBO row while checking the token', async () => {
    const client = setup(row(60 * 60 * 1000));
    await getValidAccessToken('qbo-1', { now });
    const [sql, params] = client.query.mock.calls[0];
    expect(sql).toMatch(/SELECT .* FROM QBOs WHERE QBOId = \$1 FOR UPDATE/s);
    expect(params).toEqual(['qbo-1']);
  });

  test('returns the stored token when it is not about to expire', async () => {
    setup(row(60 * 60 * 1000));
    await expect(getValidAccessToken('qbo-1', { now })).resolves.toBe('old-access');
    expect(refreshAccessToken).not.toHaveBeenCalled();
  });

  test('refreshes and saves rotated tokens (encrypted) when expiring within 5 minutes', async () => {
    const client = setup(row(2 * 60 * 1000));
    refreshAccessToken.mockResolvedValue({ accessToken: 'new-access', refreshToken: 'new-refresh', expiresInSeconds: 3600 });

    await expect(getValidAccessToken('qbo-1', { now })).resolves.toBe('new-access');
    expect(refreshAccessToken).toHaveBeenCalledWith('old-refresh');

    const update = client.query.mock.calls.find(([sql]) => /UPDATE QBOs/.test(sql));
    expect(update[1]).toEqual(['enc(new-access)', 'enc(new-refresh)', new Date(NOW + 3600 * 1000).toISOString(), 'qbo-1']);
  });

  test('forceRefresh renews even a valid token', async () => {
    setup(row(60 * 60 * 1000));
    refreshAccessToken.mockResolvedValue({ accessToken: 'a2', refreshToken: 'r2', expiresInSeconds: 3600 });
    await expect(getValidAccessToken('qbo-1', { now, forceRefresh: true })).resolves.toBe('a2');
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
  });

  test('404 when the QBO does not exist', async () => {
    setup(null);
    await expect(getValidAccessToken('missing', { now })).rejects.toMatchObject({ statusCode: 404 });
  });

  test('400 for a manual-upload QBO with no OAuth tokens', async () => {
    setup({ qboid: 'qbo-1', accesstoken: null, refreshtoken: null, tokenexpiry: null });
    await expect(getValidAccessToken('qbo-1', { now })).rejects.toMatchObject({ statusCode: 400 });
  });

  test('a failed refresh saves nothing', async () => {
    const client = setup(row(0));
    refreshAccessToken.mockRejectedValue(new Error('boom'));
    await expect(getValidAccessToken('qbo-1', { now })).rejects.toThrow('boom');
    expect(client.query.mock.calls.some(([sql]) => /UPDATE QBOs/.test(sql))).toBe(false);
  });
});

describe('isRefreshTokenRejected', () => {
  test('recognises Intuit invalid_grant', () => {
    expect(isRefreshTokenRejected({ response: { status: 400, data: { error: 'invalid_grant' } } })).toBe(true);
    expect(isRefreshTokenRejected({ response: { status: 500, data: {} } })).toBe(false);
    expect(isRefreshTokenRejected(new Error('network'))).toBe(false);
  });
});
