const { authorizeController } = require('../../../shared/controllerAuth');
const { requireGroupAccess } = require('../../../shared/authorize');
const { query } = require('../../../shared/db');
const { json, withErrorHandling } = require('../../../shared/response');
const { parseMonth } = require('../../../shared/monthRanges');

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const CHANGE_TYPES = ['added', 'changed', 'removed', 'unchanged'];
const UNCLASSIFIED = '__none__';

function badRequest(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

// Escapes LIKE wildcards so user text is matched literally.
const likePattern = (s) => `%${String(s).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const LINE_COLS = [
  'LineId', 'SnapshotId', 'Fingerprint', 'ContentHash', 'TxnDate', 'TxnType', 'DocNum', 'QBOTxnId',
  'PayeeName', 'Memo', 'AccountCode', 'AccountName', 'ClassName', 'Debit', 'Credit', 'Amount', 'SplitAccount',
];
const cols = (alias) => LINE_COLS.map((c) => `${alias}.${c}`).join(', ');
// Previous-snapshot values shown for "changed" lines. The NULL placeholders
// are typed so TO_CHAR and UNION ALL can resolve their column types.
const PREV_COLS = {
  TxnDate: 'date',
  PayeeName: 'text',
  Memo: 'text',
  ClassName: 'text',
  SplitAccount: 'text',
  Debit: 'numeric',
  Credit: 'numeric',
};
const prevCols = (alias) => Object.keys(PREV_COLS).map((c) => `${alias}.${c} AS Prev${c}`).join(', ');
const nullPrevCols = () =>
  Object.entries(PREV_COLS).map(([c, type]) => `NULL::${type} AS Prev${c}`).join(', ');

// Builds the WHERE clause for the user's filters against the combined
// line set (alias l), starting at parameter $<start>.
function buildFilters(filters, start) {
  const clauses = [];
  const params = [];
  const next = (value) => {
    params.push(value);
    return `$${start + params.length - 1}`;
  };

  if (filters.payee) clauses.push(`l.PayeeName ILIKE ${next(likePattern(filters.payee))}`);
  if (filters.account) {
    const p = next(likePattern(filters.account));
    clauses.push(`(l.AccountCode ILIKE ${p} OR l.AccountName ILIKE ${p})`);
  }
  if (filters.className === UNCLASSIFIED) {
    clauses.push(`COALESCE(l.ClassName, '') = ''`);
  } else if (filters.className) {
    clauses.push(`l.ClassName ILIKE ${next(likePattern(filters.className))}`);
  }
  if (filters.changeType) clauses.push(`l.ChangeType = ${next(filters.changeType)}`);

  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

// GET /api/controller/overview?groupId=
// Every QBO in the Group with its connection state, and every stored
// snapshot (one row per pull) so the UI can draw a file x month grid.
async function handleOverview(groupId) {
  const { rows: qbos } = await query(
    `SELECT QBOId, QBOName, IsClassBased, (RefreshToken IS NOT NULL) AS IsApiConnected, TokenExpiry
     FROM QBOs WHERE GroupId = $1 ORDER BY QBOName`,
    [groupId]
  );
  const { rows: snapshots } = await query(
    `SELECT SnapshotId, QBOId, TO_CHAR(Period, 'YYYY-MM') AS month, PulledAt, LineCount, TotalDebit, TotalCredit,
            ContentHash, Source,
            LAG(ContentHash) OVER w AS PrevContentHash,
            ROW_NUMBER() OVER (PARTITION BY QBOId, Period ORDER BY PulledAt DESC) AS RecencyRank
     FROM CtrlSnapshots
     WHERE GroupId = $1
     WINDOW w AS (PARTITION BY QBOId, Period ORDER BY PulledAt)
     ORDER BY QBOId, Period, PulledAt`,
    [groupId]
  );

  return json(200, {
    qbos: qbos.map((q) => ({
      qboId: q.qboid,
      qboName: q.qboname,
      isClassBased: q.isclassbased,
      isApiConnected: q.isapiconnected,
      tokenExpiry: q.tokenexpiry,
    })),
    snapshots: snapshots.map((s) => ({
      snapshotId: s.snapshotid,
      qboId: s.qboid,
      month: s.month,
      pulledAt: s.pulledat,
      lineCount: s.linecount,
      source: s.source,
      totalDebit: Number(s.totaldebit),
      totalCredit: Number(s.totalcredit),
      isLatest: Number(s.recencyrank) === 1,
      changedFromPrevious: s.prevcontenthash !== null && s.prevcontenthash !== s.contenthash,
    })),
  });
}

function parseLineParams(qs) {
  const p = {
    qboId: qs.qboId,
    fromMonth: qs.fromMonth,
    toMonth: qs.toMonth || qs.fromMonth,
    snapshotId: qs.snapshotId || null,
    compare: qs.compare === 'previous',
    filters: {
      payee: qs.payee?.trim() || null,
      account: qs.account?.trim() || null,
      className: qs.className?.trim() || null,
      changeType: qs.changeType || null,
    },
    limit: qs.limit === undefined ? DEFAULT_LIMIT : Number(qs.limit),
    offset: qs.offset === undefined ? 0 : Number(qs.offset),
  };

  if (!p.qboId || !p.fromMonth) throw badRequest('qboId and fromMonth are required');
  if (!parseMonth(p.fromMonth) || !parseMonth(p.toMonth)) throw badRequest('Months must be formatted YYYY-MM');
  if (p.toMonth < p.fromMonth) throw badRequest('toMonth must not be before fromMonth');
  const singleMonth = p.fromMonth === p.toMonth;
  if (p.snapshotId && !singleMonth) throw badRequest('snapshotId can only be used with a single month');
  if (p.compare && !singleMonth) throw badRequest('Comparing snapshots needs a single month');
  if (p.filters.changeType && !CHANGE_TYPES.includes(p.filters.changeType)) {
    throw badRequest(`changeType must be one of ${CHANGE_TYPES.join(', ')}`);
  }
  if (p.filters.changeType && !p.compare) throw badRequest('changeType filtering needs compare=previous');
  if (!Number.isInteger(p.limit) || p.limit < 1 || p.limit > MAX_LIMIT) {
    throw badRequest(`limit must be between 1 and ${MAX_LIMIT}`);
  }
  if (!Number.isInteger(p.offset) || p.offset < 0) throw badRequest('offset must be 0 or more');
  return p;
}

// Picks the snapshot(s) to read: the requested one, or the latest pull of
// each month in range. With compare, also the pull just before it.
async function resolveSnapshots(groupId, p) {
  if (p.snapshotId) {
    const { rows } = await query(
      `SELECT SnapshotId, PulledAt, Source, TO_CHAR(Period, 'YYYY-MM') AS month FROM CtrlSnapshots
       WHERE SnapshotId = $1 AND GroupId = $2 AND QBOId = $3`,
      [p.snapshotId, groupId, p.qboId]
    );
    if (!rows.length || rows[0].month !== p.fromMonth) throw badRequest('Snapshot not found', 404);
    return { current: rows, previous: p.compare ? await previousSnapshot(groupId, p, rows[0]) : null };
  }

  const { rows } = await query(
    `SELECT DISTINCT ON (Period) SnapshotId, PulledAt, Source, TO_CHAR(Period, 'YYYY-MM') AS month
     FROM CtrlSnapshots
     WHERE GroupId = $1 AND QBOId = $2 AND Period BETWEEN $3 AND $4
     ORDER BY Period, PulledAt DESC`,
    [groupId, p.qboId, `${p.fromMonth}-01`, `${p.toMonth}-01`]
  );
  const previous = p.compare && rows.length ? await previousSnapshot(groupId, p, rows[0]) : null;
  return { current: rows, previous };
}

async function previousSnapshot(groupId, p, snapshot) {
  const { rows } = await query(
    `SELECT SnapshotId, PulledAt, Source FROM CtrlSnapshots
     WHERE GroupId = $1 AND QBOId = $2 AND Period = $3 AND PulledAt < $4
     ORDER BY PulledAt DESC LIMIT 1`,
    [groupId, p.qboId, `${p.fromMonth}-01`, snapshot.pulledat]
  );
  return rows[0] || null;
}

// The line set as a CTE named `combined` (alias l downstream), using
// parameters $1 (groupId), $2 (current snapshot ids) and, when comparing,
// $3 (previous snapshot id). Each line gets a ChangeType: added / changed /
// unchanged / removed when comparing, NULL otherwise.
function combinedCte(comparing) {
  if (!comparing) {
    return `combined AS (
      SELECT ${cols('x')}, NULL::text AS ChangeType, ${nullPrevCols()}
      FROM CtrlLedgerLines x
      WHERE x.GroupId = $1 AND x.SnapshotId = ANY($2::uuid[])
    )`;
  }
  return `cur AS (SELECT * FROM CtrlLedgerLines WHERE GroupId = $1 AND SnapshotId = ANY($2::uuid[])),
    prev AS (SELECT * FROM CtrlLedgerLines WHERE GroupId = $1 AND SnapshotId = $3),
    combined AS (
      SELECT ${cols('c')},
             CASE WHEN p.LineId IS NULL THEN 'added'
                  WHEN p.ContentHash <> c.ContentHash THEN 'changed'
                  ELSE 'unchanged' END AS ChangeType,
             ${prevCols('p')}
      FROM cur c LEFT JOIN prev p ON p.Fingerprint = c.Fingerprint
      UNION ALL
      SELECT ${cols('p')}, 'removed' AS ChangeType, ${nullPrevCols()}
      FROM prev p
      WHERE NOT EXISTS (SELECT 1 FROM cur c WHERE c.Fingerprint = p.Fingerprint)
    )`;
}

// GET /api/controller/lines?groupId=&qboId=&fromMonth=&toMonth=
//   [&snapshotId=][&compare=previous][&payee=][&account=][&className=|__none__]
//   [&changeType=added|changed|removed|unchanged][&limit=][&offset=]
async function handleLines(groupId, qs) {
  const p = parseLineParams(qs);
  const { current, previous } = await resolveSnapshots(groupId, p);

  const base = {
    snapshots: current.map((s) => ({ snapshotId: s.snapshotid, month: s.month, pulledAt: s.pulledat, source: s.source })),
    previousSnapshot: previous ? { snapshotId: previous.snapshotid, pulledAt: previous.pulledat, source: previous.source } : null,
  };
  if (!current.length) {
    return json(200, { ...base, lines: [], total: 0, totals: { debit: 0, credit: 0 }, changeCounts: null });
  }

  const comparing = Boolean(previous);
  const baseParams = [groupId, current.map((s) => s.snapshotid)];
  if (comparing) baseParams.push(previous.snapshotid);
  const cte = `WITH ${combinedCte(comparing)}`;

  // changeType is only meaningful when there is a previous snapshot.
  const filters = comparing ? p.filters : { ...p.filters, changeType: null };
  const where = buildFilters(filters, baseParams.length + 1);
  const params = [...baseParams, ...where.params];

  const { rows: summary } = await query(
    `${cte} SELECT COUNT(*) AS total, COALESCE(SUM(l.Debit), 0) AS debit, COALESCE(SUM(l.Credit), 0) AS credit
     FROM combined l ${where.sql}`,
    params
  );

  const limitIdx = params.length + 1;
  const { rows } = await query(
    `${cte} SELECT l.*, TO_CHAR(l.TxnDate, 'YYYY-MM-DD') AS TxnDateText,
                   TO_CHAR(l.PrevTxnDate, 'YYYY-MM-DD') AS PrevTxnDateText
     FROM combined l ${where.sql}
     ORDER BY l.TxnDate, l.DocNum NULLS LAST, l.AccountCode NULLS LAST, l.Fingerprint
     LIMIT $${limitIdx} OFFSET $${limitIdx + 1}`,
    [...params, p.limit, p.offset]
  );

  let changeCounts = null;
  if (comparing) {
    const { rows: counts } = await query(
      `${cte} SELECT ChangeType, COUNT(*) AS n FROM combined GROUP BY ChangeType`,
      baseParams
    );
    changeCounts = Object.fromEntries(CHANGE_TYPES.map((t) => [t, 0]));
    for (const c of counts) changeCounts[c.changetype] = Number(c.n);
  }

  return json(200, {
    ...base,
    total: Number(summary[0].total),
    totals: { debit: Number(summary[0].debit), credit: Number(summary[0].credit) },
    changeCounts,
    lines: rows.map((r) => ({
      lineId: r.lineid,
      snapshotId: r.snapshotid,
      fingerprint: r.fingerprint,
      txnDate: r.txndatetext,
      txnType: r.txntype,
      docNum: r.docnum,
      qboTxnId: r.qbotxnid,
      payeeName: r.payeename,
      memo: r.memo,
      accountCode: r.accountcode,
      accountName: r.accountname,
      className: r.classname,
      splitAccount: r.splitaccount,
      debit: Number(r.debit),
      credit: Number(r.credit),
      amount: Number(r.amount),
      changeType: r.changetype,
      previous:
        r.changetype === 'changed'
          ? {
              txnDate: r.prevtxndatetext,
              payeeName: r.prevpayeename,
              memo: r.prevmemo,
              className: r.prevclassname,
              splitAccount: r.prevsplitaccount,
              debit: Number(r.prevdebit),
              credit: Number(r.prevcredit),
            }
          : null,
    })),
  });
}

exports.handler = withErrorHandling(async (event) => {
  const claims = await authorizeController(event);
  const qs = event.queryStringParameters || {};
  if (!qs.groupId) throw badRequest('groupId is required');
  requireGroupAccess(claims, qs.groupId);

  if (event.resource.endsWith('/overview')) return handleOverview(qs.groupId);
  if (event.resource.endsWith('/lines')) return handleLines(qs.groupId, qs);
  throw badRequest('Unknown Controller ledger route', 404);
});

exports.parseLineParams = parseLineParams;
exports.buildFilters = buildFilters;
exports.likePattern = likePattern;
