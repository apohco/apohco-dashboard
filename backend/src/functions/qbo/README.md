# qbo

- `qboOAuthConnect` — `POST /api/qbo/connect` (Cognito-authenticated, SoftwareRep/SoftwareAdmin). Returns the Intuit authorization URL to redirect the browser to.
- `qboOAuthCallback` — `GET /api/qbo/callback` (public — Intuit redirects the browser here with no Cognito token; trust comes from the signed `state` param). Exchanges the auth code for tokens, encrypts and stores them on the `QBOs` row, then redirects back to the frontend Settings page.
- `syncQBOData` — `POST /api/qbo/sync` (Cognito-authenticated, Owner/Manager/SoftwareRep/SoftwareAdmin). Refreshes the QBO access token if needed, syncs Classes and Chart of Accounts, then pulls the GeneralLedger report for the given date range and overwrites `RawTransactions` for that QBO + range.

`getChartOfAccounts` (a dedicated read endpoint for the Chart of Accounts Setup screen) is Phase 2 — for now the Chart of Accounts is queryable directly from `ChartOfAccountsMappings`, which `syncQBOData` keeps up to date.
