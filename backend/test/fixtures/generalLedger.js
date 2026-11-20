// A small QBO GeneralLedger report in the shape the Reports API returns:
// one Section per account, transaction rows inside, ids on report cells.

const COLUMNS = ['tx_date', 'txn_type', 'doc_num', 'name', 'memo', 'klass_name', 'debt_amt', 'credit_amt'];

function dataRow({ date, type, txnId, doc = '', payee = '', payeeId, memo = '', klass = '', debit = '', credit = '' }) {
  return {
    type: 'Data',
    ColData: [
      { value: date },
      { value: type, ...(txnId ? { id: txnId } : {}) },
      { value: doc },
      { value: payee, ...(payeeId ? { id: payeeId } : {}) },
      { value: memo },
      { value: klass },
      { value: debit },
      { value: credit },
    ],
  };
}

const generalLedgerReport = {
  Header: { ReportName: 'GeneralLedger', StartPeriod: '2026-10-01', EndPeriod: '2026-10-31' },
  Columns: { Column: COLUMNS.map((ColType) => ({ ColType })) },
  Rows: {
    Row: [
      {
        type: 'Section',
        Header: { ColData: [{ value: '6100 Supplies', id: '61' }] },
        Rows: {
          Row: [
            // Opening balance row: a label, not a date, in the date column. Callers must keep only real dates.
            { type: 'Data', ColData: [{ value: 'Beginning Balance' }, { value: '' }, { value: '' }, { value: '' }, { value: '' }, { value: '' }, { value: '' }, { value: '' }] },
            dataRow({ date: '2026-10-03', type: 'Expense', txnId: '901', doc: '1001', payee: 'Kroger', payeeId: '55', memo: 'Break room', debit: '42.10' }),
            dataRow({ date: '2026-10-05', type: 'Bill', txnId: '902', payee: 'Amazon', payeeId: '56', memo: 'Gloves', klass: 'Lebanon', debit: '100.00' }),
          ],
        },
        Summary: { ColData: [{ value: 'Total for 6100 Supplies' }] },
      },
      {
        type: 'Section',
        Header: { ColData: [{ value: 'Checking', id: '35' }] },
        Rows: {
          Row: [
            dataRow({ date: '2026-10-03', type: 'Expense', txnId: '901', doc: '1001', payee: 'Kroger', payeeId: '55', memo: 'Break room', credit: '42.10' }),
          ],
        },
      },
    ],
  },
};

const accounts = [
  { Id: '61', AcctNum: '6100', Name: 'Supplies', Classification: 'Expense' },
  { Id: '35', Name: 'Checking', Classification: 'Asset' },
];

module.exports = { generalLedgerReport, accounts };
