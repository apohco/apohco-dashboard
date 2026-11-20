const { withTransaction } = require('./db');
const { encrypt, decrypt } = require('./crypto');
const { refreshAccessToken } = require('./qboClient');

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // refresh if expiring within 5 minutes

function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

// Returns a usable QBO access token for `qboId`, refreshing it first when
// it's about to expire (or always, with forceRefresh).
//
// The QBOs row is locked (SELECT ... FOR UPDATE) for the whole
// check-refresh-save sequence. Intuit rotates the refresh token on every
// use and the old one stops working, so two concurrent refreshes (a
// dashboard sync and a Controller worker, or the daily refresh job) could
// otherwise each spend the same refresh token and one of them would save a
// token that's already dead, disconnecting the file. With the lock, the
// second caller waits, then sees the freshly saved token and reuses it.
async function getValidAccessToken(qboId, { forceRefresh = false, now = () => Date.now() } = {}) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT QBOId, AccessToken, RefreshToken, TokenExpiry FROM QBOs WHERE QBOId = $1 FOR UPDATE`,
      [qboId]
    );
    const qbo = rows[0];
    if (!qbo) throw httpError(404, 'QBO not found');
    if (!qbo.refreshtoken) {
      throw httpError(400, 'This QBO is not connected through the QuickBooks API (manual upload only)');
    }

    const expiry = qbo.tokenexpiry ? new Date(qbo.tokenexpiry).getTime() : 0;
    if (!forceRefresh && qbo.accesstoken && expiry - now() > TOKEN_REFRESH_BUFFER_MS) {
      return decrypt(qbo.accesstoken);
    }

    const refreshed = await refreshAccessToken(await decrypt(qbo.refreshtoken));
    const newTokenExpiry = new Date(now() + refreshed.expiresInSeconds * 1000).toISOString();

    await client.query(
      `UPDATE QBOs SET AccessToken = $1, RefreshToken = $2, TokenExpiry = $3 WHERE QBOId = $4`,
      [await encrypt(refreshed.accessToken), await encrypt(refreshed.refreshToken), newTokenExpiry, qboId]
    );

    return refreshed.accessToken;
  });
}

// True when Intuit rejected the refresh token itself (revoked, expired
// after ~100 days unused, or already rotated). Retrying can't fix that;
// someone has to reconnect the file in Settings > QBO API Setup.
function isRefreshTokenRejected(err) {
  return err?.response?.status === 400 && err?.response?.data?.error === 'invalid_grant';
}

module.exports = { getValidAccessToken, isRefreshTokenRejected, TOKEN_REFRESH_BUFFER_MS };
