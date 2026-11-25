-- Controller Phase 3: AI matching (Claude on Amazon Bedrock).
--
-- After the rules + history engine has run, the lines it couldn't settle
-- are sent to the AI in small batches by a queue worker. The AI only
-- suggests: its answers are stored beside the engine's suggestions (never
-- replacing them), and Paul still decides every line. Nothing here writes
-- to QuickBooks.

-- AI settings (Review settings).
--   AiEnabled            run an AI pass after each review run
--   AiConfidenceCap      AI confidence is capped at this, so while it is
--                        below Threshold no AI suggestion counts as "strong"
--   AiMonthlyBudget      estimated USD per calendar month; batches stop
--                        once the month's AI spend reaches it
--   AiRedactPatientInfo  withhold payee and memo on refund / patient lines
ALTER TABLE CtrlReviewSettings
    ADD COLUMN AiEnabled BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN AiConfidenceCap NUMERIC(4, 3) NOT NULL DEFAULT 0.850 CHECK (AiConfidenceCap >= 0.5 AND AiConfidenceCap <= 1),
    ADD COLUMN AiMonthlyBudget NUMERIC(10, 2) NOT NULL DEFAULT 25 CHECK (AiMonthlyBudget >= 0 AND AiMonthlyBudget <= 10000),
    ADD COLUMN AiRedactPatientInfo BOOLEAN NOT NULL DEFAULT true;

-- One AI job:
--   Review    the AI pass of a review run (RunId)
--   RuleTest  a draft written rule tried on a vendor's recent lines
--   Backtest  lines Paul already decided, re-asked without his answers,
--             to measure how often the AI agrees
-- Params holds the request (e.g. the draft rule text, months).
CREATE TABLE CtrlAiJobs (
    JobId UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    GroupId UUID NOT NULL REFERENCES Groups(GroupId) ON DELETE CASCADE,
    Kind VARCHAR(10) NOT NULL CHECK (Kind IN ('Review', 'RuleTest', 'Backtest')),
    RunId UUID REFERENCES CtrlReviewRuns(RunId) ON DELETE CASCADE,
    VendorId UUID REFERENCES CtrlVendors(VendorId) ON DELETE CASCADE,
    QBOId UUID REFERENCES QBOs(QBOId) ON DELETE CASCADE,
    Model VARCHAR(100) NOT NULL,
    Params JSONB NOT NULL DEFAULT '{}'::jsonb,
    LineCount INTEGER NOT NULL DEFAULT 0,
    CreatedBy UUID REFERENCES Users(UserId),
    CreatedDate TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (Kind <> 'Review' OR RunId IS NOT NULL),
    CHECK (Kind <> 'RuleTest' OR VendorId IS NOT NULL)
);
CREATE INDEX idx_ctrlaijobs_run ON CtrlAiJobs(RunId, CreatedDate DESC);
CREATE INDEX idx_ctrlaijobs_group ON CtrlAiJobs(GroupId, CreatedDate DESC);

-- One model call's worth of lines (one SQS message). Status is mutable
-- (like CtrlSyncJobTasks); Result holds the answers of RuleTest and
-- Backtest jobs (Review answers go to CtrlAiSuggestions).
CREATE TABLE CtrlAiBatches (
    BatchId UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    JobId UUID NOT NULL REFERENCES CtrlAiJobs(JobId) ON DELETE CASCADE,
    GroupId UUID NOT NULL REFERENCES Groups(GroupId) ON DELETE CASCADE,
    LineIds UUID[] NOT NULL,
    Status VARCHAR(12) NOT NULL DEFAULT 'Queued'
        CHECK (Status IN ('Queued', 'Running', 'Succeeded', 'Failed', 'Skipped')),
    Attempts INTEGER NOT NULL DEFAULT 0,
    Error TEXT,
    Result JSONB,
    StartedDate TIMESTAMPTZ,
    FinishedDate TIMESTAMPTZ
);
CREATE INDEX idx_ctrlaibatches_job ON CtrlAiBatches(JobId, Status);

-- The AI's answer for a line in a review run. Append-only, at most one per
-- run and line. Outcome, in the engine's terms:
--   class review:   SuggestedAction 'Assign' + SuggestedEntityId
--   account review: 'Keep', 'Reclassify' (+ account) or 'DueToFrom'
--                   (+ SuggestedEntityId, the counterparty)
--   either:         'Unsure' (the AI couldn't tell)
-- Confidence is capped at the setting in force; RawConfidence is the AI's.
CREATE TABLE CtrlAiSuggestions (
    AiSuggestionId UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    RunId UUID NOT NULL REFERENCES CtrlReviewRuns(RunId) ON DELETE CASCADE,
    GroupId UUID NOT NULL REFERENCES Groups(GroupId) ON DELETE CASCADE,
    LineId UUID NOT NULL REFERENCES CtrlLedgerLines(LineId) ON DELETE CASCADE,
    JobId UUID NOT NULL REFERENCES CtrlAiJobs(JobId) ON DELETE CASCADE,
    SuggestedAction VARCHAR(12) NOT NULL CHECK (SuggestedAction IN ('Assign', 'Keep', 'Reclassify', 'DueToFrom', 'Unsure')),
    SuggestedEntityId UUID,
    SuggestedAccountCode VARCHAR(50),
    SuggestedAccountName VARCHAR(255),
    Confidence NUMERIC(5, 4) NOT NULL CHECK (Confidence >= 0 AND Confidence <= 1),
    RawConfidence NUMERIC(5, 4) NOT NULL CHECK (RawConfidence >= 0 AND RawConfidence <= 1),
    Reason TEXT NOT NULL,
    UsedRule BOOLEAN NOT NULL DEFAULT false,
    Redacted BOOLEAN NOT NULL DEFAULT false,
    Model VARCHAR(100) NOT NULL,
    CreatedDate TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (RunId, LineId),
    CHECK ((SuggestedAction IN ('Assign', 'DueToFrom')) = (SuggestedEntityId IS NOT NULL)),
    CHECK ((SuggestedAction = 'Reclassify') = (SuggestedAccountName IS NOT NULL))
);

CREATE TRIGGER trg_ctrlaisuggestions_no_update
    BEFORE UPDATE ON CtrlAiSuggestions
    FOR EACH ROW EXECUTE FUNCTION ctrl_reject_modification();

-- Every model call, for the cost log and the monthly cap. CostUsd is an
-- estimate from token counts and the configured prices.
CREATE TABLE CtrlAiCalls (
    CallId UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    GroupId UUID NOT NULL REFERENCES Groups(GroupId) ON DELETE CASCADE,
    JobId UUID REFERENCES CtrlAiJobs(JobId) ON DELETE SET NULL,
    BatchId UUID REFERENCES CtrlAiBatches(BatchId) ON DELETE SET NULL,
    Model VARCHAR(100) NOT NULL,
    LineCount INTEGER NOT NULL,
    InputTokens INTEGER NOT NULL DEFAULT 0,
    CacheReadTokens INTEGER NOT NULL DEFAULT 0,
    CacheWriteTokens INTEGER NOT NULL DEFAULT 0,
    OutputTokens INTEGER NOT NULL DEFAULT 0,
    CostUsd NUMERIC(10, 4) NOT NULL DEFAULT 0,
    DurationMs INTEGER NOT NULL DEFAULT 0,
    StopReason VARCHAR(30),
    Error TEXT,
    CreatedDate TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ctrlaicalls_group_date ON CtrlAiCalls(GroupId, CreatedDate);

-- Which suggestion Paul accepted, when he accepted one: 'AI' marks a
-- decision made with "Accept AI", so the AI's agree rate can be measured.
ALTER TABLE CtrlDecisions
    ADD COLUMN SuggestionSource VARCHAR(10) CHECK (SuggestionSource IN ('Engine', 'AI'));
