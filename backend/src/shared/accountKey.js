// How the Controller identifies an account within one QBO file: its number
// when it has one ('code:6100'), else its name ('name:office supplies').
// Used as the key of CtrlUploads.AccountClassifications and by the review.
// Kept in its own module so the review function doesn't load the
// spreadsheet parser.
const accountKey = (code, name) => (code ? `code:${code}` : `name:${String(name || '').toLowerCase()}`);

module.exports = { accountKey };
