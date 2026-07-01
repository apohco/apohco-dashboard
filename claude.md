# APOHCO Financial Dashboard — .claude.md

## Project Overview
A multi-tenant, web-based financial reporting dashboard for dental practice groups (DSOs and solo owners). Built to consolidate QuickBooks Online (QBO) data across multiple entities, display standardized financial reports (P&L, Balance Sheet, Cash Flow), and support role-based access control. APOHCO is the founding case study tenant.

This is a **completely standalone application**, separate from the Full Circle Podcast Tool already deployed on the same AWS account. Do not share code, databases, Lambda functions, or Amplify deployments between the two apps. They coexist on the same AWS account and EC2 infrastructure only.

Screenshots of the desired UI aesthetic (modeled after QuickBooks Online) will be provided separately in the Claude Code conversation. Reference those screenshots for layout, color palette, typography, and component styling.

---

## Tech Stack

### Frontend
- React (single-page application)
- Recharts for data visualization (line charts, column charts, pie charts)
- Material-UI or Tailwind CSS for component styling
- Axios for API calls
- React Router for tab/page navigation

### Backend
- Node.js Lambda functions (AWS SAM)
- API Gateway (REST API)
- PostgreSQL on AWS RDS (separate schema/database from podcast tool)
- AWS S3 (for any file storage needs)
- AWS Cognito (authentication and role-based access)
- Llama on existing EC2 instance (shared with podcast tool, but called independently)

### Infrastructure
- AWS VPC (same account as podcast tool, separate stacks)
- AWS Amplify (separate deployment from podcast tool)
- AWS SAM for Lambda + API Gateway deployment
- Region: us-east-2

### Development
- Node.js (JavaScript throughout — frontend and backend)
- Git + GitHub for version control
- VS Code

---

## User Roles

### Platform-Level Roles (APOHCO team — spans all tenants)
- **Software Admin** (e.g., Paul) — full rights to everything across all Groups, all tenants, all settings. Can manage Software Reps and all client accounts.
- **Software Rep** — technical onboarding role. Can set up QBO API connections, configure new Groups, assist clients. Does not see sensitive financial data unless troubleshooting.

### Practice-Level Roles (scoped to their assigned Group)
- **Owner** — full access to their Group's financial data, reports, and all settings (Chart of Accounts, Consolidation Groups, QBO Data Sync, Cash Flow Configuration). UX refers to this user as "Owner" regardless of whether they have one or multiple locations.
- **Manager** — same settings access as Owner within their Group. Can configure Chart of Accounts, Consolidation Groups, and QBO Data Sync.
- **Team Member** — read-only, minimal dashboard view. Only sees reports relevant to them (e.g., quarterly bonus reporting). No access to settings.

---

## Authentication & Access Control (Cognito)

- Cognito user pool with invite-only signup (AllowAdminCreateUserOnly: true)
- JWT token verified on every Lambda request via aws-jwt-verify
- Role stored as a Cognito custom attribute
- Groups in Cognito map to platform roles and practice roles
- Software Admin and Software Rep are platform-level Cognito groups
- Each Group Practice has its own Cognito group (e.g., "APOHCO_Owner", "APOHCO_Manager", "APOHCO_TeamMember")

---

## Database Structure (PostgreSQL)

All tables are tenant-aware via GroupId.

### Users Table
- UserId (UUID, primary key)
- Username (unique — primary identifier, not email)
- Email (contact point for password reset; one email can be associated with multiple usernames)
- Role (SoftwareAdmin, SoftwareRep, Owner, Manager, TeamMember)
- CreatedDate
- LastLoginDate

### Groups Table (backend term for a practice or DSO organization)
- GroupId (UUID, primary key)
- GroupName (e.g., "APOHCO", "Thompson Dental Group")
- CreatedDate
- CreatedBy (UserId)

### GroupUsers Table (maps users to groups with roles)
- GroupUserId (UUID)
- GroupId (foreign key)
- UserId (foreign key)
- Role (Owner, Manager, TeamMember)
- AssignedDate

### QBOs Table (QuickBooks Online instances connected to a Group)
- QBOId (UUID, primary key)
- GroupId (foreign key)
- QBOName (e.g., "APOHCO Parent", "Montgomery QBO")
- RealmId (QBO company ID)
- IsClassBased (boolean — true if this QBO uses classes)
- AccessToken (encrypted)
- RefreshToken (encrypted)
- TokenExpiry
- CreatedDate
- CreatedBy (UserId — Software Rep or Software Admin only)

### QBOClasses Table (only for class-based QBOs)
- QBOClassId (UUID)
- QBOId (foreign key)
- ClassName (e.g., "Montgomery", "Westside")
- ClassId (QBO class ID)

### AccountGroupings Table (user-defined groupings per Group)
- GroupingId (UUID, primary key)
- GroupId (foreign key)
- GroupingName (e.g., "Revenue", "Marketing", "Payroll", "Current Assets")
- AccountType (PL or BalanceSheet — determines which reports this grouping appears in)
- CreatedDate
- CreatedBy (UserId)

### ChartOfAccountsMappings Table
- MappingId (UUID, primary key)
- GroupId (foreign key)
- QBOId (foreign key)
- AccountCode (from QBO)
- AccountName (from QBO)
- GroupingId (foreign key — assigned grouping)
- LastUpdated
- UpdatedBy (UserId)

### ConsolidationGroups Table
- ConsolidationGroupId (UUID, primary key)
- GroupId (foreign key)
- ConsolidationGroupName (e.g., "Montgomery Consolidated", "Full APOHCO")
- CreatedDate
- CreatedBy (UserId)

### ConsolidationGroupQBOs Table (maps QBOs or QBO Classes to a Consolidation Group)
- Id (UUID)
- ConsolidationGroupId (foreign key)
- QBOId (foreign key)
- QBOClassId (foreign key, nullable — if null, includes whole QBO)

### CashFlowMappings Table
- CashFlowMappingId (UUID)
- GroupId (foreign key)
- GroupingId (foreign key)
- CashFlowCategory (Operations, Investing, Financing)
- CreatedDate
- UpdatedBy (UserId)

### RawTransactions Table (raw QBO general ledger data)
- TransactionId (UUID, primary key)
- GroupId (foreign key)
- QBOId (foreign key)
- QBOClassId (nullable — if class-based)
- TransactionDate
- AccountCode
- AccountName
- Debit
- Credit
- Amount
- TransactionType
- Description
- QBOTransactionId (original QBO ID)
- PulledDate (when this was synced)

---

## QBO API Integration

- QuickBooks Online OAuth 2.0 authentication
- Software Rep or Software Admin sets up QBO API connection in Settings
- Pull the following from QBO API:
  - Chart of Accounts (all account codes, names, types)
  - General Ledger transactions (by date range)
  - Classes (if class-based QBO)
- Store raw transactions in RawTransactions table (overwrite by date range on sync)
- Reference QuickBooks Online API documentation for GeneralLedger, ChartOfAccounts, and Class endpoints

---

## Settings Module

Accessible via username dropdown in top-right corner of the dashboard. Settings options vary by role.

### 1. QBO API Setup (Software Rep and Software Admin only)
- View all QBOs connected to a Group
- Add new QBO connection (OAuth flow)
- Flag QBO as class-based or not (IsClassBased toggle)
- Edit or remove QBO connections

### 2. Chart of Accounts Setup (Owner and Manager)
- Landing page: list of all QBOs in the Group, each showing setup status
- Click into a QBO to open its Chart of Accounts configuration
- "Reconcile" button: pulls all unique account codes from that QBO (deduplicates), lists them in a table
- Each account row shows: Account Code, Account Name, Grouping dropdown (select existing or create new)
- On first setup, all accounts show blank Grouping
- On subsequent reconciles: existing mappings persist, new accounts appear at top with blank Grouping
- Save button stores all mappings to ChartOfAccountsMappings table
- Groupings apply to both P&L and Balance Sheet accounts

### 3. Consolidation Groups (Owner and Manager)
- Landing page: list of all Consolidation Groups for this Group
- Create new Consolidation Group: name it, select one or more QBOs (and optionally specific classes for class-based QBOs)
- Edit existing Consolidation Group: change name, add/remove QBOs or classes
- Delete Consolidation Group
- Full CRUD

### 4. QBO Data Sync (Owner, Manager, Software Rep, Software Admin)
- Select which QBO to sync
- Select date range (single month or custom range)
- Click Sync: pulls all transactions from QBO for that range, overwrites existing RawTransactions for that QBO and date range
- Shows confirmation: number of transactions synced, date range covered

### 5. Cash Flow Configuration (Owner and Manager)
- Lists all Groupings that have been created (both P&L and Balance Sheet types)
- For each Grouping, assign it to: Cash from Operations, Cash from Investing, or Cash from Financing
- Save assignments to CashFlowMappings table
- Scoped per Group

---

## Frontend Structure

### Navigation
- Left sidebar (approximately 1/6 width) with module navigation
- Main content area (approximately 5/6 width)
- Top header bar with username dropdown (Settings, Logout)

### Left Sidebar Modules
- **Financial** (expandable)
  - Profit & Loss
  - Balance Sheet
  - Cash Flow

(Additional modules will be added in future phases: Patient Data, Marketing, Operations)

### Report Views (consistent across P&L, Balance Sheet, Cash Flow)
Each report has three view options selectable at the top:
- **Single Month** — snapshot for one selected month
- **Multi-Month** — trend view across multiple months (e.g., 12-month column or line chart)
- **Compare** — side-by-side comparison of two periods or two entities

Each report also has:
- A selector for Individual QBO or Consolidation Group
- A Detail/Summary toggle:
  - **Summary view**: shows Grouping names and subtotals only
  - **Detailed view**: shows each Grouping as a header, with all accounts in that Grouping listed below (indented), and a subtotal row for that Grouping at the bottom

### P&L Report
- Revenue and expense accounts
- Grouped by AccountGroupings where AccountType = PL
- Subtotals per Grouping
- Net Income/Loss at bottom
- Optional "% of Revenue" column toggle: when enabled, displays each Grouping subtotal and each individual account amount as a percentage of total Revenue for that period. Shown as a secondary column next to the dollar amount. Available in both Summary and Detailed views.

### Balance Sheet Report
- Asset, liability, and equity accounts
- Grouped by AccountGroupings where AccountType = BalanceSheet
- Subtotals per Grouping
- As-of date selector

### Cash Flow Report
- Derived from P&L changes + Balance Sheet movements
- Grouped by CashFlowMappings (Operations, Investing, Financing)
- Net cash change at bottom

---

## Consolidation Logic

APOHCO has a parent company QBO (APOHCO Parent) that uses classes for each location (e.g., Montgomery class, Westside class). Each location also has its own standalone QBO instance.

To consolidate Montgomery's full P&L for a given month:
1. Pull RawTransactions from APOHCO Parent QBO filtered to Montgomery class
2. Pull RawTransactions from Montgomery standalone QBO
3. Join on AccountCode (chart of accounts should be consistent across entities)
4. Group by AccountGroupings
5. Sum amounts — do not double-count

When a user selects a Consolidation Group (e.g., "Montgomery Consolidated"), the system follows this logic for all QBOs and classes assigned to that group.

---

## Data Validation

- Build simple table views first to validate raw data is flowing correctly from QBO before building chart visualizations
- Each report should show a "Last Synced" timestamp so users know how fresh the data is
- If no data exists for a selected period, show a friendly empty state with a prompt to run QBO Data Sync

---

## Existing AWS Infrastructure

This app lives on the same AWS account as the Full Circle Podcast Tool but is completely independent. Use the same AWS account credentials and region (us-east-2). Create new, separate:
- SAM stack (do not modify full-circle-podcast-tool stack)
- RDS database or schema (do not use podcast tool database)
- Amplify app (separate frontend deployment)
- Cognito user pool (separate from podcast tool)
- S3 buckets (separate)
- Lambda functions (separate)

The Llama instance on EC2 can be called by this app's Lambda functions if needed, but treat it as an external endpoint — do not modify the EC2 configuration.

---

## Naming Conventions

- Tables: PascalCase (e.g., RawTransactions, ChartOfAccountsMappings)
- API endpoints: kebab-case (e.g., /api/profit-and-loss, /api/consolidation-groups)
- React components: PascalCase (e.g., ProfitAndLossReport, ChartOfAccountsSetup)
- Lambda functions: camelCase (e.g., syncQBOData, getConsolidatedPL)
- Environment variables: SCREAMING_SNAKE_CASE (e.g., DB_HOST, QBO_CLIENT_ID)

---

## Notes for Claude Code

- Screenshots of the desired UI aesthetic (QuickBooks Online style) will be provided in the conversation. Reference them for layout and design decisions.
- Build simple data tables first to validate QBO API integration before building chart visualizations.
- All backend logic should be in Node.js (JavaScript) to maintain one language across the full stack.
- Every Lambda function must verify the Cognito JWT token before processing any request.
- All database queries must be scoped by GroupId to enforce tenant isolation.
- Role-based access must be enforced at the API level, not just the frontend.
- QBO OAuth tokens must be stored encrypted.
- Include a SETUP.md with step-by-step deployment instructions.
