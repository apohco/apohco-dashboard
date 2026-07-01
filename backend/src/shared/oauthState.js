const crypto = require('crypto');
const { getSecretJson } = require('./secretsManager');

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

async function getStateSecret() {
  const { oauthStateSecret } = await getSecretJson(process.env.APP_SECRETS_ARN);
  return oauthStateSecret;
}

// The QBO OAuth `state` param round-trips through Intuit's servers and the
// user's browser, so it can't carry an Authorization header. Instead we
// HMAC-sign a payload (GroupId, UserId, and the pending QBO config) so the
// callback can trust it without a separate lookup table, and reject it if
// tampered with or expired.
async function signState(payload) {
  const secret = await getStateSecret();
  const body = JSON.stringify({ ...payload, iat: Date.now() });
  const bodyB64 = Buffer.from(body).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(bodyB64).digest('base64url');
  return `${bodyB64}.${signature}`;
}

async function verifyState(state) {
  if (!state || !state.includes('.')) {
    const err = new Error('Missing or malformed OAuth state');
    err.statusCode = 400;
    throw err;
  }

  const secret = await getStateSecret();
  const [bodyB64, signature] = state.split('.');
  const expectedSignature = crypto.createHmac('sha256', secret).update(bodyB64).digest('base64url');

  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expectedSignature);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    const err = new Error('Invalid OAuth state signature');
    err.statusCode = 400;
    throw err;
  }

  const payload = JSON.parse(Buffer.from(bodyB64, 'base64url').toString('utf8'));
  if (Date.now() - payload.iat > STATE_TTL_MS) {
    const err = new Error('OAuth state has expired');
    err.statusCode = 400;
    throw err;
  }

  return payload;
}

module.exports = { signState, verifyState };
