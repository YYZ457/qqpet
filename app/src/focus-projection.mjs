// Production pure projection, derived from the frozen focus reference. No I/O or model calls.
import {canonical, ensure, text} from './contracts.mjs';

const copy = x => JSON.parse(canonical(x));
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const sorted = (xs, key = canonical) => [...xs].sort((a, b) => cmp(key(a), key(b)));
const equal = (a, b) => canonical(a) === canonical(b);
const enumValue = (x, choices, name) => ensure(choices.includes(x), 'FOCUS_SHAPE', `invalid ${name}`);
const positive = x => ensure(Number.isSafeInteger(x) && x > 0, 'FOCUS_SHAPE', 'positive revision required');
const array = x => ensure(Array.isArray(x), 'FOCUS_SHAPE', 'array required');
function fields(x, names) {
  ensure(x && Object.getPrototypeOf(x) === Object.prototype && equal(Object.keys(x).sort(), [...names].sort()),
    'FOCUS_SHAPE', `expected fields: ${names.join(', ')}`);
}
const anchorKinds = ['process', 'question', 'state', 'thought', 'conversation'];
const purposes = ['active-task', 'affects-current-choice', 'awaiting-reply', 'self-directed', 'recovery-point'];
function identity(x) {
  fields(x, ['kind', 'id', 'epoch']); enumValue(x.kind, anchorKinds, 'anchor kind');
  text(x.id, 'anchor id'); text(x.epoch, 'identity epoch'); return copy(x);
}
const idOf = x => ({kind: x.kind, id: x.id, epoch: x.epoch});
const identityKey = x => canonical([x.kind, x.id, x.epoch]);
const headKey = x => canonical([x.kind, x.id]);
const versionOf = x => ({...idOf(x), revision: x.revision});
const versionKey = x => canonical([x.kind, x.id, x.epoch, x.revision]);
function anchorVersion(x) {
  fields(x, ['kind', 'id', 'epoch', 'revision']); identity(idOf(x)); positive(x.revision); return copy(x);
}
function anchor(x) {
  fields(x, ['kind', 'id', 'epoch', 'revision', 'world', 'lifecycle', 'label']);
  anchorVersion(versionOf(x)); enumValue(x.world, ['actual', 'possible'], 'world');
  enumValue(x.lifecycle, ['open', 'paused', 'ended'], 'lifecycle'); text(x.label, 'label'); return copy(x);
}
export const materialKey = x => canonical([x.kind, x.id, x.revision]);
function materialRef(x) {
  fields(x, ['kind', 'id', 'revision']); enumValue(x.kind, ['event', 'note', 'state'], 'material kind');
  text(x.id, 'material id'); positive(x.revision); return copy(x);
}
function refs(xs) {
  array(xs); return sorted(new Map(xs.map(x => {const r = materialRef(x); return [materialKey(r), r];})).values(), materialKey);
}
const edgeKey = x => canonical([x.id, x.revision]);
function edgeRef(x) {fields(x, ['id', 'revision']); text(x.id, 'edge id'); positive(x.revision); return copy(x);}
function path(xs) {
  array(xs); const p = xs.map(edgeRef);
  ensure(new Set(p.map(edgeKey)).size === p.length, 'FOCUS_PATH', 'path repeats an edge'); return p;
}
const prefix = (p, q) => p.length <= q.length && p.every((r, i) => equal(r, q[i]));
const byteCost = x => Buffer.byteLength(canonical(x), 'utf8');
export function entryEligibleReason(reason) {
  enumValue(reason, ['released','consumer-stale','consumer-ended','owner-stale','owner-ended','use-parked',
    'consumer-paused','owner-paused','entry-preference','off-focus','context-mismatch','selected'], 'projection reason');
  return !['released','consumer-stale','consumer-ended','owner-stale','owner-ended','selected'].includes(reason);
}

// Compiling isolates a canonical input copy. Maps remain inaccessible to callers.
export function createFocusProjector(raw, {policy = 'pinned'} = {}) {
  enumValue(policy, ['pinned', 'identity'], 'structural policy');
  fields(raw, ['anchors', 'history', 'edges', 'materials', 'continuity']);
  const input = copy(raw);
  for (const x of Object.values(input)) array(x);
  const heads = new Map(), versions = new Map(), worlds = new Map();
  function remember(a) {
    const k = versionKey(a), previous = versions.get(k);
    ensure(!previous || equal(previous, a), 'FOCUS_VERSION_REWRITE', 'one version has conflicting contents');
    const i = identityKey(a);
    ensure(!worlds.has(i) || worlds.get(i) === a.world, 'FOCUS_WORLD', 'one identity epoch cannot change world');
    worlds.set(i, a.world); versions.set(k, a);
  }
  for (const a of input.history.map(anchor)) remember(a);
  for (const a of input.anchors.map(anchor)) {
    ensure(!heads.has(headKey(a)), 'FOCUS_DUPLICATE', 'one current head per typed anchor id');
    remember(a); heads.set(headKey(a), a);
  }
  for (const v of versions.values()) {
    const h = heads.get(headKey(v));
    ensure(!h || identityKey(h) !== identityKey(v) || v.revision <= h.revision,
      'FOCUS_HEAD', 'current head is older than a supplied same-epoch version');
  }
  const current = r => {
    const h = heads.get(headKey(r)); return h && identityKey(h) === identityKey(r) ? h : null;
  };
  const knownIdentity = r => worlds.has(identityKey(r));
  const edges = new Map(), effective = new Map(), edgeDiagnostics = [];
  const parents = new Map();
  for (const e of input.edges) {
    fields(e, ['id', 'revision', 'child', 'parent', 'status']); edgeRef({id: e.id, revision: e.revision});
    ensure(!edges.has(e.id), 'FOCUS_DUPLICATE', 'one current declaration per edge id');
    anchorVersion(e.child); anchorVersion(e.parent); enumValue(e.status, ['active', 'retired'], 'edge status');
    ensure(e.child.kind === 'process' && e.parent.kind === 'process' && headKey(e.child) !== headKey(e.parent),
      'FOCUS_EDGE', 'containment connects distinct process identities');
    const oldChild = versions.get(versionKey(e.child)), oldParent = versions.get(versionKey(e.parent));
    ensure(oldChild && oldParent, 'FOCUS_EVIDENCE_MISSING', 'structural declaration needs its exact endpoint witnesses');
    ensure(oldChild.world === oldParent.world, 'FOCUS_WORLD', 'containment cannot mix actual and possible');
    const c = current(e.child), p = current(e.parent);
    const changed = c && p && (!equal(versionOf(c), e.child) || !equal(versionOf(p), e.parent));
    const reason = e.status === 'retired' ? 'retired' : !c || !p ? 'identity-changed' :
      policy === 'pinned' && changed ? 'version-changed' : changed ? 'identity-continuity' : 'exact';
    const usable = ['exact', 'identity-continuity'].includes(reason);
    edges.set(e.id, e); edgeDiagnostics.push({edge: {id: e.id, revision: e.revision}, usable, reason,
      witnesses: {child: copy(e.child), parent: copy(e.parent)},
      current: {child: c ? versionOf(c) : null, parent: p ? versionOf(p) : null}});
    if (usable) {
      effective.set(edgeKey(e), e);
      const k = identityKey(e.child); if (!parents.has(k)) parents.set(k, []);
      parents.get(k).push(identityKey(e.parent));
    }
  }
  // Kahn's test on effective child -> parent edges, including disconnected components.
  const nodes = new Set(), incoming = new Map();
  for (const [c, ps] of parents) {nodes.add(c); for (const p of ps) {nodes.add(p); incoming.set(p, (incoming.get(p) ?? 0) + 1);}}
  const queue = [...nodes].filter(k => !incoming.has(k)); let visited = 0;
  for (let i = 0; i < queue.length; i++) {
    const c = queue[i]; visited++;
    for (const p of parents.get(c) ?? []) {incoming.set(p, incoming.get(p) - 1); if (incoming.get(p) === 0) queue.push(p);}
  }
  ensure(visited === nodes.size, 'FOCUS_PART_CYCLE', 'effective containment must be acyclic');

  const materials = new Map();
  for (const m of input.materials) {
    fields(m, ['ref', 'body', 'qualifiers', 'requires']); materialRef(m.ref);
    ensure(typeof m.body === 'string', 'FOCUS_SHAPE', 'material body must be text');
    ensure(m.qualifiers && Object.getPrototypeOf(m.qualifiers) === Object.prototype, 'FOCUS_SHAPE', 'qualifiers required');
    enumValue(m.qualifiers.world, ['actual', 'possible'], 'material world');
    enumValue(m.qualifiers.mode, ['current', 'recalled', 'historical', 'knowledge', 'reported', 'imagined'], 'material mode');
    const k = materialKey(m.ref); ensure(!materials.has(k), 'FOCUS_DUPLICATE', 'duplicate material version');
    materials.set(k, {...m, requires: refs(m.requires)});
  }
  for (const m of materials.values()) for (const r of m.requires)
    ensure(materials.has(materialKey(r)), 'FOCUS_DEPENDENCY_MISSING', 'required presentation dependency missing', {ref: r});
  const continuity = refs(input.continuity);
  for (const r of continuity) ensure(materials.has(materialKey(r)), 'FOCUS_DEPENDENCY_MISSING', 'continuity reference missing');

  function checkedPath(anchorRef, rawPath) {
    const a = identity(anchorRef), xs = path(rawPath), start = current(a);
    ensure(start, 'FOCUS_ANCHOR_STALE', 'selected anchor identity is not current', {anchor: a});
    let cursor = a; const crumbs = [];
    for (const er of xs) {
      const e = effective.get(edgeKey(er));
      ensure(e && identityKey(e.child) === identityKey(cursor), 'FOCUS_PATH_BLOCKED', 'path is stale or disconnected', {edge: er});
      cursor = idOf(e.parent); const h = current(cursor);
      crumbs.push({edge: copy(er), anchor: copy(h), witnesses: {child: copy(e.child), parent: copy(e.parent)}});
    }
    return {anchor: a, path: xs, current: copy(start), breadcrumbs: crumbs};
  }
  function focuses(xs, requireCurrent = true) {
    array(xs); const result = xs.map(f => {
      fields(f, ['anchor', 'path']);
      if (!requireCurrent) return {anchor: identity(f.anchor), path: path(f.path)};
      const {anchor: a, path: p} = checkedPath(f.anchor, f.path); return {anchor: a, path: p};
    });
    ensure(new Set(result.map(canonical)).size === result.length, 'FOCUS_DUPLICATE', 'duplicate focus'); return sorted(result);
  }
  function normalizeUse(u) {
    fields(u, ['id', 'revision', 'consumer', 'owners', 'context', 'record', 'purpose', 'status', 'presentation', 'cue']);
    text(u.id, 'use id'); positive(u.revision); identity(u.consumer);
    ensure(knownIdentity(u.consumer), 'FOCUS_USE', 'use consumer identity has no history'); materialRef(u.record);
    array(u.owners); const owners = u.owners.map(identity);
    ensure(new Set(owners.map(identityKey)).size === owners.length, 'FOCUS_DUPLICATE', 'duplicate lifetime owner');
    ensure(owners.every(knownIdentity), 'FOCUS_USE', 'lifetime owner identity has no history');
    ensure(materials.has(materialKey(u.record)), 'FOCUS_MATERIAL_MISSING', 'bound material version missing');
    enumValue(u.purpose, purposes, 'purpose'); enumValue(u.status, ['open', 'parked', 'released'], 'use status');
    enumValue(u.presentation, ['full', 'entry'], 'presentation'); text(u.cue, 'use cue');
    if (u.context !== null) {
      path(u.context);
      // A retained context may now be stale. Validate its original path witnesses, not current usability.
      let cursor = u.consumer;
      for (const er of u.context) {
        const e = edges.get(er.id);
        // Missing/updated declarations remain recoverable but cannot match a new selected path.
        if (!e || e.revision !== er.revision) break;
        ensure(identityKey(e.child) === identityKey(cursor), 'FOCUS_PATH', 'use context is disconnected');
        cursor = idOf(e.parent);
      }
    }
    return {...copy(u), owners: sorted(owners, identityKey)};
  }
  function workbench(w, requireCurrent = true) {
    fields(w, ['revision', 'focus', 'uses']);
    ensure(Number.isSafeInteger(w.revision) && w.revision >= 0, 'FOCUS_SHAPE', 'invalid workbench revision'); array(w.uses);
    const us = w.uses.map(normalizeUse);
    ensure(new Set(us.map(u => u.id)).size === us.length, 'FOCUS_DUPLICATE', 'duplicate use id');
    return {revision: w.revision, focus: focuses(w.focus, requireCurrent), uses: sorted(us, u => u.id)};
  }
  function close(seeds) {
    const found = new Map(), q = [];
    for (const r of refs(seeds)) {const k = materialKey(r); ensure(materials.has(k), 'FOCUS_MATERIAL_MISSING', 'closure seed missing'); found.set(k, r); q.push(r);}
    for (let i = 0; i < q.length; i++) for (const r of materials.get(materialKey(q[i])).requires) {
      const k = materialKey(r); if (!found.has(k)) {found.set(k, r); q.push(r);}
    }
    return sorted(found.values(), materialKey).map(copy);
  }
  function project(rawWorkbench, {budgetBytes = 65536} = {}) {
    ensure(Number.isSafeInteger(budgetBytes) && budgetBytes >= 0, 'FOCUS_BUDGET', 'nonnegative byte budget required');
    const w = workbench(rawWorkbench), seeds = [...continuity], entries = [], useTrace = [];
    for (const u of w.uses) {
      const h = current(u.consumer), matched = w.focus.filter(f => equal(f.anchor, u.consumer));
      const owners = u.owners.map(current);
      const fits = matched.some(f => u.context === null || prefix(u.context, f.path));
      const reason = u.status === 'released' ? 'released' : !h ? 'consumer-stale' : h.lifecycle === 'ended' ? 'consumer-ended' :
        owners.some(o => !o) ? 'owner-stale' : owners.some(o => o.lifecycle === 'ended') ? 'owner-ended' :
        u.status === 'parked' ? 'use-parked' : h.lifecycle === 'paused' ? 'consumer-paused' :
        owners.some(o => o.lifecycle === 'paused') ? 'owner-paused' :
        u.presentation === 'entry' ? 'entry-preference' : !matched.length ? 'off-focus' : !fits ? 'context-mismatch' : 'selected';
      if (reason === 'selected') seeds.push(u.record);
      else if (entryEligibleReason(reason)) entries.push({useId: u.id, record: copy(u.record), cue: u.cue, reason});
      useTrace.push({useId: u.id, record: copy(u.record), consumer: copy(u.consumer), owners: copy(u.owners), reason});
    }
    const required = close(seeds), seedRefs = refs(seeds);
    const packet = {format: 'focus-reference-v1', structuralPolicy: policy,
      focus: w.focus.map(f => checkedPath(f.anchor, f.path)),
      full: required.map(r => copy(materials.get(materialKey(r)))), entries,
      continuity: copy(continuity)};
    const bytes = byteCost(packet);
    ensure(bytes <= budgetBytes, 'FOCUS_REQUIRED_OVERFLOW', 'complete focus packet exceeds budget; no partial packet returned',
      {requiredBytes: bytes, budgetBytes, requiredRefs: required});
    const seedOrigins = seedRefs.map(r => ({ref: r,
      uses: useTrace.filter(u => u.reason === 'selected' && equal(u.record, r)).map(u => u.useId),
      continuity: continuity.some(c => equal(c, r))}));
    const dependencies = required.flatMap(r => materials.get(materialKey(r)).requires.map(d => ({from: r, to: d})));
    return {packet, bytes, trace: copy({uses: useTrace, edges: sorted(edgeDiagnostics), seeds: seedOrigins, required, dependencies})};
  }
  function create({focus = [], uses = []} = {}) {return workbench({revision: 0, focus, uses});}
  function transition(rawWorkbench, patch, options = {}) {
    fields(patch, ['expectedRevision', 'select', 'operations']); const old = workbench(rawWorkbench, false);
    ensure(patch.expectedRevision === old.revision, 'FOCUS_CONFLICT', 'workbench revision changed');
    array(patch.operations); const ids = new Set(), next = copy(old);
    if (patch.select !== null) next.focus = focuses(patch.select); // null = keep, [] = select none
    for (const op of patch.operations) {
      fields(op, ['id', 'expectedRevision', 'operation', 'presentation']); text(op.id, 'use id');
      ensure(!ids.has(op.id), 'FOCUS_CONFLICT', 'only one operation per use in a patch'); ids.add(op.id);
      const u = next.uses.find(x => x.id === op.id); ensure(u, 'FOCUS_USE_MISSING', 'unknown use id');
      ensure(op.expectedRevision === u.revision, 'FOCUS_CONFLICT', 'use revision changed');
      enumValue(op.operation, ['park', 'resume', 'release', 'presentation'], 'operation');
      ensure(op.operation === 'presentation' ? ['entry', 'full'].includes(op.presentation) : op.presentation === null,
        'FOCUS_SHAPE', 'presentation value only for a presentation operation');
      ensure(u.status !== 'released' || op.operation === 'release', 'FOCUS_USE_RELEASED', 'released use cannot be revived or changed');
      const before = copy(u);
      if (op.operation === 'presentation') u.presentation = op.presentation;
      else u.status = {park: 'parked', resume: 'open', release: 'released'}[op.operation];
      if (!equal(before, u)) u.revision++;
    }
    if (!equal(old, next)) next.revision++;
    const view = project(next, options); // validate all effects and budget before publishing any next state
    return {workbench: next, ...view, change: {beforeRevision: old.revision, afterRevision: next.revision,
      focusBefore: old.focus, focusAfter: next.focus,
      changedUses: next.uses.filter(u => !equal(u, old.uses.find(p => p.id === u.id))).map(u => ({id: u.id, revision: u.revision, status: u.status, presentation: u.presentation}))}};
  }
  function checkpoint(rawWorkbench) {
    const w = workbench(rawWorkbench);
    return {format: 'focus-checkpoint-v1', focus: copy(w.focus),
      useVersions: w.uses.filter(u => w.focus.some(f => equal(f.anchor, u.consumer) && (u.context === null || prefix(u.context, f.path))))
        .map(u => ({id: u.id, revision: u.revision}))};
  }
  function restore(rawWorkbench, point, {expectedRevision, ...options} = {}) {
    fields(point, ['format', 'focus', 'useVersions']); ensure(point.format === 'focus-checkpoint-v1', 'FOCUS_SHAPE', 'unknown checkpoint');
    array(point.useVersions); const seen = new Set();
    for (const r of point.useVersions) {edgeRef(r); ensure(!seen.has(r.id), 'FOCUS_DUPLICATE', 'duplicate checkpoint use'); seen.add(r.id);}
    let selection;
    try {selection = focuses(point.focus);} catch (e) {
      if (['FOCUS_ANCHOR_STALE', 'FOCUS_PATH_BLOCKED'].includes(e.code))
        ensure(false, 'FOCUS_RESTORE_REVIEW_REQUIRED', 'checkpoint path or identity is no longer valid', {cause: e.code, details: e.details});
      throw e;
    }
    const result = transition(rawWorkbench, {expectedRevision, select: selection, operations: []}, options);
    return {...result, useDrift: point.useVersions.flatMap(r => {
      const u = result.workbench.uses.find(x => x.id === r.id);
      return !u || u.revision !== r.revision ? [{id: r.id, checkpointRevision: r.revision, currentRevision: u?.revision ?? null}] : [];
    })};
  }
  return Object.freeze({create, project, transition, checkpoint, restore,
    closure: seeds => close(seeds), topology: () => copy(sorted(edgeDiagnostics))});
}

