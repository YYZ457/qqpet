// Bridge existing attention records to the pure pinned projection. No second stored graph.
import {canonical,digest,ensure,text} from './contracts.mjs';
import {createFocusProjector,entryEligibleReason} from './focus-projection.mjs';
const clone=x=>JSON.parse(canonical(x)),same=(a,b)=>a?.id===b?.id&&a?.revision===b?.revision;
const ref=x=>({id:x.id,revision:x.revision}),epoch='runtime-pinned-v1';
const kinds=['process','state','question','residence','interaction'];
const mapKind=k=>k==='residence'?'thought':k==='interaction'?'conversation':k;
const key=x=>canonical([x.kind,x.id]);
function exact(x,fields){ensure(x&&Object.getPrototypeOf(x)===Object.prototype&&canonical(Object.keys(x).sort())===canonical([...fields].sort()),'FOCUS_SHAPE','focus fields do not match');}
export function focusIdentity(x){exact(x,['kind','id']);ensure(kinds.includes(x.kind),'FOCUS_SHAPE','unsupported focus kind');text(x.id,'focus id');
  ensure(x.kind!=='interaction'||x.id==='current','FOCUS_SHAPE','interaction is the current exchange, not a fabricated event');return clone(x);}
export function focusSelection(x){exact(x,['kind','id','path',...(Object.hasOwn(x??{},'token')?['token']:[])]);focusIdentity({kind:x.kind,id:x.id});
  if(Object.hasOwn(x,'token'))ensure(x.kind==='residence'&&typeof x.token==='string'&&x.token.length>0,'FOCUS_SHAPE','only residence selection has a host token');
  ensure(Array.isArray(x.path)&&x.path.length<=4,'FOCUS_PATH','path limit is four declared edges');
  x.path.forEach(r=>{exact(r,['id','revision']);text(r.id,'edge id');ensure(Number.isSafeInteger(r.revision)&&r.revision>0,'FOCUS_PATH','edge version required');});return clone(x);}
export function focusScope(x){exact(x,['consumer','owners','context']);focusIdentity(x.consumer);
  ensure(Array.isArray(x.owners)&&x.owners.length<=8&&new Set(x.owners.map(key)).size===x.owners.length,'FOCUS_SHAPE','unique bounded owners required');x.owners.forEach(focusIdentity);
  if(x.context!==null)focusSelection({...x.consumer,path:x.context});return clone(x);}
const internal=x=>({kind:mapKind(x.kind),id:x.id,epoch:x.kind==='residence'?(x.token??'unbound-residence'):epoch});
const internalFocus=x=>({anchor:internal(x),path:x.path});
const life=s=>['completed','abandoned','closed','handled','cancelled'].includes(s)?'ended':['paused','proposed','suspended'].includes(s)?'paused':'open';
export const residenceToken=(frame,r)=>r.focusToken??digest({subject:frame.subject,residence:r.id,birthBeforeFrame:frame.revision??0});
export function stampFocusBindings(frame,previous,upserts){
  const explicit=new Set(upserts.filter(r=>Object.hasOwn(r,'focusUse')).map(r=>r.id));
  for(const r of frame.residences)if(r.target.kind==='material')r.focusToken=previous.residences.find(old=>old.id===r.id)?.focusToken??residenceToken(previous,r);
  for(const r of frame.residences)if(r.focusUse&&(explicit.has(r.id)||!r.focusPins)){
    r.focusPins=[...new Map([r.focusUse.consumer,...r.focusUse.owners].filter(a=>a.kind==='residence').map(a=>{
      const target=frame.residences.find(t=>t.id===a.id&&t.target.kind==='material');ensure(target,'FOCUS_SCOPE','new scope residence identity missing');
      return [a.id,{id:a.id,token:target.focusToken}];})).values()];
  }
}

export function focusWorkbench(frame,{read,currentEvent=null,priorityProcessIds=[],stateCandidates=[]}){
  const anchors=new Map(),history=[],materials=new Map(),uses=[],source=new Map();
  const add=(k,id,revision,status,world,label,token)=>{const a={...internal({kind:k,id,...(token?{token}:{})}),revision,lifecycle:life(status),world,label};anchors.set(key({kind:k,id}),a);return a;};
  if(currentEvent)add('interaction','current',1,'open','actual','眼前交谈或观察（不是某条旧事件）');
  for(const p of frame.processes)add('process',p.id,p.revision,p.status,p.world,p.label);
  for(const q of frame.questions)add('question',q.id,q.revision,q.status,'actual','等待事项');
  const stateIds=new Set(frame.residences.filter(r=>r.target.kind==='state').map(r=>r.target.ref.id));
  for(const r of frame.residences)if(r.focusUse)for(const a of [r.focusUse.consumer,...r.focusUse.owners])if(a.kind==='state')stateIds.add(a.id);
  for(const s of frame.focus?.selection??[])if(s.kind==='state')stateIds.add(s.id);
  for(const id of stateIds){const s=read(id);ensure(s?.type==='personal_state'&&s.subject===frame.subject,'FOCUS_SCOPE','state anchor must be own retained state');add('state',id,s.revision,s.status,'actual',s.kind);}
  // 候选目录（不是选择）：她自己留下并仍开放的状态作为可选锚点出现，正文不在此交付；选了才会进正文。
  const candidateRefs=[];
  for(const c of stateCandidates){
    let s=null;try{s=read(c?.ref?.id,c?.ref?.revision);}catch{s=null;}
    if(!s||s.type!=='personal_state'||s.subject!==frame.subject||s.status==='closed')continue;
    const k=key({kind:'state',id:s.id});
    if(!anchors.has(k))add('state',s.id,s.revision,s.status,'actual',s.kind);
    candidateRefs.push({ref:{id:s.id,revision:s.revision},kind:s.kind,role:s.mind?.role??null});
  }
  for(const r of frame.residences)if(r.target.kind==='material')add('residence',r.id,frame.revision??1,'open','actual','自主保留的材料用途',residenceToken(frame,r));
  // A previously accepted binding may outlive a removed residence consumer/owner.
  // Its missing local-use object is ended, not a new external event or a reason to resurrect it.
  const retired=new Map(),pins=new Map();
  for(const r of frame.residences)for(const pin of r.focusPins??[])pins.set(canonical([pin.id,pin.token]),pin);
  for(const pin of [...pins.values()].sort((a,b)=>canonical(a)<canonical(b)?-1:1)){const a={kind:'residence',id:pin.id},current=anchors.get(key(a));
    if(current?.epoch===pin.token)continue;
    const old={...internal({...a,token:pin.token}),revision:frame.revision??1,lifecycle:'ended',world:'actual',label:'已退出的用途'};
    if(!current)anchors.set(key(a),old);else retired.set(canonical([old.kind,old.id,old.epoch,old.revision]),old);
  }
  history.push(...retired.values());
  // Strict pinned subset. Old declarations stay in attention_frame and its stale-relations diagnostics.
  const edges=frame.relations.filter(e=>e.type==='task-part-of'&&e.status==='active'&&[e.from,e.to].every(r=>same(r,frame.processes.find(p=>p.id===r.id))))
    .map(e=>({id:e.id,revision:e.revision,status:'active',child:{...internal({kind:'process',id:e.from.id}),revision:e.from.revision},parent:{...internal({kind:'process',id:e.to.id}),revision:e.to.revision}}));
  for(const r of frame.residences){
    if(r.target.kind!=='material')continue;
    const m=read(r.target.ref.id,r.target.ref.revision);ensure(m&&['event','note'].includes(m.type),'FOCUS_MATERIAL_MISSING','pinned bound material missing');
    const mr={kind:m.type,...ref(m)};materials.set(canonical(mr),{ref:mr,body:m.body,qualifiers:{world:m.origin==='imagined'?'possible':'actual',mode:'historical'},requires:[]});
    r.purposes.forEach((p,pi)=>{
      const defaults=p.kind==='active-task'?p.eventIds.map(id=>({kind:'process',id})):p.kind==='awaiting-reply'?[{kind:'question',id:p.questionId}]:
        [{kind:p.kind==='affects-current-choice'?'interaction':'residence',id:p.kind==='affects-current-choice'?'current':r.id,...(p.kind==='affects-current-choice'?{}:{token:residenceToken(frame,r)})}];
      defaults.forEach((d,di)=>{
        const scope=r.focusUse,consumer=scope?.consumer??d;
        const owners=[...new Map([...(scope?.owners??[]),...(scope&&!['self-directed','recovery-point','affects-current-choice'].includes(p.kind)?[d]:[])].filter(o=>key(o)!==key(consumer)).map(o=>[key(o),o])).values()];
        const uid=canonical([r.id,pi,di]);
        const parked=p.kind==='recovery-point'||p.kind==='affects-current-choice'&&!same(p.appliesTo,currentEvent);
        const pinnedIdentity=a=>internal({...a,...(a.kind==='residence'?{token:(r.focusPins??[]).find(p=>p.id===a.id)?.token??a.token}: {})});
        uses.push({id:uid,revision:1,consumer:pinnedIdentity(consumer),owners:owners.map(pinnedIdentity),context:scope?.context??null,record:mr,purpose:p.kind,
          status:parked?'parked':'open',presentation:r.presentation,cue:r.cue});source.set(uid,{residenceId:r.id,purpose:p.kind});
      });
    });
  }
  const projector=createFocusProjector({anchors:[...anchors.values()],history,edges,materials:[...materials.values()],continuity:[]},{policy:'pinned'});
  // 过程属于哪条事件流：只从它已交付的依据里派生，不猜；用于让她知道"这件事是在哪儿发生的"。
  const processStreams={};
  for(const p of frame.processes){
    for(const b of p.basis??[]){
      let r=null;try{r=read(b.id,b.revision);}catch{r=null;}
      const scene=r?.type==='event'?r.scene:(r?.scope?.scenes?.[0]??null);
      if(scene){processStreams[p.id]=scene;break;}
    }
  }
  const selected=frame.focus?.selection??[],valid=[],blocked=[];
  for(const s of selected){try{projector.create({focus:[internalFocus(s)]});valid.push(s);}catch(e){
    if(!['FOCUS_ANCHOR_STALE','FOCUS_PATH_BLOCKED'].includes(e.code))throw e;
    blocked.push({selection:clone(s),reason:e.code});}}
  const wb=projector.create({focus:valid.map(internalFocus),uses});
  const projection=projector.project(wb,{budgetBytes:64*1024*1024});
  const materialDelivery=new Map();
  for(const u of projection.trace.uses){const s=source.get(u.useId),row=materialDelivery.get(s.residenceId)??{residenceId:s.residenceId,delivery:'hidden',reasons:[]};
    if(u.reason==='selected')row.delivery='required';
    else if(row.delivery!=='required'&&entryEligibleReason(u.reason))row.delivery='entry';
    row.reasons.push({purpose:s.purpose,reason:u.reason});materialDelivery.set(s.residenceId,row);}
  // Menu is a directory, not a set of fully read records or permission to revise them.
  const candidates=new Map(),addMenu=s=>{try{const checked=projector.create({focus:[internalFocus(s)]});const k=canonical(s);if(!candidates.has(k))candidates.set(k,{selection:clone(s),checked:checked.focus[0]});}catch(e){if(!['FOCUS_ANCHOR_STALE','FOCUS_PATH_BLOCKED'].includes(e.code))throw e;}};
  valid.forEach(addMenu);addMenu({kind:'interaction',id:'current',path:[]});
  const outward=a=>({kind:a.kind==='thought'?'residence':a.kind==='conversation'?'interaction':a.kind,id:a.id,path:[],...(a.kind==='thought'?{token:a.epoch}:{})});
  const priority=new Set([...priorityProcessIds,...selected.filter(s=>s.kind==='process').map(s=>s.id),
    ...frame.residences.flatMap(r=>r.purposes.flatMap(p=>p.eventIds)),...frame.residences.flatMap(r=>r.focusUse?[r.focusUse.consumer,...r.focusUse.owners].filter(a=>a.kind==='process').map(a=>a.id):[])]);
  const all=[...anchors.values()].filter(a=>a.lifecycle!=='ended').sort((a,b)=>Number(b.kind==='process'&&priority.has(b.id))-Number(a.kind==='process'&&priority.has(a.id))||(canonical(a)<canonical(b)?-1:1));
  // Breadth-first path choices with explicit bounds, no parent-to-all-descendants traversal.
  let scanned=0,depthLimited=false;
  function addPaths(a){const pending=[{...outward(a),tail:a.id}];
    for(let i=0;i<pending.length&&scanned<512;i++){
      const s=pending[i];if(s.path.length===4){if(edges.some(e=>e.child.id===s.tail))depthLimited=true;continue;}
      for(const e of edges.filter(e=>e.child.id===s.tail)){scanned++;const f={kind:'process',id:s.id,path:[...s.path,{id:e.id,revision:e.revision}]};addMenu(f);pending.push({...f,tail:e.parent.id});if(scanned>=512)break;}
    }
  }
  for(const a of all){addMenu(outward(a));if(a.kind==='process'&&priority.has(a.id))addPaths(a);}
  for(const a of all)if(a.kind==='process'&&!priority.has(a.id))addPaths(a);
  const menu=[...candidates.values()].slice(0,64).map((c,i)=>{
    const a=anchors.get(key(c.selection));return {key:`F${i+1}`,selection:c.selection,anchor:{kind:c.selection.kind,id:a.id,revision:a.revision,label:a.label,world:a.world,lifecycle:a.lifecycle},
      via:c.selection.path.map(er=>{const e=edges.find(e=>e.id===er.id&&e.revision===er.revision),p=anchors.get(key({kind:'process',id:e.parent.id}));
        return {edge:clone(er),parent:{id:p.id,revision:p.revision,label:p.label,world:p.world,lifecycle:p.lifecycle}};})};
  });
  return {metadata:{enabled:true,format:'pinned-focus-v1',selection:clone(selected),validSelection:clone(valid),blocked,menu,
      ...(candidateRefs.length?{stateCandidates:candidateRefs,
        stateCandidateMeaning:'directory-of-your-own-open-states-not-recommendation; selection-is-yours; body-only-after-focus-or-residence'}:{}),
      omittedMenu:Math.max(0,candidates.size-menu.length),pathScanLimited:scanned>=512,pathDepthLimited:depthLimited,
      ...(Object.keys(processStreams).length?{processStreams,processStreamMeaning:'derived-from-delivered-basis; scene-not-authority'}:{}),
      omittedMeaning:'counted-candidates-only; deeper/unscanned-path-count-unknown; directory-is-not-history-absence',
      materialUses:projection.trace.uses.map(u=>({...source.get(u.useId),reason:u.reason})),
      meaning:'explicit-view-not-task-completion; blocked-paths-retained; menu-not-full-read; states-continue-independently'},
    materials:[...materialDelivery.values()],selectedProcessIds:valid.filter(s=>s.kind==='process').map(s=>s.id),projector,anchors};
}

export function validateFocusUse(scope,frame,env){
  focusScope(scope);
  for(const a of [scope.consumer,...scope.owners]){
    const allowed=a.kind==='interaction'||(env.focusMenu??[]).some(m=>m.selection.kind===a.kind&&m.selection.id===a.id)||a.kind==='process'&&(env.processRefs??[]).some(r=>r.id===a.id)||
      a.kind==='process'&&(env.changedProcessIds??[]).includes(a.id)||a.kind==='state'&&[...(env.stateRefs??[]).map(r=>r.id),...(env.changedStateIds??[])].includes(a.id)||
      a.kind==='question'&&((env.questionRefs??[]).some(r=>r.id===a.id)||(env.changedQuestionIds??[]).includes(a.id))||
      a.kind==='residence'&&[...(env.residenceIds??[]),...(env.changedResidenceIds??[])].includes(a.id);
    ensure(allowed,'UNREAD_FOCUS_SCOPE','focus consumer/owner must be delivered or created in this transaction');
  }
  const bridge=focusWorkbench(frame,{read:env.read,currentEvent:env.currentEvent});
  for(const a of [scope.consumer,...scope.owners])ensure(bridge.anchors.has(key(a)),'FOCUS_SCOPE','focus identity is not present');
  if(scope.context!==null){const token=scope.consumer.kind==='residence'?frame.residences.find(r=>r.id===scope.consumer.id)?.focusToken:null;
    bridge.projector.create({focus:[internalFocus({...scope.consumer,path:scope.context,...(token?{token}:{})})]});}
}
export function advanceWorkbenchFocus(frame,change,env){
  ensure(env.workbenchFocus===true,'FOCUS_CAPABILITY','focus patch requires explicit capability');
  const selection=frame.focus?.selection??[];
  if(change===undefined||change.select===null){const next={...frame,focus:{format:'pinned-focus-v1',selection:clone(selection)}};focusWorkbench(next,{read:env.read,currentEvent:env.currentEvent});return next;}
  exact(change,['select']);ensure(Array.isArray(change.select)&&change.select.length<=8,'FOCUS_SHAPE','up to eight selected anchors');
  const selected=change.select.map(item=>{
    if(typeof item==='string'){const choice=(env.focusMenu??[]).find(m=>m.key===item);ensure(choice,'UNDELIVERED_FOCUS','select only a delivered F menu key');return clone(choice.selection);}
    const s=focusSelection(item);
    ensure(s.path.length===0&&(s.kind==='process'&&(env.changedProcessIds??[]).includes(s.id)||s.kind==='state'&&(env.changedStateIds??[]).includes(s.id)||s.kind==='residence'&&(env.changedResidenceIds??[]).includes(s.id)),
      'UNDELIVERED_FOCUS','explicit IDs only for this transaction created/changed anchors; otherwise use F menu');
    if(s.kind==='residence'){const r=frame.residences.find(r=>r.id===s.id&&r.target.kind==='material');ensure(r,'FOCUS_SCOPE','new selected residence missing');s.token=residenceToken(frame,r);}return s;
  });
  ensure(new Set(selected.map(canonical)).size===selected.length,'FOCUS_DUPLICATE','duplicate selected focus');
  const next={...frame,focus:{format:'pinned-focus-v1',selection:selected}};
  const bridge=focusWorkbench(next,{read:env.read,currentEvent:env.currentEvent});
  ensure(bridge.metadata.blocked.length===0,'FOCUS_PATH_BLOCKED','newly selected focus path is no longer valid');return next;
}
