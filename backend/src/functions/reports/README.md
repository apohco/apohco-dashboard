# reports

Report-generation functions, all GroupId-scoped and consolidation-aware
(via `../../shared/reportHelpers.js`, which resolves a single QBO or a
Consolidation Group into the underlying QBO/class RawTransactions filter).
All three accept `{ groupId, entityType: 'qbo'|'consolidationGroup', entityId, periods, detailLevel: 'summary'|'detail' }`
and support Single Month / Multi-Month / Compare simply by the number and
content of `periods` passed in.

- `getProfitAndLoss` — `POST /api/reports/profit-and-loss`. `periods: [{label, startDate, endDate}]`. Income/Expense sections built from `Classification` (Revenue/Expense), subtotaled by Grouping.
- `getBalanceSheet` — `POST /api/reports/balance-sheet`. `periods: [{label, asOfDate}]`. Cumulative-since-inception balances (Asset/Liability/Equity); Equity includes a computed "Net Income (current year)" line since there's no year-end closing entry.
- `getCashFlow` — `POST /api/reports/cash-flow`. `periods: [{label, startDate, endDate}]`. Operations/Investing/Financing sections driven by each Grouping's `CashFlowMappings` assignment — P&L groupings contribute period activity, Balance Sheet groupings contribute their change in balance. Groupings without a CashFlowMapping are excluded until configured in Settings.

All three return per-period totals keyed by `period.label`, so the frontend can render Single Month (1 period), Multi-Month (N periods, e.g. one per month), or Compare (2 periods) from the same response shape.
