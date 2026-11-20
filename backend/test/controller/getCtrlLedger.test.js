jest.mock('../../src/shared/verifyToken', () => ({ requireAuth: jest.fn() }));
jest.mock('../../src/shared/db', () => ({ query: jest.fn() }));

const { requireAuth } = require('../../src/shared/verifyToken');
const { query } = require('../../src/shared/db');
const { handler, parseLineParams, buildFilters, likePattern } = require('../../src/functions/controller/getCtrlLedger');
const { CONTROLLER_ADMIN, OWNER, sqlRouter, apiEvent, parseBody } = require('../helpers');

const linesEvent = (q) =>
  apiEvent({ resource: '/api/controller/lines', query: { groupId: 'group-1', qboId: 'qbo-1', ...q } });

beforeEach(() => requireAuth.mockResolvedValue(CONTROLLER_ADMIN));

describe('access', () => {
  test('403 for an Owner', async () => {
    requireAuth.mockResolvedValue(OWNER);
    const res = await handler(apiEvent({ resource: '/api/controller/overview', query: { groupId: 'group-1' } }));
    expect(res.statusCode).toBe(403);
  });

  test('400 without groupId', async () => {
    const res = await handler(apiEvent({ resource: '/api/controller/overview', query: {} }));
    expect(res.statusCode).toBe(400);
  });
});

describe('parseLineParams', () => {
  const ok = { qboId: 'q', fromMonth: '2026-10' };
  test('defaults toMonth, limit and offset', () => {
    expect(parseLineParams(ok)).toMatchObject({ toMonth: '2026-10', limit: 200, offset: 0, compare: false });
  });
  test.each([
    [{ fromMonth: '2026-10' }, /required/],
    [{ ...ok, fromMonth: '2026-1' }, /YYYY-MM/],
    [{ ...ok, toMonth: '2026-09' }, /before/],
    [{ ...ok, toMonth: '2026-11', snapshotId: 's' }, /single month/],
    [{ ...ok, toMonth: '2026-11', compare: 'previous' }, /single month/],
    [{ ...ok, changeType: 'added' }, /compare/],
    [{ ...ok, compare: 'previous', changeType: 'bogus' }, /changeType/],
    [{ ...ok, limit: '5000' }, /limit/],
    [{ ...ok, offset: '-1' }, /offset/],
  ])('%j is rejected', (qs, msg) => {
    expect(() => parseLineParams(qs)).toThrow(msg);
  });
});

describe('buildFilters', () => {
  test('numbers parameters from the given start and matches text literally', () => {
    const { sql, params } = buildFilters({ payee: '50%_off', account: '6100', className: null, changeType: 'changed' }, 4);
    expect(sql).toBe('WHERE l.PayeeName ILIKE $4 AND (l.AccountCode ILIKE $5 OR l.AccountName ILIKE $5) AND l.ChangeType = $6');
    expect(params).toEqual(['%50\\%\\_off%', '%6100%', 'changed']);
  });

  test('"__none__" finds unclassified lines', () => {
    expect(buildFilters({ className: '__none__' }, 3)).toEqual({ sql: "WHERE COALESCE(l.ClassName, '') = ''", params: [] });
  });

  test('no filters, no WHERE', () => {
    expect(buildFilters({}, 3).sql).toBe('');
  });

  test('likePattern escapes backslashes too', () => {
    expect(likePattern('a\\b')).toBe('%a\\\\b%');
  });
});

describe('GET overview', () => {
  test('returns files and snapshots, flagging the latest pull and changes', async () => {
    query.mockImplementation(
      sqlRouter([
        [/FROM QBOs/, { rows: [{ qboid: 'qbo-1', qboname: 'MGMT', isclassbased: true, isapiconnected: true, tokenexpiry: 't' }] }],
        [
          /FROM CtrlSnapshots/,
          {
            rows: [
              { snapshotid: 's1', qboid: 'qbo-1', month: '2026-10', linecount: 10, totaldebit: '5.00', totalcredit: '5.00', contenthash: 'a', prevcontenthash: null, recencyrank: '2' },
              { snapshotid: 's2', qboid: 'qbo-1', month: '2026-10', linecount: 11, totaldebit: '6.00', totalcredit: '6.00', contenthash: 'b', prevcontenthash: 'a', recencyrank: '1' },
            ],
          },
        ],
      ])
    );
    const res = await handler(apiEvent({ resource: '/api/controller/overview', query: { groupId: 'group-1' } }));
    const data = parseBody(res);
    expect(res.statusCode).toBe(200);
    expect(data.qbos[0]).toMatchObject({ qboId: 'qbo-1', isApiConnected: true });
    expect(data.snapshots[0]).toMatchObject({ isLatest: false, changedFromPrevious: false, totalDebit: 5 });
    expect(data.snapshots[1]).toMatchObject({ isLatest: true, changedFromPrevious: true });
    expect(query.mock.calls.every(([, params]) => params[0] === 'group-1')).toBe(true);
  });
});

describe('GET lines', () => {
  test('empty result when the month has never been pulled', async () => {
    query.mockImplementation(sqlRouter([[/DISTINCT ON/, { rows: [] }]]));
    const data = parseBody(await handler(linesEvent({ fromMonth: '2026-10' })));
    expect(data).toMatchObject({ lines: [], total: 0, snapshots: [] });
  });

  test('reads the latest snapshot of each month in range, scoped to the Group', async () => {
    query.mockImplementation(
      sqlRouter([
        [/DISTINCT ON/, { rows: [{ snapshotid: 's9', month: '2026-09' }, { snapshotid: 's10', month: '2026-10' }] }],
        [/COUNT\(\*\) AS total/, { rows: [{ total: '2', debit: '10', credit: '0' }] }],
        [/LIMIT \$/, { rows: [{ lineid: 'l1', txndatetext: '2026-09-02', debit: '10', credit: '0', amount: '10', changetype: null }] }],
      ])
    );
    const data = parseBody(await handler(linesEvent({ fromMonth: '2026-09', toMonth: '2026-10', payee: 'kro' })));
    expect(data.total).toBe(2);
    expect(data.lines[0]).toMatchObject({ lineId: 'l1', txnDate: '2026-09-02', debit: 10, previous: null });

    const linesCall = query.mock.calls.find(([sql]) => /LIMIT \$/.test(sql));
    expect(linesCall[1]).toEqual(['group-1', ['s9', 's10'], '%kro%', 200, 0]);
    expect(query.mock.calls.every(([, params]) => params[0] === 'group-1')).toBe(true);
  });

  test('compare=previous diffs against the pull before, with change counts', async () => {
    query.mockImplementation(
      sqlRouter([
        [/DISTINCT ON/, { rows: [{ snapshotid: 's2', month: '2026-10', pulledat: '2026-11-02' }] }],
        [/PulledAt < \$4/, { rows: [{ snapshotid: 's1', pulledat: '2026-11-01' }] }],
        [/COUNT\(\*\) AS total/, { rows: [{ total: '1', debit: '12', credit: '0' }] }],
        [/LIMIT \$/, {
          rows: [{
            lineid: 'l2', txndatetext: '2026-10-03', debit: '12', credit: '0', amount: '12', changetype: 'changed',
            prevtxndatetext: '2026-10-03', prevdebit: '10', prevcredit: '0', prevclassname: null, prevmemo: 'x', prevpayeename: 'Kroger',
          }],
        }],
        [/GROUP BY ChangeType/, { rows: [{ changetype: 'changed', n: '1' }, { changetype: 'removed', n: '2' }] }],
      ])
    );
    const data = parseBody(await handler(linesEvent({ fromMonth: '2026-10', compare: 'previous', changeType: 'changed' })));
    expect(data.previousSnapshot).toEqual({ snapshotId: 's1', pulledAt: '2026-11-01' });
    expect(data.changeCounts).toEqual({ added: 0, changed: 1, removed: 2, unchanged: 0 });
    expect(data.lines[0].previous).toMatchObject({ debit: 10, payeeName: 'Kroger' });

    const linesCall = query.mock.calls.find(([sql]) => /LIMIT \$/.test(sql));
    expect(linesCall[0]).toMatch(/UNION ALL/);
    expect(linesCall[1]).toEqual(['group-1', ['s2'], 's1', 'changed', 200, 0]);
  });

  test('a snapshot from another QBO or month is not found', async () => {
    query.mockImplementation(sqlRouter([[/WHERE SnapshotId = \$1/, { rows: [{ snapshotid: 's1', month: '2026-09' }] }]]));
    const res = await handler(linesEvent({ fromMonth: '2026-10', snapshotId: 's1' }));
    expect(res.statusCode).toBe(404);
  });
});
