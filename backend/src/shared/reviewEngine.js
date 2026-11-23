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
// An entity's keywords/aliases are deliberate; its bare name (e.g. the
// management company's own name in a memo) is a weaker hint that alone
// stays below the default threshold.
const ENTITY_KEYWORD_CONFIDENCE = 0.92;
const ENTITY_NAME_CONFIDENCE = 0.85;
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

// Searchable terms per entity: its keywords, aliases and name. A term
// listed for more than one entity ("LLC") can't tell them apart, so it is
// dropped.
function buildEntityTerms(entities) {
  const owners = new Map();
  const terms = [];
  for (const e of entities) {
    const add = (term, kind) => {
      const t = String(term ?? '').trim();
      if (t.length < MIN_TERM_LENGTH) return;
      const key = t.toLowerCase();
      if (!owners.has(key)) owners.set(key, new Set());
      owners.get(key).add(e.entityId);
      terms.push({ entityId: e.entityId, term: t, key, kind });
    };
    for (const k of e.keywords || []) add(k, 'keyword');
    for (const a of e.aliases || []) add(a, 'alias');
    add(e.entityName, 'name');
  }
  return terms.filter((t) => owners.get(t.key).size === 1);
}

// An entity's terms found in the memo. When one entity's match sits inside
// a longer match for another ("Petr Vaughan DDS" inside "Lebanon Petr
// Vaughan DDS"), the longer one wins. Two entities left means no signal.
function entityKeywordSuggestion(entityTerms, line) {
  if (!line.memo) return null;
  const hits = entityTerms.filter((t) => containsTerm(line.memo, t.term));
  const kept = hits.filter((h) => !hits.some((o) => o.entityId !== h.entityId && o.key.length > h.key.length && o.key.includes(h.key)));
  const entityIds = new Set(kept.map((h) => h.entityId));
  if (entityIds.size !== 1) return null;
  const best = kept.find((h) => h.kind !== 'name') || kept[0];
  return {
    entityId: best.entityId,
    confidence: best.kind === 'name' ? ENTITY_NAME_CONFIDENCE : ENTITY_KEYWORD_CONFIDENCE,
    term: best.term,
  };
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
  const entityTerms = buildEntityTerms(entities);
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

// ---------------------------------------------------------------------
// Account review (files without classes: each dental home's own file).
//
// The question per line is "where does this belong?", with two kinds of
// answer ("outcomes"): an account in this file ('acct:<accountKey>') or
// another entity, through this file's Due To/From account for it
// ('due:<entityId>'). Signals:
//   - History: where this vendor's lines of the same account type went in
//     earlier months (Paul's Keep/Reclassify/DueToFrom decisions count
//     DECISION_WEIGHT times). Keyed by account type so the bank side of a
//     purchase never dilutes the expense side.
//   - Keywords: another entity's keywords/aliases/name in the memo point
//     to Due To/From that entity.
// The stronger signal wins; both strong and different is a Conflict.
// ---------------------------------------------------------------------

const acctOutcome = (key) => `acct:${key}`;
const dueOutcome = (entityId) => `due:${entityId}`;
const DUE_ACCOUNT_RE = /\bdue\s+(to|from)\b/i;

// The entity an intercompany account is for, read from its name ("114003
// Due from Montgomery Pediatric Dentistry" -> Montgomery), or null. Uses
// the same entity terms as memo matching (keywords, aliases, name).
function dueAccountEntity(entityTerms, accountName) {
  if (!accountName || !DUE_ACCOUNT_RE.test(accountName)) return null;
  const hit = entityKeywordSuggestion(entityTerms, { memo: accountName });
  return hit ? hit.entityId : null;
}

// Each other entity's Due To/From account in a file, found by name:
// Map entityId -> { accountKey, code, name }, preferring "Due from"
// (what a practice is owed when it paid for another entity) over "Due to".
// accounts: [{ key, code, name }].
function detectDueToFromAccounts(entities, ownerEntityId, accounts) {
  const terms = buildEntityTerms(entities).filter((t) => t.entityId !== ownerEntityId);
  const found = new Map();
  for (const a of accounts) {
    const entityId = dueAccountEntity(terms, a.name);
    if (!entityId) continue;
    const isFrom = /\bdue\s+from\b/i.test(a.name);
    const prev = found.get(entityId);
    if (!prev || (isFrom && !prev.isFrom)) found.set(entityId, { accountKey: a.key, code: a.code || null, name: a.name, isFrom });
  }
  return new Map([...found].map(([id, { isFrom, ...a }]) => [id, a]));
}

// rows: [{ vendorId, accountType, accountKey, accountCode, accountName,
//          decisionAction, targetAccountKey, targetAccountCode,
//          targetAccountName, counterpartyEntityId, count }]
// Returns { tallies: Map "vendorId|accountType" -> { outcome: weight },
//           labels: Map accountKey -> { code, name } }.
function buildAccountHistory(rows) {
  const tallies = new Map();
  const labels = new Map();
  const label = (key, code, name) => {
    if (key && !labels.has(key)) labels.set(key, { code: code || null, name: name || null });
  };
  for (const r of rows) {
    if (!r.vendorId) continue;
    const tKey = `${r.vendorId}|${r.accountType || 'Unknown'}`;
    if (!tallies.has(tKey)) tallies.set(tKey, {});
    const tally = tallies.get(tKey);
    const n = Number(r.count) || 0;
    label(r.accountKey, r.accountCode, r.accountName);
    if (r.decisionAction === 'Reclassify' && r.targetAccountKey) {
      label(r.targetAccountKey, r.targetAccountCode, r.targetAccountName);
      addWeight(tally, acctOutcome(r.targetAccountKey), n * DECISION_WEIGHT);
    } else if (r.decisionAction === 'DueToFrom' && r.counterpartyEntityId) {
      addWeight(tally, dueOutcome(r.counterpartyEntityId), n * DECISION_WEIGHT);
    } else if (r.decisionAction === 'Keep' && r.accountKey) {
      addWeight(tally, acctOutcome(r.accountKey), n * DECISION_WEIGHT);
    } else if (r.accountKey) {
      addWeight(tally, acctOutcome(r.accountKey), n);
    }
  }
  return { tallies, labels };
}

// Classifies every line of an account review.
//
// input: {
//   lines: [{ lineId, fingerprint, vendorId, payeeName, memo, accountType,
//             accountKey, accountCode, accountName }],
//   entities, ownerEntityId (the entity this file belongs to, or null),
//   dueToFrom: Map counterpartyEntityId -> { accountKey, code, name },
//   history: result of buildAccountHistory, threshold, mediumThreshold,
// }
function classifyAccountLines({
  lines,
  entities,
  ownerEntityId = null,
  dueToFrom = new Map(),
  history = { tallies: new Map(), labels: new Map() },
  threshold = 0.9,
  mediumThreshold = 0.7,
}) {
  const names = new Map(entities.map((e) => [e.entityId, e.entityName]));
  const nameOf = (id) => names.get(id) || 'an unknown entity';
  // The file's own entity is never "another entity".
  const entityTerms = buildEntityTerms(entities).filter((t) => t.entityId !== ownerEntityId);
  const dueByAccount = new Map([...dueToFrom].map(([entityId, a]) => [a.accountKey, entityId]));
  const level = (c) => (c >= threshold ? 'High' : c >= mediumThreshold ? 'Medium' : 'Low');
  const pct = (c) => `${Math.round(c * 100)}%`;
  const accountLabel = (key) => {
    const l = history.labels.get(key);
    return l ? [l.code, l.name].filter(Boolean).join(' ') : key.replace(/^(code|name):/, '');
  };
  const describe = (outcome) =>
    outcome.startsWith('due:') ? `Due To/From ${nameOf(outcome.slice(4))}` : accountLabel(outcome.slice(5));
  // An account that is a Due To/From account (the saved one, or one named
  // "Due to/from <entity>") stands for that entity: being in it, or moving
  // to it, is the same outcome as Due To/From.
  const outcomeOfAccount = (key, name) => {
    if (dueByAccount.has(key)) return dueOutcome(dueByAccount.get(key));
    const entityId = dueAccountEntity(entityTerms, name);
    return entityId ? dueOutcome(entityId) : acctOutcome(key);
  };
  const canonical = new Map();
  const canonicalTally = (tKey) => {
    if (!canonical.has(tKey)) {
      const merged = {};
      for (const [outcome, w] of Object.entries(history.tallies.get(tKey) || {})) {
        const key = outcome.slice(5);
        addWeight(merged, outcome.startsWith('acct:') ? outcomeOfAccount(key, history.labels.get(key)?.name) : outcome, w);
      }
      canonical.set(tKey, merged);
    }
    return canonical.get(tKey);
  };

  return lines.map((line) => {
    const currentOutcome = outcomeOfAccount(line.accountKey, line.accountName);
    const hist = line.vendorId ? scoreTally(canonicalTally(`${line.vendorId}|${line.accountType || 'Unknown'}`)) : null;
    const keywordHit = entityKeywordSuggestion(entityTerms, line);
    const reasons = [];

    const candidates = [];
    if (keywordHit) {
      candidates.push({ outcome: dueOutcome(keywordHit.entityId), confidence: keywordHit.confidence, source: 'Keyword' });
      reasons.push(`Memo mentions "${keywordHit.term}" (${nameOf(keywordHit.entityId)})`);
    }
    if (hist) {
      candidates.push({ outcome: hist.entityId, confidence: hist.confidence, source: 'History' });
      reasons.push(
        `History: ${pct(hist.share)} of ${Math.round(hist.total * 10) / 10} weighted past ` +
          `${line.accountType ? `${line.accountType} ` : ''}lines for this vendor went to ${describe(hist.entityId)}`
      );
    }
    if (!line.vendorId) reasons.push('No payee on this line');
    // Highest confidence wins; a tie goes to the memo keyword.
    const best = candidates.reduce((a, c) => (!a || c.confidence > a.confidence ? c : a), null);

    let status;
    const strong = best && best.confidence >= threshold;
    const strongOthers = candidates.filter((c) => c.confidence >= threshold);
    if (strongOthers.length === 2 && strongOthers[0].outcome !== strongOthers[1].outcome) {
      status = 'Conflict';
      reasons.push(`Conflict: the memo says ${describe(strongOthers[0].outcome)}, history says ${describe(strongOthers[1].outcome)}`);
    } else if (strong && best.outcome === currentOutcome) {
      status = 'Confirmed';
    } else if (strong) {
      status = 'LikelyMisclassified';
    } else {
      status = 'NeedsEvidence';
    }

    let suggestedAction = null;
    let suggestedEntityId = null;
    let suggestedAccount = null;
    if (best) {
      if (best.outcome === currentOutcome) {
        suggestedAction = 'Keep';
      } else if (best.outcome.startsWith('due:')) {
        suggestedAction = 'DueToFrom';
        suggestedEntityId = best.outcome.slice(4);
        const mapped = dueToFrom.get(suggestedEntityId);
        if (mapped) suggestedAccount = { code: mapped.code || null, name: mapped.name };
        else reasons.push(`Set the Due To/From account for ${nameOf(suggestedEntityId)} to approve this`);
      } else {
        suggestedAction = 'Reclassify';
        const l = history.labels.get(best.outcome.slice(5));
        suggestedAccount = { code: l?.code || null, name: l?.name || best.outcome.slice(5).replace(/^(code|name):/, '') };
      }
    }

    return {
      lineId: line.lineId,
      fingerprint: line.fingerprint,
      vendorId: line.vendorId || null,
      currentEntityId: ownerEntityId,
      suggestedEntityId,
      suggestedAction,
      suggestedAccountCode: suggestedAccount?.code || null,
      suggestedAccountName: suggestedAccount?.name || null,
      confidence: best ? Math.round(best.confidence * 10000) / 10000 : 0,
      confidenceLevel: best ? level(best.confidence) : null,
      status,
      source: best ? best.source : 'None',
      reasons,
      ruleId: null,
    };
  });
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
  buildEntityTerms,
  scoreTally,
  buildHistory,
  historySuggestion,
  classifyLines,
  decisionEntity,
  validateAllocations,
  countStatuses,
  buildAccountHistory,
  classifyAccountLines,
  dueAccountEntity,
  detectDueToFromAccounts,
};
