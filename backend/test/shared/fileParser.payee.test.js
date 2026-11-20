const { parseTransactionFile } = require('../../src/shared/fileParser');

const csv = (text) => Buffer.from(text, 'utf8');

describe('parseTransactionFile payee capture', () => {
  test('reads the payee from QBO export "Name" column', () => {
    const { rows, errors } = parseTransactionFile(
      csv('TransactionDate,Account,Name,Debit,Credit,Classification\n2026-10-03,6100 Supplies,Kroger,42.10,,Expense\n'),
      'csv'
    );
    expect(errors).toEqual([]);
    expect(rows[0].payeeName).toBe('Kroger');
  });

  test('also accepts PayeeName / Payee headers', () => {
    for (const header of ['PayeeName', 'Payee']) {
      const { rows } = parseTransactionFile(
        csv(`TransactionDate,Account,${header},Debit,Classification\n2026-10-03,6100 Supplies,Amazon,5,Expense\n`),
        'csv'
      );
      expect(rows[0].payeeName).toBe('Amazon');
    }
  });

  test('payee is optional', () => {
    const { rows } = parseTransactionFile(
      csv('TransactionDate,Account,Debit,Classification\n2026-10-03,6100 Supplies,5,Expense\n'),
      'csv'
    );
    expect(rows[0].payeeName).toBeNull();
  });
});
