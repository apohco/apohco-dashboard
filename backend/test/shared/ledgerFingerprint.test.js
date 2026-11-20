const { fingerprintLines, contentHash, snapshotHash } = require('../../src/shared/ledgerFingerprint');

const base = {
  txnDate: '2026-10-03',
  txnType: 'Expense',
  docNum: '1001',
  qboTxnId: '901',
  payeeName: 'Kroger',
  memo: 'Break room',
  accountCode: '6100',
  accountName: 'Supplies',
  className: null,
  debit: 42.1,
  credit: 0,
};

describe('fingerprintLines', () => {
  test('adds a 64-char fingerprint and content hash to every line', () => {
    const [line] = fingerprintLines('qbo-1', [base]);
    expect(line.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(line.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(line.payeeName).toBe('Kroger');
  });

  test('is stable regardless of the order QBO returns lines in', () => {
    const lines = [base, { ...base, accountCode: '1000', accountName: 'Checking', debit: 0, credit: 42.1 }];
    const a = fingerprintLines('qbo-1', lines).map((l) => l.fingerprint);
    const b = fingerprintLines('qbo-1', [...lines].reverse()).map((l) => l.fingerprint).reverse();
    expect(a).toEqual(b);
  });

  test('an edited amount, memo or class keeps the identity but changes the content hash', () => {
    const [before] = fingerprintLines('qbo-1', [base]);
    for (const edit of [{ debit: 50 }, { memo: 'Snacks' }, { className: 'Lebanon' }, { payeeName: 'Kroger #12' }]) {
      const [after] = fingerprintLines('qbo-1', [{ ...base, ...edit }]);
      expect(after.fingerprint).toBe(before.fingerprint);
      expect(after.contentHash).not.toBe(before.contentHash);
    }
  });

  test('two identical lines in one transaction get distinct fingerprints', () => {
    const lines = fingerprintLines('qbo-1', [base, { ...base }]);
    expect(lines[0].fingerprint).not.toBe(lines[1].fingerprint);
    expect(lines[0].contentHash).toBe(lines[1].contentHash);
  });

  test('the same line in a different QBO file is a different line', () => {
    const [a] = fingerprintLines('qbo-1', [base]);
    const [b] = fingerprintLines('qbo-2', [base]);
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  test('a different account or transaction is a different line', () => {
    const [a] = fingerprintLines('qbo-1', [base]);
    const [b] = fingerprintLines('qbo-1', [{ ...base, accountCode: '6200' }]);
    const [c] = fingerprintLines('qbo-1', [{ ...base, qboTxnId: '777' }]);
    expect(new Set([a.fingerprint, b.fingerprint, c.fingerprint]).size).toBe(3);
  });

  test('without a QBO transaction id, falls back to date + doc number', () => {
    const noId = { ...base, qboTxnId: null };
    const [a] = fingerprintLines('qbo-1', [noId]);
    const [sameAgain] = fingerprintLines('qbo-1', [{ ...noId, debit: 99 }]);
    const [otherDate] = fingerprintLines('qbo-1', [{ ...noId, txnDate: '2026-10-04' }]);
    expect(sameAgain.fingerprint).toBe(a.fingerprint);
    expect(otherDate.fingerprint).not.toBe(a.fingerprint);
  });

  test('accounts without a code are told apart by name', () => {
    const lines = fingerprintLines('qbo-1', [
      { ...base, accountCode: null, accountName: 'Checking' },
      { ...base, accountCode: null, accountName: 'Savings' },
    ]);
    expect(lines[0].fingerprint).not.toBe(lines[1].fingerprint);
  });
});

describe('contentHash', () => {
  test('treats null, undefined and blank text the same, and normalises amounts', () => {
    expect(contentHash({ ...base, memo: null })).toBe(contentHash({ ...base, memo: undefined }));
    expect(contentHash({ ...base, memo: '' })).toBe(contentHash({ ...base, memo: '  ' }));
    expect(contentHash({ ...base, debit: 42.1 })).toBe(contentHash({ ...base, debit: '42.10' }));
  });
});

describe('snapshotHash', () => {
  test('does not depend on line order but does change with content', () => {
    const lines = fingerprintLines('qbo-1', [base, { ...base, qboTxnId: '902', debit: 5 }]);
    expect(snapshotHash(lines)).toBe(snapshotHash([...lines].reverse()));
    const edited = fingerprintLines('qbo-1', [base, { ...base, qboTxnId: '902', debit: 6 }]);
    expect(snapshotHash(edited)).not.toBe(snapshotHash(lines));
  });

  test('an empty month has a stable hash', () => {
    expect(snapshotHash([])).toMatch(/^[0-9a-f]{64}$/);
  });
});
