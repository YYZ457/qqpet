import {canonical,digest,ensure} from './contracts.mjs';
import {focusedMaintenanceInput,expandFocusedMaintenance} from './maintenance-adapter.mjs';
// Public final proposals only; never a provider envelope or hidden reasoning.
export function focusedAuditPacket(wire,phase,value,previous=null){
 focusedMaintenanceInput(wire);ensure(['raw','expanded'].includes(phase),'AUDIT_PHASE','unknown audit phase');
 const bytes=Buffer.byteLength(typeof value==='string'?value:canonical(value));
 ensure(bytes<=wire.policy.maxOutputBytes,'MAINTENANCE_OVERFLOW','audit output exceeds bound');
 if(phase==='raw'){
  let parsed=null;try{parsed=typeof value==='string'?JSON.parse(value):value;}catch{}
  ensure(!parsed||!['reasoning_content','reasoning','analysis','chain_of_thought','api_key','authorization'].some(k=>Object.hasOwn(parsed,k)),
   'CLIENT_OUTPUT_ENVELOPE','provider envelope cannot enter final-proposal audit');
 }
 const stage='focusedMaintenanceAudit-v1',payload={phase,corePacketId:wire.basePacket.packetId,wirePacketId:wire.packetId,previous,value};
 return {stage,packetId:digest({stage,payload}),payload};
}
export function checkFocusedConversion(wire,rawPacket,expandedPacket){
 try{
  focusedMaintenanceInput(wire);
  const raw=focusedAuditPacket(wire,'raw',rawPacket.payload.value);
  ensure(canonical(raw)===canonical(rawPacket),'AUDIT_CHANGED','raw audit changed');
  const expected=expandFocusedMaintenance(wire,raw.payload.value);
  const expanded=focusedAuditPacket(wire,'expanded',expected,raw.packetId);
  ensure(canonical(expanded)===canonical(expandedPacket),'AUDIT_CHANGED','expanded proposal differs from deterministic conversion');
  return {status:'conversion-verified',rawPacketId:raw.packetId,expandedPacketId:expanded.packetId,
   meaning:'exact recorded proposal and mechanical conversion, not semantic truth or adoption'};
 }catch(error){return {status:'not-verified',errorCode:error.code??'AUDIT_INVALID',meaning:'missing, invalid or mismatched evidence is not success'};}
}
