// The Controller's Phase 2 classification engine: rules + history, no AI.
//
// For every line of the month under review it works out which entity
// (dental home) the line belongs to, how sure it is, why, and a status:
//
//   Unclassified         the line has no class
//   Confirmed            the line's class agrees with a strong suggestion
//   LikelyMisclassified  the line's class disagrees with a strong suggestion
//   Conflict             a vendor rule and strong history disagree
//   NeedsEvidence        nothing strong enough either way
//
// Signals, in priority order (spec: "Classification engine"):
//   1. Rules: a vendor's keyword hints (memo/payee text -> entity), then the
//      vendor's default entity.
//   2. Keywords: an entity's own aliases/keywords found in the memo.
//   3. History: how this vendor's lines were classed in earlier months,
//      with Paul's decisions counting DECISION_WEIGHT times a plain line.
//
// Everything here is pure (no database), so it is fully unit-tested; the
// ctrlReview function loads the inputs and stores the output.

const RULE_KEYWORD_CONFIDENCE = 0.97;
const RULE_DEFAULT_CONFIDENCE = 0.95;
const ENTITY_KEYWORD_CONFIDENCE = 0.92;
const DECISION_WEIGHT = 3;
// History for the vendor + account is preferred once it has this much
// weight; below that the vendor's history across all accounts is used.
const MIN_ACCOUNT_HISTORY = 3;
const MIN_TERM_LENGTH = 3;

const STATUSES = ['Unclassified', 'Confirmed', 'LikelyMisclassified', 'Conflict', 'NeedsEvidence'];

// Normalized payee name used to match payees to vendor profiles:
// lowercase, punctuation dropped, spaces collapsed.
function payeeKey(name) {
  const key = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return key || null;
}

const norm = (s) => String(s ?? '').trim().toLowerCase();
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Whole-word, case-insensitive match of `term` in `text`.
function containsTerm(text, term) {
  const t = String(term ?? '').trim();
  if (t.length < MIN_TERM_LENGTH || !text) return false;
  return new RegExp(`(^|[^a-z0-9])${escapeRegex(t.toLowerCase())}($|[^a-z0-9])`).test(String(text).toLowerCase());
}

// Maps a line's class name to an entity: the entity's linked management
// class (by id or name), its name, or any alias. QuickBooks sub-classes
// ("Region:Lebanon") also match on their last segment.
function buildEntityResolver(entities) {
  const byClassId = new Map();
  const byName = new Map();
  const add = (name, id) => {
    const key = norm(name);
    if (key && !byName.has(key)) byName.set(key, id);
  };
  for (const e of entities) {
    if (e.managementQboClassId) byClassId.set(e.managementQboClassId, e.entityId);
  }
  // Linked class names first, so they win over a coincidental alias.
  for (const e of entities) add(e.managementClassName, e.entityId);
  for (const e of entities) add(e.entityName, e.entityId);
  for (const e of entities) for (const a of e.aliases || []) add(a, e.entityId);

  return function resolve(className, qboClassId) {
    if (qboClassId && byClassId.has(qboClassId)) return byClassId.get(qboClassId);
    const key = norm(className);
    if (!key) return null;
    if (byName.has(key)) return byName.get(key);
    const last = key.split(':').pop().trim();
    return byName.get(last) || null;
  };
}

// Confidence from a weighted tally ({ entityId: weight }): the top
// entity's share, scaled down when there is little history
// (n / (n + 1): 1 example -> 50%, 9 -> 90%, 19 -> 95%).
function scoreTally(tally) {
  const entries = Object.entries(tally || {}).filter(([, w]) => w > 0);
  if (!entries.length) return null;
  entries.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const total = entries.reduce((s, [, w]) => s + w, 0);
  const [entityId, top] = entries[0];
  const confidence = (top / total) * (total / (total + 1));
  return { entityId, confidence, share: top / total, total };
}

function addWeight(tally, entityId, weight) {
  if (!entityId || !(weight > 0)) return;
  tally[entityId] = (tally[entityId] || 0) + weight;
}

// Turns grouped history rows into per-vendor tallies.
// rows: [{ vendorId, accountCode, entityId, decisionAction, decisionEntityId,
//          allocations, count }] -- entityId is the class's entity (resolved
//          by the caller); the decision fields are the latest decision on
//          those lines, if any.
function buildHistory(rows) {
  const history = new Map();
  for (const r of rows) {
    if (!r.vendorId) continue;
    if (!history.has(r.vendorId)) history.set(r.vendorId, { overall: {}, byAccount: new Map() });
    const h = history.get(r.vendorId);
    const accountKey = r.accountCode || '';
    if (!h.byAccount.has(accountKey)) h.byAccount.set(accountKey, {});
    const tallies = [h.overall, h.byAccount.get(accountKey)];
    const n = Number(r.count) || 0;

    if (r.decisionAction === 'Split' && Array.isArray(r.allocations)) {
      const total = r.allocations.reduce((s, a) => s + Math.abs(Number(a.amount) || 0), 0);
      for (const a of r.allocations) {
        const share = total ? Math.abs(Number(a.amount) || 0) / total : 0;
        for (const t of tallies) addWeight(t, a.entityId, n * DECISION_WEIGHT * share);
      }
    } else if (r.decisionAction && r.decisionAction !== 'Undo' && r.decisionEntityId) {
      for (const t of tallies) addWeight(t, r.decisionEntityId, n * DECISION_WEIGHT);
    } else {
      for (const t of tallies) addWeight(t, r.entityId, n);
    }
  }
  return history;
}

function historySuggestion(history, vendorId, accountCode) {
  const h = vendorId ? history.get(vendorId) : null;
  if (!h) return null;
  const byAccount = scoreTally(h.byAccount.get(accountCode || ''));
  if (byAccount && byAccount.total >= MIN_ACCOUNT_HISTORY) return { ...byAccount, scope: 'account' };
  const overall = scoreTally(h.overall);
  return overall ? { ...overall, scope: 'vendor' } : null;
}

// The rule signal for one line, or null.
function ruleSuggestion(rule, line) {
  if (!rule) return null;
  const text = `${line.memo || ''} ${line.payeeName || ''}`;
  const hits = new Set(
    (rule.hints?.keywords || []).filter((k) => k.entityId && containsTerm(text, k.keyword)).map((k) => k.entityId)
  );
  if (hits.size === 1) {
    const entityId = [...hits][0];
    const keyword = rule.hints.keywords.find((k) => k.entityId === entityId && containsTerm(text, k.keyword)).keyword;
    return { entityId, confidence: RULE_KEYWORD_CONFIDENCE, kind: 'keyword', keyword };
  }
  if (rule.defaultEntityId) return { entityId: rule.defaultEntityId, confidence: RULE_DEFAULT_CONFIDENCE, kind: 'default' };
  return null;
}

// An entity's own aliases/keywords in the memo. Ambiguous (two entities)
// means no signal.
function entityKeywordSuggestion(entityTerms, line) {
  if (!line.memo) return null;
  const hits = new Map();
  for (const { entityId, term } of entityTerms) {
    if (!hits.has(entityId) && containsTerm(line.memo, term)) hits.set(entityId, term);
  }
  if (hits.size !== 1) return null;
  const [[entityId, term]] = [...hits];
  return { entityId, confidence: ENTITY_KEYWORD_CONFIDENCE, term };
}

// Classifies every line.
//
// input: {
//   lines: [{ lineId, fingerprint, vendorId, payeeName, memo, accountCode,
//             className, qboClassId }],
//   entities: [{ entityId, entityName, managementQboClassId,
//                managementClassName, aliases, keywords }],
//   rules: Map vendorId -> { ruleId, version, defaultEntityId, hints },
//   history: result of buildHistory,
//   threshold, mediumThreshold,
// }
// Returns one result per line, in the same order.
function classifyLines({ lines, entities, rules = new Map(), history = new Map(), threshold = 0.9, mediumThreshold = 0.7 }) {
  const resolve = buildEntityResolver(entities);
  const names = new Map(entities.map((e) => [e.entityId, e.entityName]));
  const nameOf = (id) => names.get(id) || 'an unknown entity';
  const entityTerms = entities.flatMap((e) =>
    [e.entityName, ...(e.aliases || []), ...(e.keywords || [])].filter(Boolean).map((term) => ({ entityId: e.entityId, term }))
  );
  const level = (c) => (c >= threshold ? 'High' : c >= mediumThreshold ? 'Medium' : 'Low');
  const pct = (c) => `${Math.round(c * 100)}%`;

  return lines.map((line) => {
    const currentEntityId = resolve(line.className, line.qboClassId);
    const rule = line.vendorId ? rules.get(line.vendorId) : null;
    const ruleHit = ruleSuggestion(rule, line);
    const keywordHit = ruleHit ? null : entityKeywordSuggestion(entityTerms, line);
    const hist = historySuggestion(history, line.vendorId, line.accountCode);
    const reasons = [];

    let suggestion = null;
    let source = 'None';
    if (ruleHit) {
      suggestion = ruleHit;
      source = 'Rule';
      reasons.push(
        ruleHit.kind === 'keyword'
          ? `Rule v${rule.version}: "${ruleHit.keyword}" means ${nameOf(ruleHit.entityId)}`
          : `Rule v${rule.version}: this vendor defaults to ${nameOf(ruleHit.entityId)}`
      );
    } else if (keywordHit) {
      suggestion = keywordHit;
      source = 'Keyword';
      reasons.push(`Memo mentions "${keywordHit.term}" (${nameOf(keywordHit.entityId)})`);
    } else if (hist) {
      suggestion = hist;
      source = 'History';
    }
    if (hist) {
      reasons.push(
        `History: ${pct(hist.share)} of ${Math.round(hist.total * 10) / 10} weighted past lines for this vendor` +
          `${hist.scope === 'account' ? ' and account' : ''} went to ${nameOf(hist.entityId)}`
      );
    }
    if (line.className && !currentEntityId) reasons.push(`Class "${line.className}" isn't linked to an entity`);
    if (!line.vendorId) reasons.push('No payee on this line');

    const confidence = suggestion ? suggestion.confidence : 0;
    const strong = confidence >= threshold;
    let status;
    if (ruleHit && hist && hist.entityId !== ruleHit.entityId && hist.confidence >= threshold) {
      status = 'Conflict';
      reasons.push(`Conflict: the rule says ${nameOf(ruleHit.entityId)}, history says ${nameOf(hist.entityId)}`);
    } else if (!line.className) {
      status = 'Unclassified';
    } else if (strong && currentEntityId === suggestion.entityId) {
      status = 'Confirmed';
    } else if (strong) {
      status = 'LikelyMisclassified';
    } else {
      status = 'NeedsEvidence';
    }

    return {
      lineId: line.lineId,
      fingerprint: line.fingerprint,
      vendorId: line.vendorId || null,
      currentEntityId,
      suggestedEntityId: suggestion ? suggestion.entityId : null,
      confidence: Math.round(confidence * 10000) / 10000,
      confidenceLevel: suggestion ? level(confidence) : null,
      status,
      source,
      reasons,
      ruleId: source === 'Rule' ? rule.ruleId : null,
    };
  });
}

// The entity a bulk/one-line decision assigns, or null when it can't
// apply to this line (nothing to approve or keep).
function decisionEntity(action, suggestion, entityId) {
  if (action === 'Approve') return suggestion.suggestedEntityId || suggestion.currentEntityId || null;
  if (action === 'Keep') return suggestion.currentEntityId || null;
  if (action === 'Reassign') return entityId || null;
  return null;
}

// Checks a split: at least two different entities, positive amounts, and a
// total equal (to the cent) to the line's amount.
function validateAllocations(allocations, lineAmount, validEntityIds) {
  if (!Array.isArray(allocations) || allocations.length < 2) return 'A split needs at least two entities';
  const seen = new Set();
  let total = 0;
  for (const a of allocations) {
    if (!a || !validEntityIds.has(a.entityId)) return 'Each split line needs an entity from this Group';
    if (seen.has(a.entityId)) return 'Each entity can appear once in a split';
    seen.add(a.entityId);
    const cents = Math.round(Number(a.amount) * 100);
    if (!Number.isFinite(cents) || cents <= 0) return 'Split amounts must be more than zero';
    total += cents;
  }
  const target = Math.round(Math.abs(Number(lineAmount)) * 100);
  if (total !== target) return `Split amounts must add up to ${(target / 100).toFixed(2)} (they add up to ${(total / 100).toFixed(2)})`;
  return null;
}

function countStatuses(results) {
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const r of results) counts[r.status] += 1;
  return counts;
}

module.exports = {
  STATUSES,
  DECISION_WEIGHT,
  payeeKey,
  containsTerm,
  buildEntityResolver,
  scoreTally,
  buildHistory,
  historySuggestion,
  classifyLines,
  decisionEntity,
  validateAllocations,
  countStatuses,
};
