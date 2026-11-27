const { PDFDocument, StandardFonts } = require('pdf-lib');
const { extractFile, extractAmounts, extractDates, splitPages } = require('../../src/shared/docText');

async function pdfWith(lines) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of lines) doc.addPage().drawText(text, { x: 40, y: 700, size: 10, font });
  return Buffer.from(await doc.save());
}
const textract = (text = 'OCR LINE 1\nTotal 99.95') => ({ send: jest.fn(async () => ({ Blocks: text.split('\n').map((t) => ({ BlockType: 'LINE', Text: t })) })) });

test('extractAmounts: amounts with cents only, unique', () => {
  expect(extractAmounts('Total $1,250.00, tax 42.10, qty 3, again 1250.00, zero 0.00, long 12345.678')).toEqual([1250, 42.1]);
});

test('extractDates: common invoice formats, real dates only', () => {
  expect(extractDates('Inv 10/03/2026 due Oct 15, 2026 paid 2026-10-20 or 3 Nov 2026; Sept 2, 2026; bad 13/45/2026; 02/30/2026').sort()).toEqual([
    '2026-09-02', '2026-10-03', '2026-10-15', '2026-10-20', '2026-11-03',
  ]);
});

test('a text PDF is read from its text layer, without OCR', async () => {
  const client = textract();
  const r = await extractFile({ mimeType: 'application/pdf', data: await pdfWith(['INVOICE 4471 Total due 1,250.00 Ship to 12 Main St Lebanon']) }, { client });
  expect(r).toMatchObject({ method: 'pdf', ocrPages: 0, error: null });
  expect(r.text).toMatch(/Total due 1,250\.00/);
  expect(client.send).not.toHaveBeenCalled();
});

test('a scan (no text layer) is OCR\'d, first 3 pages only', async () => {
  const client = textract();
  const blank = await PDFDocument.create();
  for (let i = 0; i < 5; i += 1) blank.addPage();
  const r = await extractFile({ mimeType: 'application/pdf', data: Buffer.from(await blank.save()) }, { client });
  expect(r).toMatchObject({ method: 'ocr', ocrPages: 3, error: null });
  expect(client.send).toHaveBeenCalledTimes(3);
  expect(r.text).toMatch(/Total 99\.95/);
});

test('images are OCR\'d; text files read; other types indexed by name only', async () => {
  const client = textract('Receipt 12.50');
  expect(await extractFile({ mimeType: 'image/jpeg', data: Buffer.from('x') }, { client })).toEqual({ text: 'Receipt 12.50', method: 'ocr', ocrPages: 1, error: null });
  expect(await extractFile({ mimeType: 'text/plain', data: Buffer.from('a  b\n\n\n\nc') })).toEqual({ text: 'a b\n\nc', method: 'text', ocrPages: 0, error: null });
  expect(await extractFile({ mimeType: 'application/zip', data: Buffer.from('x') })).toEqual({ text: '', method: 'none', ocrPages: 0, error: null });
});

test('OCR errors and oversized images are reported, not thrown', async () => {
  const client = { send: jest.fn().mockRejectedValue(new Error('UnsupportedDocumentException')) };
  expect(await extractFile({ mimeType: 'image/png', data: Buffer.from('x') }, { client })).toMatchObject({ method: 'none', error: 'UnsupportedDocumentException' });
  const big = Buffer.alloc(11 * 1024 * 1024);
  expect((await extractFile({ mimeType: 'image/png', data: big }, { client: textract() })).error).toMatch(/over 10 MB/);
});

test('splitPages', async () => {
  const pages = await splitPages(await pdfWith(['a', 'b', 'c', 'd']), 3);
  expect(pages).toHaveLength(3);
  expect((await PDFDocument.load(pages[0])).getPageCount()).toBe(1);
});
