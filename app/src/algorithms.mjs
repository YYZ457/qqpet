import {ensure, refKey, time, uniqueRefs} from './contracts.mjs';

export function accessibility(traces, at, {tau, decay}) {
  time(at);
  ensure(Number.isFinite(tau) && tau > 0 && Number.isFinite(decay) && decay > 0,
    'INVALID_INPUT', 'positive finite tau and decay required');
  const unique = new Map();
  for (const trace of traces) {
    time(trace.at);
    ensure(trace.at <= at, 'FUTURE_TRACE', 'cannot evaluate before an existing use');
    ensure(typeof trace.encounterId === 'string' && trace.encounterId, 'INVALID_INPUT', 'trace needs encounterId');
    const old = unique.get(trace.encounterId);
    ensure(!old || old.at === trace.at, 'TRACE_CONFLICT', 'same encounter has inconsistent timestamps');
    unique.set(trace.encounterId, trace);
  }
  const mass = [...unique.values()].reduce((sum, trace) => sum + (1 + (at - trace.at) / tau) ** -decay, 0);
  return {mass, activation: Math.log1p(mass), traces: unique.size};
}

// Max-product walk scores nominate candidates; they are NOT probabilities or evidence votes.
export function associate({seeds, edges, decay, maxDepth, maxExpansions, minScore = 0}) {
  ensure(Number.isFinite(decay) && decay > 0 && decay < 1, 'INVALID_INPUT', 'decay must be in (0,1)');
  ensure(Number.isInteger(maxDepth) && maxDepth >= 0 && maxDepth <= 32, 'INVALID_INPUT', 'maxDepth must be 0..32');
  ensure(Number.isInteger(maxExpansions) && maxExpansions >= 0, 'INVALID_INPUT', 'invalid computation budget');
  ensure(Number.isFinite(minScore) && minScore >= 0 && minScore <= 1, 'INVALID_INPUT', 'invalid minimum score');
  ensure(Array.isArray(seeds) && Array.isArray(edges), 'INVALID_INPUT', 'seeds and edges must be arrays');
  const refs = new Map(), initial = new Map(), outgoing = new Map();
  for (const seed of seeds) {
    const [ref] = uniqueRefs([seed.ref]); const key = refKey(ref);
    ensure(Number.isFinite(seed.score) && seed.score > 0 && seed.score <= 1, 'INVALID_INPUT', 'seed score must be in (0,1]');
    refs.set(key, ref); initial.set(key, Math.max(initial.get(key) ?? 0, seed.score));
  }
  const add = (from, to, edge) => {
    const fk = refKey(from), tk = refKey(to);
    if (fk === tk) return;
    refs.set(fk, from); refs.set(tk, to);
    const neighbors = outgoing.get(fk) ?? new Map();
    const old = neighbors.get(tk);
    // Related+similar labels between the same endpoints also cannot multiply a vote.
    if (!old || edge.strength > old.weight || edge.strength === old.weight && edge.id < old.id) {
      neighbors.set(tk, {weight: edge.strength, id: edge.id});
    }
    outgoing.set(fk, neighbors);
  };
  for (const edge of edges) {
    if (!['related', 'similar'].includes(edge.relation)) continue;
    ensure(typeof edge.id === 'string', 'INVALID_INPUT', 'edge needs id');
    ensure(Number.isFinite(edge.strength) && edge.strength > 0 && edge.strength <= 1, 'INVALID_INPUT', 'invalid edge strength');
    ensure(['forward', 'both'].includes(edge.direction), 'INVALID_INPUT', 'invalid direction');
    const [from, to] = uniqueRefs([edge.from, edge.to]);
    ensure(to, 'INVALID_INPUT', 'self links are invalid');
    add(from, to, edge); if (edge.direction === 'both') add(to, from, edge);
  }
  const transitions = new Map();
  for (const [key, neighbors] of outgoing) {
    const denominator = Math.max(1, [...neighbors.values()].reduce((sum, edge) => sum + edge.weight, 0));
    transitions.set(key, [...neighbors].sort(([a],[b]) => a.localeCompare(b)).map(([to, edge]) => ({to, factor: edge.weight / denominator, edgeId: edge.id})));
  }
  const total = [...initial.values()].reduce((sum, score) => sum + score, 0);
  let layer = new Map([...initial].map(([key, score]) => [key, {score: score / total, path: [], depth: 0}]));
  const best = new Map(layer); let expansions = 0, truncated = false;
  outer: for (let depth = 1; depth <= maxDepth; depth++) {
    const next = new Map();
    for (const [key, state] of [...layer].sort(([a],[b]) => a.localeCompare(b))) {
      for (const transition of transitions.get(key) ?? []) {
        if (expansions >= maxExpansions) { truncated = true; break outer; }
        expansions++;
        const score = state.score * decay * transition.factor;
        if (score < minScore || score === 0) continue;
        const candidate = {score, depth, path: [...state.path, transition.edgeId]};
        if (score > (next.get(transition.to)?.score ?? 0)) next.set(transition.to, candidate);
        if (score > (best.get(transition.to)?.score ?? 0)) best.set(transition.to, candidate);
      }
    }
    layer = next; if (layer.size === 0) break;
  }
  const items = [...best].map(([key, value]) => ({ref: refs.get(key), ...value, seed: initial.has(key)}));
  items.sort((a,b) => b.score - a.score || refKey(a.ref).localeCompare(refKey(b.ref)));
  return {items, expansions, truncated, method: 'bounded-max-product', semantics: 'candidate-score-only'};
}
