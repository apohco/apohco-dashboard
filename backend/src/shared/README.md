# shared

Code shared across Lambda functions:

- `secretsManager.js` — cached Secrets Manager JSON secret fetcher
- `db.js` — pooled `pg` client, credentials pulled from `DB_CREDENTIALS_SECRET_ARN`
- `verifyToken.js` — re-verifies the Cognito ID token on every request and returns normalized claims (`userId`, `role`, `groupId`, ...)
- `authorize.js` — `requireRole` / `requireGroupAccess` helpers for role- and tenant-scoping API access
- `response.js` — consistent JSON API Gateway responses + error-handling wrapper
- `crypto.js` — AES-256-GCM encrypt/decrypt for QBO OAuth tokens at rest, key pulled from `APP_SECRETS_ARN`
- `oauthState.js` — signs/verifies the QBO OAuth `state` param (HMAC, 10 min TTL) so the callback route can trust it without a server-side session store
- `qboClient.js` — Intuit OAuth token exchange/refresh, Chart of Accounts / Class queries, and GeneralLedger report fetch + flattening
