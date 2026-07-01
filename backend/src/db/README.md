# db

PostgreSQL schema for the APOHCO Financial Dashboard (see `../../../claude.md`
for the full data model description).

- `migrations/001_initial_schema.sql` — creates all tables: Users, Groups,
  GroupUsers, QBOs, QBOClasses, AccountGroupings, ChartOfAccountsMappings,
  ConsolidationGroups, ConsolidationGroupQBOs, CashFlowMappings, RawTransactions.
- `migrate.js` — applies any not-yet-applied `migrations/*.sql` files in order,
  tracked in a `schema_migrations` table. Run with `npm run db:migrate` from
  `backend/` (requires `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` env vars).

Future schema changes should be added as new numbered files
(`002_*.sql`, `003_*.sql`, ...) rather than editing `001_initial_schema.sql`.
