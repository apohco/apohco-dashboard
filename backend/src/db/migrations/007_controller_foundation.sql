-- Controller module, Phase 1 (Foundation). See
-- "docs/Controller Module Spec — CFO Tool.md".
--
-- Every table is prefixed Ctrl (so generic names like Entities/AuditLog
-- can't collide with future modules) and scoped by GroupId. The Controller
-- only READS the dashboard's existing tables (QBOs, QBOClasses,
-- ConsolidationGroups); it never writes to them, and never writes to QBO.

-- Dental homes / companies the Controller assigns expenses to. An entity is
-- typically a class in the management company's QBO file plus that
-- practice's own standalone QBO file; it can optionally point at the
-- matching dashboard Consolidation Group so the two stay aligned.
CREATE TABLE CtrlEntities (
    EntityId UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    GroupId UUID NOT NULL REFERENCES Groups(GroupId) ON DELETE CASCADE,
    EntityName VARCHAR(255) NOT NULL,
    PracticeQBOId UUID REFERENCES QBOs(QBOId) ON DELETE SET NULL,
    ManagementQBOClassId UUID REFERENCES QBOClasses(QBOClassId) ON DELETE SET NULL,
    ConsolidationGroupId UUID REFERENCES ConsolidationGroups(ConsolidationGroupId) ON DELETE SET NULL,
    Aliases TEXT[] NOT NULL DEFAULT '{}',
    Keywords TEXT[] NOT NULL DEFAULT '{}',
    IsActive BOOLEAN NOT NULL DEFAULT true,
    CreatedDate TIMESTAMPTZ NOT NULL DEFAULT now(),
    CreatedBy UUID REFERENCES Users(UserId),
    LastUpdated TIMESTAMPTZ NOT NULL DEFAULT now(),
    UpdatedBy UUID REFERENCES Users(UserId),
    UNIQUE (GroupId, EntityName)
);
CREATE INDEX idx_ctrlentities_groupid ON CtrlEntities(GroupId);

-- One row per manually triggered pull request (a single month or a
-- backfill range). Overall status is derived from its tasks on read, so
-- concurrent workers never race on a shared status column.
CREATE TABLE CtrlSyncJobs (
    JobId UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    GroupId UUID NOT NULL REFERENCES Groups(GroupId) ON DELETE CASCADE,
    QBOId UUID NOT NULL REFERENCES QBOs(QBOId) ON DELETE CASCADE,
    PeriodFrom DATE NOT NULL CHECK (PeriodFrom = date_trunc('month', PeriodFrom)::date),
    PeriodTo DATE NOT NULL CHECK (PeriodTo = date_trunc('month', PeriodTo)::date),
    RequestedBy UUID REFERENCES Users(UserId),
    CreatedDate TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (PeriodTo >= PeriodFrom)
);
CREATE INDEX idx_ctrlsyncjobs_group_created ON CtrlSyncJobs(GroupId, CreatedDate DESC);

-- One row per month within a job; each is one SQS message / one
-- GeneralLedger report pull. Period is always the first day of the month.
CREATE TABLE CtrlSyncJobTasks (
    TaskId UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    JobId UUID NOT NULL REFERENCES CtrlSyncJobs(JobId) ON DELETE CASCADE,
    GroupId UUID NOT NULL REFERENCES Groups(GroupId) ON DELETE CASCADE,
    QBOId UUID NOT NULL REFERENCES QBOs(QBOId) ON DELETE CASCADE,
    Period DATE NOT NULL CHECK (Period = date_trunc('month', Period)::date),
    Status VARCHAR(20) NOT NULL DEFAULT 'Queued'
        CHECK (Status IN ('Queued', 'Running', 'Succeeded', 'Failed')),
    Attempts INTEGER NOT NULL DEFAULT 0,
    LineCount INTEGER,
    Error TEXT,
    StartedDate TIMESTAMPTZ,
    CompletedDate TIMESTAMPTZ,
    UNIQUE (JobId, Period)
);
CREATE INDEX idx_ctrlsyncjobtasks_qbo_status ON CtrlSyncJobTasks(QBOId, Status);

-- One stored GL pull for one QBO file and one month. Re-pulling a month
-- adds another snapshot beside the earlier ones; nothing is overwritten.
-- TaskId is UNIQUE so an SQS redelivery of the same task can never store
-- the same pull twice.
CREATE TABLE CtrlSnapshots (
    SnapshotId UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    GroupId UUID NOT NULL REFERENCES Groups(GroupId) ON DELETE CASCADE,
    QBOId UUID NOT NULL REFERENCES QBOs(QBOId) ON DELETE CASCADE,
    Period DATE NOT NULL CHECK (Period = date_trunc('month', Period)::date),
    TaskId UUID UNIQUE REFERENCES CtrlSyncJobTasks(TaskId) ON DELETE SET NULL,
    PulledAt TIMESTAMPTZ NOT NULL DEFAULT now(),
    LineCount INTEGER NOT NULL,
    TotalDebit NUMERIC(16, 2) NOT NULL,
    TotalCredit NUMERIC(16, 2) NOT NULL,
    ContentHash CHAR(64) NOT NULL
);
CREATE INDEX idx_ctrlsnapshots_qbo_period ON CtrlSnapshots(QBOId, Period, PulledAt DESC);
CREATE INDEX idx_ctrlsnapshots_groupid ON CtrlSnapshots(GroupId);

-- Append-only GL lines, one set per snapshot.
--   Fingerprint: stable identity of a line across pulls (QBO file, QBO
--     transaction id, type, account, occurrence within that transaction).
--   ContentHash: hash of the line's mutable content (date, amounts, memo,
--     payee, class), so comparing two snapshots shows each line as added,
--     removed or changed. See shared/ledgerFingerprint.js.
CREATE TABLE CtrlLedgerLines (
    LineId UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    GroupId UUID NOT NULL REFERENCES Groups(GroupId) ON DELETE CASCADE,
    SnapshotId UUID NOT NULL REFERENCES CtrlSnapshots(SnapshotId) ON DELETE CASCADE,
    QBOId UUID NOT NULL REFERENCES QBOs(QBOId) ON DELETE CASCADE,
    Fingerprint CHAR(64) NOT NULL,
    ContentHash CHAR(64) NOT NULL,
    TxnDate DATE NOT NULL,
    TxnType VARCHAR(50),
    DocNum VARCHAR(100),
    QBOTxnId VARCHAR(50),
    PayeeName VARCHAR(255),
    PayeeQBOId VARCHAR(50),
    Memo TEXT,
    AccountCode VARCHAR(50),
    AccountName VARCHAR(255),
    ClassName VARCHAR(255),
    QBOClassId UUID REFERENCES QBOClasses(QBOClassId) ON DELETE SET NULL,
    Debit NUMERIC(14, 2) NOT NULL DEFAULT 0,
    Credit NUMERIC(14, 2) NOT NULL DEFAULT 0,
    Amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
    UNIQUE (SnapshotId, Fingerprint)
);
CREATE INDEX idx_ctrlledgerlines_snapshot_date ON CtrlLedgerLines(SnapshotId, TxnDate);
CREATE INDEX idx_ctrlledgerlines_qbo_fingerprint ON CtrlLedgerLines(QBOId, Fingerprint);
CREATE INDEX idx_ctrlledgerlines_group_payee ON CtrlLedgerLines(GroupId, PayeeName);

-- Who did what in the Controller module, and what the system did on its
-- own (scheduled token refresh, workers). UserId is NULL for system
-- actions. No foreign keys, so the log survives deletion of what it
-- describes.
CREATE TABLE CtrlAuditLog (
    AuditId UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    GroupId UUID,
    UserId UUID,
    Action VARCHAR(100) NOT NULL,
    TargetType VARCHAR(50),
    TargetId VARCHAR(100),
    Details JSONB NOT NULL DEFAULT '{}'::jsonb,
    CreatedDate TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ctrlauditlog_group_created ON CtrlAuditLog(GroupId, CreatedDate DESC);

-- History is never rewritten: ledger lines can't be edited in place, and
-- audit entries can't be edited or deleted. (Ledger lines can still be
-- removed by ON DELETE CASCADE when a whole QBO file or Group is deleted.)
CREATE FUNCTION ctrl_reject_modification() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; % is not allowed', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_ctrlledgerlines_no_update
    BEFORE UPDATE ON CtrlLedgerLines
    FOR EACH ROW EXECUTE FUNCTION ctrl_reject_modification();

CREATE TRIGGER trg_ctrlauditlog_no_update_delete
    BEFORE UPDATE OR DELETE ON CtrlAuditLog
    FOR EACH ROW EXECUTE FUNCTION ctrl_reject_modification();
