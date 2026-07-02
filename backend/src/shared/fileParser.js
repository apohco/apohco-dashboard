const XLSX = require('xlsx');
const { parse: parseCsv } = require('csv-parse/sync');

const VALID_CLASSIFICATIONS = ['Asset', 'Liability', 'Equity', 'Revenue', 'Expense'];

// Accepts "YYYY-MM-DD" (optionally with a time suffix), "M/D/YYYY", or an
// Excel/Date object (xlsx returns these for some cell formats even with
// raw:false). Returns a "YYYY-MM-DD" string or null if unparseable.
function parseDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, '0');
    const d = String(value.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  const str = String(value ?? '').trim();
  if (!str) return null;

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(str);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(str);
  if (us) {
    const [, m, d, y] = us;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  return null;
}

function parseNumber(value) {
  if (value === '' || value === null || value === undefined) return 0;
  const n = Number(String(value).replace(/[$,]/g, '').replace(/^\((.*)\)$/, '-$1'));
  return Number.isFinite(n) ? n : NaN;
}

// Case-insensitive lookup of a row's value by column name, tolerating
// extra whitespace in the header (e.g. a trailing space from an Excel
// export).
function getField(row, name) {
  const key = Object.keys(row).find((k) => k.trim().toLowerCase() === name.toLowerCase());
  return key ? row[key] : undefined;
}

// CSV is parsed with csv-parse rather than xlsx: xlsx's CSV ingestion path
// runs the same type-inference it uses for real spreadsheet cells, and
// will silently "helpfully" reinterpret date-shaped text like "2026-01-13"
// as an Excel date serial — reformatting it as "1/12/26" (wrong format
// *and* off by a day). csv-parse returns every field as the literal
// string from the file, which is what our own date/number parsing below
// expects. Genuine .xlsx files don't have this ambiguity (cell types are
// stored explicitly in the file), so those still go through xlsx.
function rowsFromBuffer(buffer, fileExtension) {
  if (fileExtension === 'csv') {
    return parseCsv(buffer, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
      relax_column_count: true, // tolerate ragged rows (e.g. a stray trailing comma) rather than failing the whole file
    });
  }
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { raw: false, defval: '' });
}

// Parses an uploaded CSV/XLSX buffer into RawTransactions-shaped rows,
// plus the distinct set of accounts referenced (for upserting
// ChartOfAccountsMappings) and any per-row validation errors.
// Required columns: TransactionDate, AccountCode, AccountName, Classification.
// Optional: Debit, Credit, Amount (computed from Debit-Credit if omitted),
// TransactionType, Description, ClassName.
function parseTransactionFile(buffer, fileExtension) {
  const rawRows = rowsFromBuffer(buffer, fileExtension);

  const rows = [];
  const errors = [];
  const accountsByCode = new Map();

  rawRows.forEach((raw, i) => {
    const rowNum = i + 2; // +1 for header row, +1 for 1-indexing
    const transactionDate = parseDate(getField(raw, 'TransactionDate'));
    const accountCode = String(getField(raw, 'AccountCode') ?? '').trim();
    const accountName = String(getField(raw, 'AccountName') ?? '').trim();
    const classification = String(getField(raw, 'Classification') ?? '').trim();
    const className = String(getField(raw, 'ClassName') ?? '').trim() || null;

    const debit = parseNumber(getField(raw, 'Debit'));
    const credit = parseNumber(getField(raw, 'Credit'));
    const amountField = getField(raw, 'Amount');
    const amount = amountField !== undefined && amountField !== '' ? parseNumber(amountField) : debit - credit;

    const rowErrors = [];
    if (!transactionDate) rowErrors.push('invalid or missing TransactionDate');
    if (!accountCode) rowErrors.push('missing AccountCode');
    if (!accountName) rowErrors.push('missing AccountName');
    if (!VALID_CLASSIFICATIONS.includes(classification)) {
      rowErrors.push(`Classification must be one of ${VALID_CLASSIFICATIONS.join(', ')}`);
    }
    if (Number.isNaN(debit) || Number.isNaN(credit) || Number.isNaN(amount)) {
      rowErrors.push('Debit/Credit/Amount must be numeric');
    }

    if (rowErrors.length) {
      errors.push({ row: rowNum, errors: rowErrors });
      return;
    }

    accountsByCode.set(accountCode, { accountCode, accountName, classification });

    rows.push({
      transactionDate,
      accountCode,
      accountName,
      debit,
      credit,
      amount,
      transactionType: String(getField(raw, 'TransactionType') ?? '').trim() || null,
      description: String(getField(raw, 'Description') ?? '').trim() || null,
      qboTransactionId: String(getField(raw, 'QBOTransactionId') ?? '').trim() || null,
      className,
    });
  });

  return {
    rows,
    errors,
    accounts: [...accountsByCode.values()],
    totalRows: rawRows.length,
  };
}

module.exports = { parseTransactionFile, VALID_CLASSIFICATIONS };
