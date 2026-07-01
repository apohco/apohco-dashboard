const { CognitoJwtVerifier } = require('aws-jwt-verify');

// Even though API Gateway's Cognito authorizer already rejects
// unauthenticated requests before the Lambda runs, every function
// re-verifies the token itself (per project policy) so claims can be
// trusted regardless of how the function is invoked.
let verifier = null;

function getVerifier() {
  if (!verifier) {
    verifier = CognitoJwtVerifier.create({
      userPoolId: process.env.COGNITO_USER_POOL_ID,
      tokenUse: 'id',
      clientId: process.env.COGNITO_CLIENT_ID,
    });
  }
  return verifier;
}

function extractToken(event) {
  const header = event.headers?.Authorization || event.headers?.authorization;
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  return token;
}

// Verifies the Cognito ID token on the request and returns normalized
// claims: { userId, username, email, role, groupId }.
// Throws if the header is missing or the token fails verification.
async function requireAuth(event) {
  const token = extractToken(event);
  if (!token) {
    const err = new Error('Missing or malformed Authorization header');
    err.statusCode = 401;
    throw err;
  }

  let payload;
  try {
    payload = await getVerifier().verify(token);
  } catch (err) {
    const authErr = new Error('Invalid or expired token');
    authErr.statusCode = 401;
    throw authErr;
  }

  return {
    userId: payload.sub,
    username: payload['cognito:username'] || payload.username,
    email: payload.email,
    role: payload['custom:role'],
    groupId: payload['custom:groupId'] || null,
  };
}

module.exports = { requireAuth };
