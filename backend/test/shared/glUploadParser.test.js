const XLSX = require('xlsx');
const { readRowArrays } = require('../../src/shared/fileParser');
const {
  findHeaderRow,
  detectMapping,
  cleanMapping,
  splitAccountLabel,
  suggestClassification,
  parseGlDate,
  parseGlRows,
} = require('../../src/shared/glUploadParser');

const csvRows = (text) => readRowArrays(Buffer.from(text, 'utf8'), 'csv');

const KNOWN = {
  'code:6100': 'Expense',
  'code:4000': 'Revenue',
  'code:1000': 'Asset',
  'code:2000': 'Liability',
};

// QuickBooks' current General Ledger export: a title block, then a header
// row, then one line per row with the account repeated on each.
const QBO_EXPORT = [
  'APOHCO Management LLC,,,,,,,,,',
  'General Ledger,,,,,,,,,',
  'October 2026,,,,,,,,,',
  ',,,,,,,,,',
  'Distribution account,Transaction date,Transaction type,Num,Name,Description,Split,Amount,Balance,Class',
  '6100 Supplies,10/03/2026,Expense,1001,Kroger,Breakroom,1000 Checking,42.10,42.10,Lebanon',
  '1000 Checking,10/03/2026,Expense,1001,Kroger,Breakroom,6100 Supplies,-42.10,-42.10,Lebanon',
  '4000 Fees,10/05/2026,Deposit,,Patient,Collections,1000 Checking,500.00,500.00,',
  '1000 Checking,10/05/2026,Deposit,,Patient,Collections,4000 Fees,500.00,457.90,',
  'Total for 1000 Checking,,,,,,,457.90,,',
  ',,,,,,,,,',
  '"Accrual Basis Monday, November 2, 2026 09:15 AM GMT-05:00",,,,,,,,,',
].join('\n');

describe('header detection and mapping', () => {
  test('skips the title block and maps every column of a QuickBooks export', () => {
    const rows = csvRows(QBO_EXPORT);
    expect(findHeaderRow(rows)).toBe(4);
    const mapping = detectMapping(rows[4]);
    expect(mapping).toMatchObject({
      account: 0, txnDate: 1, txnType: 2, docNum: 3, name: 4, description: 5, split: 6, amount: 7, class: 9,
      debit: null, credit: null, accountCode: null,
    });
  });

  test('maps columns by name whatever their order or wording', () => {
    const headers = ['Amt', 'Memo', 'Payee', 'Class Name', 'Date', 'Type', 'Offset Account', 'Account'];
    expect(detectMapping(headers)).toMatchObject({
      amount: 0, description: 1, name: 2, class: 3, txnDate: 4, txnType: 5, split: 6, account: 7,
    });
  });

  test('accepts headers that start with a known name, but not look-alikes', () => {
    const mapping = detectMapping(['Transaction Date (MM/DD/YYYY)', 'Account Type', 'Distribution Account', 'Amount']);
    expect(mapping.txnDate).toBe(0);
    expect(mapping.account).toBe(2);
    expect(Object.values(mapping)).not.toContain(1);
  });

  test('a separate account number column is recognized', () => {
    expect(detectMapping(['Account #', 'Account', 'Date', 'Debit', 'Credit'])).toMatchObject({
      accountCode: 0, account: 1, txnDate: 2, debit: 3, credit: 4,
    });
  });

  test('cleanMapping rejects unknown fields, bad columns and a column used twice', () => {
    expect(() => cleanMapping({ nope: 1 }, 5)).toThrow(/Unknown field/);
    expect(() => cleanMapping({ amount: 9 }, 5)).toThrow(/out of range/);
    expect(() => cleanMapping({ amount: 1, debit: 1 }, 5)).toThrow(/two fields/);
    expect(cleanMapping({ amount: '2', class: '' }, 5)).toMatchObject({ amount: 2, class: null, account: null });
  });
});

describe('value helpers', () => {
  test('splitAccountLabel and suggestClassification', () => {
    expect(splitAccountLabel('400001 Management Fee Income')).toEqual({ code: '400001', name: 'Management Fee Income' });
    expect(splitAccountLabel('Accounts Payable (A/P)')).toEqual({ code: null, name: 'Accounts Payable (A/P)' });
    expect(['1000', '2100', '3000', '4000', '6100', 'x'].map(suggestClassification)).toEqual([
      'Asset', 'Liability', 'Equity', 'Revenue', 'Expense', null,
    ]);
  });

  test('parseGlDate reads spreadsheet date styles and rejects impossible dates', () => {
    expect(parseGlDate('10/03/2026')).toBe('2026-10-03');
    expect(parseGlDate('1/15/26')).toBe('2026-01-15');
    expect(parseGlDate('Jan 5, 2026')).toBe('2026-01-05');
    expect(parseGlDate('2026-03-04T00:00:00')).toBe('2026-03-04');
    expect(parseGlDate('2/30/2026')).toBeNull();
    expect(parseGlDate('Beginning Balance')).toBeNull();
  });
});

describe('parseGlRows', () => {
  test('turns a QuickBooks export into uniform, balanced lines', () => {
    const classIds = new Map([['Lebanon', 'class-leb']]);
    const result = parseGlRows(csvRows(QBO_EXPORT), { knownClassifications: KNOWN, classIds });

    expect(result.problems).toEqual([]);
    expect(result.errorCount).toBe(0);
    expect(result.lines).toHaveLength(4);
    expect(result.lines[0]).toEqual({
      sourceRow: 6,
      txnDate: '2026-10-03',
      txnType: 'Expense',
      docNum: '1001',
      qboTxnId: null,
      payeeName: 'Kroger',
      payeeQBOId: null,
      memo: 'Breakroom',
      splitAccount: '1000 Checking',
      accountCode: '6100',
      accountName: 'Supplies',
      className: 'Lebanon',
      qboClassId: 'class-leb',
      debit: 42.1,
      credit: 0,
      amount: 42.1,
    });
    // Natural sign: a negative Amount on an asset is a credit; a positive
    // Amount on revenue is a credit too.
    expect(result.lines.map((l) => [l.accountCode, l.debit, l.credit])).toEqual([
      ['6100', 42.1, 0],
      ['1000', 0, 42.1],
      ['4000', 0, 500],
      ['1000', 500, 0],
    ]);
    expect(result.totals).toEqual({ debit: 542.1, credit: 542.1, difference: 0 });
    expect(result.months).toEqual([{ month: '2026-10', lineCount: 4 }]);
    // The total and footer rows are skipped without being errors.
    expect(result.skippedRows).toBe(2);
  });

  test('debit-positive convention ignores account classification', () => {
    const rows = csvRows('Date,Account,Amount\n10/01/2026,4000 Fees,-500\n10/01/2026,9999 Unknown,25\n');
    const result = parseGlRows(rows, { amountConvention: 'debitPositive' });
    expect(result.unknownAccounts).toEqual([]);
    expect(result.lines.map((l) => [l.debit, l.credit, l.amount])).toEqual([[0, 500, -500], [25, 0, 25]]);
  });

  test('accounts with no known classification are held back until classified', () => {
    const rows = csvRows('Date,Account,Amount\n10/01/2026,2500 Loan,300\n10/02/2026,2500 Loan,-50\n10/02/2026,6100 Supplies,5\n');
    const first = parseGlRows(rows, { knownClassifications: KNOWN });
    expect(first.lines).toHaveLength(1);
    expect(first.unknownAccounts).toEqual([
      { accountKey: 'code:2500', accountCode: '2500', accountName: 'Loan', lineCount: 2, suggested: 'Liability' },
    ]);

    const second = parseGlRows(rows, { knownClassifications: KNOWN, classifications: { 'code:2500': 'Liability' } });
    expect(second.unknownAccounts).toEqual([]);
    expect(second.lines.filter((l) => l.accountCode === '2500').map((l) => [l.debit, l.credit])).toEqual([
      [0, 300],
      [50, 0],
    ]);
  });

  test('Debit and Credit columns are used as-is when present', () => {
    const rows = csvRows('Credit,Debit,Account,Date,Amount\n,10.00,6100 Supplies,10/01/2026,999\n7.5,,2000 AP,10/01/2026,\n');
    const result = parseGlRows(rows);
    expect(result.unknownAccounts).toEqual([]);
    expect(result.lines.map((l) => [l.accountCode, l.debit, l.credit])).toEqual([
      ['6100', 10, 0],
      ['2000', 0, 7.5],
    ]);
  });

  test('classic layout: account heading rows supply the account for the lines below them', () => {
    const rows = csvRows(
      [
        ',Date,Transaction Type,Num,Name,Memo/Description,Split,Amount,Balance',
        '1000 Checking (1000),,,,,,,,',
        ',,Beginning Balance,,,,,,1000.00',
        ',10/03/2026,Check,55,Kroger,Breakroom,6100 Supplies,-42.10,957.90',
        'Total for 1000 Checking,,,,,,,-42.10,',
        '6100 Supplies,,,,,,,,',
        ',10/03/2026,Check,55,Kroger,Breakroom,1000 Checking,42.10,42.10',
      ].join('\n')
    );
    const result = parseGlRows(rows, { knownClassifications: KNOWN });
    expect(result.headerRow).toBe(0);
    expect(result.mapping.account).toBeNull();
    expect(result.problems).toEqual([]);
    expect(result.lines.map((l) => [l.accountCode, l.accountName, l.splitAccount, l.debit, l.credit])).toEqual([
      ['1000', 'Checking', '6100 Supplies', 0, 42.1],
      ['6100', 'Supplies', '1000 Checking', 42.1, 0],
    ]);
    expect(result.skippedRows).toBe(2);
  });

  test('reports bad rows with their spreadsheet row number and keeps the rest', () => {
    const rows = csvRows('Date,Account,Amount\n13/45/2026,6100 Supplies,1\n10/01/2026,6100 Supplies,abc\n10/01/2026,,5\n10/02/2026,6100 Supplies,\n10/03/2026,6100 Supplies,2\n');
    const result = parseGlRows(rows, { knownClassifications: KNOWN });
    expect(result.errors).toEqual([
      { row: 2, errors: ['"13/45/2026" isn\'t a date'] },
      { row: 3, errors: ['Amount "abc" isn\'t a number'] },
      { row: 4, errors: ['no account'] },
      { row: 5, errors: ['no amount'] },
    ]);
    expect(result.lines).toHaveLength(1);
  });

  test('says what is missing when required columns cannot be found', () => {
    const result = parseGlRows(csvRows('Foo,Bar\n1,2\n'));
    expect(result.problems).toEqual([
      'Map a column to Transaction date.',
      'Map a column to Amount (or to Debit and Credit).',
    ]);
    expect(result.lines).toEqual([]);
  });

  test('falls back to the column that holds dates when no header says "date"', () => {
    const rows = csvRows('Posted On,Account,Amount\n10/01/2026,6100 Supplies,1\n10/02/2026,6100 Supplies,2\n10/03/2026,6100 Supplies,3\n');
    const result = parseGlRows(rows, { knownClassifications: KNOWN });
    expect(result.mapping.txnDate).toBe(0);
    expect(result.lines).toHaveLength(3);
  });

  test('a caller-supplied mapping overrides detection', () => {
    const rows = csvRows('A,B,C\n10/01/2026,6100 Supplies,5\n');
    const result = parseGlRows(rows, { headerRow: 0, mapping: { txnDate: 0, account: 1, amount: 2 }, knownClassifications: KNOWN });
    expect(result.detected).toBe(false);
    expect(result.lines[0]).toMatchObject({ txnDate: '2026-10-01', accountCode: '6100', debit: 5 });
  });

  test('rejects a bad amount convention or header row', () => {
    const rows = csvRows('Date,Account,Amount\n');
    expect(() => parseGlRows(rows, { amountConvention: 'sideways' })).toThrow(/amountConvention/);
    expect(() => parseGlRows(rows, { headerRow: 7 })).toThrow(/Header row/);
  });

  test('reads .xlsx files with the same row numbering as the sheet', () => {
    const sheet = XLSX.utils.aoa_to_sheet([
      ['Company'],
      [],
      ['Transaction date', 'Distribution account', 'Amount'],
      ['10/01/2026', '6100 Supplies', '12.50'],
    ]);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, 'GL');
    const buffer = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
    const result = parseGlRows(readRowArrays(buffer, 'xlsx'), { knownClassifications: KNOWN });
    expect(result.headerRow).toBe(2);
    expect(result.lines[0]).toMatchObject({ sourceRow: 4, txnDate: '2026-10-01', debit: 12.5 });
  });
});
