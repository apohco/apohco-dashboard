-- Controller Phase 2b: conflict resolution, vendor profiles, trend checks.

-- "Rule wins from now on": a rule version can take priority over history,
-- so lines where they disagree follow the rule and are no longer Conflicts.
ALTER TABLE CtrlVendorRules ADD COLUMN RuleWins BOOLEAN NOT NULL DEFAULT false;

-- Scope: 'Line' (a decision on a line under review) or 'Relabel' (an
-- earlier month's line relabeled by "Rule wins and relabel history").
-- RequestAje: whether Phase 5 should recommend an adjusting entry for it.
-- Line decisions always may; a relabel only when Paul asked for it.
-- Resolution: which conflict choice produced the decision, if any.
ALTER TABLE CtrlDecisions
    ADD COLUMN Scope VARCHAR(10) NOT NULL DEFAULT 'Line' CHECK (Scope IN ('Line', 'Relabel')),
    ADD COLUMN RequestAje BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN Resolution VARCHAR(20) CHECK (Resolution IN ('LineOnly', 'RuleWins', 'RuleWinsRelabel'));
CREATE INDEX idx_ctrldecisions_group_decided ON CtrlDecisions(GroupId, DecidedAt DESC);

-- Trend check thresholds (Review settings).
--   SplitShiftPoints   a vendor's share for an entity moves this many
--                      percentage points vs its baseline average
--   SpikePercent       an entity's spend in an account is this % above
--   SpikeMinAmount     ... and at least this many dollars above, its baseline
--   RecurringMonths    a vendor seen in each of this many previous months is
--                      "recurring" (missing this month is flagged)
--   BaselineMonths     months the averages are taken over
ALTER TABLE CtrlReviewSettings
    ADD COLUMN SplitShiftPoints NUMERIC(5, 2) NOT NULL DEFAULT 25 CHECK (SplitShiftPoints > 0 AND SplitShiftPoints <= 100),
    ADD COLUMN SpikePercent NUMERIC(7, 2) NOT NULL DEFAULT 50 CHECK (SpikePercent > 0),
    ADD COLUMN SpikeMinAmount NUMERIC(14, 2) NOT NULL DEFAULT 500 CHECK (SpikeMinAmount >= 0),
    ADD COLUMN RecurringMonths INTEGER NOT NULL DEFAULT 3 CHECK (RecurringMonths BETWEEN 2 AND 12),
    ADD COLUMN BaselineMonths INTEGER NOT NULL DEFAULT 6 CHECK (BaselineMonths BETWEEN 2 AND 24);
