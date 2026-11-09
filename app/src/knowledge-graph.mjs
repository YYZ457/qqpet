// A derived, typed view of original versions. No semantic extraction or implicit belief updates.
import {canonical,digest,ensure,oneOf,text,uniqueRefs} from './contracts.mjs';
import {mindReferences} from './mind.mjs';

export const GRAPH_RECORD_TYPES=['event','note','personal_state','attention_frame','workspace','action','link'];
const pin=r=>({id:r.id,revision:r.revision});
const exact=(v,keys)=>ensure(v&&Object.getPrototypeOf(v)===Object.prototype&&canonical(Object.keys(v).sort())===canonical([...keys].sort()),'TRACE_SHAPE','trace fields do not match');
const short=(v,max=200)=>{text(v,'bounded identifier');ensure([...v].length<=max,'TRACE_LIMIT','text exceeds bound');return v;};
export const recordNode=r=>({kind:'record',...pin(r)});
export const processNode=(frame,p)=>({kind:'process',frame:pin(frame),...pin(p)});
export function nodeRef(value){
  ensure(value&&['record','process'].includes(value.kind),'TRACE_REF','record or process reference required');
  exact(value,value.kind==='record'?['kind','id','revision']:['kind','frame','id','revision']);
  text(value.id,'node id');const base=uniqueRefs([pin(value)])[0];
  if(value.kind==='record')return {kind:'record',...base};
  exact(value.frame,['id','revision']);text(value.frame.id,'frame id');return {kind:'process',frame:uniqueRefs([value.frame])[0],...base};
}
export const nodeKey=value=>digest(nodeRef(value));

export function traceQuery(value){
  exact(value,['route','seeds','maxDepth','maxNodes','maxBytes','includeHistorical','offset','scope','need']);
  ensure(Buffer.byteLength(canonical(value))<=16384,'TRACE_LIMIT','query itself must fit its bounded protocol');
  oneOf(value.route,['grounds','impact','progress','associations','directory'],'trace route');
  ensure(Array.isArray(value.seeds)&&value.seeds.length<=4,'TRACE_LIMIT','up to four trace seeds');
  const seeds=[...new Map(value.seeds.map(r=>{const n=nodeRef(r);return [nodeKey(n),n];})).values()];
  for(const [key,min,max] of [['maxDepth',0,6],['maxNodes',1,16],['maxBytes',1024,16384],['offset',0,1000000]])
    ensure(Number.isSafeInteger(value[key])&&value[key]>=min&&value[key]<=max,'TRACE_LIMIT',`invalid ${key}`);
  ensure(typeof value.includeHistorical==='boolean','TRACE_SHAPE','includeHistorical must be explicit');
  ensure(Array.isArray(value.scope)&&value.scope.length<=8,'TRACE_LIMIT','up to eight directory scope tags');value.scope.forEach(s=>short(s));
  short(value.need,240);
  ensure(value.route==='directory'?seeds.length===0:seeds.length>0&&value.offset===0&&value.scope.length===0,'TRACE_SHAPE','directory uses scope/offset; other routes use explicit seeds');
  return {...value,seeds,scope:[...new Set(value.scope)].sort()};
}

export function projectGraphRecord(record){
  if(!GRAPH_RECORD_TYPES.includes(record.type))return {nodes:[],edges:[]};
  const owner=pin(record),nodes=[],edges=[];
  const descriptor=(ref,type,value,scope=[])=>({ref,type,owner,subject:record.subject??null,
    status:value.status??null,kind:value.kind??null,role:value.mind?.role??null,
    scope:[...new Set(scope)],recordedAt:value.recordedAt??record.recordedAt,
    ...(type==='event'?{origin:value.origin,actor:value.actor,scene:value.scene,occurredAt:value.occurredAt??null}:{}),
    ...(type==='process'?{world:value.world,label:value.label,intervals:value.intervals}:{}),
    ...(type==='note'?{validFrom:value.scope.validFrom,validUntil:value.scope.validUntil}:{})});
  const edge=(from,to,family,relation,field,usable=true,symmetric=false)=>edges.push({from,to,family,relation,owner,field,usable,symmetric,subject:record.subject??null});
  const root=recordNode(record);
  if(!['attention_frame','link'].includes(record.type)){
    const scope=record.type==='event'||record.type==='workspace'?[record.scene,...(record.actor?[record.actor]:[])]:Array.isArray(record.scope)?record.scope:
      record.scope?[...record.scope.scenes,...record.scope.people]:[];
    nodes.push(descriptor(root,record.type,record,scope));
  }
  if(record.type==='note')for(const r of record.evidence)edge(root,recordNode(r),'basis','evidence','evidence');
  if(record.type==='personal_state'){
    for(const key of ['observations','priorStates','memories'])for(const r of record.basis?.[key]??[])
      edge(root,recordNode(r),'basis',key,`basis.${key}`);
    for(const r of mindReferences(record.mind))edge(root,recordNode(r.ref),'mind',r.relation,'mind');
  }
  if(record.type==='link')edge(recordNode(record.from),recordNode(record.to),['related','similar'].includes(record.relation)?'association':'comparison',
    record.relation,'link',record.status==='active',record.direction==='both');
  if(record.type==='workspace')for(const key of ['workingRefs','continuityRefs','actionRefs'])for(const r of record[key])
    edge(root,recordNode(r),'workspace',key,key);
  if(record.type==='action'){
    edge(root,recordNode(record.workspace),'action','workspace','workspace');
    if(record.receipt)edge(root,recordNode(record.receipt),'action','receipt','receipt');
    for(const r of record.inputRefs)edge(root,recordNode(r),'basis','inputRefs','inputRefs');
  }
  if(record.type==='attention_frame'){
    const processes=new Map(record.processes.map(p=>[p.id,p]));
    for(const p of record.processes){
      const n=processNode(record,p);nodes.push(descriptor(n,'process',p));
      for(const r of p.basis)edge(n,recordNode(r),'basis','process-basis','processes.basis');
    }
    for(const r of record.relations){
      const valid=r.status==='active'&&[r.from,r.to].every(x=>processes.get(x.id)?.revision===x.revision);
      edge(processNode(record,r.from),processNode(record,r.to),['similar','related'].includes(r.type)?'association':'process',r.type,'relations',valid);
    }
    for(const r of record.residences){
      const target=r.target.kind==='process'?processNode(record,r.target.ref):recordNode(r.target.ref);
      for(const p of r.purposes)for(const id of p.eventIds){const process=processes.get(id);
        if(process)edge(target,processNode(record,process),'context','resides-in','residences.purposes.eventIds');}
    }
  }
  return {nodes,edges:edges.map((e,ordinal)=>({...e,key:digest({owner,ordinal}),ordinal}))};
}

// Route automata constrain relation families and direction. An inverse lookup never reverses a claim.
export function traceTransition(route,state,edge,direction){
  if(!edge.usable)return null;
  const out=direction==='out';
  if(route==='grounds'){
    if(out&&edge.family==='basis')return 'evidence';
    if(state==='focus'&&out&&edge.family==='mind')return 'context';
    if(state==='context'&&out&&edge.family==='mind'&&['condition-input','supports','hinders','mixed','neutral'].includes(edge.relation))return 'context';
    if(state==='focus'&&edge.family==='comparison')return 'context';
  }
  if(route==='impact'&&!out&&['basis','mind','context'].includes(edge.family))return 'dependent';
  if(route==='associations'&&edge.family==='association'&&(out||edge.symmetric))return 'candidate';
  if(route==='progress'){
    if(edge.family==='process'&&(!out&&edge.relation==='task-part-of'||['before','during','overlaps','realizes','causes','affects'].includes(edge.relation)))return 'process';
    if(edge.family==='context')return 'process';
    if(out&&edge.family==='workspace')return 'operation';
    if(!out&&edge.family==='action'&&edge.relation==='workspace')return 'operation';
    if(out&&edge.family==='action'&&edge.relation==='receipt')return 'evidence';
    if(out&&edge.family==='basis')return 'evidence';
  }
  return null;
}

export function walkKnowledgeGraph(raw,{load,neighbors,directory,maxNodes=8,maxEdges=128,epoch}){
  const q=traceQuery(raw),cap=Math.min(q.maxNodes,maxNodes),nodes=new Map(),witnesses=new Map(),limits=new Set(),missing=[],excluded=[];
  let checkedEdges=0,excludedCount=0,nextOffset=null,scanned=0,omittedPaths=0;
  const add=n=>{nodes.set(nodeKey(n.ref),n);return n;};
  if(q.route==='directory'){
    const page=directory(q,cap);for(const n of page.nodes)add(n);nextOffset=page.nextOffset;scanned=page.scanned;
  }else{
    const queue=[],visited=new Set();
    for(const seed of q.seeds){
      const n=load(seed);if(!n){missing.push({ref:seed,reason:'not-found-or-unavailable-to-subject'});continue;}
      if(nodes.size>=cap){limits.add('node-limit');continue;}add(n);queue.push({node:n,state:'focus',depth:0});visited.add(`${nodeKey(n.ref)}:focus`);
    }
    for(let i=0;i<queue.length;i++){
      const current=queue[i],remaining=maxEdges-checkedEdges;
      if(remaining<=0){limits.add('edge-limit');break;}
      const adjacent=neighbors(current.node,q.includeHistorical,remaining+1);scanned+=adjacent.length;
      for(const {edge,direction,other} of adjacent){
        if(checkedEdges>=maxEdges){limits.add('edge-limit');break;}checkedEdges++;
        const state=traceTransition(q.route,current.state,edge,direction);
        if(!state){excludedCount++;if(excluded.length<8)excluded.push({relation:edge.relation,family:edge.family,direction,reason:edge.usable?'route-excluded':'retired-or-stale'});continue;}
        if(current.depth>=q.maxDepth){limits.add('depth-limit');continue;}
        const target=load(other);if(!target){if(missing.length<8)missing.push({ref:other,reason:'endpoint-unavailable'});continue;}
        const key=nodeKey(target.ref),product=`${key}:${state}`;
        if(!nodes.has(key)&&nodes.size>=cap){limits.add('node-limit');continue;}
        add(target);witnesses.set(`${edge.key}:${direction}`,{...edge,direction,viaState:current.state,nextState:state});
        if(!visited.has(product)){visited.add(product);queue.push({node:target,state,depth:current.depth+1});}
      }
    }
  }
  const seedKeys=new Set(q.seeds.map(nodeKey));
  let result;
  const build=()=>({format:'agent-knowledge-trace-v1',route:q.route,epoch,
    nodes:[...nodes.values()],paths:[...witnesses.values()].filter(e=>nodes.has(nodeKey(e.from))&&nodes.has(nodeKey(e.to))),
    missing,limits:[...limits].sort(),excluded:{count:excludedCount,examples:excluded},checkedEdges,scanned,nextOffset,omittedPaths,
    stop:limits.size?'truncated':q.route==='directory'?(nodes.size?'directory-page':'empty-directory'):
      !nodes.size?(missing.length?'not-found':'no-path'):witnesses.size?'available':'no-path',
    interpretation:'recorded-relations-and-candidates-not-new-facts-or-proof-of-completeness'});
  result=build();
  while(Buffer.byteLength(canonical(result))>q.maxBytes){
    const removable=[...nodes.keys()].reverse().find(k=>!seedKeys.has(k));
    if(removable){
      nodes.delete(removable);limits.add('result-byte-limit');
      if(q.route==='directory'){
        ensure(nodes.size>0,'TRACE_REQUIRED_OVERFLOW','the next whole directory entry cannot fit; increase its byte bound');
        nextOffset=q.offset+nodes.size; // Removed entries must be retried on the next page, never skipped.
      }
      result=build();continue;
    }
    if(witnesses.size){witnesses.delete([...witnesses.keys()].at(-1));omittedPaths++;limits.add('result-byte-limit');result=build();continue;}
    if(excluded.length){excluded.pop();limits.add('result-byte-limit');result=build();continue;}
    ensure(false,'TRACE_REQUIRED_OVERFLOW','even the reference catalog cannot fit; no partial seed is returned');
  }
  return result;
}
