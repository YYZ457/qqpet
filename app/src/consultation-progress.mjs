import {refKey} from './contracts.mjs';
import {lookupResultId} from './local-query.mjs';
const pin=r=>r?{id:r.id,revision:r.revision}:null;
const same=(a,b)=>a?.id===b?.id&&a?.revision===b?.revision;
export function fullBodyRefs(payload){
 const refs=[...(payload.materials??[]).map(m=>m.ref),
  ...[...(payload.continuity?.foreground??[]),...(payload.continuity?.recalled??[])].filter(c=>c.record).map(c=>c.ref),
  ...(payload.knowledge?.cards??[]).filter(c=>c.record&&c.ref.kind==='record').map(c=>c.ref)];
 return [...new Map(refs.map(r=>[refKey(r),pin(r)])).values()];
}
export function consultationProgress({read,lastDecision,subjectId,currentEvent,workspace,payload}){
 const recent=[],seen=new Set(),past=new Map();let cursor=lastDecision,stop='start-or-other-context',lastResponseIntent=null;
 while(cursor){
  if(recent.length>=3){stop='history-window-limit';break;}
  if(seen.has(refKey(cursor))){stop='cycle';break;}seen.add(refKey(cursor));
  const d=read(cursor.id,cursor.revision);
  if(d?.type!=='decision'||d.input.payload.continuity?.subject.id!==subjectId||!same(d.currentEvent,currentEvent)||!same(d.workspace,workspace))break;
  const choice=d.output.options.find(o=>o.id===d.output.selected),r=choice.kind==='lookup'?read(lookupResultId(pin(d))):null;
  const result=r?.type==='lookup_result'&&r.subject===subjectId&&same(r.decision,pin(d))&&same(r.anchor,currentEvent)&&same(r.workspace,workspace)?r:null;
  const requested=choice.kind==='lookup'?choice.payload:null;
  const navigation=result?.consultation?.navigation;
  const lookup=requested?{via:requested.consult?.via??Object.keys(requested)[0],target:requested.consult?.target??requested.ref??requested.stateRef??null,
    outcome:result?.outcome??'result-not-recorded',readPerformed:result?.readPerformed??false,
    pageChanged:navigation?.fromPage? !same(navigation.fromPage,navigation.page):null}:null;
  recent.push({kind:choice.kind,lookup});
  for(const ref of fullBodyRefs(d.input.payload))if(!past.has(refKey(ref)))past.set(refKey(ref),{ref});
  if(choice.kind==='respond'&&!lastResponseIntent){const response=read(`${d.id}:response`);lastResponseIntent=response?{ref:pin(response),status:response.status}:null;}
  cursor=d.input.payload.continuity.lastReaction?.decision??null;
 }
 const now=fullBodyRefs(payload),nowKeys=new Set(now.map(refKey)),prior=[...past.values()].filter(x=>!nowKeys.has(refKey(x.ref)));
 return {trigger:{ref:currentEvent,sameAsLastOperation:recent.length>0},
  recentOperations:recent,latestOperation:recent[0]??null,completeBodiesInThisInput:now.slice(0,16),omittedCurrentBodies:Math.max(0,now.length-16),
  earlierBodyHandles:prior.slice(0,8),omittedEarlierBodies:Math.max(0,prior.length-8),
  currentPage:payload.information?.consultationDesk?.navigation.currentPage??null,lastResponseIntent,historyStop:stop,
  semanticCompletion:'not-assessed-by-host',nextChoice:'model-owned',
  meaning:'same-trigger-not-new-request; operation-and-delivery-not-comprehension; earlier-handles-not-current-evidence; unresolved-conditions-may-need-more-reading'};
}
