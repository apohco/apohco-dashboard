-- Audit trail for Settings > Users (user management, SoftwareAdmin only).
-- Records every invite, edit, disable/enable, authenticator reset and
-- password reset: who did it, to which username, and what changed.
-- No foreign keys, so entries survive changes to the users they describe;
-- append-only via the trigger function created in 007.
CREATE TABLE UserAdminAuditLog (
    AuditId UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ActorUserId UUID,
    ActorUsername VARCHAR(100),
    Action VARCHAR(100) NOT NULL,
    TargetUsername VARCHAR(100) NOT NULL,
    Details JSONB NOT NULL DEFAULT '{}'::jsonb,
    CreatedDate TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_useradminauditlog_target ON UserAdminAuditLog(TargetUsername, CreatedDate DESC);

CREATE TRIGGER trg_useradminauditlog_no_update_delete
    BEFORE UPDATE OR DELETE ON UserAdminAuditLog
    FOR EACH ROW EXECUTE FUNCTION ctrl_reject_modification();
