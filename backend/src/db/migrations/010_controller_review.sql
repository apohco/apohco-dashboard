-- Controller module, Phase 2 (Review and rules). See
-- "docs/Controller Module Spec — CFO Tool.md" and shared/reviewEngine.js.
--
-- Vendors and their rules teach the engine; each "Run review" stores the
-- engine's suggestion for every line of one stored month; Paul's decisions
-- are stored separately and never edited. As in Phase 1, nothing here
-- writes to QuickBooks or to the dashboard's own tables.

-- Per-Group review settings. Threshold: a suggestion at or above it is
-- strong enough to call a line Confirmed or Likely misclassified.
CREATE TABLE CtrlReviewSettings (
    GroupId UUID PRIMARY KEY REFERENCES Groups(GroupId) ON DELETE CASCADE,
    Threshold NUMERIC(4, 3) NOT NULL DEFAULT 0.900 CHECK (Threshold >= 0.5 AND Threshold <= 1),
    MediumThreshold NUMERIC(4, 3) NOT NULL DEFAULT 0.700 CHECK (MediumThreshold >= 0 AND MediumThreshold <= 1),
    HistoryMonths INTEGER NOT NULL DEFAULT 12 CHECK (HistoryMonths BETWEEN 1 AND 36),
    LastUpdated TIMESTAMPTZ NOT NULL DEFAULT now(),
    UpdatedBy UUID REFERENCES Users(UserId),
    CHECK (MediumThreshold <= Threshold)
);

-- One profile per vendor. Payee names that differ across files map to one
-- profile through CtrlVendorAliases. Merging marks the merged profile
-- instead of deleting it, so stored suggestions keep their reference.
CREATE TABLE CtrlVendors (
    VendorId UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    GroupId UUID NOT NULL REFERENCES Groups(GroupId) ON DELETE CASCADE,
    DisplayName VARCHAR(255) NOT NULL,
    WatchMode BOOLEAN NOT NULL DEFAULT false,
    -- Default split for vendors that serve several homes:
    -- [{ "entityId": "...", "percent": 40 }, ...], used to prefill a Split.
    SplitTemplate JSONB,
    MergedIntoVendorId UUID REFERENCES CtrlVendors(VendorId),
    CreatedDate TIMESTAMPTZ NOT NULL DEFAULT now(),
    LastUpdated TIMESTAMPTZ NOT NULL DEFAULT now(),
    UpdatedBy UUID REFERENCES Users(UserId),
    UNIQUE (GroupId, DisplayName)
);
CREATE INDEX idx_ctrlvendors_groupid ON CtrlVendors(GroupId);

-- PayeeKey is the normalized payee name (shared/reviewEngine.payeeKey).
CREATE TABLE CtrlVendorAliases (
    AliasId UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    GroupId UUID NOT NULL REFERENCES Groups(GroupId) ON DELETE CASCADE,
    VendorId UUID NOT NULL REFERENCES CtrlVendors(VendorId) ON DELETE CASCADE,
    PayeeKey VARCHAR(255) NOT NULL,
    PayeeName VARCHAR(255) NOT NULL,
    CreatedDate TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (GroupId, PayeeKey)
);
CREATE INDEX idx_ctrlvendoraliases_vendor ON CtrlVendorAliases(VendorId);

-- Versioned vendor rules: every save adds a version; the highest version
-- is the one in force. Hints holds the structured parts the Phase 2 engine
-- applies ({ "keywords": [{ "keyword": "Main St", "entityId": "..." }] });
-- RuleText is Paul's plain-language rule, read by the AI from Phase 3.
CREATE TABLE CtrlVendorRules (
    RuleId UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    GroupId UUID NOT NULL REFERENCES Groups(GroupId) ON DELETE CASCADE,
    VendorId UUID NOT NULL REFERENCES CtrlVendors(VendorId) ON DELETE CASCADE,
    Version INTEGER NOT NULL,
    DefaultEntityId UUID REFERENCES CtrlEntities(EntityId),
    Hints JSONB NOT NULL DEFAULT '{}'::jsonb,
    RuleText TEXT,
    CreatedBy UUID REFERENCES Users(UserId),
    CreatedDate TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (VendorId, Version)
);

-- One "Run review" of one stored month (one snapshot) of one QBO file,
-- with the settings it ran under.
CREATE TABLE CtrlReviewRuns (
    RunId UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    GroupId UUID NOT NULL REFERENCES Groups(GroupId) ON DELETE CASCADE,
    QBOId UUID NOT NULL REFERENCES QBOs(QBOId) ON DELETE CASCADE,
    Period DATE NOT NULL CHECK (Period = date_trunc('month', Period)::date),
    SnapshotId UUID NOT NULL REFERENCES CtrlSnapshots(SnapshotId) ON DELETE CASCADE,
    Threshold NUMERIC(4, 3) NOT NULL,
    MediumThreshold NUMERIC(4, 3) NOT NULL,
    HistoryMonths INTEGER NOT NULL,
    LineCount INTEGER NOT NULL,
    StatusCounts JSONB NOT NULL DEFAULT '{}'::jsonb,
    RunBy UUID REFERENCES Users(UserId),
    RunDate TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ctrlreviewruns_qbo_period ON CtrlReviewRuns(QBOId, Period, RunDate DESC);

-- The engine's output for each line in a run. VendorId and the entity ids
-- are plain references (no foreign keys), so merging a vendor or removing
-- an entity never has to rewrite this append-only history.
CREATE TABLE CtrlSuggestions (
    SuggestionId UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    RunId UUID NOT NULL REFERENCES CtrlReviewRuns(RunId) ON DELETE CASCADE,
    GroupId UUID NOT NULL REFERENCES Groups(GroupId) ON DELETE CASCADE,
    LineId UUID NOT NULL REFERENCES CtrlLedgerLines(LineId) ON DELETE CASCADE,
    Fingerprint CHAR(64) NOT NULL,
    VendorId UUID,
    CurrentEntityId UUID,
    SuggestedEntityId UUID,
    Confidence NUMERIC(5, 4) NOT NULL DEFAULT 0,
    Status VARCHAR(30) NOT NULL CHECK (Status IN ('Unclassified', 'Confirmed', 'LikelyMisclassified', 'Conflict', 'NeedsEvidence')),
    Source VARCHAR(20) NOT NULL CHECK (Source IN ('Rule', 'Keyword', 'History', 'None')),
    Reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
    RuleId UUID,
    UNIQUE (RunId, LineId)
);
CREATE INDEX idx_ctrlsuggestions_run_status ON CtrlSuggestions(RunId, Status);

-- Paul's decisions, keyed by line fingerprint so a decision carries over
-- to later snapshots of the same month. Never edited: a change of mind is
-- a new row, and the latest row per fingerprint is the one that counts
-- ('Undo' clears it). EntityId is the final entity for Approve, Keep and
-- Reassign; Allocations ([{ entityId, amount }]) is the split for Split.
CREATE TABLE CtrlDecisions (
    DecisionId UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    GroupId UUID NOT NULL REFERENCES Groups(GroupId) ON DELETE CASCADE,
    QBOId UUID NOT NULL REFERENCES QBOs(QBOId) ON DELETE CASCADE,
    Fingerprint CHAR(64) NOT NULL,
    LineId UUID REFERENCES CtrlLedgerLines(LineId) ON DELETE CASCADE,
    RunId UUID REFERENCES CtrlReviewRuns(RunId) ON DELETE CASCADE,
    Action VARCHAR(20) NOT NULL CHECK (Action IN ('Approve', 'Keep', 'Reassign', 'Split', 'Undo')),
    EntityId UUID,
    Allocations JSONB,
    Note TEXT,
    DecidedBy UUID REFERENCES Users(UserId),
    DecidedAt TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((Action = 'Split') = (Allocations IS NOT NULL)),
    CHECK (Action IN ('Split', 'Undo') OR EntityId IS NOT NULL)
);
CREATE INDEX idx_ctrldecisions_qbo_fingerprint ON CtrlDecisions(QBOId, Fingerprint, DecidedAt DESC);

-- UPDATE only: a whole Group can still be deleted (cascades remove rows).
CREATE TRIGGER trg_ctrlvendorrules_no_update
    BEFORE UPDATE ON CtrlVendorRules
    FOR EACH ROW EXECUTE FUNCTION ctrl_reject_modification();

CREATE TRIGGER trg_ctrlsuggestions_no_update
    BEFORE UPDATE ON CtrlSuggestions
    FOR EACH ROW EXECUTE FUNCTION ctrl_reject_modification();

CREATE TRIGGER trg_ctrldecisions_no_update
    BEFORE UPDATE ON CtrlDecisions
    FOR EACH ROW EXECUTE FUNCTION ctrl_reject_modification();
