const { amountFormats, vendorTerms, buildGmailQueries, extractMessage, scoreCandidate, stripHtml } = require('../../src/shared/evidenceMatcher');

const ENTITIES = [
  { entityId: 'leb', entityName: 'Lebanon', aliases: ['Lebanon Pediatric Dentistry'], keywords: ['Main St'] },
  { entityId: 'mil', entityName: 'Milford', aliases: [], keywords: [] },
];
const b64 = (s) => Buffer.from(s).toString('base64url');

test('amountFormats', () => {
  expect(amountFormats(-1250)).toEqual(['1,250.00', '1250.00', '1,250', '1250']);
  expect(amountFormats(42.1)).toEqual(['42.10']);
  expect(amountFormats(0)).toEqual([]);
});

test('vendorTerms drops legal suffixes, codes and short names', () => {
  expect(vendorTerms(['Lebanon Pediatric Dentistry {C}', 'Gusto, Inc.', 'GUSTO', 'Co', 'AT&T'])).toEqual(['Lebanon Pediatric Dentistry', 'Gusto', 'AT&T']);
});

describe('buildGmailQueries', () => {
  test('amount and vendor searches within ±10 days', () => {
    expect(buildGmailQueries({ txnDate: '2026-10-03', amount: 1250, vendorNames: ['Kroger'], senders: ['billing@kroger.com'] })).toEqual([
      '("1,250.00" OR "1250.00" OR "1,250" OR "1250") after:2026/09/23 before:2026/10/14',
      '("Kroger" OR from:billing@kroger.com) after:2026/09/23 before:2026/10/14',
    ]);
  });
  test('no payee: amount only; quotes in names become spaces', () => {
    expect(buildGmailQueries({ txnDate: '2026-10-03', amount: 9.5 })).toHaveLength(1);
    expect(buildGmailQueries({ txnDate: '2026-10-03', amount: 0, vendorNames: ['Joe"s Diner'] })).toEqual(['("Joe s Diner") after:2026/09/23 before:2026/10/14']);
    expect(buildGmailQueries({ txnDate: 'bad', amount: 5 })).toEqual([]);
  });
});

test('extractMessage: plain text preferred, HTML stripped, attachments listed', () => {
  const msg = {
    id: 'm1', threadId: 't1', snippet: 'Invoice 4471', internalDate: String(Date.parse('2026-10-02T15:00:00Z')),
    payload: {
      headers: [{ name: 'Subject', value: 'Invoice 4471' }, { name: 'From', value: 'Minuteman <ar@minuteman.com>' }],
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/html', body: { data: b64('<p>Total <b>$1,250.00</b></p><script>x()</script>') } }] },
        { filename: 'INV-4471.pdf', mimeType: 'application/pdf', body: { attachmentId: 'a1', size: 2048 } },
      ],
    },
  };
  expect(extractMessage(msg)).toEqual({
    id: 'm1', threadId: 't1', subject: 'Invoice 4471', from: 'Minuteman <ar@minuteman.com>', to: '', sentAt: '2026-10-02T15:00:00.000Z',
    snippet: 'Invoice 4471', text: 'Total $1,250.00', attachments: [{ name: 'INV-4471.pdf', mimeType: 'application/pdf', size: 2048, attachmentId: 'a1' }],
  });
  expect(stripHtml('a&nbsp;&amp;&lt;b&gt;')).toBe('a &<b>');
});

describe('scoreCandidate', () => {
  const line = { txnDate: '2026-10-03', amount: -1250 };
  const candidate = (over) => ({ subject: '', from: '', snippet: '', text: '', sentAt: '2026-10-02T12:00:00Z', attachments: [], ...over });

  test('amount, vendor, date and the practice it names', () => {
    const r = scoreCandidate({
      line, vendorNames: ['Minuteman'], entities: ENTITIES,
      candidate: candidate({ from: 'Minuteman <ar@minuteman.com>', text: 'Ship to: 12 Main St. Total due $1,250.00' }),
    });
    expect(r).toEqual({ score: 1, signals: { amount: true, vendor: true, days: 1, entityTerm: 'Main St' }, entityHintId: 'leb' });
  });

  test('a date-only match is weak; two practices named give no hint', () => {
    expect(scoreCandidate({ line, vendorNames: ['Minuteman'], entities: ENTITIES, candidate: candidate({ text: 'hello' }) }).score).toBe(0.15);
    const both = scoreCandidate({ line, entities: ENTITIES, candidate: candidate({ text: 'Lebanon and Milford, 1,250.00', sentAt: '2026-09-25T00:00:00Z' }) });
    expect(both).toMatchObject({ score: 0.53, entityHintId: null, signals: { amount: true, vendor: false, days: 8, entityTerm: null } });
  });

  test("a workspace address (the management company's name) never counts as naming a practice", () => {
    const withMgmt = [...ENTITIES, { entityId: 'apo', entityName: 'APOHCO', aliases: [], keywords: [] }];
    const r = scoreCandidate({ line, entities: withMgmt, candidate: candidate({ from: 'info@apohco.com', text: 'Ship to Lebanon office. Due 1,250.00' }) });
    expect(r).toMatchObject({ entityHintId: 'leb', signals: { entityTerm: 'Lebanon' } });
  });

  test('the amount can be in an attachment name', () => {
    const r = scoreCandidate({ line, entities: [], candidate: candidate({ attachments: [{ name: 'receipt_1250.00.pdf' }], sentAt: null }) });
    expect(r.signals).toEqual({ amount: true, vendor: false, days: null, entityTerm: null });
  });
});
