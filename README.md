# APOHCO Financial Dashboard

Multi-tenant financial reporting dashboard for dental practice groups, consolidating QuickBooks Online (QBO) data into standardized P&L, Balance Sheet, and Cash Flow reports.

See [CLAUDE.md](./claude.md) for the full project specification (data model, roles, module breakdown).

## Repo Structure

```
apohco-dashboard/
├── frontend/     React SPA (Vite + MUI), styled after QuickBooks Online
├── backend/      Node.js Lambda functions + AWS SAM template (API Gateway, RDS access)
├── docs/         Setup and deployment documentation
```

## Status

Phases 1-4 built: infrastructure scaffolding, QBO OAuth + data sync, Settings CRUD, financial reports (P&L/Balance Sheet/Cash Flow), and Cognito authentication are all implemented end-to-end in code. Nothing has been deployed to AWS yet. See [docs/SETUP.md](./docs/SETUP.md) for deployment steps.
