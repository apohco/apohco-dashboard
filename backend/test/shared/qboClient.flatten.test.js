const { flattenGeneralLedgerReport, buildAccountLookup } = require('../../src/shared/qboClient');
const { generalLedgerReport, accounts } = require('../fixtures/generalLedger');

describe('flattenGeneralLedgerReport', () => {
  const rows = flattenGeneralLedgerReport(generalLedgerReport, buildAccountLookup(accounts));
  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
  const dated = rows.filter((r) => isDate(r.transactionDate));

  test('returns one row per transaction line, inside its account section', () => {
    expect(dated).toHaveLength(3);
    expect(dated.map((r) => r.accountCode)).toEqual(['6100', '6100', '35']);
  });

  test('captures the payee name and its QBO id', () => {
    expect(dated[0].payeeName).toBe('Kroger');
    expect(dated[0].payeeQBOId).toBe('55');
    expect(dated[1].payeeName).toBe('Amazon');
  });

  test('captures the real QBO transaction id separately from the doc number', () => {
    expect(dated[0].qboTxnId).toBe('901');
    expect(dated[0].docNum).toBe('1001');
    // Existing dashboard field keeps its meaning (doc number).
    expect(dated[0].qboTransactionId).toBe('1001');
    expect(dated[1].docNum).toBeNull();
  });

  test('computes signed amounts and reads the class', () => {
    expect(dated[0]).toMatchObject({ debit: 42.1, credit: 0, amount: 42.1, className: null });
    expect(dated[1].className).toBe('Lebanon');
    expect(dated[2]).toMatchObject({ debit: 0, credit: 42.1, amount: -42.1 });
  });

  test('passes the opening balance label through, so callers must check for a real date', () => {
    expect(rows.length - dated.length).toBe(1);
  });

  test('a blank payee comes back as null', () => {
    const report = JSON.parse(JSON.stringify(generalLedgerReport));
    report.Rows.Row[1].Rows.Row[0].ColData[3] = { value: '' };
    const out = flattenGeneralLedgerReport(report, buildAccountLookup(accounts)).filter((r) => isDate(r.transactionDate));
    expect(out[2].payeeName).toBeNull();
    expect(out[2].payeeQBOId).toBeNull();
  });
});
