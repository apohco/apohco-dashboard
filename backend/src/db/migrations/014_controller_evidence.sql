-- Controller Phase 4a: Google Workspace connection and Gmail evidence.
--
-- The service account key is NOT stored here (AWS Secrets Manager,
-- apohco-dashboard/google-service-account). Only opted-in sources are
-- ever searched; every search and preview is written to the audit log.
-- Nothing here writes to QuickBooks.

-- The Group's Google Workspace connection.
--   AdminEmail   the workspace admin the app acts as to list users and
--                shared drives, and whose My Drive holds the evidence folder
--   Domain       taken from AdminEmail; every opted-in source must be in it
--   LastTest*    the last "Test connection" result
CREATE TABLE CtrlGoogleSettings (
    GroupId UUID PRIMARY KEY REFERENCES Groups(GroupId) ON DELETE CASCADE,
    AdminEmail VARCHAR(255) NOT NULL,
    Domain VARCHAR(255) NOT NULL,
    EvidenceFolderId VARCHAR(255),
    LastTestAt TIMESTAMPTZ,
    LastTestOk BOOLEAN,
    LastTestMessage TEXT,
    UpdatedBy UUID REFERENCES Users(UserId),
    LastUpdated TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Opted-in sources (the allowlist).
--   Mailbox      a user's Gmail (SourceKey = email)
--   UserDrive    a user's My Drive (SourceKey = email)
--   SharedDrive  a shared drive (SourceKey = drive id)
CREATE TABLE CtrlGoogleSources (
    SourceId UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    GroupId UUID NOT NULL REFERENCES Groups(GroupId) ON DELETE CASCADE,
    Kind VARCHAR(12) NOT NULL CHECK (Kind IN ('Mailbox', 'UserDrive', 'SharedDrive')),
    SourceKey VARCHAR(255) NOT NULL,
    DisplayName VARCHAR(255),
    Enabled BOOLEAN NOT NULL DEFAULT true,
    AddedBy UUID REFERENCES Users(UserId),
    AddedAt TIMESTAMPTZ NOT NULL DEFAULT now(),
    LastUpdated TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (GroupId, Kind, SourceKey)
);

-- "Search All" jobs (one line is searched right away, without a job).
-- Batches are SQS messages, like the AI's.
CREATE TABLE CtrlEvidenceJobs (
    JobId UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    GroupId UUID NOT NULL REFERENCES Groups(GroupId) ON DELETE CASCADE,
    RunId UUID NOT NULL REFERENCES CtrlReviewRuns(RunId) ON DELETE CASCADE,
    LineCount INTEGER NOT NULL DEFAULT 0,
    CreatedBy UUID REFERENCES Users(UserId),
    CreatedDate TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ctrlevidencejobs_run ON CtrlEvidenceJobs(RunId, CreatedDate DESC);

CREATE TABLE CtrlEvidenceBatches (
    BatchId UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    JobId UUID NOT NULL REFERENCES CtrlEvidenceJobs(JobId) ON DELETE CASCADE,
    GroupId UUID NOT NULL REFERENCES Groups(GroupId) ON DELETE CASCADE,
    LineIds UUID[] NOT NULL,
    Status VARCHAR(12) NOT NULL DEFAULT 'Queued' CHECK (Status IN ('Queued', 'Running', 'Succeeded', 'Failed')),
    Attempts INTEGER NOT NULL DEFAULT 0,
    Error TEXT,
    StartedDate TIMESTAMPTZ,
    FinishedDate TIMESTAMPTZ
);
CREATE INDEX idx_ctrlevidencebatches_job ON CtrlEvidenceBatches(JobId, Status);

-- Evidence candidates found for a line (by fingerprint, so they carry over
-- to later pulls of the same month). Linked, not copied: only the
-- metadata and a short snippet are kept. A new search of the line
-- replaces its candidates from that source (SearchedAt).
--   Signals: { amount: bool, vendor: bool, days: n, entityTerm: '...' }
--   EntityHintId: the practice the email names, if any
CREATE TABLE CtrlEvidenceCandidates (
    CandidateId UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    GroupId UUID NOT NULL REFERENCES Groups(GroupId) ON DELETE CASCADE,
    QBOId UUID NOT NULL REFERENCES QBOs(QBOId) ON DELETE CASCADE,
    Fingerprint CHAR(64) NOT NULL,
    Source VARCHAR(10) NOT NULL CHECK (Source IN ('Gmail', 'Drive')),
    SourceAccount VARCHAR(255) NOT NULL,
    ExternalId VARCHAR(255) NOT NULL,
    ThreadId VARCHAR(255),
    Title TEXT,
    Sender TEXT,
    SentAt TIMESTAMPTZ,
    Snippet TEXT,
    AttachmentNames TEXT[] NOT NULL DEFAULT '{}',
    Score NUMERIC(5, 4) NOT NULL CHECK (Score >= 0 AND Score <= 1),
    Signals JSONB NOT NULL DEFAULT '{}'::jsonb,
    EntityHintId UUID,
    SearchedAt TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (GroupId, QBOId, Fingerprint, Source, SourceAccount, ExternalId)
);
CREATE INDEX idx_ctrlevidencecandidates_line ON CtrlEvidenceCandidates(QBOId, Fingerprint, Score DESC);

-- When each line was last searched (so "no evidence found" differs from
-- "not searched yet").
CREATE TABLE CtrlEvidenceSearches (
    GroupId UUID NOT NULL REFERENCES Groups(GroupId) ON DELETE CASCADE,
    QBOId UUID NOT NULL REFERENCES QBOs(QBOId) ON DELETE CASCADE,
    Fingerprint CHAR(64) NOT NULL,
    SearchedAt TIMESTAMPTZ NOT NULL DEFAULT now(),
    SourcesSearched INTEGER NOT NULL DEFAULT 0,
    CandidateCount INTEGER NOT NULL DEFAULT 0,
    Error TEXT,
    PRIMARY KEY (QBOId, Fingerprint)
);
