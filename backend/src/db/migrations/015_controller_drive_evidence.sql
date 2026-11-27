-- Controller Phase 4b: invoice folders (Drive index) and Save as support.
--
-- Drive is indexed only inside the folders Paul adds (CtrlGoogleSources
-- Kind 'Folder'), never whole drives. The index keeps extracted text and
-- metadata, not the files. Saved support (a confirmed email or file) is
-- stored in the private evidence S3 bucket, with a copy in the admin's My
-- Drive. Nothing here writes to QuickBooks.

-- Folder sources: SourceKey = the Drive folder id.
--   FolderPath  where it is ("Shared drive CFO / Invoices / 2026")
--   DriveId     the shared drive it is in (null: someone's My Drive)
--   ActAs       the workspace account the app reads it as (the admin, or
--               the folder's owner when it isn't shared with the admin)
ALTER TABLE CtrlGoogleSources DROP CONSTRAINT IF EXISTS ctrlgooglesources_kind_check;
ALTER TABLE CtrlGoogleSources
    ADD CONSTRAINT ctrlgooglesources_kind_check CHECK (Kind IN ('Mailbox', 'UserDrive', 'SharedDrive', 'Folder')),
    ADD COLUMN FolderPath TEXT,
    ADD COLUMN DriveId VARCHAR(255),
    ADD COLUMN ActAs VARCHAR(255),
    ADD COLUMN LastIndexedAt TIMESTAMPTZ,
    ADD COLUMN LastIndexError TEXT,
    ADD CHECK (Kind <> 'Folder' OR ActAs IS NOT NULL);

-- One file in an indexed folder (or its subfolders).
--   Version     Drive's modifiedTime + size; a change re-extracts the file
--   Amounts     money amounts found in the text (for instant matching)
--   Dates       dates found in the text
--   Extract     how the text was read: pdf, ocr, gdoc, text, none
CREATE TABLE CtrlDriveFiles (
    GroupId UUID NOT NULL REFERENCES Groups(GroupId) ON DELETE CASCADE,
    SourceId UUID NOT NULL REFERENCES CtrlGoogleSources(SourceId) ON DELETE CASCADE,
    FileId VARCHAR(255) NOT NULL,
    Name TEXT NOT NULL,
    MimeType VARCHAR(255) NOT NULL,
    Path TEXT,
    OwnerEmail VARCHAR(255),
    ModifiedTime TIMESTAMPTZ,
    SizeBytes BIGINT,
    WebViewLink TEXT,
    Version VARCHAR(100) NOT NULL,
    Text TEXT NOT NULL DEFAULT '',
    TextTsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', coalesce(Name, '') || ' ' || coalesce(Text, ''))) STORED,
    Amounts NUMERIC(14, 2)[] NOT NULL DEFAULT '{}',
    Dates DATE[] NOT NULL DEFAULT '{}',
    Extract VARCHAR(10) NOT NULL DEFAULT 'none' CHECK (Extract IN ('pdf', 'ocr', 'gdoc', 'text', 'none')),
    ExtractError TEXT,
    IndexedAt TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (SourceId, FileId)
);
CREATE INDEX idx_ctrldrivefiles_group ON CtrlDriveFiles(GroupId);
CREATE INDEX idx_ctrldrivefiles_tsv ON CtrlDriveFiles USING GIN (TextTsv);
CREATE INDEX idx_ctrldrivefiles_amounts ON CtrlDriveFiles USING GIN (Amounts);

-- One indexing pass over one folder (nightly or "Index now").
CREATE TABLE CtrlDriveIndexRuns (
    IndexRunId UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    GroupId UUID NOT NULL REFERENCES Groups(GroupId) ON DELETE CASCADE,
    SourceId UUID NOT NULL REFERENCES CtrlGoogleSources(SourceId) ON DELETE CASCADE,
    Trigger VARCHAR(10) NOT NULL CHECK (Trigger IN ('Nightly', 'Manual')),
    Status VARCHAR(12) NOT NULL DEFAULT 'Scanning' CHECK (Status IN ('Scanning', 'Indexing', 'Succeeded', 'Failed')),
    FilesSeen INTEGER NOT NULL DEFAULT 0,
    FilesToIndex INTEGER NOT NULL DEFAULT 0,
    FilesIndexed INTEGER NOT NULL DEFAULT 0,
    FilesFailed INTEGER NOT NULL DEFAULT 0,
    FilesRemoved INTEGER NOT NULL DEFAULT 0,
    OcrPages INTEGER NOT NULL DEFAULT 0,
    Error TEXT,
    StartedAt TIMESTAMPTZ NOT NULL DEFAULT now(),
    FinishedAt TIMESTAMPTZ
);
CREATE INDEX idx_ctrldriveindexruns_source ON CtrlDriveIndexRuns(SourceId, StartedAt DESC);

-- Drive candidates: a link to open the file and where it is.
ALTER TABLE CtrlEvidenceCandidates
    ADD COLUMN Link TEXT,
    ADD COLUMN Path TEXT;

-- Confirmed evidence saved as support for a line (by fingerprint).
--   S3Key        the PDF in the private evidence bucket
--   DriveFileId  the copy filed in the admin's My Drive
CREATE TABLE CtrlEvidenceSaved (
    SavedId UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    GroupId UUID NOT NULL REFERENCES Groups(GroupId) ON DELETE CASCADE,
    QBOId UUID NOT NULL REFERENCES QBOs(QBOId) ON DELETE CASCADE,
    Fingerprint CHAR(64) NOT NULL,
    LineId UUID REFERENCES CtrlLedgerLines(LineId) ON DELETE SET NULL,
    Source VARCHAR(10) NOT NULL CHECK (Source IN ('Gmail', 'Drive')),
    SourceAccount VARCHAR(255) NOT NULL,
    ExternalId VARCHAR(255) NOT NULL,
    Title TEXT,
    EntityId UUID,
    Status VARCHAR(10) NOT NULL DEFAULT 'Saving' CHECK (Status IN ('Saving', 'Saved', 'Failed')),
    Attempts INTEGER NOT NULL DEFAULT 0,
    S3Key TEXT,
    FileName TEXT,
    SizeBytes BIGINT,
    DriveFileId VARCHAR(255),
    DrivePath TEXT,
    Error TEXT,
    ConfirmedBy UUID REFERENCES Users(UserId),
    ConfirmedAt TIMESTAMPTZ NOT NULL DEFAULT now(),
    SavedAt TIMESTAMPTZ,
    UNIQUE (QBOId, Fingerprint, Source, ExternalId)
);
CREATE INDEX idx_ctrlevidencesaved_line ON CtrlEvidenceSaved(QBOId, Fingerprint);

-- Sender addresses learned from confirmed emails, so later Gmail searches
-- for the vendor also look for mail from them.
CREATE TABLE CtrlVendorSenders (
    GroupId UUID NOT NULL REFERENCES Groups(GroupId) ON DELETE CASCADE,
    VendorId UUID NOT NULL REFERENCES CtrlVendors(VendorId) ON DELETE CASCADE,
    Email VARCHAR(255) NOT NULL,
    ConfirmCount INTEGER NOT NULL DEFAULT 1,
    LastConfirmedAt TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (VendorId, Email)
);

-- The admin's "Controller Evidence" folder and its practice / month
-- subfolders (created by the app; drive.file only sees what it created).
CREATE TABLE CtrlEvidenceFolders (
    GroupId UUID NOT NULL REFERENCES Groups(GroupId) ON DELETE CASCADE,
    Path TEXT NOT NULL,
    FolderId VARCHAR(255) NOT NULL,
    CreatedAt TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (GroupId, Path)
);
