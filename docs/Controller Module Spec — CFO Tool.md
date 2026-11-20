# Controller Module Spec — CFO Tool

Nov 19, 2026 · @Paul

## Purpose and principles

The Controller module reviews every APOHCO QuickBooks Online general ledger each month, flags expenses that are unclassified or likely misclassified, and recommends the correct dental home or entity, backed by invoices and emails from Google Workspace. It is built as an add-on to the existing financial dashboard, which becomes Paul's private CFO tool.

Scope: all practice QBO files plus the management company file, where shared expenses (Kroger, Amazon, Facebook ads and similar) are tagged to dental homes using QBO classes.

Guiding principles:

- **Read-only to QuickBooks.** The module never writes to QBO. It produces recommended adjusting journal entries (AJEs) that the accountant reviews and posts.
- **Paul is the only full user.** The dashboard and the Controller module are Paul-only. The accountant gets a walled-off AJE portal and nothing else.
- **Human-confirmed evidence.** The tool links candidate emails and documents automatically, but only saves a PDF as supporting documentation after Paul confirms the match.
- **It learns, Paul decides.** Paul's written rules and his approvals train the matching. Conflicts between rules and history are flagged, never silently resolved.
- **History is kept, never overwritten.** Every GL pull is stored as a dated snapshot so trends span the full history.

## Fit with the existing dashboard

The dashboard already provides the QBO connections, Cognito login, AWS hosting (us-east-2), Postgres on RDS and an S3 upload path, so the Controller reuses all of them. Six gaps in the current build must be closed first, because the Controller depends on them.

| Gap today | Why it matters for the Controller | Required change |
| --- | --- | --- |
| GL sync drops the payee name (`name` column) | Vendor profiles and matching are keyed on payee | Store payee name on every line |
| No line IDs; re-sync deletes and reinserts the range | Lines can't be tracked, deduplicated or compared month to month | Controller keeps its own append-only line table with a stable line fingerprint (see GL ingestion) |
| Syncs run inside API Gateway's \~29-second limit | Multi-month pulls, Drive indexing and AI matching will time out | Move long work to async jobs (Step Functions or SQS + worker Lambdas) with job-status polling |
| No scheduled QBO token refresh; possible refresh race | A file left alone for months can lose its connection | Scheduled refresh job plus a row lock on token rotation |
| No Google or LLM integration | Evidence search and AI matching are core features | Add Google domain-wide delegation and Claude via Amazon Bedrock |
| S3 bucket has a 1-day lifecycle rule | Saved supporting PDFs must persist | New private evidence bucket with no expiry |

Other items to address along the way: TeamMember can currently read every report, so the accountant needs a new, tightly scoped role (see Accountant portal), and there are no tests, so the matching engine and AJE builder get unit tests from day one.

Placement follows the existing layout: `backend/src/functions/controller/<fn>/index.js`, routes under `/api/controller/...`, migrations in `backend/src/db/migrations/`, pages in `frontend/src/pages/Controller/`, an API wrapper in `frontend/src/api/controller.js`, and a new Controller section in `Sidebar.jsx`. Move `getValidAccessToken` into `shared/` so both modules use it. Consider a nested SAM stack for the Controller to keep `template.yaml` manageable.

## GL ingestion and history

GLs are pulled straight from QBO through the existing connections, one month per pull, into the Controller's own append-only tables. CSV/Excel upload stays available as a fallback using the existing presigned-S3 upload flow.

- **Backfill:** Paul picks a QBO file and a date range (for example the last 12–24 months). The job splits it into month-sized GL pulls, which also avoids the GL report's truncation limits.
- **Monthly run:** a scheduled job pulls the prior month for every connected file early each month and queues it for review. Paul can also run any month on demand.
- **Snapshots, not overwrites:** each pull is saved as a dated snapshot. If a re-pull changes a line (because the accountant posted an AJE or someone edited it in QBO), the new version is stored beside the old one and the change is shown.
- **Line identity:** the GL report has no line IDs, so each line gets a fingerprint from QBO file, transaction ID, transaction type, account, amount, date and memo. Phase 2 can enrich lines from the entity endpoints (Purchase, Bill, JournalEntry, Deposit), which carry true line IDs.
- **Fields kept per line:** date, transaction type, doc number, payee name, memo, account, class, debit, credit, QBO transaction ID, snapshot ID.
- **Review scope vs trend scope:** Paul reviews one month or several, but every analysis reads the full stored history.

## Classification engine

Each expense line gets a suggested entity, a confidence score and the reasons behind it, drawn from three signals in priority order.

1. **Written rules:** Paul's plain-language rules on the vendor profile, applied by the AI as instructions.
2. **Evidence:** a matched invoice, receipt or email naming a practice, address, doctor or keyword.
3. **Learned history:** how this vendor, account and memo pattern has been classified and approved before, including every correction Paul made.

Each line lands in one status:

| Status | Meaning |
| --- | --- |
| Unclassified | No class or entity in QBO |
| Likely misclassified | Current class disagrees with the suggestion above a threshold |
| Confirmed | Current class agrees with rules, evidence and history |
| Conflict | Written rule and learned history point to different entities |
| Needs evidence | No rule and weak history; evidence search found nothing |

Confidence is shown as High, Medium or Low with the score and a short explanation (for example, "Rule: Minuteman invoices addressed to Milford; invoice #4471 found in Drive").

**Conflicts** go to their own queue showing the rule, the history and the evidence side by side. Paul resolves each one with one of three choices:

- This transaction only.
- Rule wins from now on.
- Rule wins and history is relabeled, so trends and future suggestions recalculate.

**Learning:** every approval, override and conflict decision is stored as a labeled example. The next run uses these as examples for the AI and updates per-vendor patterns, so confidence improves month over month.

**Trend checks** run over the full history: a vendor's split across entities shifting, spend spiking for an entity, a new vendor appearing, or a recurring charge missing.

## Vendor profiles and written rules

Every payee name found in any GL gets a vendor profile, which is where Paul teaches the tool. Payee names that differ across files ("AMZN Mktp", "Amazon.com") can be merged into one profile with aliases.

Each profile shows:

- **Written rules** in plain English, with optional structured hints: where to look (a Drive folder, a mailbox, sender addresses) and keywords that map to each entity. Example: "Minuteman invoices are PDFs in the Minuteman folder. The service address on the invoice tells you which practice it belongs to."
- **Default entity** and an optional split rule (fixed percentages) for vendors that legitimately serve several homes.
- **History:** the entity split by month, approval rate, and every correction with who made it and when.
- **Watch mode:** a toggle that sends every line for this vendor to review even at high confidence, until Paul trusts it.
- **Test a rule:** before saving a rule change, preview how it would reclassify the last 3–12 months and which lines would conflict with history.

Rules are versioned, so any suggestion can show which rule version produced it.

## Evidence: Gmail and Google Drive

The tool finds supporting documents across the APOHCO Google Workspace, which covers management-company accounts only. Access uses a Google service account with domain-wide delegation and read-only scopes, set up once by Paul as Workspace admin.

| Source | Scope | How it's searched |
| --- | --- | --- |
| Gmail | Only mailboxes on an allowlist Paul controls in settings | Live, targeted search per transaction |
| Google Drive | Every user's My Drive plus all shared drives, shared or not | Nightly index, then instant lookup |

**Gmail search** uses vendor name and known sender addresses, the amount (and common formats of it), and a date window of about ±10 days. It never searches outside the allowlist.

**Drive index:** a nightly job lists new or changed PDFs, images and invoice-like documents across all users and shared drives, extracts their text (OCR for scans), and stores the text plus file ID, owner, path and modified date in Postgres with full-text search. Matching then queries the index, not Drive.

**Every candidate is linked, not copied.** Each transaction shows candidate evidence with a match score and a deep link that opens the exact email or file. Nothing is saved yet.

**Save as support (manual, after Paul confirms):**

1. Paul clicks Confirm on the correct email or file.
2. The tool renders the email to PDF with its attachments (or copies the Drive file) and stores it in the private evidence bucket, attached to that transaction.
3. A copy is filed in Drive under a Controller folder by practice and month, named date\_vendor\_amount.

A confirmed match also becomes a learning example for that vendor.

## Review workflow and screens

The monthly cycle runs from GL pull to confirmed posting, and every decision Paul makes feeds the next month's suggestions.

&#91;embedded content: monthly controller cycle · 7 steps, 1 learning loop\]

Screens (Controller section in the sidebar):

| Screen | What it shows | Main actions |
| --- | --- | --- |
| Overview | Each QBO file by month: unclassified, likely misclassified and conflict counts, $ at stake, open AJEs | Pick a file and period; start a pull |
| Review queue | Lines with current class, suggested entity, confidence, reasons, evidence preview | Filter by vendor/status/entity; approve or override singly or in bulk |
| Conflicts | Rule vs history vs evidence, side by side | Resolve: this line, rule wins going forward, or rule wins and relabel history |
| Line detail | The line, its history for this vendor, every evidence candidate with deep links | Confirm evidence; Save as support |
| Vendors | All vendor profiles, sortable by spend, review rate, confidence | Edit rules, aliases, watch mode; test a rule |
| Trends | Entity split by vendor over time; spend by entity by month; anomalies | Drill into any month or vendor |
| AJE reports | Draft and published reports, entry status, open questions | Build, group/ungroup, publish, export, answer questions |
| Settings | Entities, QBO files, mailbox allowlist, schedules, thresholds | Edit |

Charts reuse Recharts and the existing MUI look.

## AJE reports and numbering

Approved reclassifications become recommended adjusting journal entries in a numbered report that Paul publishes to the accountant. Grouping is a toggle chosen at report time.

- **Grouped:** lines roll up by QBO file, vendor, account, from-class and to-class. Eight Kroger lines moving from Unclassified to Lebanon become one entry, with the eight transactions listed underneath as backup.
- **Per line:** one entry per transaction.

Each entry shows the debit and credit lines (same account, class moves from old to new), the total, the period, a memo the accountant can paste into QBO, and links to its supporting documents.

**Numbering:** reports are numbered per QBO file and period, and entries are numbered within the report.

| Item | Format | Example |
| --- | --- | --- |
| Report | FILE-YYYY-MM-AJE-### | MGMT-2026-10-AJE-001 |
| Entry | Report number + .## | MGMT-2026-10-AJE-001.03 |

Numbers are permanent: a revised report gets the next sequence number and references the one it replaces. The AJE number goes in the QBO journal entry's doc number, so the next GL pull can automatically confirm whether each entry was actually posted.

Exports: the portal view, plus PDF and Excel of each report for the file.

## Accountant AJE portal

The accountant gets a separate, walled-off view that shows only the AJE reports Paul publishes and their saved supporting documents. It has no access to the GL review, vendor rules, Gmail or Drive search, or any other dashboard report.

What the accountant can do:

- See each published report and its numbered entries.
- Set each entry's status: Not worked, Booked, Declined (with a required reason).
- Ask a question on any entry; Paul answers in the same thread, and the entry shows Question open until he does.
- Open supporting PDFs, served from the tool's own storage through short-lived signed links. They never get access to Paul's Google Drive.
- Download a report as PDF or Excel.

What Paul sees: a rollup by report and QBO file of open, booked and declined entries, unanswered questions, and entries marked Booked that the next GL pull has not yet confirmed.

Access: a new Cognito role (for example `Accountant`) that is allowed only on `/api/controller/portal/...` routes and only for published reports. Every status change, comment and document view is logged with user and time.

## Data model: new tables

New Postgres tables follow the existing PascalCase convention, each with a GroupId foreign key, in numbered migrations. Existing tables (QBOs, QBOClasses, RawTransactions) are not changed except to add payee name to RawTransactions.

| Table | Purpose | Key fields |
| --- | --- | --- |
| Entities | Dental homes and companies the tool assigns to | EntityId, Name, QBOClassId (in the management file), QBOId (practice file), Aliases, Keywords |
| CtrlSyncJobs | Each pull or backfill job and its status | JobId, QBOId, PeriodStart, PeriodEnd, Status, RowCount, Error |
| CtrlSnapshots | One stored GL pull per file per month | SnapshotId, QBOId, Period, PulledAt, JobId |
| CtrlLedgerLines | Append-only GL lines | LineId, SnapshotId, Fingerprint, TxnDate, TxnType, DocNum, PayeeName, Memo, AccountCode, ClassName, Debit, Credit, QBOTxnId |
| Vendors | Vendor profiles | VendorId, DisplayName, DefaultEntityId, WatchMode |
| VendorAliases | Payee names mapped to a profile | VendorId, PayeeName, QBOId |
| VendorRules | Versioned written rules | RuleId, VendorId, Version, RuleText, Hints (JSON), Active, CreatedAt |
| Suggestions | Engine output per line per run | SuggestionId, LineFingerprint, SuggestedEntityId, Confidence, Status, Reasons (JSON), RuleVersion, RunId |
| Decisions | Paul's approvals, overrides, conflict choices | DecisionId, LineFingerprint, EntityId, Action, Scope, DecidedAt |
| EvidenceCandidates | Linked emails/files per line | CandidateId, LineFingerprint, Source, ExternalId, DeepLink, Score, Confirmed |
| EvidenceDocs | Saved supporting PDFs | DocId, CandidateId, S3Key, DriveFileId, SavedAt |
| DriveIndex | Nightly Drive text index | FileId, OwnerEmail, Path, MimeType, ModifiedAt, ExtractedText (tsvector) |
| MailboxAllowlist | Gmail mailboxes the tool may search | Email, AddedAt |
| AjeReports | Numbered reports | ReportId, ReportNumber, QBOId, Period, Grouping, Status, PublishedAt, SupersedesId |
| AjeEntries | Entries within a report | EntryId, ReportId, EntryNumber, Lines (JSON), Amount, Status, StatusBy, StatusAt, PostedConfirmed |
| AjeEntryLines | Ledger lines behind each entry | EntryId, LineFingerprint |
| AjeComments | Accountant/Paul question threads | CommentId, EntryId, Author, Body, CreatedAt |
| AuditLog | Every action in the module | Who, Action, Target, At, Details (JSON) |

## Backend: routes, jobs and schedules

Short requests stay as API Lambdas; anything that can run past \~25 seconds becomes an async job that the UI polls through a job-status route.

**API routes** (all under `/api/controller/`, each handler: requireAuth → requireRole → requireGroupAccess, wrapped in withErrorHandling):

| Area | Routes |
| --- | --- |
| Sync | POST `sync` (start backfill or month), GET `jobs/{id}` |
| Review | GET `lines` (filters: file, period, status, vendor, entity), POST `decisions` (bulk approve/override) |
| Conflicts | GET `conflicts`, POST `conflicts/{id}/resolve` |
| Vendors | GET/PUT `vendors`, `vendors/{id}/rules`, POST `vendors/{id}/rules/test` |
| Evidence | GET `lines/{id}/evidence`, POST `evidence/{id}/confirm` (saves PDF) |
| AJE | POST `aje/reports` (build from approved decisions), POST `aje/reports/{id}/publish`, GET exports |
| Settings | GET/PUT `entities`, `mailboxes` |
| Portal (Accountant role only) | GET `portal/reports`, PUT `portal/entries/{id}/status`, POST `portal/entries/{id}/comments`, GET `portal/docs/{id}` (signed URL) |

**Async jobs** (Step Functions orchestrating worker Lambdas, or SQS-triggered workers):

- GL pull: split range by month, pull, write snapshot, then trigger classification.
- Classification run: rules + history first; send only ambiguous lines to Claude (Amazon Bedrock) with the vendor's rules and recent labeled examples; write Suggestions.
- Evidence match: Drive index lookup and targeted Gmail search for lines below high confidence.
- Save as support: render email to PDF, store in S3, copy to Drive.
- AJE posted-check: after each GL pull, match AJE numbers to journal entries in QBO.

**Schedules** (EventBridge):

| Job | When |
| --- | --- |
| QBO token refresh, all files | Daily |
| Drive index refresh | Nightly |
| Monthly GL pull + classification for prior month | Early each month (day to be set by Paul) |

All Google and Bedrock calls go out through the existing NAT gateway (or a Bedrock VPC endpoint). Bulk inserts replace the current row-by-row pattern.

## Security

The Google service account can read any delegated mailbox and every Drive, so it is treated as the most sensitive secret in the system.

- **Dashboard access:** Paul is the only full user. Confirm no other Cognito users exist in his Group before the Google integration goes live.
- **Read-only everywhere:** Google scopes are `gmail.readonly` and `drive.readonly`. The QBO OAuth scope technically allows writes, so the Controller code has no write path to QBO, enforced in review and by tests.
- **Secrets:** the service account key lives in AWS Secrets Manager, encrypted, readable only by the evidence-job Lambdas. Rotate it on a schedule.
- **Mailbox allowlist** enforced server-side on every Gmail call; requests for other mailboxes are refused and logged.
- **Data kept small:** the Drive index stores extracted text from document-type files only; Gmail content is fetched on demand and only confirmed emails are saved.
- **Evidence storage:** private S3 bucket with encryption, no public access, signed URLs that expire in minutes.
- **Accountant isolation:** the portal role cannot call any non-portal route; tested explicitly.
- **Audit log** of every search, confirmation, decision, publish and portal action.
- **Policy:** make sure APOHCO's employee policy states that company email and files may be reviewed.

## Build phases

Each phase ships something Paul can use on its own; the AI and Google pieces come after the data foundation is solid.

1. **Foundation:** async job framework, scheduled token refresh, payee name capture, Controller snapshot and line tables, Entities setup screen, backfill and monthly pull. Done when 12+ months of every file are stored and browsable.
2. **Review and rules:** vendor profiles with aliases, written rules, rules + history engine (no AI yet), review queue with bulk approve, conflicts queue, trend checks. Done when a full month can be reviewed and decided in the tool.
3. **AI matching:** Claude via Bedrock reads rules and labeled examples for ambiguous lines; confidence and reasons; rule test preview.
4. **Evidence:** Google delegation, mailbox allowlist, nightly Drive index, Gmail search, candidate linking, Save as support to S3 and Drive.
5. **AJE and portal:** AJE builder with grouping toggle and numbering, PDF/Excel export, Accountant role and portal, status and comments, automatic posted-check.
6. **Later:** QBO entity endpoints for true line IDs, bank/card feeds, direct Amazon Business and Meta Ads data, optional write-back to QBO if Paul ever wants it.

## Open questions

- [ ] Entity list: confirm each dental home's class name in the management file and which practice QBO file it maps to.
- [ ] Should practice files be reviewed for misclassified accounts too, or only the management file for class assignment?
- [ ] Backfill depth: how many months of history to load first?
- [ ] Monthly run day: which day of the month should the automatic pull run, given when books close?
- [ ] Starting mailbox allowlist: which management mailboxes?
- [ ] Accountant: who gets the portal login, and is it one firm or several?
- [ ] Grouped AJE default: grouped or per line as the starting toggle?
- [ ] Confidence threshold for "likely misclassified" (start at 80% and tune?).
- [ ] AI provider: Claude via Amazon Bedrock (keeps everything inside AWS) or the Anthropic API directly.
