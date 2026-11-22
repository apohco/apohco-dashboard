-- Controller module: General Ledger uploads (CSV/XLSX) as a second source
-- of snapshots, beside QuickBooks API pulls. See
-- backend/src/functions/controller/ctrlGlUpload and shared/glUploadParser.js.
--
-- Like the API pull, an upload never touches the dashboard's own tables
-- (RawTransactions, ChartOfAccountsMappings, QBOClasses): it only reads
-- them, and stores its lines as new, append-only Controller snapshots.

-- One row per uploaded file. Created when the browser asks for an upload
-- URL (Pending); marked Imported, with the column mapping that was used,
-- once its lines are stored. The mapping is reused for the next file from
-- the same QBO with the same headers.
CREATE TABLE CtrlUploads (
    UploadId UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    GroupId UUID NOT NULL REFERENCES Groups(GroupId) ON DELETE CASCADE,
    QBOId UUID NOT NULL REFERENCES QBOs(QBOId) ON DELETE CASCADE,
    FileName VARCHAR(255) NOT NULL,
    S3Key TEXT NOT NULL,
    FileSha256 CHAR(64),
    Status VARCHAR(20) NOT NULL DEFAULT 'Pending' CHECK (Status IN ('Pending', 'Imported')),
    HeaderRow INTEGER,
    ColumnMapping JSONB,
    AmountConvention VARCHAR(20),
    AccountClassifications JSONB,
    PeriodFrom DATE CHECK (PeriodFrom = date_trunc('month', PeriodFrom)::date),
    PeriodTo DATE CHECK (PeriodTo = date_trunc('month', PeriodTo)::date),
    LineCount INTEGER,
    ErrorRowCount INTEGER,
    UploadedBy UUID REFERENCES Users(UserId),
    CreatedDate TIMESTAMPTZ NOT NULL DEFAULT now(),
    ImportedDate TIMESTAMPTZ
);
CREATE INDEX idx_ctrluploads_group_created ON CtrlUploads(GroupId, CreatedDate DESC);
CREATE INDEX idx_ctrluploads_qbo_status ON CtrlUploads(QBOId, Status, ImportedDate DESC);

-- Where a snapshot came from. Existing rows are all API pulls.
ALTER TABLE CtrlSnapshots
    ADD COLUMN Source VARCHAR(20) NOT NULL DEFAULT 'QBO' CHECK (Source IN ('QBO', 'Upload')),
    ADD COLUMN UploadId UUID REFERENCES CtrlUploads(UploadId) ON DELETE SET NULL,
    ADD CONSTRAINT ctrlsnapshots_upload_period_unique UNIQUE (UploadId, Period);

-- The GL's Split column (the other account(s) on the transaction).
ALTER TABLE CtrlLedgerLines ADD COLUMN SplitAccount TEXT;
