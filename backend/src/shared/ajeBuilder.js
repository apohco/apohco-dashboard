// Controller Phase 5a: turning review decisions into recommended adjusting
// journal entries (AJEs). Pure functions; data access is in ajeData.js.
//
// Every GL line is described by a "state": the postings it makes,
// [{ code, name, className, amount }], amounts signed (debit +, credit -)
// and summing to the line's own amount (a Due To/From mirror sums to 0).
//
//   from  where the books have the line now: the latest entry already
//         published for it, else the GL itself
//   to    where Paul's latest decision puts it
//
// The entry is to - from, netted by account and class, so a line that is
// already where the decision says (or was already covered by a published
// entry) produces nothing, and an undone decision reverses its entry.
const crypto = require('crypto');
const { accountKey } = require('./accountKey');

const KINDS = ['ClassMove', 'Reclassify', 'DueToFrom', 'DueToFromMirror', 'Reversal'];
const KIND_LABELS = {
  ClassMove: 'Class change',
  Reclassify: 'Reclassify',
  DueToFrom: 'Due To/From',
  DueToFromMirror: 'Due To/From (other side)',
  Reversal: 'Reversal of an earlier entry',
};
const CLASS_ACTIONS = ['Approve', 'Keep', 'Reassign', 'Split'];
const GROUPINGS = ['Grouped', 'PerLine'];
const QBO_NUM_MAX = 21;

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const normClass = (c) => String(c || '').trim().toLowerCase();
const postingKey = (p) => `${accountKey(p.code || null, p.name || '')}|${normClass(p.className)}`;
const accountLabel = (code, name) => [code, name].filter(Boolean).join(' ');

// The line's signed amount: debit +, credit -.
const signedAmount = (line) => round2((Number(line.debit) || 0) - (Number(line.credit) || 0));

function glState(line) {
  return [{ code: line.accountCode || null, name: line.accountName || '', className: line.className || null, amount: signedAmount(line) }];
}

// Merge postings by account and class; drops zeros.
function netPostings(postings) {
  const byKey = new Map();
  for (const p of postings) {
    const key = postingKey(p);
    const cur = byKey.get(key) || { code: p.code || null, name: p.name || '', className: p.className || null, amount: 0 };
    cur.amount = round2(cur.amount + Number(p.amount || 0));
    byKey.set(key, cur);
  }
  return [...byKey.values()].filter((p) => Math.abs(p.amount) >= 0.005);
}

// to - from, netted: [{ code, name, className, amount }].
function diffStates(to, from) {
  return netPostings([...to, ...from.map((p) => ({ ...p, amount: -Number(p.amount || 0) }))]);
}

const sameState = (a, b) => diffStates(a, b).length === 0;

// Does a decision ask for an entry? Undo clears; a relabel of an earlier
// month only when Paul ticked "request AJE".
function activeDecision(decision) {
  if (!decision || decision.action === 'Undo') return null;
  return decision;
}
const relabelWithoutAje = (decision) => Boolean(decision && decision.scope === 'Relabel' && decision.requestAje === false);

// The class a posting for `entityId` uses in a class-based file: the line's
// own class when that already resolves to the entity (so aliases and
// sub-classes don't create spurious moves), else the entity's linked class.
function classFor(entityId, line, ctx, issues) {
  if (ctx.resolve && ctx.resolve(line.className, line.qboClassId) === entityId) return line.className || null;
  const entity = ctx.entitiesById.get(entityId);
  if (!entity) {
    issues.push('The decision names an entity that is no longer active');
    return null;
  }
  if (!entity.managementClassName) {
    issues.push(`${entity.entityName} has no QuickBooks class linked in this file (set it in Entities)`);
    return null;
  }
  return entity.managementClassName;
}

// Where the decision puts the line: { state, issues }.
//   ctx: { isClassBased, entitiesById, resolve }
function targetState(line, decision, ctx) {
  const d = activeDecision(decision);
  if (!d) return { state: glState(line), issues: [] };
  const issues = [];
  const amount = signedAmount(line);
  let code = line.accountCode || null;
  let name = line.accountName || '';
  if ((d.action === 'Reclassify' || d.action === 'DueToFrom') && d.targetAccount && d.targetAccount.name) {
    code = d.targetAccount.code || null;
    name = d.targetAccount.name;
  }
  if (ctx.isClassBased && CLASS_ACTIONS.includes(d.action)) {
    if (d.action === 'Split' && Array.isArray(d.allocations) && d.allocations.length) {
      const sign = amount < 0 ? -1 : 1;
      const parts = d.allocations.map((a) => ({ code, name, className: classFor(a.entityId, line, ctx, issues), amount: round2(sign * Math.abs(Number(a.amount) || 0)) }));
      // Any rounding difference stays on the largest part, so the entry balances.
      const diff = round2(amount - parts.reduce((s, p) => s + p.amount, 0));
      if (diff && parts.length) {
        const big = parts.reduce((m, p) => (Math.abs(p.amount) > Math.abs(m.amount) ? p : m), parts[0]);
        big.amount = round2(big.amount + diff);
      }
      return { state: parts, issues };
    }
    if (d.entityId) return { state: [{ code, name, className: classFor(d.entityId, line, ctx, issues), amount }], issues };
  }
  return { state: [{ code, name, className: line.className || null, amount }], issues };
}

function kindFor(decision) {
  const d = activeDecision(decision);
  if (!d) return 'Reversal';
  if (d.action === 'Reclassify') return 'Reclassify';
  if (d.action === 'DueToFrom') return 'DueToFrom';
  return 'ClassMove';
}

// One line of the report's own file: a change, or null when there is
// nothing to book.
//   line: { fingerprint, lineId, txnDate, txnType, docNum, payeeName, payeeKey, vendorName, memo,
//           accountCode, accountName, className, qboClassId, debit, credit, qboId }
//   decision: latest decision ({ decisionId, action, entityId, allocations, targetAccount,
//             counterpartyEntityId, scope, requestAje }) or null
//   prior: ToState of the latest entry in force for the line, or null
function lineChange(line, decision, prior, ctx) {
  if (relabelWithoutAje(decision)) return null;
  const from = prior || glState(line);
  const { state: to, issues } = targetState(line, decision, ctx);
  const lines = diffStates(to, from);
  if (!lines.length) return null;
  const warnings = [];
  const d = activeDecision(decision);
  if (d && d.action === 'DueToFrom' && ctx.mirrorNote) warnings.push(ctx.mirrorNote(d.counterpartyEntityId));
  return {
    side: 'Own',
    kind: kindFor(decision),
    line,
    decisionId: decision ? decision.decisionId || null : null,
    from,
    to,
    lines,
    issues,
    warnings: warnings.filter(Boolean),
  };
}

// The other entity's side of a Due To/From decision made in another file,
// booked in the report's file (the counterparty's own file):
//   Dr the line's account / Cr "Due To <the deciding file's entity>".
//   mirror: { dueAccount: { code, name } | null, issues: [], warnings: [] }
function mirrorChange(line, decision, prior, mirror) {
  const d = activeDecision(decision);
  const isMirror = Boolean(d && d.action === 'DueToFrom');
  const from = prior || [];
  const issues = isMirror ? [...(mirror.issues || [])] : [];
  let to = [];
  if (isMirror) {
    const amount = signedAmount(line);
    to = [{ code: line.accountCode || null, name: line.accountName || '', className: null, amount }];
    if (mirror.dueAccount) to.push({ code: mirror.dueAccount.code || null, name: mirror.dueAccount.name, className: null, amount: -amount });
  }
  const lines = isMirror && !mirror.dueAccount ? [] : diffStates(to, from);
  if (!lines.length && !(isMirror && !mirror.dueAccount && !prior)) return null;
  return {
    side: 'Mirror',
    kind: isMirror ? 'DueToFromMirror' : 'Reversal',
    line,
    decisionId: decision ? decision.decisionId || null : null,
    from,
    to,
    lines,
    issues,
    warnings: isMirror ? [...(mirror.warnings || [])] : [],
  };
}

// ---- Grouping into entries

const stateLabel = (state, kind) => {
  if (!state.length) return 'nothing';
  if (kind === 'ClassMove') return [...new Set(state.map((p) => p.className || 'no class'))].join(' / ');
  return [...new Set(state.map((p) => accountLabel(p.code, p.name)))].join(' / ');
};

// The account/class pattern of a change: what a grouped entry shares.
const signature = (lines) => lines.map((p) => `${postingKey(p)}:${p.amount > 0 ? 'D' : 'C'}`).sort().join(',');

function keyOf(parts) {
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 20);
}

function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
}

// The memo body (without the entry number, which publishing prepends).
function defaultMemo(entry) {
  const n = entry.sources.length;
  const dates = entry.sources.map((s) => s.line.txnDate).filter(Boolean).sort();
  const when = dates.length ? (dates[0] === dates[dates.length - 1] ? formatDate(dates[0]) : `${formatDate(dates[0])}-${formatDate(dates[dates.length - 1])}`) : '';
  const vendor = entry.vendor || 'No payee';
  const first = entry.sources[0];
  const what = `${n} transaction${n === 1 ? '' : 's'}${when ? ` ${when}` : ''}`;
  if (entry.kind === 'DueToFromMirror') {
    const due = first.to.find((p) => p.amount * signedAmount(first.line) < 0);
    return `${KIND_LABELS[entry.kind]}: ${vendor}, ${what}, paid by the other entity; record to ${accountLabel(first.line.accountCode, first.line.accountName)} against ${due ? accountLabel(due.code, due.name) : 'Due To'}. Controller review.`;
  }
  const kindForLabel = entry.kind === 'Reversal' ? 'Reclassify' : entry.kind;
  return `${KIND_LABELS[entry.kind]}: ${vendor}, ${what}, from ${stateLabel(first.from, kindForLabel)} to ${stateLabel(first.to, kindForLabel)}. Controller review.`;
}

const KIND_ORDER = Object.fromEntries(KINDS.map((k, i) => [k, i]));

// changes -> draft entries, in report order.
//   grouping: 'Grouped' (same kind, vendor and account/class pattern become
//   one entry) or 'PerLine'
function groupChanges(changes, grouping = 'Grouped') {
  const groups = new Map();
  for (const c of changes) {
    const vendorKey = c.line.vendorKey || c.line.payeeKey || '';
    const gkey = grouping === 'PerLine'
      ? `${c.side}|${c.line.sourceQboId || ''}|${c.line.fingerprint}`
      : `${c.kind}|${vendorKey}|${signature(c.lines)}|${c.issues.length ? 'issue' : 'ok'}`;
    if (!groups.has(gkey)) groups.set(gkey, []);
    groups.get(gkey).push(c);
  }
  const entries = [];
  for (const members of groups.values()) {
    members.sort((a, b) => String(a.line.txnDate).localeCompare(String(b.line.txnDate)) || String(a.line.fingerprint).localeCompare(String(b.line.fingerprint)));
    const lines = netPostings(members.flatMap((m) => m.lines));
    const first = members[0];
    const entry = {
      kind: first.kind,
      kindLabel: KIND_LABELS[first.kind],
      vendor: first.line.vendorName || first.line.payeeName || null,
      lines: lines
        .map((p) => ({ accountCode: p.code, accountName: p.name, className: p.className, debit: p.amount > 0 ? p.amount : 0, credit: p.amount < 0 ? -p.amount : 0 }))
        .sort((a, b) => b.debit - a.debit || a.credit - b.credit),
      amount: round2(lines.filter((p) => p.amount > 0).reduce((s, p) => s + p.amount, 0)),
      issues: [...new Set(members.flatMap((m) => m.issues))],
      warnings: [...new Set(members.flatMap((m) => m.warnings))],
      sources: members,
    };
    entry.key = keyOf([
      entry.kind,
      ...members.map((m) => `${m.side}|${m.line.sourceQboId || ''}|${m.line.fingerprint}|${m.decisionId || ''}|${JSON.stringify(netPostings(m.from))}|${JSON.stringify(netPostings(m.to))}`).sort(),
    ]);
    entry.memo = defaultMemo(entry);
    entries.push(entry);
  }
  return entries.sort(
    (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || String(a.vendor || '~').localeCompare(String(b.vendor || '~')) || b.amount - a.amount || a.key.localeCompare(b.key)
  );
}

// ---- Numbering

const yyyymm = (month) => month.replace('-', '');
const pad = (n, w) => String(n).padStart(w, '0');

// MGMT-2026-10-AJE-001
const reportNumber = (fileCode, month, seq) => `${fileCode}-${month}-AJE-${pad(seq, 3)}`;
// MGMT-2026-10-AJE-001.03
const entryNumber = (repNumber, seq) => `${repNumber}.${pad(seq, 2)}`;
// The Num to type in QuickBooks (its journal entry number holds at most 21
// characters): MGMT-2610-AJE001.03
const qboNum = (fileCode, month, seq, entrySeq) => `${fileCode}-${yyyymm(month).slice(2)}-AJE${pad(seq, 3)}.${pad(entrySeq, 2)}`;
const qboReportNum = (fileCode, month, seq) => `${fileCode}-${yyyymm(month).slice(2)}-AJE${pad(seq, 3)}`;

const FILE_CODE_RE = /^[A-Z][A-Z0-9]{1,5}$/;

// A starting code for a file: MGMT for a class-based (management) file,
// else the initials of its entity or file name (Westside Pediatric
// Dentistry -> WPD), made unique against `taken`.
function suggestFileCode({ isClassBased, name }, taken = new Set()) {
  let base;
  if (isClassBased) base = 'MGMT';
  else {
    const words = String(name || '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean)
      .filter((w) => !['THE', 'OF', 'AND', 'LLC', 'INC', 'PC', 'PLLC', 'QBO'].includes(w));
    base = words.length >= 2 ? words.map((w) => w[0]).join('') : (words[0] || 'FILE').slice(0, 4);
    base = base.replace(/^[0-9]+/, '').slice(0, 6);
    if (base.length < 2) base = `${base}${(words[0] || 'FILE').slice(1)}`.slice(0, 4) || 'FILE';
    if (!FILE_CODE_RE.test(base)) base = 'FILE';
  }
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${base.slice(0, 6 - String(i).length)}${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return base;
}

// ---- Posted-check

// Uppercase letters, digits and dots only, so "MGMT-2026-10-AJE-001.03",
// "MGMT 2610 AJE001.03" and "mgmt202610aje001.03" all compare equal.
const normalizeRef = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9.]+/g, '');

// The report-level forms a GL line may carry: full and QBO-short.
function reportTokens(report) {
  const month = report.month;
  return [normalizeRef(reportNumber(report.fileCode, month, report.seq)), normalizeRef(qboReportNum(report.fileCode, month, report.seq))];
}

// Which entries of `reports` a GL line's Num / memo refers to.
//   reports: [{ reportId, fileCode, month, seq, entries: [{ entryId, seq }] }]
//   -> [{ entryId, matchedOn: 'Entry' | 'Report' }]
function matchPosting(texts, reports) {
  const out = new Map();
  for (const text of texts) {
    const norm = normalizeRef(text);
    if (!norm.includes('AJE')) continue;
    for (const report of reports) {
      for (const token of reportTokens(report)) {
        let at = norm.indexOf(token);
        while (at !== -1) {
          const rest = norm.slice(at + token.length);
          const m = rest.match(/^\.(\d{2,3})(?!\d)/);
          if (m) {
            const entry = report.entries.find((e) => e.seq === Number(m[1]));
            if (entry) out.set(entry.entryId, 'Entry');
          } else if (!/^\d/.test(rest)) {
            for (const e of report.entries) if (!out.has(e.entryId)) out.set(e.entryId, 'Report');
          }
          at = norm.indexOf(token, at + 1);
        }
      }
    }
  }
  return [...out].map(([entryId, matchedOn]) => ({ entryId, matchedOn }));
}

module.exports = {
  KINDS,
  KIND_LABELS,
  GROUPINGS,
  QBO_NUM_MAX,
  FILE_CODE_RE,
  round2,
  signedAmount,
  glState,
  netPostings,
  diffStates,
  sameState,
  targetState,
  lineChange,
  mirrorChange,
  groupChanges,
  defaultMemo,
  reportNumber,
  entryNumber,
  qboNum,
  qboReportNum,
  suggestFileCode,
  normalizeRef,
  matchPosting,
  postingKey,
};
