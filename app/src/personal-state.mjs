// Local state semantics shared by the SQLite adapter; no model, clock, or effects here.
import {canonical,ensure,oneOf,refKey,text,time,uniqueRefs} from './contracts.mjs';
import {normalizeMind} from './mind.mjs';
import {normalizeAnchor} from './anchor.mjs';

export const STATE_KINDS=['feeling','appraisal','intention','tension','activity','concern','condition','expectation','readiness'];
export const STATE_STATUSES=['open','suspended','closed'];
export const STATE_NATURES=['encounter','reappraisal','self-report','wording','unknown'];
const own=(x,k)=>Object.prototype.hasOwnProperty.call(x,k);
const inRefs=(r,rs)=>rs.some(x=>refKey(x)===refKey(r));
const short=(v,n,max)=>{text(v,n);ensure([...v].length<=max,'STATE_LIMIT',`${n} too long`);return v;};
export function stateIds(xs,name='state ids',max=256) {
  ensure(Array.isArray(xs)&&xs.length<=max,'STATE_LIMIT',`${name} must be bounded`);xs.forEach(x=>short(x,name,200));
  return [...new Set(xs)].sort();
}
function exactAllowed(value,allowed,name) {
  ensure(value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).every(k=>allowed.includes(k)),
    'STATE_SHAPE',`${name} has unsupported fields`);
}
export function stateBasis(value) {
  if(value===undefined||value===null)return null;
  exactAllowed(value,['observations','priorStates','memories'],'basis');
  return {observations:uniqueRefs(value.observations??[]),priorStates:uniqueRefs(value.priorStates??[]),memories:uniqueRefs(value.memories??[])};
}

export function personalStateChange(change,previous,{subject,recordedAt,states,observations,currentObservations,memories}) {
  exactAllowed(change,['id','expectedRevision','kind','body','status','scope','nature','reason','basis','mind','anchor','nextStep','checkpoint'],'state change');
  short(change.id,'state id',200);text(subject,'subject');time(recordedAt);
  ensure(Number.isSafeInteger(change.expectedRevision)&&change.expectedRevision===(previous?.revision??0),'STATE_CONFLICT','state version changed');
  if(previous)ensure(previous.subject===subject&&inRefs(previous,states),'UNREAD_STATE','read the current own state before revising it');
  oneOf(change.nature,STATE_NATURES,'change nature');
  // An omitted audit explanation is not a semantic state failure. Never invent its contents.
  const reason=change.reason??null;if(reason!==null)short(reason,'change reason',512);
  const fields={kind:change.kind??previous?.kind,body:change.body??previous?.body,
    status:change.status??previous?.status??'open',scope:stateIds(change.scope??previous?.scope??[],'state scope',32)};
  oneOf(fields.kind,STATE_KINDS,'state kind');short(fields.body,'state body',2048);oneOf(fields.status,STATE_STATUSES,'state status');
  ensure(!previous||fields.kind===previous.kind,'STATE_IDENTITY','use another object to change its kind');
  const mind=normalizeMind(own(change,'mind')?change.mind:previous?.mind,fields.kind);
  ensure(!previous?.mind||mind?.role===previous.mind.role,'MIND_IDENTITY','cannot remove or recast an existing semantic identity');
  if(mind)fields.mind=mind;
  const anchor=normalizeAnchor(own(change,'anchor')?change.anchor:previous?.anchor);
  if(anchor)fields.anchor=anchor;
  const nextStep=own(change,'nextStep')?change.nextStep:(previous?.nextStep??null);
  if(nextStep!==null){short(nextStep,'next step',1200);fields.nextStep=nextStep;}
  const checkpoint=own(change,'checkpoint')?change.checkpoint:(previous?.checkpoint??null);
  if(checkpoint!==null){short(checkpoint,'checkpoint',4000);fields.checkpoint=checkpoint;}
  const basis=stateBasis(change.basis);
  ensure(!basis||basis.observations.every(r=>inRefs(r,observations))&&basis.priorStates.every(r=>inRefs(r,states))&&basis.memories.every(r=>inRefs(r,memories)),
    'UNDELIVERED_BASIS','state basis must have been delivered in this input');
  if(change.nature==='encounter')ensure(basis?.observations.some(r=>inRefs(r,currentObservations)),'ENCOUNTER_REQUIRED','encounter needs an actual current observation');
  if(change.nature==='wording')ensure(previous&&fields.kind===previous.kind&&fields.status===previous.status&&canonical(fields.scope)===canonical(previous.scope)
    &&canonical(mind)===canonical(previous.mind??null)&&(basis===null||canonical(basis)===canonical(previous.basis)),'WORDING_SCOPE','wording cannot change scope, lifecycle, semantics, or basis');
  if(previous&&canonical(fields)===canonical({kind:previous.kind,body:previous.body,status:previous.status,scope:previous.scope,...(previous.mind?{mind:previous.mind}:{}),...(previous.anchor?{anchor:previous.anchor}:{}),...(previous.nextStep?{nextStep:previous.nextStep}:{}),...(previous.checkpoint?{checkpoint:previous.checkpoint}:{})})
    &&(basis===null||canonical(basis)===canonical(previous.basis)))return null;
  return {...fields,subject,nature:change.nature,reason,basis,
    predecessor:previous?{id:previous.id,revision:previous.revision}:null,recordedAt};
}

export function normalizeStateDelta(delta,{attention=false,reflection=false}={}) {
  const keys=reflection?['changes','residency',...(attention?['attention']:[])]:['changes','residency','expressionChoice','observationDisposition',...(attention?['attention']:[])];
  exactAllowed(delta,keys,'continuity');
  if(attention)ensure(own(delta,'attention'),'ATTENTION_SHAPE','explicit attention keep or patch required');
  ensure((reflection?['changes','residency']:['changes','residency','expressionChoice','observationDisposition']).every(k=>own(delta,k)),'STATE_SHAPE','continuity fields required, including an explicit keep');
  ensure(Array.isArray(delta.changes)&&delta.changes.length<=16,'STATE_LIMIT','up to sixteen changes');
  delta.changes.forEach(c=>{text(c?.id,'state id');});
  ensure(new Set(delta.changes.map(c=>c.id)).size===delta.changes.length,'DUPLICATE_CHANGE','one change per state');
  exactAllowed(delta.residency,['add','remove'],'residency');
  const residency={add:stateIds(delta.residency.add??[],'foreground additions'),remove:stateIds(delta.residency.remove??[],'foreground removals')};
  ensure(!residency.add.some(id=>residency.remove.includes(id)),'RESIDENCY_CONFLICT','cannot add and remove the same state');
  if(reflection)return {changes:delta.changes,residency,...(attention?{attention:delta.attention}:{})};
  let expressionChoice=null;
  if(delta.expressionChoice!==null){
    exactAllowed(delta.expressionChoice,['mode','reason'],'expression choice');
    oneOf(delta.expressionChoice.mode,['direct','withhold','redirect','mask','unspecified'],'expression choice');
    const reason=delta.expressionChoice.reason??null;if(reason!==null)short(reason,'expression reason',512);
    expressionChoice={mode:delta.expressionChoice.mode,reason};
  }
  oneOf(delta.observationDisposition,['handled','deferred'],'observation disposition');
  return {changes:delta.changes,residency,expressionChoice,observationDisposition:delta.observationDisposition,...(attention?{attention:delta.attention}:{})};
}

export function stateCard(record,{historical=false,detail=false}={}) {
  if(detail)return {ref:{id:record.id,revision:record.revision},historical,record};
  return {ref:{id:record.id,revision:record.revision},historical,kind:record.kind,body:record.body,status:record.status,
    scope:record.scope,nature:record.nature,asOf:record.recordedAt,basisStatus:record.basis===null?'unspecified':'recorded',...(record.mind?{mind:record.mind}:{}),...(record.anchor?{anchor:record.anchor}:{}),...(record.nextStep?{nextStep:record.nextStep}:{}),...(record.checkpoint?{checkpoint:record.checkpoint}:{})};
}
