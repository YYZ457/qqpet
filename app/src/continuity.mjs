import {ensure,refKey,text,uniqueRefs} from './contracts.mjs';
import {stateCard} from './personal-state.mjs';
import {attentionId,attentionView} from './attention.mjs';
import {associationCandidates} from './association.mjs';
import {streamInfo} from './streams.mjs';
import {mindProjection} from './mind.mjs';
import {anchorView} from './anchor.mjs';
import {recentContext} from './recent-context.mjs';
import {activityDirectory} from './activities.mjs';
const ref=x=>({id:x.id,revision:x.revision});

export function initializeSubject({store,subjectId,requestId,maxForeground=8}) {
  return store.execute({requestId,commands:[{op:'initialize_subject',id:subjectId,maxForeground}]}).at(-1);
}
export function admitSubjectEvent({store,subjectId,event,requestId}) {
  return store.execute({requestId,commands:[{op:'admit_subject_event',subjectId,event}]}).at(-1);
}
export function readPersonalState({store,subjectId,state,detail=true}) {
  uniqueRefs([state]);const value=store.read(state.id,state.revision);
  ensure(value?.type==='personal_state'&&value.subject===subjectId,'MISSING_STATE','unknown own state');
  return stateCard(value,{historical:store.read(value.id).revision!==value.revision,detail});
}
export function continuityInput({store,subjectId,stateRefs=[],detail=false,currentEvent=null,mind=false,workbenchFocus=false,focusProcessIds=[],tasks=[],recent:recentOptions=null}) {
  text(subjectId,'subject id');ensure(typeof detail==='boolean','INVALID_INPUT','detail must be boolean');
  return store.view(()=>{
    const subject=store.read(subjectId);ensure(subject?.type==='subject','MISSING_SUBJECT','initialize the subject first');
    const frame=store.read(attentionId(subjectId));
  // 候选目录：她自己留下的 B/C/R/Z 状态作为焦点候选出现，但不交付正文；
  // 只有显式选择（focus）或明确驻留，下一轮才把正文带进投影。
  const stateCandidates=workbenchFocus&&mind?[...store.all('personal_state')]
    .filter(r=>r.subject===subjectId&&r.status!=='closed'&&r.mind)
    .sort((a,b)=>(b.recordedAt??0)-(a.recordedAt??0)||a.id.localeCompare(b.id)).slice(0,8)
    .map(r=>({ref:{id:r.id,revision:r.revision},kind:r.kind,role:r.mind.role})):[];
  const associations=currentEvent?associationCandidates({store,subjectId,currentEvent,limit:6}):[];
  const currentRecord=currentEvent?store.read(currentEvent.id,currentEvent.revision):null;
  const stream=currentRecord?.scene?streamInfo(currentRecord.scene):null;
  const view=frame?attentionView(frame,{read:(id,rev)=>store.read(id,rev),currentEvent,workbenchFocus,focusProcessIds,stateCandidates,associationCandidates:associations}):null;
    const foreground=(view?view.foreground.map(ref):subject.foreground).map(pinned=>{
      const value=store.read(pinned.id,pinned.revision);ensure(value?.type==='personal_state'&&value.subject===subjectId&&value.status!=='closed'
        &&store.read(value.id).revision===pinned.revision,'BROKEN_FOREGROUND','invalid foreground state');
      return stateCard(value,{detail});
    });
    // 她显式选中的状态焦点：下一轮把正文带进投影（recalled），没选就不带。
    const focusedStates=(view?.metadata?.focusSupport?.selection??[]).filter(s=>s.kind==='state')
      .map(s=>{try{const head=store.read(s.id);return head?{id:s.id,revision:head.revision}:null;}catch{return null;}}).filter(Boolean);
    const seen=new Set(foreground.map(x=>refKey(x.ref))),recalled=uniqueRefs([...stateRefs,...focusedStates]).filter(r=>!seen.has(refKey(r)))
      .map(state=>readPersonalState({store,subjectId,state,detail}));
    let lastReaction=null;
    if(subject.lastDecision){
      const reaction=readReaction({store,subjectId,decision:subject.lastDecision});
      const decision=store.read(subject.lastDecision.id,subject.lastDecision.revision);
      lastReaction={decision:subject.lastDecision,fromScene:decision.input.payload.workspace.scene,kind:reaction.choice.kind,
        utterance:reaction.choice.kind==='respond'||reaction.choice.kind==='turn'?(reaction.choice.payload.text??reaction.choice.payload.utterances?.[0]?.text??null):null,expressionChoice:reaction.expressionChoice??null,
        responseStatus:reaction.response?.status??'no-response-intent'};
    }
    const projection=mind?mindProjection({records:[...foreground,...recalled].map(x=>store.read(x.ref.id,x.ref.revision)),readHead:id=>store.read(id)}):null;
    const activitiesFrame=frame;
    const selectedActivityIds=new Set();
    for(const residence of activitiesFrame?.residences??[]){
      if(residence.target?.kind==='state'&&residence.target.ref?.id)selectedActivityIds.add(residence.target.ref.id);
    }
    for(const selectedState of view?.metadata?.focusSupport?.selection??[]){
      if(selectedState.kind==='state'&&selectedState.id)selectedActivityIds.add(selectedState.id);
    }
    const activities=activityDirectory([...store.all('personal_state')].filter(r=>r.subject===subjectId),[...selectedActivityIds]);
    const anchors=anchorView({store,subjectId,currentEvent:currentRecord,limit:12});
    // 规模来自 limits（由 turn-driver 传入，超预算时会自动缩小）；按当前频道分组，别的频道只给摘要。
    const recent=recentContext({store,subjectId,currentEvent:currentRecord,scene:currentRecord?.scene??null,...(recentOptions??{})});
    return {subject:ref(subject),maxForeground:subject.maxForeground,foreground,recalled,
      lastReaction,pendingObservations:store.subjectInbox({subjectId,limit:16}),detail,...(activities.length?{activities}:{}),...(tasks.length?{tasks}:{}),...(stream?{stream}:{}),...(view?{attention:view.metadata}:{}),...(projection?{mind:projection}:{}),...(anchors.records.length?{anchors}:{}),...(recent?{recent}:{}),
      // 版本栅栏：只有新投影携带自述/记忆协议；历史打包没有该字段，字节保持不变，可原样复核。
      ...(mind&&workbenchFocus?{selfProtocol:{format:'self-protocol-v1',enabled:true}}:{}),
      ...(mind&&workbenchFocus?{turnPlan:{format:'turn-plan-v1',enabled:true}}:{}),
      ...(mind&&workbenchFocus?{taskEngine:{format:'task-engine-v1',enabled:true}}:{}),
      ...(view?{memoryProtocol:{format:'memory-protocol-v1',enabled:true}}:{}),
      ...(view?{silenceProtocol:{format:'silence-protocol-v1',enabled:true}}:{})};
  });
}
export function readReaction({store,subjectId,decision}) {
  uniqueRefs([decision]);const record=store.read(decision.id,decision.revision);
  ensure(record?.type==='decision'&&record.input.payload.continuity?.subject.id===subjectId,'MISSING_REACTION','unknown own reaction');
  const selected=record.output.options.find(o=>o.id===record.output.selected),response=store.read(`${record.id}:response`);
  const before=record.input.payload.continuity.subject,after=store.read(before.id,before.revision+1);
  ensure(after?.type==='subject'&&after.lastDecision?.id===record.id,'MISSING_CONTINUATION','missing committed state checkpoint');
  return {decision:ref(record),currentEvent:record.currentEvent,workspace:record.workspace,
    stateBefore:[...record.input.payload.continuity.foreground,...record.input.payload.continuity.recalled].map(x=>x.ref),
    stateAfter:{subject:ref(after),foreground:after.foreground,changed:after.changedStates},
    expressionChoice:record.output.continuity.expressionChoice,choice:selected,
    response:response?{ref:ref(response),status:response.status,receipts:response.receipts}:null};
}
export function claimResponse({store,response,claimId,worker,requestId}) {
  return store.execute({requestId,commands:[{op:'claim_response',response,claimId,worker}]}).at(-1);
}
export function recordResponseDelivery({store,response,claimId,outcome,eventId,body,source,actor,requestId,parts=null}) {
  return store.execute({requestId,commands:[{op:'record_response_delivery',response,claimId,outcome,eventId,body,source,actor,...(parts?{parts}:{})}]}).at(-1);
}
export function recoverResponse({store,response,claimId,eventId,body,source,actor,requestId}) {
  return store.execute({requestId,commands:[{op:'recover_response',response,claimId,eventId,body,source,actor}]}).at(-1);
}
