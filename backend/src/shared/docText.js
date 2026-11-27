// Controller Phase 4b: text from documents in invoice folders.
//
//   extractFile({ mimeType, data })   text from a PDF (text layer, else OCR of
//                                     its first pages), an image (OCR) or a
//                                     plain-text file
//   extractAmounts(text)              money amounts written with cents
//   extractDates(text)                dates (ISO YYYY-MM-DD)
//
// OCR uses Amazon Textract's synchronous DetectDocumentText, one page at a
// time (a scanned PDF is split with pdf-lib). Nothing is stored here.
const { TextractClient, DetectDocumentTextCommand } = require('@aws-sdk/client-textract');

const MAX_TEXT = 50000;
const MAX_PDF_PAGES = 20;
const OCR_PAGES = 3;
const MIN_TEXT_LAYER = 40;
const MAX_OCR_BYTES = 10 * 1024 * 1024;
const OCR_MIME = ['image/jpeg', 'image/png', 'image/tiff'];
const TEXT_MIME = ['text/plain', 'text/csv'];

let textract = null;
const getTextract = () => {
  if (!textract) textract = new TextractClient({});
  return textract;
};

const clean = (s) => String(s || '').replace(/\u0000/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

// 1,250.00 / $1250.00 / 42.10 -> [1250, 42.1]. Only amounts with cents,
// which is how invoices write them; unique, at most 300.
function extractAmounts(text) {
  const out = new Set();
  const re = /(?<![\d.,])(\d{1,3}(?:,\d{3})+|\d{1,9})\.(\d{2})(?![\d])/g;
  let m;
  while ((m = re.exec(text || '')) && out.size < 300) {
    const v = Number(`${m[1].replace(/,/g, '')}.${m[2]}`);
    if (v > 0) out.add(Math.round(v * 100) / 100);
  }
  return [...out];
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const iso = (y, m, d) => {
  const year = y < 100 ? 2000 + y : y;
  if (year < 2015 || year > 2035 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(year, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return dt.toISOString().slice(0, 10);
};

// 10/03/2026, 10-3-26, 2026-10-03, Oct 3, 2026, October 3 2026, 3 Oct 2026.
function extractDates(text) {
  const out = new Set();
  const t = text || '';
  const add = (v) => v && out.size < 100 && out.add(v);
  for (const m of t.matchAll(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g)) add(iso(+m[1], +m[2], +m[3]));
  for (const m of t.matchAll(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})\b/g)) add(iso(+m[3], +m[1], +m[2]));
  for (const m of t.matchAll(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/g)) {
    const mo = MONTHS[m[1].toLowerCase().slice(0, m[1].toLowerCase().startsWith('sept') ? 4 : 3)];
    if (mo) add(iso(+m[3], mo, +m[2]));
  }
  for (const m of t.matchAll(/\b(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/g)) {
    const mo = MONTHS[m[2].toLowerCase().slice(0, 3)];
    if (mo) add(iso(+m[3], mo, +m[1]));
  }
  return [...out];
}

async function ocr(bytes, { client = getTextract() } = {}) {
  if (bytes.length > MAX_OCR_BYTES) throw new Error('Too large to read (over 10 MB)');
  const r = await client.send(new DetectDocumentTextCommand({ Document: { Bytes: bytes } }));
  return (r.Blocks || []).filter((b) => b.BlockType === 'LINE').map((b) => b.Text).join('\n');
}

// The PDF's own text layer (pdf.js, Mozilla's reader; text only, no rendering).
async function pdfTextLayer(data) {
  // eslint-disable-next-line global-require
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  const pdf = await pdfjs.getDocument({
    data: new Uint8Array(data),
    disableWorker: true,
    isEvalSupported: false,
    useSystemFonts: false,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
  }).promise;
  const parts = [];
  try {
    for (let i = 1; i <= Math.min(pdf.numPages, MAX_PDF_PAGES); i += 1) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      parts.push(content.items.map((it) => `${it.str}${it.hasEOL ? '\n' : ' '}`).join(''));
    }
  } finally {
    await pdf.destroy();
  }
  return { text: parts.join('\n'), pages: pdf.numPages };
}

// The first `count` pages of a PDF, each as its own one-page PDF.
async function splitPages(data, count) {
  // eslint-disable-next-line global-require
  const { PDFDocument } = require('pdf-lib');
  const src = await PDFDocument.load(data, { ignoreEncryption: true });
  const out = [];
  for (let i = 0; i < Math.min(count, src.getPageCount()); i += 1) {
    const doc = await PDFDocument.create();
    const [page] = await doc.copyPages(src, [i]);
    doc.addPage(page);
    out.push(Buffer.from(await doc.save()));
  }
  return out;
}

// { text, method: 'pdf'|'ocr'|'text'|'none', ocrPages, error }
async function extractFile({ mimeType, data }, deps = {}) {
  try {
    if (mimeType === 'application/pdf') {
      let layer = { text: '' };
      try {
        layer = await pdfTextLayer(data);
      } catch {
        layer = { text: '' };
      }
      if (clean(layer.text).length >= MIN_TEXT_LAYER) return { text: clean(layer.text).slice(0, MAX_TEXT), method: 'pdf', ocrPages: 0, error: null };
      // A scan: OCR the first pages.
      const pages = await (deps.splitPages || splitPages)(data, OCR_PAGES);
      const texts = [];
      for (const p of pages) texts.push(await ocr(p, deps));
      return { text: clean(texts.join('\n\n')).slice(0, MAX_TEXT), method: 'ocr', ocrPages: pages.length, error: null };
    }
    if (OCR_MIME.includes(mimeType)) return { text: clean(await ocr(data, deps)).slice(0, MAX_TEXT), method: 'ocr', ocrPages: 1, error: null };
    if (TEXT_MIME.includes(mimeType)) return { text: clean(data.toString('utf8')).slice(0, MAX_TEXT), method: 'text', ocrPages: 0, error: null };
    return { text: '', method: 'none', ocrPages: 0, error: null };
  } catch (err) {
    return { text: '', method: 'none', ocrPages: 0, error: String(err.message || err).slice(0, 500) };
  }
}

module.exports = { extractFile, extractAmounts, extractDates, ocr, splitPages, OCR_MIME, TEXT_MIME, OCR_PAGES, MAX_TEXT };
