// Reconstruct use exits from immutable attention versions; no second memory store.
import {canonical,ensure,text,uniqueRefs} from './contracts.mjs';
import {residenceToken} from './focus-workbench.mjs';
const copy=x=>JSON.parse(canonical(x)),pin=x=>({id:x.id,revision:x.revision});
const same=(a,b)=>a?.id===b?.id&&a?.revision===b?.revision;
const exact=(x,keys)=>ensure(x&&Object.getPrototypeOf(x)===Object.prototype&&canonical(Object.keys(x).sort())===canonical([...keys].sort()),'RECOVERY_SHAPE','recovery fields do not match');
const short=x=>{text(x,'recovery id');ensure([...x].length<=200,'RECOVERY_SHAPE','recovery id too long');};
export function recoveryQuery(q){
 ensure(q&&['list','read'].includes(q.via),'RECOVERY_SHAPE','use list or read');
 if(q.via==='read'){exact(q,['via','source']);exact(q.source,['frame','id']);uniqueRefs([q.source.frame]);short(q.source.id);ensure(q.source.frame.revision>1,'RECOVERY_SHAPE','exit transition requires a preceding version');}
 else {exact(q,['via','frame','task','cursor']);uniqueRefs([q.frame]);if(q.task!==null)short(q.task);
  if(q.cursor!==null){exact(q.cursor,['revision','offset']);ensure(Number.isSafeInteger(q.cursor.revision)&&q.cursor.revision>1&&q.cursor.revision<=q.frame.revision&&Number.isSafeInteger(q.cursor.offset)&&q.cursor.offset>=0&&q.cursor.offset<=128,'RECOVERY_CURSOR','invalid cursor');}}
 return copy(q);
}
function pair(source,read,subject){
 const after=read(source.frame.id,source.frame.revision),before=read(source.frame.id,source.frame.revision-1);
 ensure([after,before].every(f=>f?.type==='attention_frame'&&f.subject===subject),'RECOVERY_SCOPE','own adjacent attention versions required');return {after,before};
}
export function exitedUse(source,{read,subject}){
 const {after,before}=pair(source,read,subject),use=before.residences.find(r=>r.id===source.id&&r.target.kind==='material');
 if(!use||after.residences.some(r=>r.id===source.id))return null;
 return {source:copy(source),binding:copy(use),exitedAt:after.recordedAt,exitReason:null,kind:'material-use-read',
  interpretation:'retained-use-before-exit-not-current-focus-or-new-experience'};
}
export function recoveryPage({query,frames,read,subject,maxHits}){
 const items=[];let nextCursor=null;
 for(const after of frames){
  const {before}=pair({frame:pin(after)},read,subject);
  const exited=before.residences.filter(r=>r.target.kind==='material'&&!after.residences.some(a=>a.id===r.id)).sort((a,b)=>a.id.localeCompare(b.id));
  const start=query.cursor?.revision===after.revision?query.cursor.offset:0;
  for(let i=start;i<exited.length;i++){
   const r=exited[i],tasks=[...r.purposes.flatMap(p=>p.eventIds),...[r.focusUse?.consumer,...(r.focusUse?.owners??[])].filter(a=>a?.kind==='process').map(a=>a.id)];
   if(query.task!==null&&!tasks.includes(query.task))continue;
   items.push({source:{frame:pin(after),id:r.id},material:r.target.ref,cue:r.cue,taskIds:[...new Set(tasks)],exitedAt:after.recordedAt,exitReason:null,representation:'entry-not-read'});
   if(items.length===maxHits){nextCursor=i+1<exited.length?{revision:after.revision,offset:i+1}:after.revision>2?{revision:after.revision-1,offset:0}:null;
    return {kind:'material-use-directory',snapshot:query.frame,items,nextCursor,scanLimited:false};}
  }
 }
 const last=frames.at(-1);nextCursor=last?.revision>2?{revision:last.revision-1,offset:0}:null;
 return {kind:'material-use-directory',snapshot:query.frame,items,nextCursor,scanLimited:nextCursor!==null};
}
export function restoreUse(request,{frame,read,subject,currentEvent,sources}){
 exact(request,['source','id','presentation']);uniqueRefs([request.source]);short(request.id);
 ensure(['entry','full'].includes(request.presentation),'RECOVERY_SHAPE','choose entry or full');
 const receipt=sources.find(r=>same(pin(r),request.source));
 const witness=receipt?.readPerformed?receipt:receipt?.repeatOf?read(receipt.repeatOf.id,receipt.repeatOf.revision):null;
 ensure(receipt?.subject===subject&&['found','no-progress'].includes(receipt.outcome)&&receipt.workbench?.kind==='material-use-read'
  &&witness?.subject===subject&&witness.outcome==='found'&&witness.readPerformed&&canonical(witness.workbench?.source)===canonical(receipt.workbench.source),
  'UNREAD_RECOVERY','read an own exit item before restoration');
 const historical=exitedUse(receipt.workbench.source,{read,subject});ensure(historical,'RECOVERY_SOURCE','source transition no longer identifies an exit');
 ensure(!frame.residences.some(r=>r.id===request.id),'RECOVERY_CONFLICT','live binding with this id exists; never overwrite it');
 const r=historical.binding,need=(condition,message)=>ensure(condition,'RECOVERY_NEEDS_REBIND',message);
 for(const p of r.purposes){
  if(p.kind==='active-task')need(p.eventIds.some(id=>frame.processes.some(v=>v.id===id&&(v.status==='active'||v.status==='paused'&&request.presentation==='entry'))),'task ended or paused: read material and declare a new use');
  if(p.kind==='awaiting-reply')need(frame.questions.some(q=>q.id===p.questionId&&['open','suspended'].includes(q.status)),'old wait has ended');
  if(p.kind==='affects-current-choice')need(same(p.appliesTo,currentEvent),'old current observation no longer applies');
 }
 if(r.focusUse){
  for(const a of [r.focusUse.consumer,...r.focusUse.owners]){
   const value=a.kind==='process'?frame.processes.find(v=>v.id===a.id):a.kind==='question'?frame.questions.find(v=>v.id===a.id):a.kind==='state'?read(a.id):a.kind==='residence'?frame.residences.find(v=>v.id===a.id):{};
   need(value&&!['completed','abandoned','closed','handled','cancelled'].includes(value.status),'old consumer or owner is no longer open');
   if(a.kind==='state')need(value.type==='personal_state'&&value.subject===subject,'old state owner is not own state');
   if(a.kind==='residence')need(value.target.kind==='material'&&(r.focusPins??[]).some(p=>p.id===a.id&&p.token===residenceToken(frame,value)),'dependent use changed incarnation');
  }
  for(const edge of r.focusUse.context??[])need(frame.relations.some(e=>same(e,edge)&&e.status==='active'&&[e.from,e.to].every(p=>frame.processes.some(v=>same(v,p)))),'old parent path changed');
 }
 // Host tokens and cueFor are regenerated, never copied into the new incarnation.
 return {id:request.id,target:copy(r.target),cue:r.cue,purposes:copy(r.purposes),presentation:request.presentation,...(r.focusUse?{focusUse:copy(r.focusUse)}:{})};
}
