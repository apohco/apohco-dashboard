// Controller Phase 4: the pure parts of evidence matching (no network, no
// database). ctrlEvidence / ctrlEvidenceWorker fetch from Gmail and store.
//
//   amountFormats       the ways an amount is written in invoices/emails
//   vendorTerms         names to look for (vendor display name + aliases)
//   buildGmailQueries   targeted Gmail searches for one line
//   extractMessage      subject / sender / date / text / attachments of a
//                       Gmail API message
//   scoreCandidate      how well a candidate matches the line, and which
//                       practice it names (entity hint)
const { buildEntityTerms, containsTerm } = require('./reviewEngine');

const DAYS_WINDOW = 10;
const MAX_TEXT = 20000;
const MAX_SNIPPET = 300;
const MIN_TERM = 3;
// Words that say nothing about the vendor ("Inc", "LLC", "{C}"...).
const NOISE = /\b(inc|llc|ltd|co|corp|company|the|pc|pllc|dds|dmd)\b\.?|\{[a-z]\}|[^a-z0-9&' ]+/gi;

const WEIGHTS = { amount: 0.45, vendor: 0.25, dateNear: 0.15, dateWindow: 0.08, entity: 0.15 };

// 1250 -> ['1,250.00', '1250.00', '1,250', '1250']; 42.1 -> ['42.10'].
function amountFormats(amount) {
  const n = Math.abs(Number(amount) || 0);
  if (!n) return [];
  const fixed = n.toFixed(2);
  const withCommas = Number(fixed).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const out = [withCommas, fixed];
  if (Number.isInteger(n)) out.push(withCommas.slice(0, -3), fixed.slice(0, -3));
  return [...new Set(out)];
}

// Vendor names worth searching for: the display name and payee aliases,
// without legal suffixes and punctuation; at least 3 characters.
function vendorTerms(names) {
  const seen = new Set();
  const out = [];
  for (const raw of names || []) {
    const t = String(raw || '').replace(NOISE, ' ').replace(/\s+/g, ' ').trim();
    if (t.length < MIN_TERM || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out.slice(0, 5);
}

const gmailDate = (d) => `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
const quote = (s) => `"${String(s).replace(/"/g, '')}"`;

// Two targeted searches within ±10 days of the line: by amount (the most
// specific), and by vendor name / known sender. No vendor: amount only.
function buildGmailQueries({ txnDate, amount, vendorNames = [], senders = [] }) {
  const d = new Date(`${txnDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return [];
  const after = new Date(d.getTime() - DAYS_WINDOW * 86400000);
  const before = new Date(d.getTime() + (DAYS_WINDOW + 1) * 86400000);
  const window = `after:${gmailDate(after)} before:${gmailDate(before)}`;
  const queries = [];
  const amounts = amountFormats(amount);
  if (amounts.length) queries.push(`(${amounts.map(quote).join(' OR ')}) ${window}`);
  const terms = [...vendorTerms(vendorNames).map(quote), ...senders.slice(0, 5).map((s) => `from:${s}`)];
  if (terms.length) queries.push(`(${terms.join(' OR ')}) ${window}`);
  return queries;
}

const decode = (data) => (data ? Buffer.from(data, 'base64url').toString('utf8') : '');

function stripHtml(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

// A Gmail API message (format 'full' or 'metadata') as plain fields. The
// body is plain text (HTML stripped), never HTML.
function extractMessage(msg) {
  const headers = new Map((msg?.payload?.headers || []).map((h) => [h.name.toLowerCase(), h.value]));
  let plain = '';
  let html = '';
  const attachments = [];
  const walk = (part) => {
    if (!part) return;
    if (part.filename) attachments.push({ name: part.filename, mimeType: part.mimeType, size: part.body?.size || 0, attachmentId: part.body?.attachmentId || null });
    else if (part.mimeType === 'text/plain' && !plain) plain = decode(part.body?.data);
    else if (part.mimeType === 'text/html' && !html) html = decode(part.body?.data);
    (part.parts || []).forEach(walk);
  };
  walk(msg?.payload);
  const text = (plain || stripHtml(html)).slice(0, MAX_TEXT);
  const dateHeader = headers.get('date');
  const sentAt = msg?.internalDate ? new Date(Number(msg.internalDate)) : dateHeader ? new Date(dateHeader) : null;
  return {
    id: msg?.id,
    threadId: msg?.threadId,
    subject: headers.get('subject') || '',
    from: headers.get('from') || '',
    to: headers.get('to') || '',
    sentAt: sentAt && !Number.isNaN(sentAt.getTime()) ? sentAt.toISOString() : null,
    snippet: (msg?.snippet || '').slice(0, MAX_SNIPPET),
    text,
    attachments,
  };
}

// How well a candidate matches the line.
//   line: { txnDate, amount }; vendorNames: names/aliases; entities: loadEntities rows
//   candidate: { subject, from, text, snippet, sentAt, attachments }
// Returns { score, signals: { amount, vendor, days, entityTerm }, entityHintId }.
function scoreCandidate({ line, vendorNames = [], entities = [], candidate }) {
  const haystack = [candidate.subject, candidate.from, candidate.snippet, candidate.text, ...(candidate.attachments || []).map((a) => a.name)]
    .filter(Boolean)
    .join('\n');
  const lower = haystack.toLowerCase();
  const amount = amountFormats(line.amount).some((f) => lower.includes(f.toLowerCase()));
  const vendor = vendorTerms(vendorNames).some((t) => containsTerm(haystack, t));
  let days = null;
  if (candidate.sentAt && line.txnDate) {
    days = Math.round(Math.abs(new Date(candidate.sentAt) - new Date(`${line.txnDate}T00:00:00Z`)) / 86400000);
  }
  // The practice it names: one entity's terms only (two = no hint).
  const hits = buildEntityTerms(entities).filter((t) => containsTerm(haystack, t.term));
  const ids = new Set(hits.map((h) => h.entityId));
  const hit = ids.size === 1 ? hits.find((h) => h.kind !== 'name') || hits[0] : null;

  let score = 0;
  if (amount) score += WEIGHTS.amount;
  if (vendor) score += WEIGHTS.vendor;
  if (days !== null && days <= 3) score += WEIGHTS.dateNear;
  else if (days !== null && days <= DAYS_WINDOW) score += WEIGHTS.dateWindow;
  if (hit) score += WEIGHTS.entity;
  return {
    score: Math.round(Math.min(1, score) * 10000) / 10000,
    signals: { amount, vendor, days, entityTerm: hit ? hit.term : null },
    entityHintId: hit ? hit.entityId : null,
  };
}

module.exports = { DAYS_WINDOW, WEIGHTS, amountFormats, vendorTerms, buildGmailQueries, stripHtml, extractMessage, scoreCandidate };
