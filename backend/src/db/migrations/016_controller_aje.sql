-- Controller Phase 5a: recommended adjusting journal entries (AJEs).
--
-- Paul's review decisions become recommended entries, grouped into a
-- numbered report per QBO file and month (FILE-YYYY-MM-AJE-###, entries
-- .01, .02 ...). Nothing here writes to QuickBooks: the accountant books
-- the entries, and the next GL pull notices them by their number.
--
-- Numbers are permanent. Reports are never deleted; a revision is a new
-- report with the next number that supersedes the old one. Entries, their
-- backup lines and posted-checks are append-only.

-- The short code each file's numbers start with (MGMT, WPD, ...).
CREATE TABLE CtrlAjeFileSettings (
    QBOId UUID PRIMARY KEY REFERENCES QBOs(QBOId) ON DELETE CASCADE,
    GroupId UUID NOT NULL REFERENCES Groups(GroupId) ON DELETE CASCADE,
    FileCode VARCHAR(6) NOT NULL CHECK (FileCode ~ '^[A-Z][A-Z0-9]{1,5}$'),
    UpdatedBy UUID REFERENCES Users(UserId),
    LastUpdated TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (GroupId, FileCode)
);

CREATE TABLE CtrlAjeSettings (
    GroupId UUID PRIMARY KEY REFERENCES Groups(GroupId) ON DELETE CASCADE,
    DefaultGrouping VARCHAR(10) NOT NULL DEFAULT 'Grouped' CHECK (DefaultGrouping IN ('Grouped', 'PerLine')),
    UpdatedBy UUID REFERENCES Users(UserId),
    LastUpdated TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One published report. FileCode is copied in so a later code change never
-- renumbers it.
CREATE TABLE CtrlAjeReports (
    ReportId UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    GroupId UUID NOT NULL REFERENCES Groups(GroupId) ON DELETE CASCADE,
    QBOId UUID NOT NULL REFERENCES QBOs(QBOId) ON DELETE CASCADE,
    Period DATE NOT NULL CHECK (Period = date_trunc('month', Period)::date),
    FileCode VARCHAR(6) NOT NULL,
    Seq INTEGER NOT NULL CHECK (Seq BETWEEN 1 AND 999),
    ReportNumber VARCHAR(40) NOT NULL,
    Grouping VARCHAR(10) NOT NULL CHECK (Grouping IN ('Grouped', 'PerLine')),
    Status VARCHAR(12) NOT NULL DEFAULT 'Published' CHECK (Status IN ('Published', 'Superseded')),
    SupersedesReportId UUID REFERENCES CtrlAjeReports(ReportId),
    SupersededByReportId UUID REFERENCES CtrlAjeReports(ReportId),
    SupersededAt TIMESTAMPTZ,
    EntryCount INTEGER NOT NULL,
    TotalAmount NUMERIC(16, 2) NOT NULL,
    Note TEXT,
    PublishedBy UUID REFERENCES Users(UserId),
    PublishedAt TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (GroupId, ReportNumber),
    UNIQUE (QBOId, Period, Seq)
);
CREATE INDEX idx_ctrlajereports_group_period ON CtrlAjeReports(GroupId, Period DESC);

-- One recommended entry. Lines: [{ accountCode, accountName, className, debit, credit }].
CREATE TABLE CtrlAjeEntries (
    EntryId UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ReportId UUID NOT NULL REFERENCES CtrlAjeReports(ReportId) ON DELETE CASCADE,
    GroupId UUID NOT NULL REFERENCES Groups(GroupId) ON DELETE CASCADE,
    QBOId UUID NOT NULL REFERENCES QBOs(QBOId) ON DELETE CASCADE,
    Seq INTEGER NOT NULL CHECK (Seq >= 1),
    EntryNumber VARCHAR(48) NOT NULL,
    QboNum VARCHAR(21) NOT NULL,
    Kind VARCHAR(20) NOT NULL CHECK (Kind IN ('ClassMove', 'Reclassify', 'DueToFrom', 'DueToFromMirror', 'Reversal')),
    EntryDate DATE NOT NULL,
    Vendor TEXT,
    Memo TEXT NOT NULL,
    Amount NUMERIC(16, 2) NOT NULL,
    Lines JSONB NOT NULL,
    Warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
    UNIQUE (ReportId, Seq),
    UNIQUE (GroupId, EntryNumber)
);
CREATE INDEX idx_ctrlajeentries_qbo ON CtrlAjeEntries(QBOId);

-- The GL lines behind each entry (the backup), with the state the entry
-- moves each line from and to: [{ code, name, className, amount }].
--   Side 'Own'     the line is in this report's file
--   Side 'Mirror'  the other entity's side of a Due To/From decision made
--                  in SourceQBOId
-- The latest ToState per (SourceQBOId, Fingerprint, Side) in a report that
-- is still in force is where the next entry for that line starts from.
CREATE TABLE CtrlAjeEntrySources (
    SourceId UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    EntryId UUID NOT NULL REFERENCES CtrlAjeEntries(EntryId) ON DELETE CASCADE,
    ReportId UUID NOT NULL REFERENCES CtrlAjeReports(ReportId) ON DELETE CASCADE,
    GroupId UUID NOT NULL REFERENCES Groups(GroupId) ON DELETE CASCADE,
    SourceQBOId UUID NOT NULL REFERENCES QBOs(QBOId) ON DELETE CASCADE,
    Side VARCHAR(6) NOT NULL CHECK (Side IN ('Own', 'Mirror')),
    Fingerprint CHAR(64) NOT NULL,
    LineId UUID REFERENCES CtrlLedgerLines(LineId) ON DELETE SET NULL,
    DecisionId UUID,
    TxnDate DATE,
    TxnType VARCHAR(50),
    DocNum VARCHAR(100),
    PayeeName VARCHAR(255),
    Memo TEXT,
    AccountCode VARCHAR(50),
    AccountName VARCHAR(255),
    ClassName VARCHAR(255),
    Amount NUMERIC(14, 2) NOT NULL,
    FromState JSONB NOT NULL,
    ToState JSONB NOT NULL
);
CREATE INDEX idx_ctrlajeentrysources_line ON CtrlAjeEntrySources(SourceQBOId, Fingerprint);
CREATE INDEX idx_ctrlajeentrysources_entry ON CtrlAjeEntrySources(EntryId);

-- An entry seen in a stored GL: a line whose Num or memo carries its number
-- (or its report's number, when the whole report was booked as one entry).
CREATE TABLE CtrlAjePostings (
    PostingId UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    EntryId UUID NOT NULL REFERENCES CtrlAjeEntries(EntryId) ON DELETE CASCADE,
    GroupId UUID NOT NULL REFERENCES Groups(GroupId) ON DELETE CASCADE,
    SnapshotId UUID NOT NULL REFERENCES CtrlSnapshots(SnapshotId) ON DELETE CASCADE,
    LineId UUID REFERENCES CtrlLedgerLines(LineId) ON DELETE SET NULL,
    DocNum VARCHAR(100),
    MatchedOn VARCHAR(10) NOT NULL CHECK (MatchedOn IN ('Entry', 'Report')),
    SeenAt TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (EntryId, SnapshotId)
);
CREATE INDEX idx_ctrlajepostings_entry ON CtrlAjePostings(EntryId);

-- Reports: never deleted (except with their whole file or Group), and the
-- only change allowed is Published -> Superseded.
CREATE FUNCTION ctrl_aje_report_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Cascades from deleting the whole QBO file or Group still work: the
    -- parent row is already gone by the time this runs.
    IF EXISTS (SELECT 1 FROM QBOs WHERE QBOId = OLD.QBOId) AND EXISTS (SELECT 1 FROM Groups WHERE GroupId = OLD.GroupId) THEN
      RAISE EXCEPTION 'AJE reports are permanent; % is not allowed', TG_OP;
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.ReportId <> OLD.ReportId OR NEW.GroupId <> OLD.GroupId OR NEW.QBOId <> OLD.QBOId OR NEW.Period <> OLD.Period
     OR NEW.FileCode <> OLD.FileCode OR NEW.Seq <> OLD.Seq OR NEW.ReportNumber <> OLD.ReportNumber
     OR NEW.Grouping <> OLD.Grouping OR NEW.EntryCount <> OLD.EntryCount OR NEW.TotalAmount <> OLD.TotalAmount
     OR NEW.PublishedAt <> OLD.PublishedAt OR NEW.SupersedesReportId IS DISTINCT FROM OLD.SupersedesReportId
     OR NOT (OLD.Status = 'Published' AND NEW.Status = 'Superseded' AND NEW.SupersededByReportId IS NOT NULL) THEN
    RAISE EXCEPTION 'A published AJE report can only be marked superseded';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_ctrlajereports_guard
    BEFORE UPDATE OR DELETE ON CtrlAjeReports
    FOR EACH ROW EXECUTE FUNCTION ctrl_aje_report_guard();

CREATE TRIGGER trg_ctrlajeentries_no_update
    BEFORE UPDATE ON CtrlAjeEntries
    FOR EACH ROW EXECUTE FUNCTION ctrl_reject_modification();

CREATE TRIGGER trg_ctrlajeentrysources_no_update
    BEFORE UPDATE ON CtrlAjeEntrySources
    FOR EACH ROW EXECUTE FUNCTION ctrl_reject_modification();

CREATE TRIGGER trg_ctrlajepostings_no_update
    BEFORE UPDATE ON CtrlAjePostings
    FOR EACH ROW EXECUTE FUNCTION ctrl_reject_modification();
