# SETUP

Deployment guide for the APOHCO Financial Dashboard. This app is fully
independent from the Full Circle Podcast Tool — it uses its own RDS
schema, Cognito user pool, S3 buckets, Lambda functions, and Amplify app,
though it shares the same AWS account and region (`us-east-2`).

## Prerequisites

- Node.js 20.x
- AWS CLI configured with credentials for the shared AWS account
- AWS SAM CLI
- Access to the existing VPC in `us-east-2`

Deployment order matters here: the database and app secrets need to exist
before the backend can deploy; the backend needs to be deployed before you
know the API URL (needed for the QBO redirect URI) or can create Cognito
users; and a user needs to complete their first login before their `Users`
row exists (see section 6) and can be referenced as `CreatedBy` elsewhere.

## 1. Database (RDS PostgreSQL)

1. On the existing RDS instance (or a new instance, in the same VPC), create
   a database: `CREATE DATABASE apohco_dashboard;` — do not reuse the podcast
   tool's database.
2. Create a dedicated DB user for the app and store its credentials in
   Secrets Manager as JSON: `{ "username": "...", "password": "..." }`. Note
   the secret's ARN — it's the `DbCredentialsSecretArn` parameter below.
3. Run migrations from a machine with network access to the DB (e.g. via a
   bastion/VPN, or temporarily from within the VPC):
   ```
   cd backend
   npm install
   DB_HOST=<rds-endpoint> DB_NAME=apohco_dashboard DB_USER=<user> DB_PASSWORD=<password> npm run db:migrate
   ```
   This creates all tables listed in `claude.md` (Users, Groups, GroupUsers,
   QBOs, QBOClasses, AccountGroupings, ChartOfAccountsMappings,
   ConsolidationGroups, ConsolidationGroupQBOs, CashFlowMappings,
   RawTransactions), plus the `Classification` column added for report sign
   handling, and the `ReportLayoutRows`/`ReportLayoutRowComponents` tables
   used by Settings > Report Layout. Re-running is safe — already-applied
   migrations are tracked in `schema_migrations` and skipped.
4. After migrations are applied (and before/around first use of Settings >
   Report Layout), seed every existing Group's starting Report Layout so
   its P&L/Balance Sheet/Cash Flow reports don't go blank — the report
   Lambdas require a configured layout and no longer fall back to the old
   alphabetical display:
   ```
   DB_HOST=<rds-endpoint> DB_NAME=apohco_dashboard DB_USER=<user> DB_PASSWORD=<password> npm run db:backfill-report-layouts
   ```
   This reproduces each Group's current report structure (Groupings in
   today's order, plus the Total/Net rows today's reports compute
   automatically, like Total Income/Total Expenses/Net Income) as their
   starting layout, which can then be freely rearranged in Settings. Safe
   to re-run — any Group+Statement that already has a layout (including one
   a user has since customized) is left untouched.

## 2. Secrets Manager: app secrets

Create a secret (its ARN becomes the `AppSecretsArn` deploy parameter) as JSON:

```json
{
  "qboClientId": "...",
  "qboClientSecret": "...",
  "qboRedirectUri": "https://PLACEHOLDER/api/qbo/callback",
  "qboEnvironment": "sandbox",
  "oauthStateSecret": "<random 32+ byte string>",
  "tokenEncryptionKey": "<base64-encoded random 32-byte key, e.g. `openssl rand -base64 32`>"
}
```

`qboRedirectUri` is a placeholder for now — you won't know the real API URL
until after the first deploy (section 4). Come back and update this secret
(section 7) once you have it; Lambdas read secrets at invoke time, so no
redeploy is needed after updating it.

## 3. Backend (SAM)

This stack provisions the API Gateway API, all Lambda functions, **and the
Cognito User Pool** (`AllowAdminCreateUserOnly`, a `custom:role` attribute,
a `custom:groupId` attribute, and the platform-level `SoftwareAdmin` /
`SoftwareRep` Cognito Groups) — there's no separate manual Cognito setup step.

```
cd backend
npm install
sam build
sam deploy --guided   # first deploy; subsequent deploys use samconfig.toml
```

Fill in `backend/samconfig.toml` parameter overrides (`DbHost`,
`DbCredentialsSecretArn`, `AppSecretsArn`, `FrontendUrl`, `VpcSubnetIds`,
`VpcSecurityGroupIds`) before deploying. `VpcSubnetIds`/`VpcSecurityGroupIds`
must let the Lambda functions reach the RDS instance's port from within the
existing VPC. `FrontendUrl` can be a placeholder (e.g. `http://localhost:5173`)
until the frontend is deployed (section 8) — update and redeploy once known.

After deploy, note the stack Outputs — you'll need all three:
```
aws cloudformation describe-stacks --stack-name apohco-dashboard \
  --query "Stacks[0].Outputs"
```
- `ApiUrl` — the API Gateway base URL
- `UserPoolId` — the Cognito User Pool ID
- `UserPoolClientId` — the Cognito App Client ID

## 4. Frontend (local development)

```
cd frontend
npm install
cp .env.example .env
```

Fill in `.env` with the Outputs from section 3:
```
VITE_API_BASE_URL=<ApiUrl>
VITE_COGNITO_USER_POOL_ID=<UserPoolId>
VITE_COGNITO_CLIENT_ID=<UserPoolClientId>
```

```
npm run dev
```

## 5. QBO App Setup

1. Create an app in the [Intuit Developer portal](https://developer.intuit.com/)
   under `com.intuit.quickbooks.accounting` scope.
2. Add a Redirect URI matching the deployed API's callback route exactly:
   `<ApiUrl>/api/qbo/callback`.
3. Update the `AppSecretsArn` secret (section 2) with the real `qboClientId`,
   `qboClientSecret`, and `qboRedirectUri`. Use `sandbox` company credentials
   for `qboEnvironment` until ready to connect production QBOs.
4. Once a Software Rep/Admin is signed in, they initiate a connection from
   Settings → QBO API Setup, which calls `POST /api/qbo/connect` to get the
   Intuit authorization URL and redirects the browser there.

## 6. Initial Software Admin user (Paul)

Accounts are invite-only (`AllowAdminCreateUserOnly: true`) — there's no
self-service signup. Create the first user with the AWS CLI, using the
`UserPoolId` from section 3:

```
aws cognito-idp admin-create-user \
  --user-pool-id <UserPoolId> \
  --username paul \
  --user-attributes Name=email,Value=paul.r.rudolph@gmail.com Name=email_verified,Value=true Name=custom:role,Value=SoftwareAdmin \
  --desired-delivery-mediums EMAIL

aws cognito-idp admin-add-user-to-group \
  --user-pool-id <UserPoolId> \
  --username paul \
  --group-name SoftwareAdmin
```

This emails Paul a temporary password. He signs in at the deployed frontend
with username `paul`; the app will prompt him to set a permanent password on
first login (Cognito's `FORCE_CHANGE_PASSWORD` flow, handled by the Login
page). Once he completes that, the `postConfirmation` Lambda trigger
automatically creates his row in the `Users` table (`UserId` = his Cognito
`sub`, `Role` = `SoftwareAdmin`) — no manual DB step needed for this part.

Software Admins have no `custom:groupId` (they're platform-level, scoped to
every Group).

## 7. Creating the first Group Practice (APOHCO) and its Owner

New tenant onboarding goes through the `manageGroups` Lambda (SoftwareAdmin
only) rather than a manual SQL insert — once Paul's `Users` row exists
(section 6), he signs in to the frontend and goes to Settings → Manage
Groups (only visible to `SoftwareAdmin`), where **New Group** calls
`POST /api/settings/groups` with `{ groupName: "APOHCO" }`.

(Equivalently, from the CLI once Paul has an ID token:
`curl -X POST <ApiUrl>/api/settings/groups -H "Authorization: Bearer <id-token>" -d '{"groupName":"APOHCO"}'`.)

Then create the practice's Owner user the same way as section 6, this time
with `custom:groupId` set to the new Group's `GroupId` (shown in the Manage
Groups table, or in the `POST` response):

```
aws cognito-idp admin-create-user \
  --user-pool-id <UserPoolId> \
  --username <owner-username> \
  --user-attributes Name=email,Value=<owner-email> Name=email_verified,Value=true Name=custom:role,Value=Owner Name=custom:groupId,Value=<apohco-groupid> \
  --desired-delivery-mediums EMAIL
```

`email_verified=true` is what lets the user reset a forgotten password
themselves (the "Forgot password?" link on the login page emails a code
to a verified address only). For a user created without it:
```
aws cognito-idp admin-update-user-attributes --user-pool-id <UserPoolId> \
  --username <username> --user-attributes Name=email_verified,Value=true
```

Once Paul can sign in, the easier route is **Settings → Users → Invite
user** (SoftwareAdmin only). It creates the user with a verified email and
the right role and practice, and Cognito emails the temporary password. The
same screen edits email, role and practice, resends invites, sends password
resets, resets a lost authenticator app, and disables or re-enables
accounts. Accounts are never deleted from the app. The ControllerOwner
account is locked on that screen and can only be changed with the CLI.
Every change is recorded in `UserAdminAuditLog` (migration 008).

On their first login, `postConfirmation` creates both their `Users` row and
a `GroupUsers` row linking them to the APOHCO Group as Owner. Manager and
Team Member users are created the same way, with `custom:role` set to
`Manager` or `TeamMember`.

If the intended Owner already has a `Users` row from a prior sign-in (e.g.
you're granting an existing user Owner access to a *new* Group), skip the
`custom:groupId` dance and instead pass their `UserId` as `initialOwnerUserId`
in the `POST /api/settings/groups` body (or via the Manage Groups dialog) —
`manageGroups` links them to `GroupUsers` as Owner directly, in the same
request that creates the Group.

Deleting a Group (`DELETE /api/settings/groups/{groupId}`, also
SoftwareAdmin only) returns a 409 warning if it still has connected QBOs or
assigned users; retry with `?force=true` to delete it and everything under
it (QBOs, synced transactions, Groupings, Consolidation Groups, users'
Group membership).

## 8. Frontend deployment (Amplify Hosting)

`amplify.yml` at the repo root defines the build spec for this monorepo
(`appRoot: frontend`).

1. Push this repo to GitHub (or another supported git provider) if you
   haven't already — Amplify Hosting deploys from a connected repo.
2. In the Amplify Console: **New app → Host web app**, connect the repo, and
   confirm the detected `amplify.yml` build settings.
3. Add environment variables on the Amplify app (Console → App settings →
   Environment variables), matching `.env`: `VITE_API_BASE_URL`,
   `VITE_COGNITO_USER_POOL_ID`, `VITE_COGNITO_CLIENT_ID`.
4. Deploy. Once you have the Amplify domain, update the backend's
   `FrontendUrl` parameter (section 3) and redeploy the SAM stack — it's used
   for the QBO OAuth callback redirect and CORS.
5. **Add a SPA rewrite rule** (Console → App settings → Rewrites and
   redirects, or `aws amplify update-app --custom-rules ...`) — without this,
   Amplify 404s on any client-side route (e.g. `/settings/qbo-setup`) because
   it only serves files that actually exist in the build output. This isn't
   part of `amplify.yml` (that's the build spec, not routing config), so it
   has to be set on the app separately:
   ```json
   [{
     "source": "</^[^.]+$|\\.(?!(css|gif|ico|jpg|jpeg|js|png|txt|svg|woff|woff2|ttf|map|json)$)([^.]+$)/>",
     "target": "/index.html",
     "status": "200"
   }]
   ```

## 9. Controller module (Phase 1: Foundation)

The Controller module stores dated, append-only snapshots of each QBO
file's General Ledger, one month per pull. Only a `SoftwareAdmin` who is
also in the `ControllerOwner` Cognito group can see or call it. It never
writes to QuickBooks. See `docs/Controller Module Spec — CFO Tool.md`.

### 9.1 Before deploying: authenticator app (MFA) for every user

This release turns on **required TOTP MFA** for the whole user pool
(`MfaConfiguration: ON`, `SOFTWARE_TOKEN_MFA` only). Every existing user is
asked to set up an authenticator app (Google Authenticator, Microsoft
Authenticator, 1Password, ...) at their next sign-in. Let them know first.

When `sam deploy` shows the change set, check that `ApohcoUserPool` is
listed as **Modify** with **Replacement: False**. If it ever says
`Replacement: True`, cancel the deploy: replacing the pool would delete
every user account.

If a user loses their authenticator, an admin resets it so they can set it
up again at next sign-in:
```
aws cognito-idp admin-set-user-mfa-preference --user-pool-id <UserPoolId> \
  --username <username> --software-token-mfa-settings Enabled=false,PreferredMfa=false
```

### 9.2 Deploy

```
cd backend
npm install
npm test            # backend unit tests
sam build
sam deploy          # review the change set (see 9.1)
```

Then apply the new migrations (same as section 1):
```
cd backend
npm run db:migrate   # applies 006_raw_transactions_payee.sql, 007_controller_foundation.sql
```

New resources: the `ControllerOwner` Cognito group, the
`apohco-ctrl-gl-pull-<stage>` SQS queue and its dead-letter queue, the
`startCtrlSync`, `ctrlGlPullWorker`, `getCtrlJobs`, `getCtrlLedger`,
`manageCtrlEntities` functions, and `refreshQBOTokens` (daily at 09:00 UTC,
renews every API-connected QBO file's tokens so they don't lapse; it reads
no financial data).

Frontend: `cd frontend && npm install && npm test`, then push; Amplify
rebuilds as usual. No new environment variables.

### 9.3 Grant Controller access (Paul only)

```
aws cognito-idp admin-add-user-to-group --user-pool-id <UserPoolId> \
  --username paul --group-name ControllerOwner
```
Sign out and back in afterwards: group membership is read from the ID
token, which is only reissued at sign-in. Do not add anyone else to this
group. Membership can be checked with:
```
aws cognito-idp list-users-in-group --user-pool-id <UserPoolId> --group-name ControllerOwner
```

### 9.4 First use

1. **Controller → Entities**: add each dental home, linked to its class in
   the management company file and to its own QBO file.
2. **Controller → Overview**: pick a QBO file and a month range (up to 36
   months per pull) and click **Pull**. Each month is pulled separately in
   the background; the page shows progress. Repeat per file for the
   backfill.
3. **Controller → Ledger Browser**: browse any stored month. Re-pulling a
   month keeps the earlier pull; tick **Compare with previous pull** to see
   lines added, changed or removed since.

A month that fails three times is marked Failed (the message lands in the
dead-letter queue); start the pull again once the cause is fixed. If a
file shows **Last renewed** in amber on the Overview, its QBO connection
needs reconnecting in Settings → QBO API Setup.

### 9.5 Uploading a General Ledger file (no API connection needed)

Deploy: `npm run db:migrate` applies `009_controller_gl_uploads.sql`
(`CtrlUploads`, plus `Source`/`UploadId` on `CtrlSnapshots` and
`SplitAccount` on `CtrlLedgerLines`), and `sam deploy` adds the
`ctrlGlUpload` function (`/api/controller/uploads...`). No new environment
variables or buckets: files are staged under `controller-uploads/` in the
existing uploads bucket and deleted after import.

**Controller → Upload GL**:
1. Pick the QBO file, choose the CSV/XLSX export, click **Upload and match
   columns**. The header row is found automatically (title rows above it
   are skipped) and each column is matched by its header, in any order:
   Distribution account, Transaction date, Transaction type, Num, Name,
   Description, Split, Amount (or Debit/Credit), Class.
2. Check the mapping and fix any column with its dropdown. A file with
   the same columns as an earlier import from that QBO file reuses that
   import's mapping.
3. **Amount** in QuickBooks' GL export is positive when it increases the
   account, so each account's type (from Chart of Accounts) decides debit
   or credit. Accounts the dashboard hasn't classified are listed with a
   suggested type to confirm. The debit/credit total check flags a wrong
   setting on a full GL export.
4. Choose the months and **Import**. Each month becomes a new snapshot
   (marked as uploaded) beside any earlier pulls or uploads; nothing is
   written to QuickBooks or to the dashboard's report data.

Uploaded lines carry no QuickBooks transaction id, so comparing an upload
with a later API pull of the same month shows most lines as changed;
compare uploads with uploads, and pulls with pulls.

### 9.6 Review and vendors (Phase 2a)

Deploy: `npm run db:migrate` applies `010_controller_review.sql` (review
settings, vendors and aliases, versioned vendor rules, review runs,
suggestions, decisions); `sam deploy` adds `ctrlReview`
(`/api/controller/review/...`) and `manageCtrlVendors`
(`/api/controller/vendors...`). No new environment variables.

**Controller → Review**: pick a class-based file and a stored month, click
**Run review**. Every line gets a status (Unclassified, Confirmed, Likely
misclassified, Conflict, Needs evidence), a suggested entity and the
reasons. Filter by status, open/decided, account type, account, vendor,
entity or memo; approve, keep, set an entity or split a line; select all
matching lines to decide in bulk (lines already decided and watch-mode
vendors are skipped). **Settings** holds the confidence threshold (90% to
start) and how many months of history the engine learns from.

**Controller → Vendors**: one profile per payee (created on the first
review), with a default entity, memo keywords, a written rule (versioned;
used by the AI from Phase 3), watch mode, default split percentages, and
merge. Account types come from the dashboard's Chart of Accounts, else
from the types confirmed during GL upload.

### 9.7 Reviewing practice files (Phase 2a.1)

Deploy: `npm run db:migrate` applies `011_controller_account_review.sql`
(review kind on runs, suggested account on suggestions, target account and
other entity on decisions, and the `CtrlDueToFromAccounts` setting);
`sam deploy` adds `GET /api/controller/review/accounts` and
`PUT /api/controller/review/due-to-from` to `ctrlReview`.

**Controller → Review** now lists every QBO file. A class-based file gets
the class review above; any other file (each dental home's own file) gets an
**account review**: is each line in the right account, or does it belong to
another entity?

- **Reclassify…** moves lines to another account in the same file.
- **Due To/From…** marks lines as belonging to another entity. The line
  moves to this file's Due To/From account for that entity: the saved
  default, else the account named "Due from/to <entity>" (found by name,
  using the entity's name, aliases and keywords). Choosing a different
  account uses it for those lines; tick **Make this the default** to keep
  it. **Due To/From accounts** (next to the file picker) shows and edits
  every entity's default for the file.
- Suggestions: where this vendor's lines of the same account type went in
  earlier months (decisions count 3x), and another entity named in the
  memo. A line already in a "Due to/from <entity>" account counts as Due
  To/From that entity. **Approve** records the suggested Keep, Reclassify
  or Due To/From.

Both actions also work on the management file. Decisions are only recorded
here; nothing is written to QuickBooks. Phase 5 turns them into recommended
adjusting entries.

### 9.8 Conflicts, vendor profiles and trends (Phase 2b)

Deploy: `npm run db:migrate` applies `012_controller_conflicts_trends.sql`
(RuleWins on vendor rules; Scope, RequestAje and Resolution on decisions;
trend thresholds on review settings). `sam deploy` adds `ctrlConflicts`
(`/api/controller/conflicts...`), `ctrlTrends` (`/api/controller/trends`),
and two routes on `manageCtrlVendors`: GET `/vendors/{vendorId}` (profile)
and POST `/vendors/{vendorId}/rules/test`. No new environment variables.

**Controller → Conflicts**: lines where a vendor rule and strong history
disagree (management file), with the rule and history side by side. For each:

- **This transaction only:** decides the line; the rule and history stay as they are.
- **Rule wins from now on:** saves a new rule version that takes priority
  over history, and decides this month's open conflicts for the vendor.
- **Rule wins and relabel history:** as above, and relabels every earlier
  line of the vendor that disagrees with the rule (preview first). Relabeled
  lines only request adjusting entries if **Request adjusting journal
  entries** is ticked.

**Controller → Vendors**: the list adds 12-month spend, % reviewed and
average confidence (sortable). Click a vendor for its profile: spend by
entity by month, approval rate, rule versions, relabels and corrections.
**Test rule** in the edit dialog previews a rule over the last 3, 6 or 12
months before you save it.

**Controller → Trends**: spend by entity by month across every file (your
decisions applied), each top vendor's split by entity, and the trend checks
for a month: split shift, spend spike, new vendor, missing recurring charge,
each linking to the lines in Review. Thresholds are in Review → Settings
(start: 25 points; +50% and $500; 3 months; 6-month average).

### 9.9 AI matching (Phase 3: Claude on Amazon Bedrock)

Deploy: `npm run db:migrate` applies `013_controller_ai.sql` (AI settings on
review settings; `CtrlAiJobs`, `CtrlAiBatches`, `CtrlAiSuggestions`,
`CtrlAiCalls`; `SuggestionSource` on decisions). `sam deploy` adds:

- the `apohco-ctrl-ai-<stage>` queue and its dead-letter queue;
- `ctrlAiWorker` (queue worker; the only function allowed to call Bedrock:
  `bedrock:InvokeModel` on Anthropic models through the `us.` inference
  profile, so requests are served from US regions only);
- `ctrlAi` (`/api/controller/ai/status`, `/usage`, `/jobs`, `/jobs/{jobId}`);
- SQS send permission and `CTRL_AI_QUEUE_URL` on `ctrlReview`.

Settings (template.yaml, `Globals`): `AI_MODEL_ID`
(`us.anthropic.claude-opus-5-5`) and `AI_EFFORT` (`low`). Optional
`AI_PRICE_INPUT` / `AI_PRICE_OUTPUT` / `AI_PRICE_CACHE_READ` /
`AI_PRICE_CACHE_WRITE` (USD per million tokens) adjust the cost estimate.
Model access: the account could already invoke Claude Opus 5.5 through
`bedrock-runtime` when Phase 3 was built. If a call ever fails with an access
error, enable the model under Bedrock → Model access (us-east-2). The newer
Bedrock "Mantle" endpoint returned 404 for this account, so the app uses the
standard `bedrock-runtime` API.

How it works:

- **Run review** works as before, then starts an **AI pass** in the
  background for the lines rules and history couldn't settle (below the
  confidence threshold, or vendors whose written rule the engine can't
  read). Only expense and revenue lines are sent, never the bank or card
  side of a transaction. Conflicts and decided lines are skipped. At most
  500 lines per run, in batches of up to 25 (one model call each).
- The queue shows an **AI** column (suggestion, confidence, reason as a
  tooltip) and an AI filter. **Accept AI** (per line, or in bulk) records
  the suggestion as your decision. AI confidence is capped (default 85%,
  below the 90% threshold), so every AI suggestion waits for you.
- **Check AI accuracy** re-asks the AI about up to 50 lines you already
  decided, without showing it your answers, and reports how often it agrees.
  **Test with AI** in the vendor dialog tries a draft written rule on the
  vendor's recent lines. Neither changes anything.
- Review → Settings → **AI matching**: on/off, confidence cap, **monthly
  budget** (default $25; batches stop when this month's estimated spend
  reaches it) and **Withhold payee and memo on refund and patient lines**
  (on by default; no AWS BAA has been confirmed).
- Cost: about $0.05 per batch with Claude Opus 5.5 (October 2026: about
  $1 for a full AI pass of the management file). Every call is logged in
  `CtrlAiCalls`.

Troubleshooting: a batch that fails 3 times is marked Failed (shown on the AI
bar) and its message lands in the dead-letter queue. "Run AI pass" / "Ask AI
about remaining lines" asks again only about lines without an answer.

**Deploying since Phase 3:** use `backend/scripts/deploy-single-package.ps1`
(PowerShell) instead of `sam build` + `sam deploy`. It builds once into
`C:\Projects\sb` (avoiding Windows' 260-character path limit), zips the code
once for every function, and creates the change set without executing it.
Review the change set, then execute it.

### 9.10 Evidence from Gmail (Phase 4a)

Deploy: `npm run db:migrate` applies `014_controller_evidence.sql` (Google
settings and opted-in sources; evidence candidates, searches and "Search All"
jobs). The deploy adds the `apohco-ctrl-evidence-<stage>` queue and its
dead-letter queue, plus three functions. Only these three can read the Google
key (`GOOGLE_SA_SECRET_ID`):

- `ctrlGoogle`: `/api/controller/google`, `/test`, `/directory`, `/sources`
- `ctrlEvidence`: `/api/controller/evidence`, `/find`, `/jobs/{jobId}`,
  `/{candidateId}/preview`
- `ctrlEvidenceWorker`: the "Search All" queue worker

It also adds `POST /api/controller/review/evidence-search` to `ctrlReview`.
Nothing reads mail until section 10 below is done and the connection is set
up in the dashboard.

- **Controller → Google Workspace**: the admin account (info@apohco.com),
  **Test connection** (checks the key, the user list, Gmail and shared drives),
  and the sources that may be searched. **Browse workspace** lists users and
  shared drives to opt in. Only switched-on sources are searched, and only
  accounts in the workspace's domain can be added. Gmail is searched now;
  Drives join with the Drive index (Phase 4b).
- **Review**: an **Evidence** column. **Find Evidence** searches the opted-in
  mailboxes for that line right away. **Search All** searches every matching
  line (or the selected ones) in the background, 300 at most per run, largest
  amounts first. Each search looks for the amount, then for the vendor's name
  and aliases, within ±10 days. Candidates are scored on amount, vendor and
  date, and on whether they name a practice, which is shown as a hint, e.g.
  "Names Lebanon".
- **Line detail** (a line's ⋮ menu → *Line detail and evidence*, or click its
  evidence count): every candidate with what matched, and **Preview**, which
  fetches the email itself as plain text. Emails are linked, not copied: only
  the subject, sender, date, a short snippet and attachment names are stored.
  Every search and preview is written to the audit log.

## 10. Before Phase 4: Google Workspace (Gmail and Drive evidence)

Phase 4 searches Gmail and Drive for invoices and receipts that support a
line, and saves confirmed evidence. It reads mail and files through a Google
service account with **domain-wide delegation**, limited to the mailboxes
and folders you list. These steps need a Google Workspace **super admin**.
Nothing here can be done from the dashboard, and no key should ever be
pasted into chat or email.

1. **Google Cloud project** (console.cloud.google.com, signed in with the
   Workspace admin account): create a project, e.g. `apohco-controller`.
   Under APIs & Services → Library, enable the **Gmail API** and the
   **Google Drive API**.
2. **Service account**: IAM & Admin → Service Accounts → Create, e.g.
   `controller-evidence`. Grant it no project roles. Open it and note its
   **Unique ID** (the numeric client ID).
3. **Key**: on the service account, Keys → Add key → JSON. Store it in AWS
   Secrets Manager yourself, then delete the downloaded file:

   ```bash
   aws secretsmanager create-secret --region us-east-2 \
     --name apohco-dashboard/google-service-account \
     --secret-string file://controller-evidence-key.json
   ```

   Phase 4 lets only the evidence Lambdas read this secret. (If your
   organization blocks key creation with the
   `iam.disableServiceAccountKeyCreation` policy, tell me and I'll set up
   keyless access through Workload Identity Federation instead.)
4. **Domain-wide delegation** (admin.google.com → Security → Access and data
   control → API controls → Manage Domain Wide Delegation → Add new): the
   client ID from step 2, with exactly these scopes:

   ```
   https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/drive.readonly,https://www.googleapis.com/auth/drive.file,https://www.googleapis.com/auth/admin.directory.user.readonly
   ```

   Read-only for mail, files and the user list. `drive.file` only lets the
   app write files it creates itself: the **Controller Evidence** folder it
   makes in the admin account's (info@apohco.com) My Drive.
   `admin.directory.user.readonly` lets Controller → Google Workspace list
   the workspace's users so you can opt their mailbox or Drive in.
5. **Connect** in the dashboard: Controller → **Google Workspace**. Enter the
   admin account (info@apohco.com), click **Test connection**, then opt in
   the mailboxes and Drives to search (start with info@apohco.com). Only
   opted-in sources are ever searched; the list is enforced on the server.
