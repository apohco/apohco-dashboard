// Search by invoice number: a payment that covers several invoices.
jest.mock('../../src/shared/db', () => ({ query: jest.fn(), withTransaction: jest.fn() }));

const { query, withTransaction } = require('../../src/shared/db');
const {
  extractInvoiceNumbers,
  readInvoiceTotal,
  buildInvoiceQueries,
  invoiceNumbersIn,
  scoreInvoiceCandidate,
} = require('../../src/shared/evidenceMatcher');
const { searchInvoiceNumbers, searchLines } = require('../../src/shared/ctrlEvidence');
const { parseInvoiceNumbers } = require('../../src/functions/controller/ctrlEvidence');
const { sqlRouter } = require('../helpers');

describe('reading invoice numbers', () => {
  test.each([
    ['Payment for Invoices #4471, #4472 and 4480. Thanks!', ['4471', '4472', '4480']],
    ['Invoices: 101, 102; 103 & 104', ['101', '102', '103', '104']],
    ['Re: INV-10233 overdue', ['10233']],
    ['Invoice No. A-1023 dated 10/03/2026 Total due $1,250.00', ['A-1023']],
    ['Your invoice is attached. Invoice Number: 558812', ['558812']],
    ['Patterson  Invoice # 3046441307', ['3046441307']],
    ['Invoice date 10/03/2026, invoice total 99.00', []],
    ['Please pay invoice 2026-10-03', []],
    ['no invoices here', []],
  ])('%s', (text, expected) => {
    expect(extractInvoiceNumbers(text)).toEqual(expected);
  });

  test('readInvoiceTotal: the last total written', () => {
    expect(readInvoiceTotal('Subtotal 1,000.00 Tax 80.00 Total due $1,080.00')).toBe(1080);
    expect(readInvoiceTotal('Amount due: 250.00')).toBe(250);
    expect(readInvoiceTotal('Balance Due USD 99.95')).toBe(99.95);
    expect(readInvoiceTotal('nothing')).toBeNull();
  });

  test('queries: quoted numbers, up to 18 months before the payment, 10 per query', () => {
    expect(buildInvoiceQueries({ txnDate: '2026-10-30', numbers: ['4471', 'A-1023'] })).toEqual(['("4471" OR "A-1023") after:2025/04/30 before:2026/11/01 in:anywhere']);
    expect(buildInvoiceQueries({ txnDate: '2026-10-30', numbers: Array.from({ length: 12 }, (_, i) => `${1000 + i}`) })).toHaveLength(2);
    expect(buildInvoiceQueries({ txnDate: 'bad', numbers: ['1'] })).toEqual([]);
  });

  test('a number counts only as a whole token', () => {
    const c = { subject: 'Invoice 4471', text: 'ref 144712 and A-1023', attachments: [{ name: 'INV-4480.pdf' }] };
    expect(invoiceNumbersIn(c, ['4471', '4480', '4472', 'A-1023', '1023'])).toEqual(['4471', '4480', 'A-1023', '1023']);
    expect(invoiceNumbersIn({ text: '144712' }, ['4471'])).toEqual([]);
  });

  test('scoring: the number, the vendor and the practice; the invoice total is read', () => {
    const entities = [{ entityId: 'leb', entityName: 'Lebanon', aliases: [], keywords: [] }];
    const s = scoreInvoiceCandidate({
      vendorNames: ['Patterson Dental'], entities, numbers: ['4471', '4472'],
      candidate: { subject: 'Patterson Dental Invoice 4471', from: 'billing@patterson.com', text: 'Ship to Lebanon. Total due 412.50', attachments: [] },
    });
    expect(s).toEqual({
      matched: ['4471'],
      score: 1,
      signals: { invoiceNumber: '4471', invoiceNumbers: ['4471'], invoiceTotal: 412.5, vendor: true, entityTerm: 'Lebanon' },
      entityHintId: 'leb',
    });
  });
});

test('parseInvoiceNumbers (API input)', () => {
  expect(parseInvoiceNumbers('4471, #4472  INV-4480;4471')).toEqual(['4471', '4472', '4480']);
  expect(parseInvoiceNumbers(['A-1023'])).toEqual(['A-1023']);
  expect(() => parseInvoiceNumbers('')).toThrow(/at least one/);
  expect(() => parseInvoiceNumbers('<script>')).toThrow(/doesn't look like an invoice number/);
  expect(() => parseInvoiceNumbers(Array.from({ length: 21 }, (_, i) => `${100 + i}`))).toThrow(/At most 20/);
});

describe('searchInvoiceNumbers', () => {
  const b64 = (s) => Buffer.from(s).toString('base64url');
  const LINE = { lineId: 'l1', fingerprint: 'f1', txnDate: '2026-10-30', amount: 1250, payeeName: 'Patterson' };
  let client;
  function setup({ mailboxes = ['info@apohco.com', 'amy@apohco.com'], folders = ['src-1'], driveRows = [] } = {}) {
    query.mockImplementation(
      sqlRouter([
        [/FROM CtrlGoogleSources WHERE GroupId = \$1 AND Kind = \$2/, (sql, p) => ({
          rows: p[1] === 'Mailbox' ? mailboxes.map((m) => ({ sourceid: m, kind: 'Mailbox', sourcekey: m, enabled: true })) : folders.map((f) => ({ sourceid: f, kind: 'Folder', sourcekey: f, enabled: true })),
        })],
        [/FROM CtrlEntities e/, { rows: [] }],
        [/FROM CtrlVendorAliases a JOIN CtrlVendors v/, { rows: [{ payeekey: 'patterson', vendorid: 'v1', displayname: 'Patterson Dental', names: ['Patterson'], senders: [] }] }],
        [/FROM CtrlDriveFiles f JOIN CtrlGoogleSources s/, { rows: driveRows }],
      ])
    );
    client = { query: sqlRouter([]) };
    withTransaction.mockImplementation((fn) => fn(client));
  }
  const msg = (id, subject, text) => ({ id, threadId: `t${id}`, internalDate: String(Date.parse('2026-08-01T00:00:00Z')), payload: { headers: [{ name: 'Subject', value: subject }, { name: 'From', value: 'billing@patterson.com' }], mimeType: 'text/plain', body: { data: b64(text) } } });

  test('Gmail (each mailbox) and folders; numbers not found are listed; earlier results for the numbers are replaced', async () => {
    setup({
      driveRows: [{ fileid: 'pdf1', sourceid: 'src-1', name: 'Patterson INV 4472.pdf', owneremail: 'amy@apohco.com', path: '2026', modifiedtime: '2026-08-02T00:00:00Z', webviewlink: 'https://d/1', text: 'Invoice 4472 Total due 837.50', foldername: 'Invoices' }],
    });
    const api = {
      gmailSearch: jest.fn(async (mailbox) => (mailbox === 'info@apohco.com' ? [{ id: 'm1' }, { id: 'm2' }] : [])),
      gmailGetMessage: jest.fn(async (mailbox, id) => (id === 'm1' ? msg('m1', 'Patterson Invoice 4471', 'Total due 412.50') : msg('m2', 'Newsletter', 'nothing about invoices'))),
    };
    const out = await searchInvoiceNumbers({ groupId: 'g1', qboId: 'q1', line: LINE, numbers: ['4471', '4472', '4480'], userId: 'u1', api });
    expect(out).toEqual({ numbers: ['4471', '4472', '4480'], foundNumbers: ['4471', '4472'], notFound: ['4480'], found: 2, sources: 3, errors: [] });
    expect(api.gmailSearch.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ['info@apohco.com', '("4471" OR "4472" OR "4480") after:2025/04/30 before:2026/11/01 in:anywhere'],
      ['amy@apohco.com', '("4471" OR "4472" OR "4480") after:2025/04/30 before:2026/11/01 in:anywhere'],
    ]);
    const folderQuery = query.mock.calls.find(([sql]) => /FROM CtrlDriveFiles f JOIN CtrlGoogleSources s/.test(sql))[1];
    expect(folderQuery[2]).toEqual(['\\m4471\\M', '\\m4472\\M', '\\m4480\\M']);
    expect(client.query.mock.calls.find(([sql]) => /DELETE FROM CtrlEvidenceCandidates/.test(sql))[1]).toEqual(['q1', 'f1', ['4471', '4472', '4480']]);
    const p = client.query.mock.calls.find(([sql]) => /INSERT INTO CtrlEvidenceCandidates/.test(sql))[1];
    expect(p.slice(3, 6)).toEqual(['Gmail', 'info@apohco.com', 'm1']);
    expect(JSON.parse(p[13])).toMatchObject({ invoiceNumber: '4471', invoiceTotal: 412.5 });
    expect(p.slice(17 + 3, 17 + 6)).toEqual(['Drive', 'src-1', 'pdf1']);
    expect(JSON.parse(p[17 + 13])).toMatchObject({ invoiceNumber: '4472', invoiceTotal: 837.5 });
    const audit = client.query.mock.calls.find(([sql]) => /INSERT INTO CtrlAuditLog/.test(sql))[1];
    expect(audit[2]).toBe('ctrl.evidence.invoices');
  });

  test('when the email has no total, it is read from the attached invoice PDF', async () => {
    setup({ mailboxes: ['info@apohco.com'], folders: [] });
    const { PDFDocument, StandardFonts } = require('pdf-lib');
    const doc = await PDFDocument.create();
    doc.addPage().drawText('Invoice 3046385818 Sub Total $ 412.50 Total $ 412.50', { x: 40, y: 700, size: 9, font: await doc.embedFont(StandardFonts.Helvetica) });
    const pdfBytes = Buffer.from(await doc.save());
    const withPdf = {
      id: 'p1', threadId: 't', internalDate: String(Date.parse('2026-11-21T00:00:00Z')),
      payload: {
        headers: [{ name: 'Subject', value: 'Patterson  Invoice # 3046385818' }, { name: 'From', value: 'Patterson' }],
        mimeType: 'multipart/mixed',
        parts: [
          { mimeType: 'text/html', body: { data: b64('<p>Your invoice is attached.</p>') } },
          { filename: 'Patterson  Invoice # 3046385818.PDF', mimeType: 'application/pdf', body: { attachmentId: 'att1', size: pdfBytes.length } },
        ],
      },
    };
    const api = { gmailSearch: async () => [{ id: 'p1' }], gmailGetMessage: async () => withPdf, gmailGetAttachment: jest.fn(async () => pdfBytes) };
    await searchInvoiceNumbers({ groupId: 'g1', qboId: 'q1', line: LINE, numbers: ['3046385818'], api });
    expect(api.gmailGetAttachment).toHaveBeenCalledWith('info@apohco.com', 'p1', 'att1');
    const p = client.query.mock.calls.find(([sql]) => /INSERT INTO CtrlEvidenceCandidates/.test(sql))[1];
    expect(JSON.parse(p[13])).toMatchObject({ invoiceNumber: '3046385818', invoiceTotal: 412.5 });
  });

  test('one mailbox failing is reported; the rest still count', async () => {
    setup({ folders: [] });
    const api = {
      gmailSearch: jest.fn(async (mailbox) => {
        if (mailbox === 'amy@apohco.com') throw new Error('Google 403');
        return [{ id: 'm1' }];
      }),
      gmailGetMessage: jest.fn(async () => msg('m1', 'Invoice 4471', 'x')),
    };
    const out = await searchInvoiceNumbers({ groupId: 'g1', qboId: 'q1', line: LINE, numbers: ['4471'], api });
    expect(out).toMatchObject({ foundNumbers: ['4471'], errors: ['amy@apohco.com: Google 403'] });
  });

  test('a later ordinary search keeps the invoices found by number', async () => {
    setup({ folders: [] });
    await searchLines({ groupId: 'g1', qboId: 'q1', lines: [LINE], api: { gmailSearch: async () => [], gmailGetMessage: async () => ({}) } });
    const del = client.query.mock.calls.find(([sql]) => /DELETE FROM CtrlEvidenceCandidates/.test(sql))[0];
    expect(del).toMatch(/AND NOT \(Signals \? 'invoiceNumber'\)/);
  });

  test('normal matches record the invoice numbers they mention', async () => {
    setup({ mailboxes: ['info@apohco.com'], folders: [] });
    const api = {
      gmailSearch: async () => [{ id: 'p1' }],
      gmailGetMessage: async () => msg('p1', 'Payment confirmation', 'Paid $1,250.00 for Invoices #4471, #4472 and 4480 from Patterson'),
    };
    await searchLines({ groupId: 'g1', qboId: 'q1', lines: [{ ...LINE, txnDate: '2026-07-31' }], api });
    const p = client.query.mock.calls.find(([sql]) => /INSERT INTO CtrlEvidenceCandidates/.test(sql))[1];
    expect(JSON.parse(p[13]).mentions).toEqual(['4471', '4472', '4480']);
  });
});
