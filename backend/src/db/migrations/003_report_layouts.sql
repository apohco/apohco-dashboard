-- Report Layout: per-Group, per-Statement (PL/BalanceSheet/CashFlow) ordered
-- rows of Grouping/Total/Net that replace the old hardcoded
-- alphabetical-Grouping-with-fixed-totals report structure. See claude.md
-- and the Report Layout plan for the full data model rationale.
--
-- Sign is implicit, not stored: a Total row's components are always
-- additive; a Net row always has exactly two components ordered by
-- SortOrder (the first is positive, the second is subtracted). Component
-- count rules, the Grouping/GroupingId pairing, and the single-IsSystemRow/
-- single-IsRevenueBase constraints are enforced in application code on
-- save (manageReportLayout), not as DB CHECKs, since they're relational
-- rules rather than simple per-column enums.

CREATE TABLE ReportLayoutRows (
    RowId UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    GroupId UUID NOT NULL REFERENCES Groups(GroupId) ON DELETE CASCADE,
    Statement VARCHAR(20) NOT NULL CHECK (Statement IN ('PL', 'BalanceSheet', 'CashFlow')),
    RowType VARCHAR(10) NOT NULL CHECK (RowType IN ('Grouping', 'Total', 'Net')),
    Label VARCHAR(255) NOT NULL,
    GroupingId UUID REFERENCES AccountGroupings(GroupingId) ON DELETE CASCADE,
    IsSystemRow BOOLEAN NOT NULL DEFAULT false,
    IsRevenueBase BOOLEAN NOT NULL DEFAULT false,
    SortOrder INTEGER NOT NULL,
    CreatedDate TIMESTAMPTZ NOT NULL DEFAULT now(),
    UpdatedBy UUID REFERENCES Users(UserId),
    UNIQUE (GroupId, Statement, SortOrder)
);
CREATE INDEX idx_report_layout_rows_lookup ON ReportLayoutRows(GroupId, Statement, SortOrder);

CREATE TABLE ReportLayoutRowComponents (
    ComponentId UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    RowId UUID NOT NULL REFERENCES ReportLayoutRows(RowId) ON DELETE CASCADE,
    ComponentRowId UUID NOT NULL REFERENCES ReportLayoutRows(RowId) ON DELETE CASCADE,
    SortOrder INTEGER NOT NULL,
    UNIQUE (RowId, ComponentRowId)
);
CREATE INDEX idx_report_layout_row_components_rowid ON ReportLayoutRowComponents(RowId);
