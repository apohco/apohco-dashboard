# settings

CRUD functions backing the Settings module. All require Cognito auth;
mutation routes are further role-gated.

- `manageGroups` — `/api/settings/groups` (GET, POST) and `/{groupId}` (PUT, DELETE). **SoftwareAdmin only.** Platform-level: creates/lists/renames/deletes Group Practices (tenants) themselves, unlike everything else below which operates *within* an existing Group. Creating a Group can optionally link an existing user as its initial Owner (`initialOwnerUserId`) directly via `GroupUsers`. Deleting a Group with QBOs or users still attached returns a 409 warning unless `?force=true` is passed. See `docs/SETUP.md` for the new-tenant-onboarding flow this replaced (a manual SQL insert).

The rest are GroupId-scoped:

- `manageAccountGroupings` — `/api/settings/account-groupings` (GET, POST) and `/{groupingId}` (PUT, DELETE). Owner/Manager for writes.
- `manageChartOfAccounts` — `/api/settings/chart-of-accounts` (GET, PUT). Reads the list `syncQBOData` keeps reconciled; PUT saves Grouping assignments. Owner/Manager for writes.
- `manageConsolidationGroups` — `/api/settings/consolidation-groups` (GET, POST) and `/{consolidationGroupId}` (PUT, DELETE). Full CRUD including QBO/class membership. Owner/Manager for writes.
- `manageCashFlowMappings` — `/api/settings/cash-flow-mappings` (GET, PUT). Assigns P&L/Balance Sheet Groupings to Operations/Investing/Financing. Owner/Manager for writes.
- `manageQBOs` — `/api/settings/qbos` (GET, any role — also feeds report entity selectors) and `/{qboId}` (PATCH, DELETE, SoftwareRep/SoftwareAdmin only).

OAuth connection setup itself lives in `../qbo` (`qboOAuthConnect`, `qboOAuthCallback`, `syncQBOData`).
