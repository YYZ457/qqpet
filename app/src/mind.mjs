// Semantic state contracts, not an emotion oracle. No provider, timers, or external effects.
import {canonical,ensure,oneOf,refKey,text,uniqueRefs} from './contracts.mjs';
import {anchorKey} from './anchor.mjs';

export const MIND_KINDS={belief:'appraisal',concern:'concern',condition:'condition',expectation:'expectation',readiness:'readiness'};
const ref=r=>({id:r.id,revision:r.revision});
const exact=(v,keys,name)=>ensure(v&&Object.getPrototypeOf(v)===Object.prototype
  &&Object.keys(v).every(k=>keys.includes(k)),'MIND_SHAPE',`${name} contains unsupported fields`);
const short=(v,name,max=240)=>{text(v,name);ensure([...v].length<=max,'MIND_LIMIT',`${name} too long`);return v;};
const confidence=v=>oneOf(v,['tentative','uncertain','confident'],'subjective confidence');
function refs(values,name){
  ensure(Array.isArray(values)&&values.length<=8,'MIND_LIMIT',`${name} requires up to eight pinned references`);
  for(const r of values){exact(r,['id','revision'],name);ensure(Object.keys(r).length===2,'MIND_SHAPE','reference must pin id and revision');short(r.id,'reference id',200);}
  return uniqueRefs(values).sort((a,b)=>refKey(a).localeCompare(refKey(b)));
}

export function conditionTree(value){
  let nodes=0;
  function visit(v,depth){
    ensure(++nodes<=32&&depth<=4,'MIND_LIMIT','condition tree exceeds 32 nodes or depth four');
    exact(v,['constant','condition','all','any','not'],'condition expression');
    ensure(Object.keys(v).length===1,'MIND_SHAPE','one condition operator required');
    if('constant' in v){ensure(typeof v.constant==='boolean','MIND_SHAPE','constant must be boolean');return {constant:v.constant};}
    if('condition' in v)return {condition:refs([v.condition],'condition reference')[0]};
    if('not' in v)return {not:visit(v.not,depth+1)};
    const op='all' in v?'all':'any';
    ensure(Array.isArray(v[op])&&v[op].length>0&&v[op].length<=8,'MIND_LIMIT','condition group needs 1..8 children');
    return {[op]:v[op].map(c=>visit(c,depth+1))};
  }
  return visit(value,0);
}

export function normalizeMind(value,kind){
  if(value===undefined||value===null){ensure(!['concern','condition','expectation','readiness'].includes(kind),'MIND_REQUIRED','typed state needs mind metadata');return null;}
  const specific={belief:['alternatives'],concern:['orientation'],condition:['assessment'],
    expectation:['action','when','likelihood','effects'],readiness:['concerns','appraisals','conditions','expectations']};
  ensure(value&&Object.hasOwn(specific,value.role),'MIND_SHAPE','unknown semantic state role');
  exact(value,['role','confidence','unresolved',...specific[value.role]],'mind state');
  ensure(MIND_KINDS[value.role]===kind,'MIND_KIND','semantic role and state kind differ');
  const unresolved=value.unresolved??[];
  ensure(Array.isArray(unresolved)&&unresolved.length<=4,'MIND_LIMIT','up to four unresolved needs');
  unresolved.forEach(v=>short(v,'unresolved need'));
  const result={role:value.role,confidence:confidence(value.confidence),unresolved:[...unresolved]};
  switch(value.role){
    case 'belief':{
      const alternatives=value.alternatives??[];ensure(Array.isArray(alternatives)&&alternatives.length<=4,'MIND_LIMIT','up to four alternative interpretations');
      result.alternatives=alternatives.map(v=>short(v,'alternative'));break;
    }
    case 'concern':result.orientation=oneOf(value.orientation,['seek','preserve','avoid'],'concern orientation');break;
    case 'condition':result.assessment=oneOf(value.assessment,['available','unavailable','unknown'],'subjective condition');break;
    case 'expectation':{
      exact(value.action,['tool','args'],'predicted action');ensure(Object.keys(value.action).length===2,'MIND_SHAPE','predicted action needs tool and args');
      short(value.action.tool,'predicted tool',200);ensure(value.action.args&&Object.getPrototypeOf(value.action.args)===Object.prototype,'MIND_SHAPE','predicted args must be an object');
      ensure(Buffer.byteLength(canonical(value.action.args))<=4096,'MIND_LIMIT','predicted args exceed bound');
      ensure(Array.isArray(value.effects)&&value.effects.length<=8,'MIND_LIMIT','up to eight concern effects');
      result.action=JSON.parse(canonical(value.action));result.when=conditionTree(value.when);
      result.likelihood=oneOf(value.likelihood,['likely','possible','unlikely','unknown'],'subjective likelihood');
      result.effects=value.effects.map(e=>{
        exact(e,['concern','relation','confidence'],'predicted effect');
        return {concern:refs([e.concern],'affected concern')[0],relation:oneOf(e.relation,['supports','hinders','mixed','neutral'],'effect relation'),confidence:confidence(e.confidence)};
      });
      ensure(new Set(result.effects.map(e=>refKey(e.concern))).size===result.effects.length,'MIND_SHAPE','combine a mixed effect on the same concern');break;
    }
    case 'readiness':for(const key of specific.readiness)result[key]=refs(value[key],key);break;
  }
  ensure(Buffer.byteLength(canonical(result))<=8192,'MIND_LIMIT','semantic metadata exceeds 8 KiB');
  return result;
}

export function mindReferences(mind){
  const out=[];
  const add=(r,role,relation)=>out.push({ref:ref(r),role,relation});
  function visit(v){
    if(v.condition)add(v.condition,'condition','condition-input');
    else if(v.not)visit(v.not);
    else for(const c of v.all??v.any??[])visit(c);
  }
  if(mind?.role==='expectation'){
    visit(mind.when);for(const e of mind.effects)add(e.concern,'concern',e.relation);
  }
  if(mind?.role==='readiness')for(const [key,role] of Object.entries({concerns:'concern',appraisals:'belief',conditions:'condition',expectations:'expectation'}))
    for(const r of mind[key])add(r,role,key);
  return out;
}

// The same transaction may create a concern and its preparation. Earlier unseen records may not be smuggled in.
export function validateMindPatch({fields,deliveredRecords,subject}){
  const delivered=new Map(deliveredRecords.map(r=>[refKey(r),r]));
  const staged=new Map(fields.map(f=>{
    const r={id:f.id,revision:f.expectedRevision+1,type:'personal_state',...f.next};return [refKey(r),r];
  }));
  const graph=new Map();
  for(const [key,r] of staged){
    const prior=deliveredRecords.find(p=>p.id===r.id&&p.revision===r.revision-1);
    const retained=new Set(mindReferences(prior?.mind).map(l=>canonical(l)));
    const dependencies=[];
    for(const link of mindReferences(r.mind)){
      const target=staged.get(refKey(link.ref))??delivered.get(refKey(link.ref));
      // Keeping an already validated historical edge does not require expanding its body again.
      if(!target&&retained.has(canonical(link)))continue;
      ensure(target&&target.subject===subject,'MIND_UNREAD_REFERENCE','mind dependency must be delivered or proposed in this transaction',link);
      ensure(target.type==='personal_state'&&MIND_KINDS[link.role]===target.kind,'MIND_REFERENCE_ROLE','mind dependency has the wrong role',link);
      if(staged.has(refKey(link.ref)))dependencies.push(refKey(link.ref));
    }
    graph.set(key,dependencies);
  }
  const visiting=new Set(),done=new Set();
  function visit(key){
    ensure(!visiting.has(key),'MIND_CYCLE','new versions cannot cite each other as a circular justification');
    if(done.has(key))return;visiting.add(key);for(const next of graph.get(key)??[])visit(next);visiting.delete(key);done.add(key);
  }
  for(const key of graph.keys())visit(key);
}

// Strong Kleene logic, relative to delivered subjective conditions. Never an authorization decision.
export function evaluateConditions(expression,resolve){
  const tree=conditionTree(expression),consulted=[];
  function visit(v){
    if('constant' in v)return v.constant?'true':'false';
    if(v.condition){
      const result=resolve(v.condition);let value='unknown',reason=result?.record?(result.reason??null):(result?.reason??'undelivered');
      if(result?.record?.kind==='condition'&&result.record.mind?.role==='condition'&&!reason){
        value={available:'true',unavailable:'false',unknown:'unknown'}[result.record.mind.assessment];
        reason=value==='unknown'?'subjective-unknown':null;
      }else if(result?.record&&!reason)reason='wrong-role';
      consulted.push({ref:ref(v.condition),value,reason});return value;
    }
    if(v.not){const value=visit(v.not);return value==='unknown'?'unknown':value==='true'?'false':'true';}
    const op='all' in v?'all':'any',values=v[op].map(visit);
    return op==='all'?(values.includes('false')?'false':values.every(v=>v==='true')?'true':'unknown')
      :(values.includes('true')?'true':values.every(v=>v==='false')?'false':'unknown');
  }
  return {value:visit(tree),consulted,meaning:'premise-under-delivered-subjective-assessments-not-execution-permission'};
}

export function mindProjection({records,readHead}){
  const visible=new Map(records.map(r=>[refKey(r),r]));
  const nodes=records.filter(r=>r.mind);
  ensure(nodes.length<=32,'MIND_LIMIT','up to 32 explicitly delivered mind states');
  const roles={B:[],C:[],R:[],Z:[]},links=[],expectations=[],anchors={};
  const roleView={belief:'B',concern:'C',condition:'R',expectation:'B',readiness:'Z'};
  for(const record of nodes){const key=anchorKey(record.anchor)??'unscoped';(anchors[key]??={B:[],C:[],R:[],Z:[]})[roleView[record.mind.role]].push(ref(record));}
  function resolve(r){
    const head=readHead(r.id),record=visible.get(refKey(r)),latestRef=head?ref(head):null;
    if(!record)return {reason:'undelivered',latestRef};
    if(head?.revision!==record.revision)return {record,reason:'historical',latestRef};
    if(record.status!=='open')return {record,reason:record.status,latestRef};
    return {record,reason:null,latestRef};
  }
  for(const record of nodes){
    roles[roleView[record.mind.role]].push(ref(record));
    for(const link of mindReferences(record.mind)){
      const resolved=resolve(link.ref);
      links.push({from:ref(record),to:link.ref,relation:link.relation,status:resolved.reason??'delivered',
        ...(resolved.reason?{latestRef:resolved.latestRef}:{})});
    }
    if(record.mind.role==='expectation'){
      const self=resolve(ref(record));
      const evaluation=evaluateConditions(record.mind.when,resolve);
      expectations.push({ref:ref(record),...evaluation,...(self.reason?{value:'unknown',recordStatus:self.reason}:{recordStatus:'current'}),
        // The action remains an unexecuted possibility regardless of this evaluation.
        executionStatus:'not-established-by-prediction'});
    }
  }
  ensure(links.length<=128,'MIND_LIMIT','mind projection exceeds 128 typed links');
  const gaps=[...new Map(links.filter(l=>l.status!=='delivered').map(l=>[refKey(l.to),{ref:l.to,status:l.status,latestRef:l.latestRef}])).values()];
  return {format:'agent-mind-view-v1',roles,links,expectations,gaps,anchors,
    scope:'explicitly-delivered-state-versions-only',authority:'subjective-personal-state',
    completeness:'partial-view-not-entire-memory',clockPolicy:'no-automatic-emotion-decay'};
}
