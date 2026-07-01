const { query } = require('../../../shared/db');

const PRACTICE_ROLES = ['Owner', 'Manager', 'TeamMember'];

// Cognito Post Confirmation trigger — fires once a user (created via
// AdminCreateUser, since self-signup is disabled) confirms their account by
// setting a permanent password. Keeps the Users/GroupUsers tables in sync
// with Cognito so every UserId referenced elsewhere (QBOs.CreatedBy,
// Groups.CreatedBy, GroupUsers, ...) has a matching row, without requiring
// a manual SQL step per user. Cognito invokes this directly (not via API
// Gateway), so there's no JWT to verify here — trust comes from the
// resource-based Lambda permission scoped to this specific User Pool ARN.
exports.handler = async (event) => {
  const attrs = event.request.userAttributes;
  const userId = attrs.sub;
  const role = attrs['custom:role'];
  const groupId = attrs['custom:groupId'] || null;

  await query(
    `INSERT INTO Users (UserId, Username, Email, Role)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (UserId) DO UPDATE SET
       Username = EXCLUDED.Username,
       Email = EXCLUDED.Email,
       Role = EXCLUDED.Role`,
    [userId, event.userName, attrs.email, role]
  );

  if (groupId && PRACTICE_ROLES.includes(role)) {
    await query(
      `INSERT INTO GroupUsers (GroupId, UserId, Role)
       VALUES ($1, $2, $3)
       ON CONFLICT (GroupId, UserId) DO UPDATE SET Role = EXCLUDED.Role`,
      [groupId, userId, role]
    );
  }

  return event;
};
