// Controller Phase 5a: AJE report exports.
//
//   buildXlsx(report)                    Entries / Backup / Support sheets
//   buildPdf(report, { support })        the entries and their backup, then
//                                        each saved support PDF behind a
//                                        divider page
//
// `report` is ajeData.loadReport's result. Nothing is stored here.
const XLSX = require('xlsx');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const money = (v) => (Number(v) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const acct = (code, name) => [code, name].filter(Boolean).join(' ');
const stateText = (state) => (state || []).map((p) => `${acct(p.code, p.name)}${p.className ? ` [${p.className}]` : ''} ${money(p.amount)}`).join('; ');

function exportFileName(report, ext) {
  return `${report.reportNumber} ${String(report.qboName || '').replace(/[^A-Za-z0-9 ._-]+/g, '').trim()}.${ext}`.replace(/\s+/g, ' ');
}

function buildXlsx(report) {
  const head = [
    [`AJE report ${report.reportNumber}`],
    [`File: ${report.qboName}`, `Month: ${report.month}`, `Status: ${report.status}${report.supersededBy ? ` (replaced by ${report.supersededBy})` : ''}`],
    [`Published ${String(report.publishedAt instanceof Date ? report.publishedAt.toISOString() : report.publishedAt || '').slice(0, 10)}`,
      report.supersedes ? `Replaces ${report.supersedes}` : '', `Recommended entries only; nothing has been posted to QuickBooks by this tool.`],
    [],
  ];
  const entries = [...head, ['Entry #', 'QBO Num', 'Date', 'Kind', 'Account', 'Class', 'Debit', 'Credit', 'Memo', 'Posted (seen in GL)']];
  for (const e of report.entries) {
    e.lines.forEach((l, i) => {
      entries.push([
        e.entryNumber, e.qboNum, e.entryDate, e.kindLabel, acct(l.accountCode, l.accountName), l.className || '',
        l.debit ? Number(l.debit) : null, l.credit ? Number(l.credit) : null, i === 0 ? e.memo : '',
        i === 0 && e.posted ? `Yes, ${e.posted.month || ''} GL` : '',
      ]);
    });
  }
  const backup = [...head, ['Entry #', 'Side', 'Txn date', 'Type', 'Num', 'Payee', 'Memo', 'Account', 'Class', 'Amount', 'Moves from', 'Moves to']];
  for (const e of report.entries) {
    for (const s of e.sources) {
      backup.push([
        e.entryNumber, s.side === 'Mirror' ? 'Other entity' : 'This file', s.txnDate, s.txnType || '', s.docNum || '', s.payeeName || '',
        s.memo || '', acct(s.accountCode, s.accountName), s.className || '', Number(s.amount), stateText(s.from), stateText(s.to),
      ]);
    }
  }
  const support = [...head, ['Entry #', 'File', 'Source', 'Saved', 'Drive copy']];
  for (const e of report.entries) for (const s of e.support) support.push([e.entryNumber, s.fileName || s.title || '', s.source, s.savedAt || '', s.drivePath || '']);

  const wb = XLSX.utils.book_new();
  const add = (rows, name, widths) => {
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = widths.map((wch) => ({ wch }));
    XLSX.utils.book_append_sheet(wb, ws, name);
  };
  add(entries, 'Entries', [26, 20, 11, 18, 34, 18, 12, 12, 70, 18]);
  add(backup, 'Backup', [26, 13, 11, 14, 10, 26, 40, 34, 18, 12, 50, 50]);
  add(support, 'Support', [26, 46, 8, 11, 60]);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// ---- PDF

const SMART = { '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', '…': '...', ' ': ' ', '→': '->' };
const safe = (s) => String(s === null || s === undefined ? '' : s).replace(/[‘’“”–—… →]/g, (c) => SMART[c]).replace(/[^\x20-\x7E\xA1-\xFF]/g, '?');

class Writer {
  constructor(doc, fonts) {
    this.doc = doc;
    this.fonts = fonts;
    this.margin = 48;
    this.width = 612;
    this.height = 792;
    this.newPage();
  }

  newPage() {
    this.page = this.doc.addPage([this.width, this.height]);
    this.y = this.height - this.margin;
  }

  ensure(h) {
    if (this.y - h < this.margin) this.newPage();
  }

  wrap(text, size, maxWidth, bold = false) {
    const font = bold ? this.fonts.bold : this.fonts.regular;
    const out = [];
    for (const para of safe(text).split('\n')) {
      let line = '';
      for (const word of para.split(' ')) {
        const next = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(next, size) <= maxWidth) line = next;
        else {
          if (line) out.push(line);
          let w = word;
          while (font.widthOfTextAtSize(w, size) > maxWidth && w.length > 1) {
            let cut = w.length - 1;
            while (cut > 1 && font.widthOfTextAtSize(w.slice(0, cut), size) > maxWidth) cut -= 1;
            out.push(w.slice(0, cut));
            w = w.slice(cut);
          }
          line = w;
        }
      }
      out.push(line);
    }
    return out;
  }

  text(text, { size = 9, bold = false, x = this.margin, width = this.width - 2 * this.margin, color = rgb(0, 0, 0), gap = 2 } = {}) {
    for (const line of this.wrap(text, size, width, bold)) {
      this.ensure(size + gap);
      this.page.drawText(line, { x, y: this.y - size, size, font: bold ? this.fonts.bold : this.fonts.regular, color });
      this.y -= size + gap;
    }
  }

  // One table row; cells: [{ text, width, align?, bold? }]. Returns nothing.
  row(cells, { size = 8, bold = false, shade = false } = {}) {
    const wrapped = cells.map((c) => this.wrap(c.text, size, c.width - 4, bold || c.bold));
    const h = Math.max(...wrapped.map((w) => w.length)) * (size + 2) + 3;
    this.ensure(h);
    if (shade) this.page.drawRectangle({ x: this.margin, y: this.y - h, width: this.width - 2 * this.margin, height: h, color: rgb(0.93, 0.95, 0.97) });
    let x = this.margin;
    cells.forEach((c, i) => {
      wrapped[i].forEach((line, j) => {
        const font = bold || c.bold ? this.fonts.bold : this.fonts.regular;
        const lx = c.align === 'right' ? x + c.width - 2 - font.widthOfTextAtSize(line, size) : x + 2;
        this.page.drawText(line, { x: lx, y: this.y - (j + 1) * (size + 2), size, font });
      });
      x += c.width;
    });
    this.y -= h;
  }

  rule() {
    this.ensure(6);
    this.page.drawLine({ start: { x: this.margin, y: this.y - 2 }, end: { x: this.width - this.margin, y: this.y - 2 }, thickness: 0.5, color: rgb(0.7, 0.7, 0.7) });
    this.y -= 6;
  }

  space(h = 6) {
    this.y -= h;
  }
}

const MAX_SUPPORT_BYTES = 40 * 1024 * 1024;

// support: [{ entryNumber, fileName, data (Buffer) }] -- PDFs to append.
async function buildPdf(report, { support = [] } = {}) {
  const doc = await PDFDocument.create();
  doc.setTitle(`AJE report ${report.reportNumber}`);
  const fonts = { regular: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold) };
  const w = new Writer(doc, fonts);
  const published = String(report.publishedAt instanceof Date ? report.publishedAt.toISOString() : report.publishedAt || '').slice(0, 10);

  w.text(`Recommended adjusting entries ${report.reportNumber}`, { size: 15, bold: true, gap: 6 });
  w.text(`${report.qboName}  |  ${report.month}  |  ${report.entryCount} entr${report.entryCount === 1 ? 'y' : 'ies'}  |  $${money(report.totalAmount)}`, { size: 10, gap: 4 });
  w.text(`Published ${published}${report.supersedes ? `  |  Replaces ${report.supersedes}` : ''}${report.status === 'Superseded' ? `  |  SUPERSEDED by ${report.supersededBy}` : ''}`, { size: 9 });
  w.text('Recommendations only: nothing has been posted to QuickBooks by this tool. Type each entry\'s QBO Num in the journal entry\'s Num field and paste its memo.', { size: 8, color: rgb(0.35, 0.35, 0.35), gap: 3 });
  if (report.note) w.text(`Note: ${report.note}`, { size: 9 });
  w.space(8);

  const AW = 220;
  const CW = 120;
  const DW = 88;
  for (const e of report.entries) {
    w.ensure(80);
    w.rule();
    w.text(`${e.entryNumber}   ${e.kindLabel}${e.vendor ? ` - ${e.vendor}` : ''}`, { size: 10, bold: true, gap: 3 });
    w.text(`Date ${e.entryDate}   QBO Num ${e.qboNum}${e.posted ? `   Posted (seen in ${e.posted.month || ''} GL)` : ''}`, { size: 8, gap: 3 });
    w.row([{ text: 'Account', width: AW }, { text: 'Class', width: CW }, { text: 'Debit', width: DW, align: 'right' }, { text: 'Credit', width: DW, align: 'right' }], { bold: true, shade: true });
    for (const l of e.lines) {
      w.row([
        { text: acct(l.accountCode, l.accountName), width: AW },
        { text: l.className || '', width: CW },
        { text: l.debit ? money(l.debit) : '', width: DW, align: 'right' },
        { text: l.credit ? money(l.credit) : '', width: DW, align: 'right' },
      ]);
    }
    w.text(`Memo: ${e.memo}`, { size: 8, gap: 3 });
    for (const warn of e.warnings || []) w.text(`Note: ${warn}`, { size: 7.5, color: rgb(0.45, 0.3, 0) });
    w.space(2);
    w.text(`Backup (${e.sources.length} transaction${e.sources.length === 1 ? '' : 's'})`, { size: 8, bold: true });
    for (const s of e.sources.slice(0, 200)) {
      w.row([
        { text: s.txnDate || '', width: 58 },
        { text: [s.txnType, s.docNum].filter(Boolean).join(' '), width: 74 },
        { text: s.payeeName || '', width: 110 },
        { text: s.memo || '', width: 186 },
        { text: money(s.amount), width: 88, align: 'right' },
      ], { size: 7 });
    }
    if (e.sources.length > 200) w.text(`... and ${e.sources.length - 200} more (see the Excel export)`, { size: 7 });
    if (e.support.length) w.text(`Support: ${e.support.map((s) => s.fileName || s.title).join('; ')}`, { size: 7.5, gap: 3 });
    w.space(6);
  }

  // Saved support, each behind a divider page.
  let bytes = 0;
  const skipped = [];
  for (const s of support) {
    bytes += s.data.length;
    if (bytes > MAX_SUPPORT_BYTES) {
      skipped.push(s.fileName);
      continue;
    }
    try {
      const src = await PDFDocument.load(s.data, { ignoreEncryption: true });
      w.newPage();
      w.text(`Support for ${s.entryNumber}`, { size: 13, bold: true, gap: 6 });
      w.text(s.fileName, { size: 10 });
      const pages = await doc.copyPages(src, src.getPageIndices());
      for (const p of pages) doc.addPage(p);
    } catch {
      skipped.push(s.fileName);
    }
  }
  if (skipped.length) {
    w.newPage();
    w.text('Support not included in this PDF', { size: 12, bold: true, gap: 6 });
    for (const name of skipped) w.text(`- ${name}`, { size: 9 });
    w.text('Download these from the report screen.', { size: 9 });
  }
  return Buffer.from(await doc.save());
}

module.exports = { buildXlsx, buildPdf, exportFileName, safe, MAX_SUPPORT_BYTES };
