import {MaintenanceSession} from './maintenance.mjs';
import {focusedMaintenancePacket,focusedMaintenanceInput,expandFocusedMaintenance} from './maintenance-adapter.mjs';
import {ensure} from './contracts.mjs';
import {failureMetadata,outputMetrics} from './debug-contract.mjs';
import {focusedAuditPacket} from './focused-audit.mjs';

// Opt-in adapter. The original session owns scheduling, dispatch, concurrency,
// transactions and version checks. No provider, credential or extra model call.
export class FocusedMaintenanceSession {
 #base;#store;#focus;
 #rotation(job){return [...this.#store.all('maintenance_job')].filter(j=>j.subject===job.subject&&j.id!==job.id&&j.calls>0).length;}
 constructor({store,subjectId,identity='',policy,focusMode='auto'}){
  ensure(['auto','experience','appraisal','cleanup'].includes(focusMode),'FOCUS_MODE','unknown focus');
  this.#store=store;this.#focus=focusMode;
  this.#base=new MaintenanceSession({store,subjectId,identity,...(policy?{policy}:{})});
 }
 inspect(args){
  const result=this.#base.inspect(args);
  if(result.status!=='ready')return result;
  const packet=focusedMaintenancePacket(result.job.packet,result.job.policy,{focusMode:this.#focus,rotation:this.#rotation(result.job)});
  return {...result,modelPacket:packet};
 }
 configure(args){return this.#base.configure(args);}
 adopt(args){return this.#base.adopt(args);}
 tick({invoke=null,...args}={}){
  if(invoke===null)return this.#base.tick(args);
  ensure(typeof invoke==='function','FOCUS_CLIENT','invoke must be callable');
  return this.#base.tick({...args,invoke:async(input,options)=>{
   const job=[...this.#store.all('maintenance_job')].find(j=>j.packet.packetId===input.packetId);
   ensure(job,'MAINTENANCE_JOB','exact dispatched job required');
   const packet=focusedMaintenancePacket(job.packet,job.policy,{focusMode:this.#focus,rotation:this.#rotation(job)});
   const context={jobId:job.id,subjectId:job.subject,packetId:packet.packetId};
   const snapshot=this.#store.captureDebugPacket(packet);
   this.#store.recordDiagnostic({stage:'maintenance.focused-input',status:'ok',context,
    data:{bytes:packet.bytes,snapshot,reason:packet.focus,source:{corePacketId:job.packet.packetId,
     delivered:packet.payload.references.map(r=>({key:r.key,ref:r.ref,type:r.type})),omissions:packet.payload.omissions}}});
   ensure(['captured','already-captured'].includes(snapshot),'AUDIT_UNAVAILABLE','cannot call model without its exact input record');
   let raw;
   try{raw=await invoke(focusedMaintenanceInput(packet),{...options,focusMode:packet.focus});}
   catch(error){this.#store.recordDiagnostic({stage:'maintenance.focused-client',status:'uncertain',context,data:failureMetadata(error,{client:true})});throw error;}
   this.#store.recordDiagnostic({stage:'maintenance.focused-output',status:'completed',context,data:outputMetrics(raw)});
   try{
    const original=focusedAuditPacket(packet,'raw',raw),rawSnapshot=this.#store.captureDebugPacket(original);
    this.#store.recordDiagnostic({stage:'maintenance.focused-raw',status:'ok',context,data:{snapshot:rawSnapshot,source:original.packetId}});
    ensure(['captured','already-captured'].includes(rawSnapshot),'AUDIT_UNAVAILABLE','cannot submit without original final proposal');
    const expanded=expandFocusedMaintenance(packet,raw),audit=focusedAuditPacket(packet,'expanded',expanded,original.packetId),expandedSnapshot=this.#store.captureDebugPacket(audit);
    this.#store.recordDiagnostic({stage:'maintenance.focused-converted',status:'ok',context,data:{snapshot:expandedSnapshot,source:audit.packetId}});
    ensure(['captured','already-captured'].includes(expandedSnapshot),'AUDIT_UNAVAILABLE','cannot submit without converted proposal');
    return expanded;
   }
   catch(error){this.#store.recordDiagnostic({stage:'maintenance.focused-adapter',status:'rejected',context,data:failureMetadata(error)});throw error;}
  }});
 }
}
