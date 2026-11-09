import {readFileSync} from 'node:fs';
import {canonical,digest,ensure,text,time,uniqueRefs,refKey,oneOf} from './contracts.mjs';
import {normalizeStateDelta} from './personal-state.mjs';
import {attentionDelta} from './attention.mjs';
import {withMindInstructions} from './mind-prompt.mjs';
import {normalizeAnchor} from './anchor.mjs';
export const maintenanceScheduleId=subject=>`maintenance-schedule:${digest(subject)}`;
export const maintenanceJobId=(subject,day)=>`maintenance-job:${digest({subject,day})}`;
export const MAINTENANCE_DEFAULTS={enabled:true,utcOffsetMinutes:480,hour:3,minute:30,maxCandidates:8,maxSources:8,scanLimit:32,maxInputBytes:32768,maxOutputBytes:16384,maxOutputTokens:2048};
const prompt=readFileSync(new URL('../prompts/maintenance.zh.md',import.meta.url),'utf8');
const focusPrompt=readFileSync(new URL('../prompts/decision-workbench-focus.zh.md',import.meta.url),'utf8');
export const pin=r=>({id:r.id,revision:r.revision});
export function exact(value,keys,name){ensure(value&&Object.getPrototypeOf(value)===Object.prototype&&canonical(Object.keys(value).sort())===canonical([...keys].sort()),'MAINTENANCE_SHAPE',`${name} fields do not match`);}
export function maintenancePolicy(value=MAINTENANCE_DEFAULTS){
  exact(value,Object.keys(MAINTENANCE_DEFAULTS),'maintenance policy');ensure(typeof value.enabled==='boolean','MAINTENANCE_POLICY','enabled must be boolean');
  const limits={utcOffsetMinutes:[-720,840],hour:[0,23],minute:[0,59],maxCandidates:[1,16],maxSources:[0,16],scanLimit:[1,64],maxInputBytes:[4096,65536],maxOutputBytes:[1024,32768],maxOutputTokens:[128,4096]};
  for(const [key,[min,max]] of Object.entries(limits))ensure(Number.isSafeInteger(value[key])&&value[key]>=min&&value[key]<=max,'MAINTENANCE_POLICY',`invalid ${key}`);
  return {...value};
}
export function maintenanceSlot(now,policy){time(now);const p=maintenancePolicy(policy),local=new Date(now+p.utcOffsetMinutes*60000);
  return {day:local.toISOString().slice(0,10),due:p.enabled&&local.getUTCHours()*60+local.getUTCMinutes()>=p.hour*60+p.minute};}
export function maintenancePacket(payload,policy){
  const base=prompt+(payload.continuity?.attention?.focusSupport?.enabled?'\n\n'+focusPrompt:'');
  const instruction=payload.continuity?.mind?withMindInstructions(base):base;
  const p=maintenancePolicy(policy),stage='personalMaintenance',packetId=digest({stage,instruction,payload});
  const messages=[{role:'system',content:instruction},{role:'user',content:canonical({packetId,...payload})}],bytes=Buffer.byteLength(canonical(messages));
  ensure(bytes<=p.maxInputBytes,'MAINTENANCE_OVERFLOW','complete maintenance messages exceed budget',{bytes,budget:p.maxInputBytes});
  return {stage,packetId,payload,instruction,messages,bytes};
}
export function verifyMaintenancePacket(packet,policy){const actual=maintenancePacket(packet.payload,policy);
  ensure(canonical(actual)===canonical(packet),'PACKET_CHANGED','maintenance input changed');return actual;}
export function maintenanceModelInput(packet,policy){verifyMaintenancePacket(packet,policy);return {packetId:packet.packetId,messages:JSON.parse(canonical(packet.messages)),bytes:packet.bytes};}
export function maintenanceOutput(raw,packet,policy){
  const p=maintenancePolicy(policy),encoded=typeof raw==='string'?raw:canonical(raw);
  ensure(Buffer.byteLength(encoded)<=p.maxOutputBytes,'MAINTENANCE_OVERFLOW','maintenance output too large');let out;
  try{out=JSON.parse(encoded);}catch{ensure(false,'OUTPUT_JSON','maintenance requires final JSON');}
  out.links=out.links??[];
  exact(out,['packetId','disposition','summary','changes','attention','noteUpdates','observations','requests','links'],'maintenance output');
  ensure(out.packetId===packet.packetId,'WRONG_PACKET','maintenance output belongs to another input');
  ensure(['keep','update','defer'].includes(out.disposition),'MAINTENANCE_SHAPE','invalid disposition');text(out.summary,'maintenance summary');ensure([...out.summary].length<=400,'MAINTENANCE_LIMIT','summary too long');
  const delta=normalizeStateDelta({changes:out.changes,residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'deferred',attention:out.attention},{attention:true});
  attentionDelta(out.attention);
  for(const c of delta.changes)ensure(c.nature!=='encounter','MAINTENANCE_ENCOUNTER','maintenance is not a new encounter');
  ensure(out.attention.questions.every(q=>!['open','followup'].includes(q.op)),'MAINTENANCE_ACTION','background review cannot send or ask a new question');
  ensure(Array.isArray(out.noteUpdates)&&out.noteUpdates.length<=4&&Array.isArray(out.observations)&&out.observations.length<=16
    &&Array.isArray(out.requests)&&out.requests.length<=4,'MAINTENANCE_LIMIT','bounded updates and information needs required');
  out.requests.forEach(r=>{text(r,'information need');ensure([...r].length<=240,'MAINTENANCE_LIMIT','information need too long');});
  const allowed=new Map([...packet.payload.materials.map(m=>[refKey(m.ref),m.record]),...packet.payload.sources.map(m=>[refKey(m.ref),m.record])]);
  const ids=new Set();
  for(const u of out.noteUpdates){
    u.anchor=u.anchor??null;
    exact(u,['id','expectedRevision','body','kind','change','confidence','status','scope','evidence','anchor'],'note update');text(u.id,'note id');text(u.body,'note body');
    ensure(!ids.has(u.id)&&[...u.body].length<=4000,'MAINTENANCE_LIMIT','duplicate or oversized note update');ids.add(u.id);
    ensure(Number.isSafeInteger(u.expectedRevision)&&u.expectedRevision>=0,'MAINTENANCE_SHAPE','invalid note revision');
    if(u.expectedRevision>0)ensure(allowed.get(refKey({id:u.id,revision:u.expectedRevision}))?.type==='note','UNREAD_TARGET','read note before updating it');
    ensure(uniqueRefs(u.evidence).every(r=>allowed.has(refKey(r))&&['note','event'].includes(allowed.get(refKey(r)).type)),'UNDELIVERED_BASIS','note evidence must have been delivered');
    exact(u.scope,['scenes','people','validFrom','validUntil'],'scope');
    normalizeAnchor(u.anchor??null);
  }
  const seen=new Set();for(const u of out.observations){exact(u,['ref','status'],'observation disposition');uniqueRefs([u.ref]);
    ensure(!seen.has(refKey(u.ref))&&['handled','deferred'].includes(u.status),'MAINTENANCE_SHAPE','duplicate or invalid observation disposition');seen.add(refKey(u.ref));
    ensure(packet.payload.pendingObservations.some(o=>refKey(o.ref)===refKey(u.ref)),'UNDELIVERED_REFERENCE','only delivered pending observations can be handled');}
  const changed=out.changes.length+out.noteUpdates.length+out.observations.length+out.attention.processes.length+out.attention.relations.length+
    out.attention.residency.upsert.length+out.attention.residency.remove.length+out.attention.questions.length+(out.attention.focus?.select!==undefined&&out.attention.focus.select!==null?1:0)+out.links.length;
  ensure(out.disposition==='update'?changed>0:changed===0,'MAINTENANCE_SHAPE','keep/defer cannot hide mutations');
  ensure(Array.isArray(out.links)&&out.links.length<=8,'MAINTENANCE_LIMIT','bounded links required');
  for(const l of out.links){exact(l,['from','to','relation'],'link');ensure(allowed.has(refKey(l.from))&&allowed.has(refKey(l.to))&&['event','note'].includes(allowed.get(refKey(l.from)).type)&&['event','note'].includes(allowed.get(refKey(l.to)).type),'UNDELIVERED_BASIS','link endpoints must be delivered');oneOf(l.relation,['related','similar','supports','contradicts'],'link relation');}
  return {out,delta};
}
