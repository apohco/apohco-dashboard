const { query } = require('./db');

// Appends one entry to CtrlAuditLog. `db` may be a transaction client so
// the audit row commits or rolls back with the change it describes.
// userId is null for system actions (scheduled jobs, workers).
async function recordAudit(
  { groupId = null, userId = null, action, targetType = null, targetId = null, details = {} },
  db = { query }
) {
  if (!action) throw new Error('recordAudit requires an action');
  await db.query(
    `INSERT INTO CtrlAuditLog (GroupId, UserId, Action, TargetType, TargetId, Details)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [groupId, userId, action, targetType, targetId === null ? null : String(targetId), JSON.stringify(details)]
  );
}

module.exports = { recordAudit };
