const XLSX = require('xlsx');
const { PDFDocument } = require('pdf-lib');
const { buildXlsx, buildPdf, exportFileName, safe } = require('../../src/shared/ajeExport');

const report = {
  reportNumber: 'MGMT-2026-10-AJE-001', qboName: 'APOHCO / Management', month: '2026-10', status: 'Published', supersedes: null, supersededBy: null,
  publishedAt: new Date('2026-11-20T12:00:00Z'), entryCount: 1, totalAmount: 150, note: 'For October close',
  entries: [{
    entryNumber: 'MGMT-2026-10-AJE-001.01', qboNum: 'MGMT-2610-AJE001.01', entryDate: '2026-10-31', kindLabel: 'Class change', vendor: 'Kroger',
    memo: 'MGMT-2026-10-AJE-001.01 Class change: Kroger — 2 transactions', amount: 150, warnings: ['Westside has no file → record its side'],
    lines: [
      { accountCode: '6100', accountName: 'Supplies', className: 'Lebanon', debit: 150, credit: 0 },
      { accountCode: '6100', accountName: 'Supplies', className: 'Unclassified', debit: 0, credit: 150 },
    ],
    posted: { month: '2026-10' },
    sources: [
      { side: 'Own', txnDate: '2026-10-05', txnType: 'Expense', docNum: '1001', payeeName: 'Kroger', memo: 'café snacks \u{1F600}', accountCode: '6100', accountName: 'Supplies', className: 'Unclassified', amount: 100,
        from: [{ code: '6100', name: 'Supplies', className: 'Unclassified', amount: 100 }], to: [{ code: '6100', name: 'Supplies', className: 'Lebanon', amount: 100 }] },
      { side: 'Own', txnDate: '2026-10-09', txnType: 'Expense', docNum: null, payeeName: 'Kroger', memo: null, accountCode: '6100', accountName: 'Supplies', className: 'Unclassified', amount: 50,
        from: [], to: [] },
    ],
    support: [{ fileName: 'inv.pdf', source: 'Gmail', savedAt: '2026-11-01', drivePath: 'Controller Evidence / Lebanon / 2026-10 / inv.pdf' }],
  }],
};

test('Excel: one row per entry line, backup per transaction, support list', () => {
  const wb = XLSX.read(buildXlsx(report), { type: 'buffer' });
  expect(wb.SheetNames).toEqual(['Entries', 'Backup', 'Support']);
  const entries = XLSX.utils.sheet_to_json(wb.Sheets.Entries, { header: 1 });
  const header = entries.findIndex((r) => r[0] === 'Entry #');
  expect(entries[header + 1]).toEqual(expect.arrayContaining(['MGMT-2026-10-AJE-001.01', 'MGMT-2610-AJE001.01', '6100 Supplies', 'Lebanon', 150]));
  expect(entries[header + 2][7]).toBe(150);
  const backup = XLSX.utils.sheet_to_json(wb.Sheets.Backup, { header: 1 });
  expect(backup.filter((r) => r[0] === 'MGMT-2026-10-AJE-001.01')).toHaveLength(2);
  const support = XLSX.utils.sheet_to_json(wb.Sheets.Support, { header: 1 });
  expect(support.some((r) => r[1] === 'inv.pdf')).toBe(true);
});

test('PDF: renders with unusual characters; unreadable support is listed, not fatal', async () => {
  const buf = await buildPdf(report, { support: [{ entryNumber: 'x', fileName: 'broken.pdf', data: Buffer.from('not a pdf') }] });
  const doc = await PDFDocument.load(buf);
  // The report page plus the "not included" page.
  expect(doc.getPageCount()).toBe(2);
});

test('helpers', () => {
  expect(exportFileName(report, 'pdf')).toBe('MGMT-2026-10-AJE-001 APOHCO Management.pdf');
  expect(safe('a—b “q” \u{1F600}')).toBe('a-b "q" ??');
});
