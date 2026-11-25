jest.mock('../../src/shared/db', () => ({ query: jest.fn(), withTransaction: jest.fn() }));

const { query, withTransaction } = require('../../src/shared/db');
const { searchLines, loadCandidates, mapLimit } = require('../../src/shared/ctrlEvidence');
const { sqlRouter } = require('../helpers');

const b64 = (s) => Buffer.from(s).toString('base64url');
const message = (id, { subject, from, text, date = '2026-10-02T12:00:00Z' }) => ({
  id, threadId: `t-${id}`, snippet: subject, internalDate: String(Date.parse(date)),
  payload: { headers: [{ name: 'Subject', value: subject }, { name: 'From', value: from }], mimeType: 'text/plain', body: { data: b64(text) } },
});
const LINE = { lineId: 'l1', fingerprint: 'f1', txnDate: '2026-10-03', amount: -1250, payeeName: 'Minuteman' };

let client;
function setup({ mailboxes = ['info@apohco.com'] } = {}) {
  query.mockImplementation(
    sqlRouter([
      [/FROM CtrlGoogleSources/, { rows: mailboxes.map((m) => ({ sourceid: m, kind: 'Mailbox', sourcekey: m, enabled: true })) }],
      [/FROM CtrlEntities e/, { rows: [{ entityid: 'leb', entityname: 'Lebanon', aliases: [], keywords: ['Main St'] }] }],
      [/FROM CtrlVendorAliases a JOIN CtrlVendors v/, { rows: [{ payeekey: 'minuteman', displayname: 'Minuteman Press', names: ['Minuteman', 'MINUTEMAN PRESS'] }] }],
    ])
  );
  client = { query: sqlRouter([]) };
  withTransaction.mockImplementation((fn) => fn(client));
}
const api = () => ({
  gmailSearch: jest.fn(async (mailbox, q) =>
    q.startsWith('("1,250.00"') ? [{ id: 'm1' }, { id: 'm2' }] : [{ id: 'm1' }, { id: 'm3' }]
  ),
  gmailGetMessage: jest.fn(async (mailbox, id) =>
    ({
      m1: message('m1', { subject: 'Invoice 4471', from: 'Minuteman Press <ar@mm.com>', text: 'Ship to 12 Main St. Total $1,250.00' }),
      m2: message('m2', { subject: 'Payroll', from: 'Gusto', text: 'Net pay 1,250.00', date: '2026-09-24T00:00:00Z' }),
      m3: message('m3', { subject: 'Newsletter', from: 'x@y.com', text: 'hello', date: '2026-09-15T00:00:00Z' }),
    })[id]
  ),
});

test('searches each opted-in mailbox, scores and keeps the good candidates', async () => {
  setup();
  const gm = api();
  const out = await searchLines({ groupId: 'g1', qboId: 'q1', lines: [LINE], userId: 'u1', via: 'FindEvidence', api: gm });
  expect(out).toEqual({ searched: 1, found: 1, sources: 1, errors: [] });
  // Amount search, then vendor search (display name + aliases).
  expect(gm.gmailSearch.mock.calls.map((c) => c[1])).toEqual([
    '("1,250.00" OR "1250.00" OR "1,250" OR "1250") after:2026/09/23 before:2026/10/14',
    '("Minuteman Press" OR "Minuteman") after:2026/09/23 before:2026/10/14',
  ]);
  // m1 fetched once although both searches found it.
  expect(gm.gmailGetMessage.mock.calls.map((c) => c[1])).toEqual(['m1', 'm2', 'm3']);
  const insert = client.query.mock.calls.find(([sql]) => /INSERT INTO CtrlEvidenceCandidates/.test(sql));
  const p = insert[1];
  // 15 columns per row: m1 (1.0, names Lebanon), then m2 (amount only + date window).
  expect(p.slice(0, 8)).toEqual(['g1', 'q1', 'f1', 'Gmail', 'info@apohco.com', 'm1', 't-m1', 'Invoice 4471']);
  expect(p.slice(12, 15)).toEqual([1, JSON.stringify({ amount: true, vendor: true, days: 1, entityTerm: 'Main St' }), 'leb']);
  expect(p[15 + 5]).toBe('m2');
  expect(p.length).toBe(30); // m3 (date-window only) is below the minimum score
  expect(client.query.mock.calls.some(([sql]) => /DELETE FROM CtrlEvidenceCandidates/.test(sql))).toBe(true);
  const search = client.query.mock.calls.find(([sql]) => /INSERT INTO CtrlEvidenceSearches/.test(sql))[1];
  expect(search).toEqual(['g1', 'q1', 'f1', 1, 2, null]);
  const audit = client.query.mock.calls.find(([sql]) => /INSERT INTO CtrlAuditLog/.test(sql))[1];
  expect(audit[2]).toBe('ctrl.evidence.search');
  expect(JSON.parse(audit[5])).toEqual({ via: 'FindEvidence', lines: 1, mailboxes: ['info@apohco.com'], found: 2, errors: 0 });
});

test('no opted-in mailbox: refused', async () => {
  setup({ mailboxes: [] });
  await expect(searchLines({ groupId: 'g1', qboId: 'q1', lines: [LINE], api: api() })).rejects.toMatchObject({ statusCode: 409 });
});

test('when every mailbox fails, the line keeps its earlier candidates and the error is recorded', async () => {
  setup();
  const gm = api();
  gm.gmailSearch.mockRejectedValue(new Error('Google 403: Mail service not enabled'));
  const out = await searchLines({ groupId: 'g1', qboId: 'q1', lines: [LINE], api: gm });
  expect(out.errors).toEqual(['info@apohco.com: Google 403: Mail service not enabled']);
  expect(client.query.mock.calls.some(([sql]) => /DELETE FROM CtrlEvidenceCandidates/.test(sql))).toBe(false);
  const search = client.query.mock.calls.find(([sql]) => /INSERT INTO CtrlEvidenceSearches/.test(sql))[1];
  expect(search[5]).toBe('info@apohco.com: Google 403: Mail service not enabled');
});

test('loadCandidates', async () => {
  query.mockImplementation(
    sqlRouter([
      [/FROM CtrlEvidenceCandidates/, { rows: [{ candidateid: 'c1', source: 'Gmail', sourceaccount: 'info@apohco.com', externalid: 'm1', title: 'Invoice', score: '0.9500', signals: { amount: true }, attachmentnames: ['a.pdf'] }] }],
      [/FROM CtrlEvidenceSearches/, { rows: [{ searchedat: 'now', sourcessearched: 1, candidatecount: 1, error: null }] }],
    ])
  );
  expect(await loadCandidates('g1', 'q1', 'f1')).toMatchObject({
    lastSearch: { at: 'now', sources: 1, found: 1, error: null },
    candidates: [{ candidateId: 'c1', account: 'info@apohco.com', score: 0.95, attachmentNames: ['a.pdf'] }],
  });
});

test('mapLimit keeps order and limits concurrency', async () => {
  let running = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5));
    running -= 1;
    return n * 10;
  });
  expect(out).toEqual([10, 20, 30, 40, 50]);
  expect(peak).toBe(2);
});
