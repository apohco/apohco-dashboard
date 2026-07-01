const { verifyState } = require('../../../shared/oauthState');
const { exchangeCodeForTokens } = require('../../../shared/qboClient');
const { encrypt } = require('../../../shared/crypto');
const { query } = require('../../../shared/db');
const { redirect } = require('../../../shared/response');

const SETTINGS_URL = () => `${process.env.FRONTEND_URL}/settings/qbo-setup`;

// GET /api/qbo/callback
// Intuit redirects the user's browser here after they approve/deny access,
// so this route is NOT behind the Cognito authorizer (the browser has no
// Cognito token at this point) — trust is established via the signed
// `state` param instead (see shared/oauthState.js).
exports.handler = async (event) => {
  const qs = event.queryStringParameters || {};

  if (qs.error) {
    return redirect(`${SETTINGS_URL()}?error=${encodeURIComponent(qs.error)}`);
  }

  try {
    const { code, realmId, state } = qs;
    if (!code || !realmId || !state) {
      throw new Error('Missing code, realmId, or state from QBO callback');
    }

    const { groupId, userId, qboName, isClassBased } = await verifyState(state);

    const { accessToken, refreshToken, expiresInSeconds } = await exchangeCodeForTokens(code);
    const encryptedAccessToken = await encrypt(accessToken);
    const encryptedRefreshToken = await encrypt(refreshToken);
    const tokenExpiry = new Date(Date.now() + expiresInSeconds * 1000).toISOString();

    const result = await query(
      `INSERT INTO QBOs (GroupId, QBOName, RealmId, IsClassBased, AccessToken, RefreshToken, TokenExpiry, CreatedBy)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (GroupId, RealmId) DO UPDATE SET
         QBOName = EXCLUDED.QBOName,
         IsClassBased = EXCLUDED.IsClassBased,
         AccessToken = EXCLUDED.AccessToken,
         RefreshToken = EXCLUDED.RefreshToken,
         TokenExpiry = EXCLUDED.TokenExpiry
       RETURNING QBOId`,
      [groupId, qboName, realmId, isClassBased, encryptedAccessToken, encryptedRefreshToken, tokenExpiry, userId]
    );

    const qboId = result.rows[0].qboid;
    return redirect(`${SETTINGS_URL()}?connected=1&qboId=${qboId}`);
  } catch (err) {
    console.error(err);
    return redirect(`${SETTINGS_URL()}?error=${encodeURIComponent(err.message)}`);
  }
};
