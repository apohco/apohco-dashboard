-- Initial schema for the APOHCO Financial Dashboard.
-- All practice-level tables are scoped by GroupId for tenant isolation.
-- See ../../../claude.md for the full data model description.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE Users (
    UserId UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    Username VARCHAR(100) NOT NULL UNIQUE,
    Email VARCHAR(255) NOT NULL,
    Role VARCHAR(20) NOT NULL CHECK (Role IN ('SoftwareAdmin', 'SoftwareRep', 'Owner', 'Manager', 'TeamMember')),
    CreatedDate TIMESTAMPTZ NOT NULL DEFAULT now(),
    LastLoginDate TIMESTAMPTZ
);

CREATE TABLE Groups (
    GroupId UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    GroupName VARCHAR(255) NOT NULL,
    CreatedDate TIMESTAMPTZ NOT NULL DEFAULT now(),
    CreatedBy UUID NOT NULL REFERENCES Users(UserId)
);

CREATE TABLE GroupUsers (
    GroupUserId UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    GroupId UUID NOT NULL REFERENCES Groups(GroupId) ON DELETE CASCADE,
    UserId UUID NOT NULL REFERENCES Users(UserId) ON DELETE CASCADE,
    Role VARCHAR(20) NOT NULL CHECK (Role IN ('Owner', 'Manager', 'TeamMember')),
    AssignedDate TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (GroupId, UserId)
);
CREATE INDEX idx_groupusers_userid ON GroupUsers(UserId);

CREATE TABLE QBOs (
    QBOId UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    GroupId UUID NOT NULL REFERENCES Groups(GroupId) ON DELETE CASCADE,
    QBOName VARCHAR(255) NOT NULL,
    RealmId VARCHAR(50) NOT NULL,
    IsClassBased BOOLEAN NOT NULL DEFAULT false,
    AccessToken TEXT,
    RefreshToken TEXT,
    TokenExpiry TIMESTAMPTZ,
    CreatedDate TIMESTAMPTZ NOT NULL DEFAULT now(),
    CreatedBy UUID NOT NULL REFERENCES Users(UserId),
    UNIQUE (GroupId, RealmId)
);
CREATE INDEX idx_qbos_groupid ON QBOs(GroupId);

CREATE TABLE QBOClasses (
    QBOClassId UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    QBOId UUID NOT NULL REFERENCES QBOs(QBOId) ON DELETE CASCADE,
    ClassName VARCHAR(255) NOT NULL,
    ClassId VARCHAR(50) NOT NULL,
    UNIQUE (QBOId, ClassId)
);
CREATE INDEX idx_qboclasses_qboid ON QBOClasses(QBOId);

CREATE TABLE AccountGroupings (
    GroupingId UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    GroupId UUID NOT NULL REFERENCES Groups(GroupId) ON DELETE CASCADE,
    GroupingName VARCHAR(255) NOT NULL,
    AccountType VARCHAR(20) NOT NULL CHECK (AccountType IN ('PL', 'BalanceSheet')),
    CreatedDate TIMESTAMPTZ NOT NULL DEFAULT now(),
    CreatedBy UUID NOT NULL REFERENCES Users(UserId),
    UNIQUE (GroupId, GroupingName, AccountType)
);
CREATE INDEX idx_accountgroupings_groupid ON AccountGroupings(GroupId);

CREATE TABLE ChartOfAccountsMappings (
    MappingId UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    GroupId UUID NOT NULL REFERENCES Groups(GroupId) ON DELETE CASCADE,
    QBOId UUID NOT NULL REFERENCES QBOs(QBOId) ON DELETE CASCADE,
    AccountCode VARCHAR(50) NOT NULL,
    AccountName VARCHAR(255) NOT NULL,
    GroupingId UUID REFERENCES AccountGroupings(GroupingId),
    LastUpdated TIMESTAMPTZ NOT NULL DEFAULT now(),
    UpdatedBy UUID REFERENCES Users(UserId),
    UNIQUE (QBOId, AccountCode)
);
CREATE INDEX idx_coamappings_groupid ON ChartOfAccountsMappings(GroupId);
CREATE INDEX idx_coamappings_groupingid ON ChartOfAccountsMappings(GroupingId);

CREATE TABLE ConsolidationGroups (
    ConsolidationGroupId UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    GroupId UUID NOT NULL REFERENCES Groups(GroupId) ON DELETE CASCADE,
    ConsolidationGroupName VARCHAR(255) NOT NULL,
    CreatedDate TIMESTAMPTZ NOT NULL DEFAULT now(),
    CreatedBy UUID NOT NULL REFERENCES Users(UserId),
    UNIQUE (GroupId, ConsolidationGroupName)
);
CREATE INDEX idx_consolidationgroups_groupid ON ConsolidationGroups(GroupId);

CREATE TABLE ConsolidationGroupQBOs (
    Id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ConsolidationGroupId UUID NOT NULL REFERENCES ConsolidationGroups(ConsolidationGroupId) ON DELETE CASCADE,
    QBOId UUID NOT NULL REFERENCES QBOs(QBOId) ON DELETE CASCADE,
    QBOClassId UUID REFERENCES QBOClasses(QBOClassId) ON DELETE CASCADE
);
-- A whole QBO (QBOClassId IS NULL) may only be added once per consolidation group;
-- a specific class of a QBO may also only be added once per consolidation group.
CREATE UNIQUE INDEX uq_consolidationgroupqbos_whole_qbo
    ON ConsolidationGroupQBOs(ConsolidationGroupId, QBOId) WHERE QBOClassId IS NULL;
CREATE UNIQUE INDEX uq_consolidationgroupqbos_class
    ON ConsolidationGroupQBOs(ConsolidationGroupId, QBOId, QBOClassId) WHERE QBOClassId IS NOT NULL;

CREATE TABLE CashFlowMappings (
    CashFlowMappingId UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    GroupId UUID NOT NULL REFERENCES Groups(GroupId) ON DELETE CASCADE,
    GroupingId UUID NOT NULL REFERENCES AccountGroupings(GroupingId) ON DELETE CASCADE,
    CashFlowCategory VARCHAR(20) NOT NULL CHECK (CashFlowCategory IN ('Operations', 'Investing', 'Financing')),
    CreatedDate TIMESTAMPTZ NOT NULL DEFAULT now(),
    UpdatedBy UUID REFERENCES Users(UserId),
    UNIQUE (GroupId, GroupingId)
);
CREATE INDEX idx_cashflowmappings_groupid ON CashFlowMappings(GroupId);

CREATE TABLE RawTransactions (
    TransactionId UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    GroupId UUID NOT NULL REFERENCES Groups(GroupId) ON DELETE CASCADE,
    QBOId UUID NOT NULL REFERENCES QBOs(QBOId) ON DELETE CASCADE,
    QBOClassId UUID REFERENCES QBOClasses(QBOClassId),
    TransactionDate DATE NOT NULL,
    AccountCode VARCHAR(50),
    AccountName VARCHAR(255),
    Debit NUMERIC(14, 2) NOT NULL DEFAULT 0,
    Credit NUMERIC(14, 2) NOT NULL DEFAULT 0,
    Amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
    TransactionType VARCHAR(50),
    Description TEXT,
    QBOTransactionId VARCHAR(100),
    PulledDate TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_rawtransactions_group_qbo_date ON RawTransactions(GroupId, QBOId, TransactionDate);
CREATE INDEX idx_rawtransactions_qbo_date ON RawTransactions(QBOId, TransactionDate);
