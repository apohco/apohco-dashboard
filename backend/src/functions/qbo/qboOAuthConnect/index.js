const { requireAuth } = require('../../../shared/verifyToken');
const { requireRole, requireGroupAccess } = require('../../../shared/authorize');
const { signState } = require('../../../shared/oauthState');
const { buildAuthorizeUrl } = require('../../../shared/qboClient');
const { json, withErrorHandling } = require('../../../shared/response');

// POST /api/qbo/connect
// Body: { groupId, qboName, isClassBased }
// Returns the Intuit authorization URL the frontend should redirect the
// browser to. Only Software Rep / Software Admin can set up QBO connections.
exports.handler = withErrorHandling(async (event) => {
  const claims = await requireAuth(event);
  requireRole(claims, ['SoftwareRep', 'SoftwareAdmin']);

  const body = JSON.parse(event.body || '{}');
  const { groupId, qboName, isClassBased } = body;

  if (!groupId || !qboName) {
    const err = new Error('groupId and qboName are required');
    err.statusCode = 400;
    throw err;
  }

  requireGroupAccess(claims, groupId);

  const state = await signState({
    groupId,
    userId: claims.userId,
    qboName,
    isClassBased: Boolean(isClassBased),
  });

  const authUrl = await buildAuthorizeUrl(state);

  return json(200, { authUrl });
});
