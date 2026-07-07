-- Lets a Consolidation Group exclude specific accounts from a specific
-- member QBO/class's contribution -- e.g. excluding a Management Fee
-- expense/income account pair on both sides of an intercompany transaction
-- to avoid double-counting it in the consolidated report. Scoped per
-- ConsolidationGroupQBOs row (i.e. per QBO/class within one specific
-- Consolidation Group), not globally per QBO: the same QBO can be excluded
-- differently across different Consolidation Groups, and its standalone
-- report is never affected. Purely additive -- no existing data touched.
CREATE TABLE ConsolidationGroupQBOExclusions (
    Id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ConsolidationGroupQBOId UUID NOT NULL REFERENCES ConsolidationGroupQBOs(Id) ON DELETE CASCADE,
    AccountCode VARCHAR(50) NOT NULL,
    UNIQUE (ConsolidationGroupQBOId, AccountCode)
);
CREATE INDEX idx_cgqbo_exclusions_cgqboid ON ConsolidationGroupQBOExclusions(ConsolidationGroupQBOId);
