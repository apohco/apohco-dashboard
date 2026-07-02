# qbo

- `qboOAuthConnect` — `POST /api/qbo/connect` (Cognito-authenticated, SoftwareRep/SoftwareAdmin). Returns the Intuit authorization URL to redirect the browser to.
- `qboOAuthCallback` — `GET /api/qbo/callback` (public — Intuit redirects the browser here with no Cognito token; trust comes from the signed `state` param). Exchanges the auth code for tokens, encrypts and stores them on the `QBOs` row, then redirects back to the frontend Settings page.
- `syncQBOData` — `POST /api/qbo/sync` (Cognito-authenticated, Owner/Manager/SoftwareRep/SoftwareAdmin). Refreshes the QBO access token if needed, syncs Classes and Chart of Accounts, then pulls the GeneralLedger report for the given date range and overwrites `RawTransactions` for that QBO + range.
- `manualUpload` — CSV/Excel import as an alternative to the API sync, same overwrite-by-QBO-and-date-range semantics and same role gate (Owner/Manager/SoftwareRep/SoftwareAdmin). Three routes, all POST:
  - `/api/qbo/manual-upload/presign` — returns an S3 presigned PUT URL; the browser uploads the file directly to S3 (bypasses Lambda/API Gateway payload limits).
  - `/api/qbo/manual-upload/preview` — parses the uploaded file (via `shared/fileParser.js`), returns the first 10 valid rows + row-level errors, no DB writes.
  - `/api/qbo/manual-upload/confirm` — re-parses, upserts `ChartOfAccountsMappings` for every account referenced (same "reconcile" semantics as `syncQBOData`), overwrites `RawTransactions` for the QBO + date range, then deletes the S3 object.

  Expected columns: `TransactionDate`, `AccountCode`, `AccountName`, `Classification` (required — `Asset|Liability|Equity|Revenue|Expense`), `Debit`, `Credit`, `Amount` (optional, computed from Debit-Credit if omitted), `TransactionType`, `Description`, `ClassName` (only used if the QBO `IsClassBased`). CSV is parsed with `csv-parse` rather than `xlsx` — see the comment in `fileParser.js` for why (the `xlsx` library's CSV type-inference mangles date-shaped text).

`getChartOfAccounts` (a dedicated read endpoint for the Chart of Accounts Setup screen) is Phase 2 — for now the Chart of Accounts is queryable directly from `ChartOfAccountsMappings`, which `syncQBOData` keeps up to date.
