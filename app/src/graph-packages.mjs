import {canonical,ensure} from './contracts.mjs';
import {nodeKey,recordNode} from './knowledge-graph.mjs';

// The renderer is the real complete-message builder/seal, not an estimated per-record token sum.
export function assembleGraphPackages({baseRecords=[],traces,render}){
  const traceFor=r=>{const q=r.operation?.trace??r.query.trace;ensure(q?.seeds,'TRACE_QUERY_REQUIRED','a resolved typed query is required for complete graph delivery');return q;};
  const candidates=new Map(),required=new Set();
  for(const result of traces){
    for(const seed of traceFor(result).seeds)required.add(nodeKey(seed));
    for(const node of result.trace.nodes){const key=nodeKey(node.ref);if(!candidates.has(key))candidates.set(key,node);}
  }
  // A failed/missing seed stays a reported gap. There is no fictional body to load for it.
  const unavailableSeeds=traces.flatMap(r=>traceFor(r).seeds).filter(ref=>!candidates.has(nodeKey(ref)))
    .map(ref=>({ref,reason:'seed-not-in-result-check-missing-and-query-limits'}));
  for(const key of [...required])if(!candidates.has(key))required.delete(key);
  const baseKeys=new Set(baseRecords.map(nodeKey));
  const selected=new Map();
  const present=()=>[...selected.values()].map(n=>n.ref);
  const report=(stop,extra=[])=>({stop:stop==='selected-available'&&[...candidates.keys()].some(k=>!selected.has(k)&&!baseKeys.has(k))?'selected-partial':stop,algorithm:'purpose-ordered-complete-packages-v1',
    presented:present(),alreadyPresent:[...candidates].filter(([k])=>baseKeys.has(k)).map(([,n])=>n.ref),
    omitted:[...candidates].filter(([key])=>!selected.has(key)&&!baseKeys.has(key)).map(([,n])=>({ref:n.ref,reason:extra.includes(nodeKey(n.ref))?'required-overflow':'input-budget-or-node-limit'})),
    unavailableSeeds,semanticSufficiency:'not-established',bodyPolicy:'whole-record-no-text-truncation'});
  for(const key of required)if(!baseKeys.has(key))selected.set(key,candidates.get(key));
  let packet;
  try{packet=render([...selected.values()],report('selected-available'));}
  catch(error){
    if(!['INPUT_OVERFLOW','MIND_LIMIT','INPUT_LIMIT'].includes(error.code))throw error;
    const failed=[...selected.keys()];selected.clear();return render([],report('required-overflow',failed));
  }
  for(const [key,node] of candidates){
    if(selected.has(key)||baseKeys.has(key))continue;
    selected.set(key,node);
    try{packet=render([...selected.values()],report('selected-available'));}
    catch(error){if(!['INPUT_OVERFLOW','MIND_LIMIT','INPUT_LIMIT'].includes(error.code))throw error;selected.delete(key);}
  }
  return render([...selected.values()],report('selected-available'));
}

export function graphRecordPresent(payload,node){
  if(node.kind==='record'){
    const key=nodeKey(node);
    if(nodeKey(recordNode(payload.current))===key)return true;
    if(nodeKey(recordNode(payload.workspace))===key)return true;
    if(payload.materials.some(m=>nodeKey(recordNode(m.ref))===key))return true;
    return [...payload.continuity.foreground,...payload.continuity.recalled].some(c=>nodeKey(recordNode(c.ref))===key&&c.record);
  }
  return canonical(node.frame)===canonical(payload.continuity.attention.frame)&&payload.continuity.attention.processes.some(p=>p.id===node.id&&p.revision===node.revision&&typeof p.body==='string');
}
