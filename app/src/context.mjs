import {ensure, refKey, text, uniqueRefs} from './contracts.mjs';

const equalRef = (a,b) => a?.id === b?.id && a?.revision === b?.revision;
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');

function material(store, ref, purposes) {
  const record = store.read(ref.id, ref.revision);
  ensure(record && ['event', 'note'].includes(record.type), 'MISSING_REFERENCE', 'context reference is missing or not memory');
  const historical = store.read(record.id).revision !== record.revision || record.status === 'historical';
  const common = {ref, type: record.type, body: record.body, purposes, historical,
    needsReview: store.basisChanged(ref), recordedAt: record.recordedAt};
  if (record.type === 'event') return {...common, origin: record.origin, source: record.source,
    scene: record.scene, actor: record.actor, occurredAt: record.occurredAt};
  return {...common, kind: record.kind, confidence: record.confidence, status: record.status, scope: record.scope,
    evidence: record.evidence, sourceRoots: record.rootIds.map(id => ({id, origin: store.read(id).origin}))};
}

export function composeContext(options) {
  return options.store.view(() => composeFromSnapshot(options));
}
function composeFromSnapshot({store, currentEvent, workspace, identity = '', ranked = [], assessments = [], budgetBytes}) {
  ensure(Number.isInteger(budgetBytes) && budgetBytes > 0, 'INVALID_INPUT', 'positive whole byte budget required');
  ensure(typeof identity === 'string', 'INVALID_INPUT', 'identity must be text');
  uniqueRefs([currentEvent, workspace]);
  const event = store.read(currentEvent.id, currentEvent.revision);
  const frame = store.read(workspace.id, workspace.revision);
  ensure(event?.type === 'event' && frame?.type === 'workspace', 'REFERENCE_TYPE', 'event and workspace required');
  ensure(store.read(frame.id).revision === frame.revision, 'STALE_WORKSPACE', 'compose from a fresh workspace');
  const selected = new Map(), rejected = [], unresolved = [];
  for (const [purpose, refs] of [['working', frame.workingRefs], ['continuity', frame.continuityRefs]]) {
    for (const ref of refs) {
      if (equalRef(ref, currentEvent)) continue;
      const key = refKey(ref);
      if (selected.has(key)) selected.get(key).purposes.push(purpose);
      else selected.set(key, material(store, ref, [purpose]));
    }
  }
  const context = {
    format: 'agent-context-v1', identity,
    current: material(store, currentEvent, ['current']),
    workspace: {ref: workspace, scene: frame.scene, focus: frame.focus, resume: frame.resume, actionRefs: frame.actionRefs},
    materials: [...selected.values()]
  };
  ensure(bytes(context) <= budgetBytes, 'CONTEXT_OVERFLOW', 'required material exceeds budget', {requiredBytes: bytes(context), budgetBytes});
  const judgements = new Map();
  for (const assessment of assessments) {
    uniqueRefs([assessment.ref]);
    if (!equalRef(assessment.currentEvent, currentEvent) || !equalRef(assessment.workspace, workspace)) continue;
    ensure([true, false, null].includes(assessment.applies), 'INVALID_INPUT', 'assessment must be true, false or null');
    const key = refKey(assessment.ref);
    if (!judgements.has(key)) judgements.set(key, assessment.applies);
    else if (judgements.get(key) !== assessment.applies) judgements.set(key, null);
  }
  for (const candidate of ranked) {
    const [ref] = uniqueRefs([candidate.ref]); const key = refKey(ref);
    if (selected.has(key) || equalRef(ref, currentEvent)) continue;
    if (judgements.get(key) !== true) {
      (judgements.get(key) === false ? rejected : unresolved).push({ref, reason: judgements.get(key) === false ? 'not-applicable' : 'needs-assessment'});
      continue;
    }
    const entry = material(store, ref, ['optional']);
    if (entry.historical || entry.status === 'suspended' || entry.needsReview) {
      unresolved.push({ref, reason: 'historical-suspended-or-basis-changed'}); continue;
    }
    if (entry.scope) {
      const at = event.occurredAt ?? event.recordedAt;
      if (entry.scope.scenes.length && !entry.scope.scenes.includes(frame.scene)
        || entry.scope.validFrom !== null && at < entry.scope.validFrom
        || entry.scope.validUntil !== null && at >= entry.scope.validUntil) {
        rejected.push({ref, reason: 'outside-declared-scope'}); continue;
      }
    }
    context.materials.push(entry);
    if (bytes(context) > budgetBytes) {
      context.materials.pop(); rejected.push({ref, reason: 'budget'});
    } else selected.set(key, entry);
  }
  const json = JSON.stringify(context);
  return {context, json, bytes: Buffer.byteLength(json), budgetBytes, unit: 'utf8-bytes',
    selected: [...selected.values()].map(entry => entry.ref), rejected, unresolved};
}

// The caller supplies semantic assessments; this function intentionally does not invent them.
export function assessmentFor({currentEvent, workspace, ref, applies}) {
  uniqueRefs([currentEvent, workspace, ref]);
  ensure([true, false, null].includes(applies), 'INVALID_INPUT', 'invalid applicability');
  text(ref.id, 'memory id');
  return {currentEvent, workspace, ref, applies};
}
