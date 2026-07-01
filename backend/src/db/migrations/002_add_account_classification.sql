-- QBO's Account entity exposes a `Classification` field (Asset, Liability,
-- Equity, Revenue, Expense) that tells us each account's normal balance
-- side. Reports need this to display debit/credit-normal accounts with
-- consistent signs (e.g. Revenue shown positive despite being credit-normal
-- in the underlying Debit/Credit ledger columns). syncQBOData populates
-- this on every sync.
ALTER TABLE ChartOfAccountsMappings
    ADD COLUMN Classification VARCHAR(20)
        CHECK (Classification IN ('Asset', 'Liability', 'Equity', 'Revenue', 'Expense'));
