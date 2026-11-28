// Enforces role-based access at the API level. `claims` comes from
// verifyToken.requireAuth(). Throws a 403 if the caller's role isn't allowed.
function requireRole(claims, allowedRoles) {
  if (!allowedRoles.includes(claims.role)) {
    const err = new Error(`Role '${claims.role}' is not permitted to perform this action`);
    err.statusCode = 403;
    throw err;
  }
}

const PLATFORM_ROLES = ['SoftwareAdmin', 'SoftwareRep'];
const PRACTICE_ROLES = ['Owner', 'Manager', 'TeamMember'];
// Every role that may use the dashboard itself. The Accountant role (the
// AJE portal, Phase 5b) is deliberately not here: portal routes use
// portalData.authorizePortal, and every other route refuses it.
const DASHBOARD_ROLES = [...PLATFORM_ROLES, ...PRACTICE_ROLES];

// Platform-level roles (SoftwareAdmin, SoftwareRep) can act across any
// Group; practice-level roles (Owner, Manager, TeamMember) must match the
// requested GroupId to their own assigned GroupId. Any other role (e.g.
// Accountant) is refused outright, even if it somehow carried a groupId.
function requireGroupAccess(claims, requestedGroupId) {
  if (!DASHBOARD_ROLES.includes(claims.role)) {
    const err = new Error('Not authorized for this Group');
    err.statusCode = 403;
    throw err;
  }
  if (PLATFORM_ROLES.includes(claims.role)) return;

  if (!requestedGroupId || claims.groupId !== requestedGroupId) {
    const err = new Error('Not authorized for this Group');
    err.statusCode = 403;
    throw err;
  }
}

module.exports = { requireRole, requireGroupAccess, DASHBOARD_ROLES, PLATFORM_ROLES, PRACTICE_ROLES };
