jest.mock('../../src/shared/db', () => ({ query: jest.fn(), withTransaction: jest.fn() }));

const { query, withTransaction } = require('../../src/shared/db');
const { searchLines, loadCandidates, mapLimit, nearestDate, snippetAround } = require('../../src/shared/ctrlEvidence');
const { sqlRouter } = require('../helpers');

const b64 = (s) => Buffer.from(s).toString('base64url');
const message = (id, { subject, from, text, date = '2026-10-02T12:00:00Z' }) => ({
  id, threadId: `t-${id}`, snippet: subject, internalDate: String(Date.parse(date)),
  payload: { headers: [{ name: 'Subject', value: subject }, { name: 'From', value: from }], mimeType: 'text/plain', body: { data: b64(text) } },
});
const LINE = { lineId: 'l1', fingerprint: 'f1', txnDate: '2026-10-03', amount: -1250, payeeName: 'Minuteman' };

let client;
function setup({ mailboxes = ['info@apohco.com'], folders = [], driveRows = [], senders = [] } = {}) {
  query.mockImplementation(
    sqlRouter([
      [/FROM CtrlGoogleSources WHERE GroupId = \$1 AND Kind = \$2/, (sql, p) => ({
        rows: p[1] === 'Mailbox'
          ? mailboxes.map((m) => ({ sourceid: `mb-${m}`, kind: 'Mailbox', sourcekey: m, enabled: true }))
          : folders.map((f) => ({ sourceid: f, kind: 'Folder', sourcekey: `key-${f}`, enabled: true })),
      })],
      [/FROM CtrlEntities e/, { rows: [{ entityid: 'leb', entityname: 'Lebanon', aliases: [], keywords: ['Main St'] }] }],
      [/FROM CtrlVendorAliases a JOIN CtrlVendors v/, { rows: [{ payeekey: 'minuteman', vendorid: 'v1', displayname: 'Minuteman Press', names: ['Minuteman', 'MINUTEMAN PRESS'], senders }] }],
      [/FROM CtrlDriveFiles f JOIN CtrlGoogleSources s/, { rows: driveRows }],
    ])
  );
  client = { query: sqlRouter([]) };
  withTransaction.mockImplementation((fn) => fn(client));
}
const api = () => ({
  gmailSearch: jest.fn(async (mailbox, q) => (q.startsWith('("1,250.00"') ? [{ id: 'm1' }, { id: 'm2' }] : [{ id: 'm1' }, { id: 'm3' }])),
  gmailGetMessage: jest.fn(async (mailbox, id) =>
    ({
      m1: message('m1', { subject: 'Invoice 4471', from: 'Minuteman Press <ar@mm.com>', text: 'Ship to 12 Main St. Total $1,250.00' }),
      m2: message('m2', { subject: 'Payroll', from: 'Gusto', text: 'Net pay 1,250.00', date: '2026-09-24T00:00:00Z' }),
      m3: message('m3', { subject: 'Newsletter', from: 'x@y.com', text: 'hello', date: '2026-09-15T00:00:00Z' }),
    })[id]
  ),
});
const insertedRows = () => {
  const ins = client.query.mock.calls.find(([sql]) => /INSERT INTO CtrlEvidenceCandidates/.test(sql));
  if (!ins) return [];
  const p = ins[1];
  const rows = [];
  for (let i = 0; i < p.length; i += 17) rows.push(p.slice(i, i + 17));
  return rows;
};

test('Gmail: searches each opted-in mailbox, scores and keeps the good candidates', async () => {
  setup();
  const gm = api();
  const out = await searchLines({ groupId: 'g1', qboId: 'q1', lines: [LINE], userId: 'u1', via: 'FindEvidence', api: gm });
  expect(out).toEqual({ searched: 1, found: 1, sources: 1, errors: [] });
  expect(gm.gmailSearch.mock.calls.map((c) => c[1])).toEqual([
    '("1,250.00" OR "1250.00" OR "1,250" OR "1250") after:2026/09/23 before:2026/10/14',
    '("Minuteman Press" OR "Minuteman") after:2026/09/23 before:2026/10/14',
  ]);
  expect(gm.gmailGetMessage.mock.calls.map((c) => c[1])).toEqual(['m1', 'm2', 'm3']);
  const rows = insertedRows();
  expect(rows.map((r) => [r[3], r[5], r[12], r[14]])).toEqual([['Gmail', 'm1', 1, 'leb'], ['Gmail', 'm2', 0.53, null]]);
  // Only Gmail candidates are replaced when no folder is switched on.
  expect(client.query.mock.calls.find(([sql]) => /DELETE FROM CtrlEvidenceCandidates/.test(sql))[1]).toEqual(['q1', 'f1', ['Gmail']]);
  const audit = client.query.mock.calls.find(([sql]) => /INSERT INTO CtrlAuditLog/.test(sql))[1];
  expect(JSON.parse(audit[5])).toEqual({ via: 'FindEvidence', lines: 1, mailboxes: ['info@apohco.com'], folders: 0, found: 2, errors: 0 });
});

test('learned sender addresses join the vendor search', async () => {
  setup({ senders: ['ar@mm.com'] });
  const gm = api();
  await searchLines({ groupId: 'g1', qboId: 'q1', lines: [LINE], api: gm });
  expect(gm.gmailSearch.mock.calls[1][1]).toBe('("Minuteman Press" OR "Minuteman" OR from:ar@mm.com) after:2026/09/23 before:2026/10/14');
});

test('folders: the index is searched by amount or vendor and scored like email', async () => {
  setup({
    mailboxes: [],
    folders: ['src-1'],
    driveRows: [
      { fileid: 'file1', sourceid: 'src-1', name: 'Minuteman INV-4471.pdf', owneremail: 'amy@apohco.com', path: '2026', modifiedtime: '2026-11-20T00:00:00Z', webviewlink: 'https://d/1', text: 'Invoice date 10/02/2026. Total due 1,250.00. Ship to Main St.', dates: ['2026-10-02'], foldername: 'Invoices' },
      { fileid: 'file2', sourceid: 'src-1', name: 'scan.pdf', owneremail: 'amy@apohco.com', path: '', modifiedtime: '2026-01-01T00:00:00Z', webviewlink: 'https://d/2', text: 'nothing', dates: [], foldername: 'Invoices' },
    ],
  });
  const gm = api();
  const out = await searchLines({ groupId: 'g1', qboId: 'q1', lines: [LINE], api: gm });
  expect(gm.gmailSearch).not.toHaveBeenCalled();
  expect(out).toMatchObject({ found: 1, sources: 1 });
  const driveQuery = query.mock.calls.find(([sql]) => /FROM CtrlDriveFiles f JOIN CtrlGoogleSources s/.test(sql))[1];
  expect(driveQuery).toEqual(['g1', ['src-1'], 1250, '"Minuteman Press" or "Minuteman"']);
  const [row] = insertedRows();
  // The invoice's own date (10/02) counts, not when it was saved to the folder.
  expect(row.slice(3, 10)).toEqual(['Drive', 'src-1', 'file1', null, 'Minuteman INV-4471.pdf', 'amy@apohco.com', '2026-10-02T00:00:00.000Z']);
  expect(row[12]).toBe(1);
  expect(row.slice(15)).toEqual(['https://d/1', 'Invoices / 2026']);
  expect(insertedRows()).toHaveLength(1);
});

test('nothing switched on: refused', async () => {
  setup({ mailboxes: [] });
  await expect(searchLines({ groupId: 'g1', qboId: 'q1', lines: [LINE], api: api() })).rejects.toMatchObject({ statusCode: 409 });
});

test('when every mailbox fails, the line keeps its earlier Gmail candidates and the error is recorded', async () => {
  setup();
  const gm = api();
  gm.gmailSearch.mockRejectedValue(new Error('Google 403: Mail service not enabled'));
  const out = await searchLines({ groupId: 'g1', qboId: 'q1', lines: [LINE], api: gm });
  expect(out.errors).toEqual(['info@apohco.com: Google 403: Mail service not enabled']);
  expect(client.query.mock.calls.some(([sql]) => /DELETE FROM CtrlEvidenceCandidates/.test(sql))).toBe(false);
  const search = client.query.mock.calls.find(([sql]) => /INSERT INTO CtrlEvidenceSearches/.test(sql))[1];
  expect(search[5]).toBe('info@apohco.com: Google 403: Mail service not enabled');
});

test('loadCandidates: candidates (with saved state) and saved support', async () => {
  query.mockImplementation(
    sqlRouter([
      [/FROM CtrlEvidenceCandidates c/, { rows: [{ candidateid: 'c1', source: 'Drive', sourceaccount: 'src-1', externalid: 'file1', title: 'INV.pdf', score: '0.9500', signals: { amount: true }, link: 'https://d/1', path: 'Invoices', savedid: 's1', savedstatus: 'Saved' }] }],
      [/FROM CtrlEvidenceSearches/, { rows: [{ searchedat: 'now', sourcessearched: 2, candidatecount: 1, error: null }] }],
      [/FROM CtrlEvidenceSaved WHERE GroupId/, { rows: [{ savedid: 's1', source: 'Drive', title: 'INV.pdf', status: 'Saved', filename: '2026-10-03_x_1.00.pdf', sizebytes: '2048', drivepath: 'Controller Evidence / Lebanon / 2026-10 / x.pdf', drivefileid: 'd1' }] }],
    ])
  );
  const out = await loadCandidates('g1', 'q1', 'f1');
  expect(out.candidates[0]).toMatchObject({ link: 'https://d/1', path: 'Invoices', saved: { savedId: 's1', status: 'Saved' } });
  expect(out.saved[0]).toMatchObject({ savedId: 's1', status: 'Saved', sizeBytes: 2048, driveCopied: true });
});

test('helpers', async () => {
  expect(nearestDate('2026-10-03', ['2026-01-01', '2026-10-05', '2026-09-30'], '2026-11-20T00:00:00Z')).toBe('2026-10-05T00:00:00.000Z');
  expect(nearestDate('2026-10-03', ['2025-01-01'], '2026-11-20T00:00:00Z')).toBe('2026-11-20T00:00:00.000Z');
  expect(snippetAround(`${'x'.repeat(500)} Total 1,250.00 due`, 1250)).toMatch(/Total 1,250\.00 due/);
  let running = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4], 2, async (n) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5));
    running -= 1;
    return n * 10;
  });
  expect(out).toEqual([10, 20, 30, 40]);
  expect(peak).toBe(2);
});
