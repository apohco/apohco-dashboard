// One-off seed script: gives every existing Group a starting Report Layout
// (see migration 003_report_layouts.sql) that reproduces today's report
// behavior, so nothing goes blank the moment the report Lambdas start
// requiring a configured layout. Run once via `npm run
// db:backfill-report-layouts` from backend/, after 003_report_layouts.sql
// has been applied and before/around first use of the new Report Layout
// Settings page. Safe to re-run: any (GroupId, Statement) that already has
// rows is left untouched, so it never clobbers a layout a user has since
// customized. Requires the same DB_HOST/DB_NAME/DB_PORT/DB_USER/DB_PASSWORD
// env vars as migrate.js.
const { Client } = require('pg');

const CASH_FLOW_CATEGORY_ORDER = ['Operations', 'Investing', 'Financing'];

async function alreadyConfigured(client, groupId, statement) {
  const { rows } = await client.query(
    `SELECT 1 FROM ReportLayoutRows WHERE GroupId = $1 AND Statement = $2 LIMIT 1`,
    [groupId, statement]
  );
  return rows.length > 0;
}

async function insertRow(client, { groupId, statement, rowType, label, groupingId, isSystemRow, isRevenueBase, sortOrder }) {
  const { rows } = await client.query(
    `INSERT INTO ReportLayoutRows (GroupId, Statement, RowType, Label, GroupingId, IsSystemRow, IsRevenueBase, SortOrder)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING RowId`,
    [groupId, statement, rowType, label, groupingId || null, Boolean(isSystemRow), Boolean(isRevenueBase), sortOrder]
  );
  return rows[0].rowid;
}

async function insertComponents(client, rowId, componentRowIds) {
  for (let i = 0; i < componentRowIds.length; i += 1) {
    await client.query(
      `INSERT INTO ReportLayoutRowComponents (RowId, ComponentRowId, SortOrder) VALUES ($1, $2, $3)`,
      [rowId, componentRowIds[i], i]
    );
  }
}

// Each Grouping's classification (Asset/Liability/Equity/Revenue/Expense)
// isn't stored on AccountGroupings itself -- it's inferred from whichever
// Classification its mapped accounts carry in ChartOfAccountsMappings
// (in practice a Grouping's accounts share one classification by
// convention). Groupings with no mapped accounts yet (nothing classifies
// them) are returned separately so the caller can place them without
// guessing which auto-Total they'd belong to.
async function groupingsByClassification(client, groupId, accountType) {
  const { rows } = await client.query(
    `SELECT ag.GroupingId, ag.GroupingName,
            (SELECT coam.Classification FROM ChartOfAccountsMappings coam
             WHERE coam.GroupingId = ag.GroupingId AND coam.Classification IS NOT NULL
             LIMIT 1) AS Classification
     FROM AccountGroupings ag
     WHERE ag.GroupId = $1 AND ag.AccountType = $2
     ORDER BY ag.GroupingName`,
    [groupId, accountType]
  );

  const byClassification = new Map();
  const unclassified = [];
  for (const g of rows) {
    if (!g.classification) {
      unclassified.push(g);
      continue;
    }
    if (!byClassification.has(g.classification)) byClassification.set(g.classification, []);
    byClassification.get(g.classification).push(g);
  }
  return { byClassification, unclassified };
}

async function insertGroupingRows(client, groupId, statement, groupings, sortOrderRef) {
  const rowIds = [];
  for (const g of groupings) {
    const rowId = await insertRow(client, {
      groupId,
      statement,
      rowType: 'Grouping',
      label: g.groupingname,
      groupingId: g.groupingid,
      sortOrder: sortOrderRef.value++,
    });
    rowIds.push(rowId);
  }
  return rowIds;
}

// Seeds PL: Revenue groupings + "Total Income", then Expense groupings +
// "Total Expenses", then a "Net Income" Net row -- reproducing today's
// Income/Expenses sections and Net Income summary row as ordinary layout
// rows. Groupings with no classified accounts yet are appended at the end,
// unincluded in either Total (nothing to safely infer).
async function seedPL(client, groupId) {
  if (await alreadyConfigured(client, groupId, 'PL')) return;

  const { byClassification, unclassified } = await groupingsByClassification(client, groupId, 'PL');
  const sortOrderRef = { value: 0 };

  const revenueRowIds = await insertGroupingRows(client, groupId, 'PL', byClassification.get('Revenue') || [], sortOrderRef);
  const totalIncomeRowId = await insertRow(client, {
    groupId,
    statement: 'PL',
    rowType: 'Total',
    label: 'Total Income',
    isRevenueBase: true,
    sortOrder: sortOrderRef.value++,
  });
  await insertComponents(client, totalIncomeRowId, revenueRowIds);

  const expenseRowIds = await insertGroupingRows(client, groupId, 'PL', byClassification.get('Expense') || [], sortOrderRef);
  const totalExpensesRowId = await insertRow(client, {
    groupId,
    statement: 'PL',
    rowType: 'Total',
    label: 'Total Expenses',
    sortOrder: sortOrderRef.value++,
  });
  await insertComponents(client, totalExpensesRowId, expenseRowIds);

  const netIncomeRowId = await insertRow(client, {
    groupId,
    statement: 'PL',
    rowType: 'Net',
    label: 'Net Income',
    sortOrder: sortOrderRef.value++,
  });
  await insertComponents(client, netIncomeRowId, [totalIncomeRowId, totalExpensesRowId]);

  await insertGroupingRows(client, groupId, 'PL', unclassified, sortOrderRef);
}

// Seeds BalanceSheet: Asset groupings + "Total Assets", then Liability
// groupings, Equity groupings, and the system Net Income row, followed by a
// "Total Liabilities & Equity" Total -- reproducing today's
// Assets/Liabilities/Equity sections and the two cross-check totals used to
// confirm the balance sheet balances.
async function seedBalanceSheet(client, groupId) {
  if (await alreadyConfigured(client, groupId, 'BalanceSheet')) return;

  const { byClassification, unclassified } = await groupingsByClassification(client, groupId, 'BalanceSheet');
  const sortOrderRef = { value: 0 };

  const assetRowIds = await insertGroupingRows(client, groupId, 'BalanceSheet', byClassification.get('Asset') || [], sortOrderRef);
  const totalAssetsRowId = await insertRow(client, {
    groupId,
    statement: 'BalanceSheet',
    rowType: 'Total',
    label: 'Total Assets',
    sortOrder: sortOrderRef.value++,
  });
  await insertComponents(client, totalAssetsRowId, assetRowIds);

  const liabilityRowIds = await insertGroupingRows(client, groupId, 'BalanceSheet', byClassification.get('Liability') || [], sortOrderRef);
  const equityRowIds = await insertGroupingRows(client, groupId, 'BalanceSheet', byClassification.get('Equity') || [], sortOrderRef);
  const netIncomeRowId = await insertRow(client, {
    groupId,
    statement: 'BalanceSheet',
    rowType: 'Grouping',
    label: 'Net Income (current year)',
    isSystemRow: true,
    sortOrder: sortOrderRef.value++,
  });

  const totalLiabEquityRowId = await insertRow(client, {
    groupId,
    statement: 'BalanceSheet',
    rowType: 'Total',
    label: 'Total Liabilities & Equity',
    sortOrder: sortOrderRef.value++,
  });
  await insertComponents(client, totalLiabEquityRowId, [...liabilityRowIds, ...equityRowIds, netIncomeRowId]);

  await insertGroupingRows(client, groupId, 'BalanceSheet', unclassified, sortOrderRef);
}

// Seeds CashFlow from today's CashFlowMappings: one Grouping row per mapped
// Grouping (grouped by category, alphabetical within category, category
// order Operations/Investing/Financing), a "Cash from {Category}" Total per
// non-empty category, and a final "Net Change in Cash" Total summing the
// category Totals. Groups with no CashFlowMappings at all are left
// unconfigured (empty-state) -- there's nothing meaningful to seed.
async function seedCashFlow(client, groupId) {
  if (await alreadyConfigured(client, groupId, 'CashFlow')) return;

  const { rows: mapped } = await client.query(
    `SELECT ag.GroupingId, ag.GroupingName, cfm.CashFlowCategory
     FROM CashFlowMappings cfm
     JOIN AccountGroupings ag ON ag.GroupingId = cfm.GroupingId
     WHERE cfm.GroupId = $1
     ORDER BY cfm.CashFlowCategory, ag.GroupingName`,
    [groupId]
  );
  if (!mapped.length) return;

  const byCategory = new Map();
  for (const row of mapped) {
    if (!byCategory.has(row.cashflowcategory)) byCategory.set(row.cashflowcategory, []);
    byCategory.get(row.cashflowcategory).push(row);
  }

  let sortOrder = 0;
  const categoryTotalRowIds = [];
  for (const category of CASH_FLOW_CATEGORY_ORDER) {
    const rowsForCategory = byCategory.get(category);
    if (!rowsForCategory || !rowsForCategory.length) continue;

    const groupingRowIds = [];
    for (const g of rowsForCategory) {
      const rowId = await insertRow(client, {
        groupId,
        statement: 'CashFlow',
        rowType: 'Grouping',
        label: g.groupingname,
        groupingId: g.groupingid,
        sortOrder: sortOrder++,
      });
      groupingRowIds.push(rowId);
    }

    const totalRowId = await insertRow(client, {
      groupId,
      statement: 'CashFlow',
      rowType: 'Total',
      label: `Cash from ${category}`,
      sortOrder: sortOrder++,
    });
    await insertComponents(client, totalRowId, groupingRowIds);
    categoryTotalRowIds.push(totalRowId);
  }

  if (categoryTotalRowIds.length) {
    const netChangeRowId = await insertRow(client, {
      groupId,
      statement: 'CashFlow',
      rowType: 'Total',
      label: 'Net Change in Cash',
      sortOrder: sortOrder++,
    });
    await insertComponents(client, netChangeRowId, categoryTotalRowIds);
  }
}

// Exported separately from the CLI entrypoint below so it can be reused by
// anything that already has a connected `client` (e.g. a one-off Lambda
// running inside the VPC with credentials from Secrets Manager, rather than
// raw DB_USER/DB_PASSWORD env vars).
async function backfillAll(client) {
  const log = [];
  const { rows: groups } = await client.query(`SELECT GroupId, GroupName FROM Groups`);
  for (const group of groups) {
    await client.query('BEGIN');
    try {
      await seedPL(client, group.groupid);
      await seedBalanceSheet(client, group.groupid);
      await seedCashFlow(client, group.groupid);
      await client.query('COMMIT');
      log.push(`Seeded Report Layouts for Group ${group.groupname} (${group.groupid})`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Backfill failed for Group ${group.groupid}: ${err.message}`);
    }
  }
  return log;
}

async function run() {
  const client = new Client({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
  });

  await client.connect();
  try {
    const log = await backfillAll(client);
    log.forEach((line) => console.log(line));
    console.log('Backfill complete.');
  } finally {
    await client.end();
  }
}

module.exports = { backfillAll };

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
