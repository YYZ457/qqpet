import {attentionId} from './attention.mjs';
import {canonical,ensure,time,uniqueRefs} from './contracts.mjs';
const pin=r=>({id:r.id,revision:r.revision}),same=(a,b)=>a?.id===b?.id&&a?.revision===b?.revision;
const exact=(x,keys)=>ensure(x&&Object.getPrototypeOf(x)===Object.prototype&&canonical(Object.keys(x).sort())===canonical([...keys].sort()),'WAIT_SHAPE','explicit wait mode and its own fields required');
const MAX_DELAY=24*60*60*1000;

export function waitSupportInput({store,subjectId}){
 const at=store.clockNow(),frame=store.read(attentionId(subjectId));
 const sources=(frame?.questions??[]).filter(q=>q.status==='open').flatMap(q=>{
   const sent=[...q.attempts].reverse().map(r=>store.read(r.id)).find(r=>r?.type==='response'&&r.status==='sent');
   return sent?[{kind:'question',question:{id:q.id,revision:q.revision},frame:pin(frame),response:pin(sent),
     awaitingResponseFrom:q.awaitingResponseFrom}]:[];
 }).map((s,i)=>({key:'W'+(i+1),...s}));
 return {format:'wait-support-v1',at,maxWakeAt:at+MAX_DELAY,sources,
   modes:sources.length?['feedback','until','next-event','park']:['until','next-event','park'],
   examples:{...(sources.length?{feedback:{mode:'feedback',source:sources[0].key,wakeAt:at+60000}}:{}),
     until:{mode:'until',wakeAt:at+60000},nextEvent:{mode:'next-event'},park:{mode:'park'}},
   meaning:'feedback sources are host-verified sent open questions; proposed actions alone are not running; timeouts require reassessment, not fabricated answers'};
}
export function checkWaitDeclaration(support,payload,{now=support.at}={}){
 time(now);ensure(support?.format==='wait-support-v1','WAIT_CAPABILITY','wait support was not delivered');
 ensure(payload&&support.modes.includes(payload.mode),'WAIT_SOURCE_REQUIRED','choose an explicit wait mode; no feedback source means no feedback wait');
 if(payload.mode==='feedback'){
   exact(payload,['mode','source','wakeAt']);ensure(support.sources.some(s=>s.key===payload.source),'WAIT_SOURCE_REQUIRED','only a delivered live source may be awaited');
 }else if(payload.mode==='until')exact(payload,['mode','wakeAt']);else exact(payload,['mode']);
 if(['feedback','until'].includes(payload.mode)){
   time(payload.wakeAt);ensure(payload.wakeAt>now&&payload.wakeAt<=support.maxWakeAt,'WAIT_DEADLINE','deadline must be future and inside the host bound');
 }
 return payload.mode==='feedback'?support.sources.find(s=>s.key===payload.source):null;
}
export function validateWaitCommit({store,support,payload}){
 const source=checkWaitDeclaration(support,payload,{now:store.clockNow()});if(!source)return [];
 const frame=store.read(source.frame.id),response=store.read(source.response.id),question=frame?.questions.find(q=>same(q,source.question));
 ensure(same(frame,source.frame)&&question?.status==='open'&&same(response,source.response)&&response?.status==='sent',
   'WAIT_SOURCE_STALE','source changed; rebuild the input rather than waiting on an obsolete source');
 return uniqueRefs([source.frame,source.response]);
}

// A host polls this read-only status. It never calls a model, sleeps, sends a message or marks a question answered.
export function inspectWait({store,decision,now=store.clockNow(),event=null,resume=false}){
 time(now);ensure(typeof resume==='boolean','WAIT_SHAPE','explicit resume boolean');uniqueRefs([decision]);
 const d=store.read(decision.id,decision.revision);ensure(d?.type==='decision','WAIT_DECISION','existing fixed decision required');
 const choice=d.output.options.find(o=>o.id===d.output.selected);
 if(choice?.kind!=='wait')return {status:'not-waiting',reason:'different-choice'};
 const support=d.input.payload.waitSupport,payload=choice.payload;
 if(!support)return {status:'untracked-legacy',reason:'no-wait-contract-in-original-input'};
 checkWaitDeclaration(support,payload);
 if(resume)return {status:'ready',reason:'explicit-resume'};
 if(payload.mode==='park')return {status:'parked',reason:'explicitly-set-aside'};
 let observation=null;
 if(event){uniqueRefs([event]);observation=store.read(event.id,event.revision);
   const subjectId=d.input.payload.continuity.subject.id,incoming=store.subjectObservation(subjectId,event.id),trigger=store.subjectObservation(subjectId,d.currentEvent.id);
   ensure(observation?.type==='event'&&incoming
     &&['observed','reported','tool_receipt'].includes(observation.origin),'WAIT_EVENT','only a received own observation can wake this wait');
   if(same(event,d.currentEvent)||incoming.seq<=trigger.seq)observation=null;
 }
 if(payload.mode==='next-event')return observation?{status:'ready',reason:'new-observation',event:pin(observation)}:{status:'waiting',reason:'next-observation'};
 if(payload.mode==='feedback'){
   const source=support.sources.find(s=>s.key===payload.source),frame=store.read(source.frame.id),q=frame?.questions.find(q=>q.id===source.question.id);
   if(!q||q.status!=='open'||q.revision!==source.question.revision)return {status:'ready',reason:'source-needs-reassessment'};
   if(observation&&observation.actor===source.awaitingResponseFrom&&['observed','reported'].includes(observation.origin))
     return {status:'ready',reason:'candidate-reply-not-yet-judged',event:pin(observation)};
 }
 if(now>=payload.wakeAt)return {status:'ready',reason:payload.mode==='feedback'?'feedback-timeout-reassess':'deadline-reached'};
 return {status:'waiting',reason:payload.mode==='feedback'?'registered-feedback':'until-deadline',wakeAt:payload.wakeAt};
}
