-- Controller Phase 5b: the accountant AJE portal.
--
-- Accountants are Cognito users with custom:role = 'Accountant' and NO
-- custom:groupId, so every existing dashboard route (which checks the
-- caller's groupId) refuses them. What they can see is kept here instead:
-- CtrlAccountantAccess lists their Groups and, optionally, the QBO files
-- within each. Only /api/controller/portal/... reads it.
--
-- Entry statuses and question threads are append-only histories: the
-- current status is the latest row, and nothing is edited in place.

-- Users.Role gains 'Accountant' (the constraint name was generated in 001,
-- so it's looked up rather than assumed).
DO $$
DECLARE c TEXT;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'users'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%role%'
  LOOP
    EXECUTE format('ALTER TABLE Users DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE Users ADD CONSTRAINT users_role_check
    CHECK (Role IN ('SoftwareAdmin', 'SoftwareRep', 'Owner', 'Manager', 'TeamMember', 'Accountant'));

-- One row per accountant login. UserId is the Cognito sub (known when the
-- invite is created); there's no FK to Users because that row only appears
-- at first sign-in. Accountants are deactivated, never deleted, so their
-- statuses and comments keep a name.
CREATE TABLE CtrlAccountants (
    AccountantId UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    Username VARCHAR(100) NOT NULL,
    UserId UUID NOT NULL UNIQUE,
    FullName VARCHAR(200) NOT NULL CHECK (length(btrim(FullName)) > 0),
    Email VARCHAR(255) NOT NULL,
    Firm VARCHAR(200),
    Active BOOLEAN NOT NULL DEFAULT true,
    NotifyByEmail BOOLEAN NOT NULL DEFAULT true,
    CreatedBy UUID,
    CreatedAt TIMESTAMPTZ NOT NULL DEFAULT now(),
    UpdatedBy UUID,
    UpdatedAt TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_ctrlaccountants_username ON CtrlAccountants (lower(Username));

-- Which Groups (and files) an accountant can see. QBOIds NULL = every file
-- in the Group, including files added later.
CREATE TABLE CtrlAccountantAccess (
    AccountantId UUID NOT NULL REFERENCES CtrlAccountants(AccountantId) ON DELETE CASCADE,
    GroupId UUID NOT NULL REFERENCES Groups(GroupId) ON DELETE CASCADE,
    QBOIds UUID[] CHECK (QBOIds IS NULL OR cardinality(QBOIds) > 0),
    UpdatedBy UUID,
    UpdatedAt TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (AccountantId, GroupId)
);
CREATE INDEX idx_ctrlaccountantaccess_group ON CtrlAccountantAccess (GroupId);

-- Entry status history (NotWorked / Booked / Declined). Declined needs a reason.
CREATE TABLE CtrlAjeEntryStatus (
    StatusId UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    EntryId UUID NOT NULL REFERENCES CtrlAjeEntries(EntryId) ON DELETE CASCADE,
    ReportId UUID NOT NULL REFERENCES CtrlAjeReports(ReportId) ON DELETE CASCADE,
    GroupId UUID NOT NULL REFERENCES Groups(GroupId) ON DELETE CASCADE,
    Status VARCHAR(10) NOT NULL CHECK (Status IN ('NotWorked', 'Booked', 'Declined')),
    Reason TEXT CHECK (Reason IS NULL OR length(Reason) <= 2000),
    SetByUserId UUID NOT NULL,
    SetByName VARCHAR(200) NOT NULL,
    SetAt TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (Status <> 'Declined' OR length(btrim(coalesce(Reason, ''))) > 0)
);
CREATE INDEX idx_ctrlajeentrystatus_entry ON CtrlAjeEntryStatus (EntryId, SetAt DESC);
CREATE INDEX idx_ctrlajeentrystatus_report ON CtrlAjeEntryStatus (ReportId);

-- Question threads. An entry has a question open while its latest comment
-- is from an accountant.
CREATE TABLE CtrlAjeComments (
    CommentId UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    EntryId UUID NOT NULL REFERENCES CtrlAjeEntries(EntryId) ON DELETE CASCADE,
    ReportId UUID NOT NULL REFERENCES CtrlAjeReports(ReportId) ON DELETE CASCADE,
    GroupId UUID NOT NULL REFERENCES Groups(GroupId) ON DELETE CASCADE,
    AuthorUserId UUID NOT NULL,
    AuthorName VARCHAR(200) NOT NULL,
    AuthorRole VARCHAR(12) NOT NULL CHECK (AuthorRole IN ('Accountant', 'Controller')),
    Body TEXT NOT NULL CHECK (length(btrim(Body)) BETWEEN 1 AND 4000),
    CreatedAt TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ctrlajecomments_entry ON CtrlAjeComments (EntryId, CreatedAt);
CREATE INDEX idx_ctrlajecomments_group ON CtrlAjeComments (GroupId, CreatedAt DESC);

CREATE TRIGGER trg_ctrlajeentrystatus_no_update
    BEFORE UPDATE ON CtrlAjeEntryStatus
    FOR EACH ROW EXECUTE FUNCTION ctrl_reject_modification();
CREATE TRIGGER trg_ctrlajecomments_no_update
    BEFORE UPDATE ON CtrlAjeComments
    FOR EACH ROW EXECUTE FUNCTION ctrl_reject_modification();

-- Email notifications (off by default). Sent from the Google Workspace
-- admin mailbox by ctrlNotifyWorker, which is the only function holding the
-- Google key; the portal only queues rows here.
CREATE TABLE CtrlNotifySettings (
    GroupId UUID PRIMARY KEY REFERENCES Groups(GroupId) ON DELETE CASCADE,
    EmailEnabled BOOLEAN NOT NULL DEFAULT false,
    ControllerEmail VARCHAR(255),
    UpdatedBy UUID,
    LastUpdated TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE CtrlNotifications (
    NotificationId UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    GroupId UUID NOT NULL REFERENCES Groups(GroupId) ON DELETE CASCADE,
    Kind VARCHAR(20) NOT NULL CHECK (Kind IN ('ReportPublished', 'Question', 'Reply', 'Test')),
    ToEmail VARCHAR(255) NOT NULL,
    Subject VARCHAR(300) NOT NULL,
    Body TEXT NOT NULL,
    Status VARCHAR(10) NOT NULL DEFAULT 'Pending' CHECK (Status IN ('Pending', 'Sent', 'Failed')),
    Attempts INTEGER NOT NULL DEFAULT 0,
    LastError TEXT,
    CreatedAt TIMESTAMPTZ NOT NULL DEFAULT now(),
    SentAt TIMESTAMPTZ
);
CREATE INDEX idx_ctrlnotifications_pending ON CtrlNotifications (CreatedAt) WHERE Status = 'Pending';
CREATE INDEX idx_ctrlnotifications_group ON CtrlNotifications (GroupId, CreatedAt DESC);

-- "Last active" for each accountant on Controller > Accountants.
CREATE INDEX idx_ctrlauditlog_user_created ON CtrlAuditLog (UserId, CreatedDate DESC);
