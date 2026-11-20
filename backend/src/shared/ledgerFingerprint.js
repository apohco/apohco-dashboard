const crypto = require('crypto');

// The GeneralLedger report has no line IDs, so the Controller derives two
// hashes per line:
//
//   identity (Fingerprint): which line this is. Built from the QBO file,
//   QBO's transaction id, transaction type, account, and the line's
//   occurrence index among otherwise-identical lines of the same
//   transaction. Deliberately excludes amount, memo, payee and class, so a
//   line edited in QBO (an AJE posted, a class fixed) keeps its identity
//   and shows up as "changed" rather than as one removed line plus one new
//   one.
//
//   content (ContentHash): what the line currently says. Date, doc number,
//   payee, memo, account name, class, debit and credit. Comparing content
//   hashes for the same fingerprint across two snapshots shows what changed.
//
// When QBO gives no transaction id for a row, the identity falls back to
// date + doc number, which is weaker (an edited date then looks like a new
// line), but still stable across unchanged re-pulls.

const SEP = '\u001f'; // unit separator: can't appear in QBO text fields

function sha256(parts) {
  return crypto.createHash('sha256').update(parts.join(SEP)).digest('hex');
}

const text = (v) => (v === null || v === undefined ? '' : String(v).trim());
const money = (v) => (Number(v) || 0).toFixed(2);

function identityBase(qboId, line) {
  const txnKey = line.qboTxnId ? `id:${line.qboTxnId}` : `nodoc:${text(line.txnDate)}|${text(line.docNum)}`;
  return [text(qboId), txnKey, text(line.txnType), text(line.accountCode) || `name:${text(line.accountName)}`];
}

function contentHash(line) {
  return sha256([
    text(line.txnDate),
    text(line.docNum),
    text(line.payeeName),
    text(line.memo),
    text(line.accountName),
    text(line.className),
    money(line.debit),
    money(line.credit),
  ]);
}

// Adds `fingerprint` and `contentHash` to every line (returns new objects).
// Lines sharing an identity base are numbered in a deterministic order
// (by content) so the same set of lines always gets the same fingerprints,
// whatever order QBO returned them in.
function fingerprintLines(qboId, lines) {
  const withContent = lines.map((line) => ({ line, base: identityBase(qboId, line), content: contentHash(line) }));

  const groups = new Map();
  for (const item of withContent) {
    const key = item.base.join(SEP);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  for (const items of groups.values()) {
    items.sort((a, b) => (a.content < b.content ? -1 : a.content > b.content ? 1 : 0));
    items.forEach((item, occurrence) => {
      item.fingerprint = sha256([...item.base, String(occurrence)]);
    });
  }

  return withContent.map(({ line, fingerprint, content }) => ({ ...line, fingerprint, contentHash: content }));
}

// One hash for a whole snapshot, independent of line order, so two pulls
// of the same month can be compared in one step.
function snapshotHash(fingerprintedLines) {
  const parts = fingerprintedLines.map((l) => `${l.fingerprint}:${l.contentHash}`).sort();
  return sha256(parts);
}

module.exports = { fingerprintLines, contentHash, snapshotHash };
