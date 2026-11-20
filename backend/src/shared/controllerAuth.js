const { requireAuth } = require('./verifyToken');
const { requireRole } = require('./authorize');

// The Controller module can search company email and files (from Phase 4
// on), so access is deliberately narrower than "SoftwareAdmin": the caller
// must be a SoftwareAdmin AND a member of the ControllerOwner Cognito
// group, which only Paul is added to. A future second SoftwareAdmin gets
// nothing here unless explicitly added to that group.
const CONTROLLER_ROLES = ['SoftwareAdmin'];
const CONTROLLER_COGNITO_GROUP = 'ControllerOwner';

function requireControllerOwner(claims) {
  if (!(claims.groups || []).includes(CONTROLLER_COGNITO_GROUP)) {
    const err = new Error('Not authorized for the Controller module');
    err.statusCode = 403;
    throw err;
  }
}

// requireAuth -> requireRole -> requireControllerOwner. Each handler still
// calls requireGroupAccess itself once it knows which Group the request is
// about.
async function authorizeController(event) {
  const claims = await requireAuth(event);
  requireRole(claims, CONTROLLER_ROLES);
  requireControllerOwner(claims);
  return claims;
}

module.exports = { authorizeController, requireControllerOwner, CONTROLLER_ROLES, CONTROLLER_COGNITO_GROUP };
