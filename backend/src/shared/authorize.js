// Enforces role-based access at the API level. `claims` comes from
// verifyToken.requireAuth(). Throws a 403 if the caller's role isn't allowed.
function requireRole(claims, allowedRoles) {
  if (!allowedRoles.includes(claims.role)) {
    const err = new Error(`Role '${claims.role}' is not permitted to perform this action`);
    err.statusCode = 403;
    throw err;
  }
}

// Platform-level roles (SoftwareAdmin, SoftwareRep) can act across any
// Group; practice-level roles (Owner, Manager, TeamMember) must match the
// requested GroupId to their own assigned GroupId.
function requireGroupAccess(claims, requestedGroupId) {
  const platformRoles = ['SoftwareAdmin', 'SoftwareRep'];
  if (platformRoles.includes(claims.role)) return;

  if (!requestedGroupId || claims.groupId !== requestedGroupId) {
    const err = new Error('Not authorized for this Group');
    err.statusCode = 403;
    throw err;
  }
}

module.exports = { requireRole, requireGroupAccess };
