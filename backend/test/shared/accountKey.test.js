const { accountKey } = require('../../src/shared/accountKey');

test('accounts are keyed by number, else by lowercased name', () => {
  expect(accountKey('6100', 'Supplies')).toBe('code:6100');
  expect(accountKey(null, 'Office Supplies')).toBe('name:office supplies');
  expect(accountKey('', 'Due From Lebanon')).toBe('name:due from lebanon');
});

test('the review function does not load the spreadsheet parser', () => {
  const src = require('fs').readFileSync(require.resolve('../../src/functions/controller/ctrlReview'), 'utf8');
  expect(src).not.toMatch(/require\([^)]*(glUploadParser|fileParser)/);
});
