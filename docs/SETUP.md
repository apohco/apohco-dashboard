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
   handling. Re-running is safe — already-applied migrations are tracked in
   `schema_migrations` and skipped.

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
  --user-attributes Name=email,Value=paul.r.rudolph@gmail.com Name=custom:role,Value=SoftwareAdmin \
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
  --user-attributes Name=email,Value=<owner-email> Name=custom:role,Value=Owner Name=custom:groupId,Value=<apohco-groupid> \
  --desired-delivery-mediums EMAIL
```

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
