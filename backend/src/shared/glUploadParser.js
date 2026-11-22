const { parseDate, parseNumber } = require('./fileParser');

// Column detection and normalization for General Ledger files uploaded to
// the Controller module. Exports from QuickBooks (and other tools) put the
// same data under different headers and in different column orders, so
// instead of requiring fixed column names this module:
//
//   1. finds the header row (title blocks above it are skipped),
//   2. matches each header to a canonical field by name (synonyms below),
//   3. lets the caller override any match (the UI's mapping dropdowns),
//   4. turns every data row into one uniform ledger line.
//
// Lines come out in the same shape ctrlGlPullWorker builds from the QBO
// API, with Amount signed debit-positive (Amount = Debit - Credit).

// Canonical fields, in the order the UI shows them. Synonyms are compared
// after normalizeHeader (lowercase, letters and digits only), and earlier
// synonyms win when a file has more than one candidate column.
const FIELDS = [
  {
    // Optional: QuickBooks' classic layout has no account column and
    // labels each account's block of lines with a heading row instead.
    key: 'account',
    label: 'Distribution account',
    synonyms: ['distribution account', 'account', 'account full name', 'account name', 'gl account', 'ledger account'],
  },
  {
    key: 'txnDate',
    label: 'Transaction date',
    required: true,
    synonyms: ['transaction date', 'date', 'txn date', 'trans date', 'posting date', 'entry date'],
  },
  { key: 'txnType', label: 'Transaction type', synonyms: ['transaction type', 'type', 'txn type', 'trans type'] },
  { key: 'name', label: 'Name', synonyms: ['name', 'payee', 'payee name', 'vendor', 'customer', 'vendor customer', 'customer vendor'] },
  { key: 'description', label: 'Description', synonyms: ['description', 'memo', 'memo description', 'line description', 'memo/description'] },
  { key: 'split', label: 'Split', synonyms: ['split', 'split account', 'offset account', 'contra account'] },
  { key: 'amount', label: 'Amount', synonyms: ['amount', 'net amount', 'transaction amount', 'amt'] },
  { key: 'class', label: 'Class', synonyms: ['class', 'class name', 'class full name'] },
  { key: 'debit', label: 'Debit', synonyms: ['debit', 'debits', 'debit amount', 'dr'] },
  { key: 'credit', label: 'Credit', synonyms: ['credit', 'credits', 'credit amount', 'cr'] },
  { key: 'docNum', label: 'Num', synonyms: ['num', 'no', 'doc num', 'document number', 'ref no', 'reference', 'check no', 'number'] },
  { key: 'accountCode', label: 'Account number', synonyms: ['account number', 'account no', 'acct num', 'acct no', 'account code', 'account #'] },
];
const FIELD_KEYS = FIELDS.map((f) => f.key);

// Positive Amount means "increases the account's balance" in QuickBooks'
// General Ledger export, so a credit for these classifications.
const CREDIT_NORMAL = ['Liability', 'Equity', 'Revenue'];
const CLASSIFICATIONS = ['Asset', 'Liability', 'Equity', 'Revenue', 'Expense'];
const AMOUNT_CONVENTIONS = ['natural', 'debitPositive'];

const HEADER_SCAN_ROWS = 30;
const SAMPLE_SIZE = 10;
const MAX_ERRORS = 50;

const normalizeHeader = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9#]/g, '');
// Headers that only look like a field by prefix ("Account type").
const NOT_FIELDS = new Set(['balance', 'accounttype', 'openbalance', 'createdby', 'createdate', 'lastmodified', 'lastmodifiedby']);
const SYNONYMS = FIELDS.map((f) => ({ key: f.key, names: f.synonyms.map(normalizeHeader) }));
const ALL_SYNONYMS = new Set(SYNONYMS.flatMap((s) => s.names));

const cellText = (row, idx) => (idx === null || idx === undefined ? '' : String(row?.[idx] ?? '').trim());
const isBlank = (v) => v === undefined || v === null || String(v).trim() === '';

// The header row is the first of the top rows with the most cells that are
// known column names (at least 2). Returns its 0-based index, or 0.
function findHeaderRow(rows) {
  let best = { index: 0, score: 1 };
  for (let i = 0; i < Math.min(rows.length, HEADER_SCAN_ROWS); i++) {
    const score = (rows[i] || []).filter((cell) => ALL_SYNONYMS.has(normalizeHeader(cell))).length;
    if (score > best.score) best = { index: i, score };
  }
  return best.index;
}

// Matches headers to fields. Each field takes the header matching its
// earliest synonym, and each column is used at most once (fields are
// matched in FIELDS order, so "Account" goes to the account label before
// the account number). Then, for headers like "Transaction Date (MM/DD)",
// a second pass accepts a header that starts with a synonym.
function detectMapping(headers) {
  const normalized = headers.map(normalizeHeader);
  const used = new Set();
  const mapping = Object.fromEntries(FIELD_KEYS.map((k) => [k, null]));

  const take = (matches) => {
    for (const { key, names } of SYNONYMS) {
      if (mapping[key] !== null) continue;
      for (const name of names) {
        const idx = normalized.findIndex((h, i) => h && !used.has(i) && matches(h, name));
        if (idx >= 0) {
          mapping[key] = idx;
          used.add(idx);
          break;
        }
      }
    }
  };
  take((h, name) => h === name);
  take((h, name) => name.length >= 4 && !NOT_FIELDS.has(h) && h.startsWith(name));
  return mapping;
}

// With no recognizable date header, use the column whose values are
// mostly dates.
function detectDateColumn(rows, headerRow, mapping) {
  if (mapping.txnDate !== null) return mapping;
  const taken = new Set(Object.values(mapping).filter((v) => v !== null));
  const sample = rows.slice(headerRow + 1, headerRow + 1 + 200).filter((r) => r.some((c) => !isBlank(c)));
  const width = Math.max(0, ...sample.map((r) => r.length));
  let best = null;
  for (let col = 0; col < width; col++) {
    if (taken.has(col)) continue;
    const values = sample.map((r) => r[col]).filter((v) => !isBlank(v));
    if (values.length < 3) continue;
    const share = values.filter((v) => parseGlDate(v)).length / values.length;
    if (share >= 0.8 && (!best || share > best.share)) best = { col, share };
  }
  return best ? { ...mapping, txnDate: best.col } : mapping;
}

// Validates a caller-supplied mapping ({ field: columnIndex | null }).
function cleanMapping(mapping, headerCount) {
  const out = Object.fromEntries(FIELD_KEYS.map((k) => [k, null]));
  const seen = new Set();
  for (const [key, value] of Object.entries(mapping || {})) {
    if (!FIELD_KEYS.includes(key)) throw new Error(`Unknown field "${key}" in column mapping`);
    if (value === null || value === undefined || value === '') continue;
    const idx = Number(value);
    if (!Number.isInteger(idx) || idx < 0 || idx >= headerCount) {
      throw new Error(`Column for ${key} is out of range`);
    }
    if (seen.has(idx)) throw new Error('The same column is mapped to two fields');
    seen.add(idx);
    out[key] = idx;
  }
  return out;
}

function mappingProblems(mapping) {
  const problems = [];
  if (mapping.txnDate === null) problems.push('Map a column to Transaction date.');
  if (mapping.amount === null && mapping.debit === null && mapping.credit === null) {
    problems.push('Map a column to Amount (or to Debit and Credit).');
  }
  return problems;
}

// "400001 Management Fee Income" -> code 400001. A label without a leading
// account number keeps a null code (QBO files without account numbering).
function splitAccountLabel(label) {
  const match = /^(\d[\d.-]*)\s+(.+)$/.exec(label);
  if (match) return { code: match[1], name: match[2] };
  return { code: null, name: label || null };
}

// A first guess at an account's classification from its number, for
// accounts this QBO file has never been reconciled against.
function suggestClassification(code) {
  const first = String(code || '').charAt(0);
  return { 1: 'Asset', 2: 'Liability', 3: 'Equity', 4: 'Revenue' }[first] || (/[5-9]/.test(first) ? 'Expense' : null);
}

// Dates as spreadsheets show them: everything fileParser.parseDate reads,
// plus 2-digit years ("1/15/26", Excel's default short date) and month
// names ("Jan 15, 2026").
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const ymd = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
function parseGlDate(value) {
  const str = String(value ?? '').trim();
  const short = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/.exec(str);
  const named = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(str);
  let iso = parseDate(value);
  if (!iso && short) iso = ymd(2000 + Number(short[3]), Number(short[1]), Number(short[2]));
  if (!iso && named && MONTHS.includes(named[1].toLowerCase())) {
    iso = ymd(Number(named[3]), MONTHS.indexOf(named[1].toLowerCase()) + 1, Number(named[2]));
  }
  if (!iso) return null;
  // Reject impossible dates ("2/30/2026") that the database would refuse.
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? iso : null;
}

const accountKey = (code, name) => (code ? `code:${code}` : `name:${String(name || '').toLowerCase()}`);
const round2 = (n) => Math.round(n * 100) / 100;

// Rows QuickBooks puts between transactions: totals, opening balances and
// report footers. They have no transaction date and are skipped quietly.
const SUMMARY_ROW = /^(total|beginning balance|opening balance|ending balance|net|balance forward)\b/i;
const FOOTER_ROW = /^(cash basis|accrual basis)|\bGMT\b/i;

// The first non-blank cell of a row, when that is the only text on it and
// it isn't a summary label: QuickBooks' classic layout labels each
// account's block of lines this way instead of repeating the account on
// every line.
function sectionLabel(row) {
  const texts = row.map((c) => String(c ?? '').trim()).filter(Boolean);
  if (texts.length !== 1 || SUMMARY_ROW.test(texts[0]) || FOOTER_ROW.test(texts[0])) return null;
  if (parseGlDate(texts[0]) || !Number.isNaN(Number(texts[0].replace(/[$,()]/g, '')))) return null;
  return texts[0].replace(/\s+\(\d[\d.-]*\)$/, '');
}

// Parses an uploaded GL into uniform lines.
//
// options:
//   headerRow         0-based header row (detected when omitted)
//   mapping           { field: columnIndex | null } (detected when omitted)
//   amountConvention  'natural' (default; QuickBooks: positive increases the
//                     account) or 'debitPositive' (positive = debit). Only
//                     used for rows that have an Amount but no Debit/Credit.
//   classifications   { accountKey: Classification } chosen by the user for
//                     accounts the QBO file doesn't know yet
//   knownClassifications  same shape, from ChartOfAccountsMappings
//   classIds          Map className -> QBOClassId
function parseGlRows(rows, options = {}) {
  const headerRow = options.headerRow ?? findHeaderRow(rows);
  if (!Number.isInteger(headerRow) || headerRow < 0 || headerRow >= rows.length) {
    throw new Error('Header row is outside the file');
  }
  const headers = (rows[headerRow] || []).map((h) => String(h ?? '').trim());
  const detected = !options.mapping;
  const mapping = detected
    ? detectDateColumn(rows, headerRow, detectMapping(headers))
    : cleanMapping(options.mapping, headers.length);
  const amountConvention = options.amountConvention || 'natural';
  if (!AMOUNT_CONVENTIONS.includes(amountConvention)) {
    throw new Error(`amountConvention must be one of ${AMOUNT_CONVENTIONS.join(', ')}`);
  }

  const base = { headerRow, headers, mapping, detected, amountConvention };
  const problems = mappingProblems(mapping);
  if (problems.length) {
    return { ...base, problems, lines: [], sample: [], errors: [], errorCount: 0, skippedRows: 0, unknownAccounts: [], months: [], totals: null };
  }

  const known = options.knownClassifications || {};
  const chosen = options.classifications || {};
  const classIds = options.classIds || new Map();
  const usesDebitCredit = mapping.debit !== null || mapping.credit !== null;

  const lines = [];
  const errors = [];
  const unknown = new Map();
  let errorCount = 0;
  let skippedRows = 0;
  let section = null;

  const addError = (rowNumber, messages) => {
    errorCount += 1;
    if (errors.length < MAX_ERRORS) errors.push({ row: rowNumber, errors: messages });
  };

  for (let i = headerRow + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const rowNumber = i + 1; // as counted in a spreadsheet
    if (!row.some((c) => !isBlank(c))) continue;

    const dateText = cellText(row, mapping.txnDate);
    const txnDate = parseGlDate(row[mapping.txnDate]);
    if (!txnDate) {
      const label = sectionLabel(row);
      if (label) section = label;
      else if (!dateText || SUMMARY_ROW.test(dateText) || FOOTER_ROW.test(dateText) || !/\d/.test(dateText)) skippedRows += 1;
      else addError(rowNumber, [`"${dateText}" isn't a date`]);
      continue;
    }

    const label = cellText(row, mapping.account) || section || '';
    const fromLabel = splitAccountLabel(label);
    const code = cellText(row, mapping.accountCode) || fromLabel.code;
    const name = !fromLabel.code || fromLabel.code === code ? fromLabel.name : label || null;
    const rowErrors = [];
    if (!code && !name) rowErrors.push('no account');

    let debit = 0;
    let credit = 0;
    const debitCell = mapping.debit === null ? '' : row[mapping.debit];
    const creditCell = mapping.credit === null ? '' : row[mapping.credit];
    const amountCell = mapping.amount === null ? '' : row[mapping.amount];
    const key = accountKey(code, name);
    let awaitingClassification = false;

    if (usesDebitCredit && (!isBlank(debitCell) || !isBlank(creditCell))) {
      const net = parseNumber(debitCell) - parseNumber(creditCell);
      if (Number.isNaN(net)) rowErrors.push('Debit/Credit must be numbers');
      else if (net >= 0) debit = net;
      else credit = -net;
    } else if (!isBlank(amountCell)) {
      const amount = parseNumber(amountCell);
      if (Number.isNaN(amount)) {
        rowErrors.push(`Amount "${String(amountCell).trim()}" isn't a number`);
      } else if (amountConvention === 'debitPositive') {
        if (amount >= 0) debit = amount;
        else credit = -amount;
      } else {
        const classification = chosen[key] || known[key] || null;
        if (!classification) {
          awaitingClassification = true;
          const entry = unknown.get(key) || { accountKey: key, accountCode: code, accountName: name, lineCount: 0, suggested: suggestClassification(code) };
          entry.lineCount += 1;
          unknown.set(key, entry);
        } else {
          const increasesCredit = CREDIT_NORMAL.includes(classification);
          const positive = amount >= 0;
          if (positive === increasesCredit) credit = Math.abs(amount);
          else debit = Math.abs(amount);
        }
      }
    } else {
      rowErrors.push('no amount');
    }

    if (rowErrors.length) {
      addError(rowNumber, rowErrors);
      continue;
    }
    if (awaitingClassification) continue; // counted in unknownAccounts until the user classifies it

    debit = round2(debit);
    credit = round2(credit);
    const className = cellText(row, mapping.class) || null;
    lines.push({
      sourceRow: rowNumber,
      txnDate,
      txnType: cellText(row, mapping.txnType) || null,
      docNum: cellText(row, mapping.docNum) || null,
      qboTxnId: null,
      payeeName: cellText(row, mapping.name) || null,
      payeeQBOId: null,
      memo: cellText(row, mapping.description) || null,
      splitAccount: cellText(row, mapping.split) || null,
      accountCode: code || null,
      accountName: name || null,
      className,
      qboClassId: className ? classIds.get(className) || null : null,
      debit,
      credit,
      amount: round2(debit - credit),
    });
  }

  const monthCounts = new Map();
  for (const l of lines) monthCounts.set(l.txnDate.slice(0, 7), (monthCounts.get(l.txnDate.slice(0, 7)) || 0) + 1);
  const totalDebit = round2(lines.reduce((s, l) => s + l.debit, 0));
  const totalCredit = round2(lines.reduce((s, l) => s + l.credit, 0));

  return {
    ...base,
    problems: [],
    lines,
    sample: lines.slice(0, SAMPLE_SIZE),
    errors,
    errorCount,
    skippedRows,
    unknownAccounts: [...unknown.values()].sort((a, b) => b.lineCount - a.lineCount),
    months: [...monthCounts.entries()].sort().map(([month, lineCount]) => ({ month, lineCount })),
    totals: { debit: totalDebit, credit: totalCredit, difference: round2(totalDebit - totalCredit) },
  };
}

module.exports = {
  FIELDS,
  CLASSIFICATIONS,
  AMOUNT_CONVENTIONS,
  normalizeHeader,
  findHeaderRow,
  detectMapping,
  cleanMapping,
  splitAccountLabel,
  suggestClassification,
  accountKey,
  parseGlDate,
  parseGlRows,
};
