-- Adds support for multiple named "Report Views" per Group+Statement (e.g.
-- two different P&L layouts a user can switch between), replacing the old
-- one-layout-per-statement model. See claude.md and the Report Views plan
-- for the full rationale.

CREATE TABLE ReportViews (
    ReportViewId UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    GroupId UUID NOT NULL REFERENCES Groups(GroupId) ON DELETE CASCADE,
    Statement VARCHAR(20) NOT NULL CHECK (Statement IN ('PL', 'BalanceSheet', 'CashFlow')),
    ViewName VARCHAR(255) NOT NULL,
    IsDefault BOOLEAN NOT NULL DEFAULT false,
    SortOrder INTEGER NOT NULL DEFAULT 0,
    CreatedDate TIMESTAMPTZ NOT NULL DEFAULT now(),
    CreatedBy UUID REFERENCES Users(UserId),
    UNIQUE (GroupId, Statement, ViewName)
);
CREATE INDEX idx_report_views_lookup ON ReportViews(GroupId, Statement);
-- At most one default view per Group+Statement.
CREATE UNIQUE INDEX uq_report_views_default ON ReportViews(GroupId, Statement) WHERE IsDefault;

-- Backfill: one "Default" view per existing (GroupId, Statement) that has
-- rows today. SELECT DISTINCT dedupes before insert, so no two rows here
-- share (GroupId, Statement) -- no conflict against uq_report_views_default.
INSERT INTO ReportViews (GroupId, Statement, ViewName, IsDefault, SortOrder)
SELECT DISTINCT GroupId, Statement, 'Default', true, 0
FROM ReportLayoutRows;

ALTER TABLE ReportLayoutRows ADD COLUMN ReportViewId UUID REFERENCES ReportViews(ReportViewId) ON DELETE CASCADE;

-- Unambiguous: exactly one ReportViews row exists per (GroupId, Statement) here.
UPDATE ReportLayoutRows r
SET ReportViewId = v.ReportViewId
FROM ReportViews v
WHERE v.GroupId = r.GroupId AND v.Statement = r.Statement AND v.IsDefault = true;

ALTER TABLE ReportLayoutRows ALTER COLUMN ReportViewId SET NOT NULL;

CREATE INDEX idx_report_layout_rows_reportviewid ON ReportLayoutRows(ReportViewId, SortOrder);

-- Drop the old (GroupId, Statement, SortOrder) unique constraint. Looked up
-- dynamically rather than hardcoding Postgres's auto-generated name, but
-- hard-fails (RAISE EXCEPTION, aborting the whole migration transaction)
-- rather than silently skipping if not found -- a wrong/missing constraint
-- name here should never leave two overlapping constraints in place.
DO $$
DECLARE cname text;
BEGIN
  SELECT conname INTO cname FROM pg_constraint
  WHERE conrelid = 'ReportLayoutRows'::regclass AND contype = 'u'
    AND conname LIKE '%groupid_statement_sortorder%';
  IF cname IS NULL THEN
    RAISE EXCEPTION 'Could not find the GroupId/Statement/SortOrder unique constraint on ReportLayoutRows';
  END IF;
  EXECUTE format('ALTER TABLE ReportLayoutRows DROP CONSTRAINT %I', cname);
END $$;

ALTER TABLE ReportLayoutRows ADD CONSTRAINT uq_report_layout_rows_view_sortorder UNIQUE (ReportViewId, SortOrder);

DROP INDEX idx_report_layout_rows_lookup;

-- GroupId/Statement columns are intentionally KEPT on ReportLayoutRows here
-- (the app continues to populate them on every insert) rather than dropped
-- in this same migration -- dropping them here would couple this schema
-- change to instantaneous app-code cutover with zero rollback window.
-- ReportViewId is the sole scoping key application code uses for reads
-- going forward; a later migration can drop these once that's confirmed
-- fully live.
