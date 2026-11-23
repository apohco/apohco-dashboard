-- Controller Phase 2a.1: review of files that don't use classes (each
-- dental home's own practice file). There the questions are "is this line
-- in the right account?" and "does it belong to another entity?", so two
-- decisions are added -- Reclassify (move to another account) and
-- DueToFrom (move to this file's intercompany account for another entity)
-- -- usable on the management file too. Nothing here writes to QuickBooks;
-- Phase 5 turns these decisions into recommended adjusting entries.

-- Which kind of review a run is: 'Class' (class -> entity, the management
-- file) or 'Account' (account + intercompany, practice files).
ALTER TABLE CtrlReviewRuns
    ADD COLUMN ReviewKind VARCHAR(10) NOT NULL DEFAULT 'Class' CHECK (ReviewKind IN ('Class', 'Account'));

-- Account-review suggestions. SuggestedAction says what "Approve" would
-- record: Keep (the line is where history says), Reclassify (to the
-- suggested account) or DueToFrom (SuggestedEntityId is the other entity).
ALTER TABLE CtrlSuggestions
    ADD COLUMN SuggestedAction VARCHAR(20) CHECK (SuggestedAction IN ('Keep', 'Reclassify', 'DueToFrom')),
    ADD COLUMN SuggestedAccountCode TEXT,
    ADD COLUMN SuggestedAccountName TEXT;

-- Decisions: the target account (Reclassify / DueToFrom, as chosen at the
-- time, so later mapping changes never rewrite history) and the other
-- entity (DueToFrom). The CHECK constraints are replaced to allow the new
-- actions; Keep no longer needs an entity (an account-review Keep keeps the
-- line's account).
ALTER TABLE CtrlDecisions
    ADD COLUMN TargetAccountCode TEXT,
    ADD COLUMN TargetAccountName TEXT,
    ADD COLUMN CounterpartyEntityId UUID;

DO $$
DECLARE c record;
BEGIN
    FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'ctrldecisions'::regclass AND contype = 'c' LOOP
        EXECUTE format('ALTER TABLE CtrlDecisions DROP CONSTRAINT %I', c.conname);
    END LOOP;
END $$;

ALTER TABLE CtrlDecisions
    ADD CONSTRAINT ctrldecisions_action_check
        CHECK (Action IN ('Approve', 'Keep', 'Reassign', 'Split', 'Undo', 'Reclassify', 'DueToFrom')),
    ADD CONSTRAINT ctrldecisions_split_check CHECK ((Action = 'Split') = (Allocations IS NOT NULL)),
    ADD CONSTRAINT ctrldecisions_entity_check CHECK (Action NOT IN ('Approve', 'Reassign') OR EntityId IS NOT NULL),
    ADD CONSTRAINT ctrldecisions_target_check
        CHECK ((Action IN ('Reclassify', 'DueToFrom')) = (TargetAccountName IS NOT NULL)),
    ADD CONSTRAINT ctrldecisions_counterparty_check CHECK ((Action = 'DueToFrom') = (CounterpartyEntityId IS NOT NULL));

-- For each QBO file and each other entity: the account in that file that
-- holds "Due To/From <entity>". A setting (editable), not history.
CREATE TABLE CtrlDueToFromAccounts (
    GroupId UUID NOT NULL REFERENCES Groups(GroupId) ON DELETE CASCADE,
    QBOId UUID NOT NULL REFERENCES QBOs(QBOId) ON DELETE CASCADE,
    CounterpartyEntityId UUID NOT NULL REFERENCES CtrlEntities(EntityId) ON DELETE CASCADE,
    AccountCode TEXT,
    AccountName TEXT NOT NULL,
    UpdatedBy UUID REFERENCES Users(UserId),
    LastUpdated TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (QBOId, CounterpartyEntityId)
);
CREATE INDEX idx_ctrlduetofromaccounts_group ON CtrlDueToFromAccounts(GroupId);
