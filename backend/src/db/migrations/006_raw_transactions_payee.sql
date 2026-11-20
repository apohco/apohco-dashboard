-- Captures the payee (QBO's GeneralLedger `name` column: vendor, customer
-- or employee on the transaction) on every RawTransactions line. syncQBOData
-- already requested this column from QBO but discarded it; the Controller
-- module keys vendor profiles and matching on it. Nullable: rows synced
-- before this migration (and journal entries with no name) have none.
-- This is the only change the Controller module makes to an existing table.
ALTER TABLE RawTransactions ADD COLUMN PayeeName VARCHAR(255);
