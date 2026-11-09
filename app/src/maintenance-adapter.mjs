import {canonical,digest,ensure,refKey} from './contracts.mjs';
import {maintenanceModelInput,maintenanceOutput,exact} from './maintenance-protocol.mjs';
import {keepAttention} from './attention.mjs';
import {withMindInstructions} from './mind-prompt.mjs';
import {referenceMenu,referenceTargetMenu,resolveReferenceKey} from './reference-menu.mjs';
const clone=x=>JSON.parse(canonical(x)),pin=r=>({id:r.id,revision:r.revision});
const modes=['experience','appraisal','cleanup'];
const rules={
 experience:'回顾实际经历与执行回执，判断是否有值得保留、适用范围明确的经验。可不改，不因没有情绪变化而否定技术经验。notes每项含target、body、kind、change、confidence、status、scope、references。target为已有笔记短名或新增{id,expectedRevision:0}；kind=fact_claim/interpretation/value/preference/dream/tension/feeling/skill；change=new_evidence/reinterpretation/self_report；confidence=tentative/uncertain/confident；status=current/suspended/historical；scope={scenes:[],people:[],validFrom:null,validUntil:null}；references为交付事件/笔记的短名数组。没有新来源不标new_evidence。',
 appraisal:'结合交付的经历与旧状态判断是否需要局部重评，允许矛盾或未决，允许无新外部证据的主观变化。states每项含target、nature、references，可含kind、body、status、scope、reason、mind；target为已有状态短名或新增{id,expectedRevision:0}。kind=feeling/appraisal/intention/tension/activity/concern/condition/expectation/readiness；nature=reappraisal/self-report/wording/unknown；status=open/suspended/closed；scope为字符串数组。references为交付事件、笔记或状态短名数组。主观变化不是新外部事实；不要求原谅、恢复、每天感悟。',
 cleanup:'只维护已交付工作台。cleanup每项为{op:"pause-process",id:"已交付过程ID",expectedRevision:当前版本}或{op:"remove-residence",id:"已交付驻留ID"}。暂停不改变其他过程、认识或关系，也不删除记忆。其他维护能力在requests里提出，本轮不执行。'
};
function modeFor(p,requested,rotation){
 ensure([...modes,'auto'].includes(requested),'FOCUS_MODE','unknown maintenance focus');
 if(requested!=='auto')return requested;
 const available=modes.filter(m=>m==='experience'?p.materials.length+p.sources.length>0:m==='appraisal'?p.continuity.recalled.length>0:
  p.continuity.attention.processes.length+p.continuity.attention.residences.length>0);
 ensure(available.length,'FOCUS_EMPTY','no applicable maintenance work');
 ensure(Number.isSafeInteger(rotation)&&rotation>=0,'FOCUS_MODE','host rotation must be nonnegative');
 return available[rotation%available.length];
}
export function focusedMaintenancePacket(packet,policy,{focusMode='auto',rotation=0}={}) {
 maintenanceModelInput(packet,policy);const p=packet.payload,focus=modeFor(p,focusMode,rotation),table=[];
 const register=r=>{const existing=table.find(x=>refKey(x.ref)===refKey(r));if(existing)return existing.key;
  const entry={key:'R'+(table.length+1),ref:pin(r),type:r.type};table.push(entry);return entry.key;};
 const materials=[...p.materials,...p.sources].filter((m,i,xs)=>xs.findIndex(x=>refKey(x.ref)===refKey(m.ref))===i).map(m=>({...clone(m),key:register(m.record)}));
 const states=focus==='experience'?[]:p.continuity.recalled.map(s=>{
  const r=s.record??{...s,...s.ref,type:'personal_state'};return {...clone(s),key:register(r)};
 });
 const attention=focus==='cleanup'?clone(p.continuity.attention):null;
 const payload={focus,identity:p.identity,asOf:p.generatedAt,kind:p.kind,materials,states,attention,
  ...(focus==='appraisal'&&p.continuity.mind?{mind:clone(p.continuity.mind)}:{}),
  pendingObservations:p.pendingObservations.filter(x=>table.some(r=>refKey(r.ref)===refKey(x.ref))),
  references:table,referenceUsage:referenceMenu(table),targetUsage:focus==='cleanup'?null:referenceTargetMenu(table,focus==='experience'?'note':'personal_state'),omissions:{sourceOmissions:p.missingSources,candidateOmissions:p.omissions,
   statesNotDelivered:focus==='experience'?p.continuity.recalled.length:0,attentionNotDelivered:focus!=='cleanup'}};
 let instruction='你在回顾自己的既有材料。维护机会不是新经历，交付的实际工具回执仍是其合成世界中的经历。只能修改本轮读到的版本，保留否定、范围、未知及事实/计划区别。只输出JSON，必须含packetId、summary(≤400字简短说明，不展示逐步思维)。无变化可省略全部操作，不必凑出认识。可选handled:["R1"]表示已理解该pending观察，requests:["尚缺的信息或能力"]不表示已经查询，defer:true仅限无修改。程序负责事务类型，不输出disposition。禁止输出未列明字段。'+rules[focus];
 instruction+=' references中的每项必须逐字复制referenceUsage.allowedValues里的本轮短名（如R1）；禁止填写ref.id或自造别名。referenceUsage.example仅是语法示例，不要求采用那条材料。已有对象的target必须逐字复制targetUsage.allowedExistingTargets，按existingExample写；target禁止填写record.id或ref.id。新对象才使用target={id:"新ID",expectedRevision:0}，按createExample写。修改已有笔记时references不得包含target自身，应列支撑本次变化的其他交付来源。';
 if(focus==='appraisal'&&payload.mind)instruction=withMindInstructions(instruction);
 const stage='focusedMaintenance-v1',packetId=digest({stage,base:packet.packetId,instruction,payload});
 const messages=[{role:'system',content:instruction},{role:'user',content:canonical({packetId,...payload})}],bytes=Buffer.byteLength(canonical(messages));
 ensure(bytes<=policy.maxInputBytes,'MAINTENANCE_OVERFLOW','complete focused input exceeds budget');
 return {stage,packetId,basePacket:packet,policy,focus,payload,instruction,messages,bytes};
}
export function focusedMaintenanceInput(packet){
 const actual=focusedMaintenancePacket(packet.basePacket,packet.policy,{focusMode:packet.focus});
 ensure(canonical(packet)===canonical(actual),'PACKET_CHANGED','focused input changed');
 return {packetId:packet.packetId,messages:clone(packet.messages),bytes:packet.bytes};
}
export function expandFocusedMaintenance(wire,raw){
 focusedMaintenanceInput(wire);
 ensure(Buffer.byteLength(typeof raw==='string'?raw:canonical(raw))<=wire.policy.maxOutputBytes,'MAINTENANCE_OVERFLOW','output too large');
 let out;try{out=typeof raw==='string'?JSON.parse(raw):clone(raw);}catch{ensure(false,'OUTPUT_JSON','final JSON required');}
 ensure(Buffer.byteLength(canonical(out))<=wire.policy.maxOutputBytes,'MAINTENANCE_OVERFLOW','output too large');
 const channel={experience:'notes',appraisal:'states',cleanup:'cleanup'}[wire.focus];
 ensure(out&&Object.getPrototypeOf(out)===Object.prototype&&Object.keys(out).every(k=>['packetId','summary',channel,'handled','requests','defer'].includes(k)),
  'FOCUS_OUTPUT','unsupported field or cross-focus operation');
 ensure(out.packetId===wire.packetId,'WRONG_PACKET','wrong focused snapshot');
 ensure(!Object.hasOwn(out,'defer')||typeof out.defer==='boolean','FOCUS_OUTPUT','defer must be boolean');
 const array=(key,max)=>{const xs=Object.hasOwn(out,key)?out[key]:[];ensure(Array.isArray(xs)&&xs.length<=max,'FOCUS_OUTPUT','bounded operation array required');return xs;};
 const lookup=key=>resolveReferenceKey(wire.payload.references,key);
 const references=(xs,types)=>{ensure(Array.isArray(xs)&&xs.length<=32,'FOCUS_OUTPUT','references must be an array');
  return [...new Map(xs.map(key=>{const x=lookup(key);ensure(types.includes(x.type),'REFERENCE_TYPE','basis type does not match operation');return [refKey(x.ref),x];})).values()];};
 const target=(value,type)=>{
  if(typeof value==='string'){const x=lookup(value);ensure(x.type===type,'REFERENCE_TYPE','wrong target type');return {id:x.ref.id,expectedRevision:x.ref.revision};}
  exact(value,['id','expectedRevision'],'new target');ensure(value.expectedRevision===0,'UNREAD_TARGET','existing targets require delivered short reference');return clone(value);
 };
 const result={packetId:wire.basePacket.packetId,summary:out.summary,changes:[],noteUpdates:[],attention:keepAttention(),observations:[],requests:array('requests',4)};
 if(wire.focus==='experience')for(const u of array('notes',4)){
  exact(u,['target','body','kind','change','confidence','status','scope','references'],'note proposal');
  const refs=references(u.references,['event','note']),{target:t,references:ignored,...fields}=u;
  result.noteUpdates.push({...fields,...target(t,'note'),evidence:refs.map(x=>x.ref)});
 }
 if(wire.focus==='appraisal')for(const u of array('states',16)){
  ensure(u&&Object.keys(u).every(k=>['target','nature','references','kind','body','status','scope','reason','mind'].includes(k)),'FOCUS_OUTPUT','unsupported state field');
  const refs=references(u.references,['event','note','personal_state']),{target:t,references:ignored,...fields}=u;
  result.changes.push({...fields,...target(t,'personal_state'),basis:{observations:refs.filter(x=>x.type==='event').map(x=>x.ref),
   memories:refs.filter(x=>x.type==='note').map(x=>x.ref),priorStates:refs.filter(x=>x.type==='personal_state').map(x=>x.ref)}});
 }
 if(wire.focus==='cleanup')for(const u of array('cleanup',16)){
  const a=wire.payload.attention;
  if(u.op==='remove-residence'){exact(u,['op','id'],'remove residence');ensure(a.residences.some(r=>r.id===u.id),'UNREAD_RESIDENCE','residence not delivered');result.attention.residency.remove.push(u.id);}
  else {
   exact(u,['op','id','expectedRevision'],'pause process');ensure(u.op==='pause-process','FOCUS_OUTPUT','unknown cleanup operation');
   const p=a.processes.find(p=>p.id===u.id);ensure(p&&p.revision===u.expectedRevision&&p.status==='active','UNREAD_PROCESS','read active process version before pausing');
   result.attention.processes.push({id:p.id,expectedRevision:p.revision,label:p.label,body:p.body,status:'paused',world:p.world,intervals:p.intervals,basis:p.basis});
  }
 }
 for(const key of array('handled',16)){const r=lookup(key);ensure(wire.payload.pendingObservations.some(p=>refKey(p.ref)===refKey(r.ref)),'UNDELIVERED_REFERENCE','not a delivered pending observation');result.observations.push({ref:r.ref,status:'handled'});}
 const changed=result.changes.length+result.noteUpdates.length+result.observations.length+result.attention.processes.length+result.attention.residency.remove.length;
 ensure(!(out.defer===true&&changed),'FOCUS_OUTPUT','defer cannot include modifications');result.disposition=changed?'update':out.defer?'defer':'keep';
 maintenanceOutput(result,wire.basePacket,wire.policy);return result;
}
