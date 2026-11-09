// Host-driven maintenance. No default provider, credentials, user notification or personal tick event.
import {canonical,digest,ensure,refKey,uniqueRefs} from './contracts.mjs';
import {randomUUID} from 'node:crypto';
import {packetContext,failureMetadata,outputMetrics} from './debug-contract.mjs';
import {attentionId,attentionView,activeRelations} from './attention.mjs';
import {stateCard} from './personal-state.mjs';
import {mindProjection} from './mind.mjs';
import {MAINTENANCE_DEFAULTS,maintenancePolicy,maintenanceScheduleId,maintenanceJobId,maintenanceSlot,maintenancePacket,maintenanceModelInput,pin} from './maintenance-protocol.mjs';

const clone=x=>JSON.parse(canonical(x));
const rotate=(items,after)=>{const sorted=[...items].sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);return [...sorted.filter(i=>after===null||i.key>after),...sorted.filter(i=>after!==null&&i.key<=after)];};
function prepareSnapshot(store,subjectId,schedule,identity){
  return store.view(()=>{
    const subject=store.read(subjectId),frame=store.read(attentionId(subjectId)),now=store.clockNow(),policy=schedule.policy;
    ensure(subject?.type==='subject'&&frame?.type==='attention_frame','ATTENTION_REQUIRED','maintenance requires the explicit event/residence mode');
    const view=attentionView(frame,{read:(id,rev)=>store.read(id,rev),currentEvent:null,workbenchFocus:Boolean(frame.focus)}).metadata;
    const recordBudget=Math.floor(policy.maxInputBytes/2);
    const rows=store.maintenancePage({subjectId,after:schedule.cursors.objects,limit:policy.scanLimit,maxRecordBytes:recordBudget});
    let inbox=store.subjectInbox({subjectId,afterSeq:Number(schedule.cursors.inbox??0),limit:policy.scanLimit});
    if(!inbox.items.length&&schedule.cursors.inbox!==null)inbox=store.subjectInbox({subjectId,limit:policy.scanLimit});
    const experiences=store.maintenanceExperiences({subjectId,afterSeq:Number(schedule.cursors.experiences??0),limit:policy.scanLimit});
    const stale=frame.relations.filter(r=>r.status==='active'&&!activeRelations(frame).some(x=>x.id===r.id));
    const lanes={residences:rotate([
      ...frame.residences.map(r=>({key:`r:${r.id}`,kind:'residence',record:r,reasons:[r.cueFor&&refKey(r.cueFor)!==refKey(r.target.ref)?'outdated-entry':'resident-to-reconsider']})),
      ...stale.map(r=>({key:`e:${r.id}`,kind:'relation',record:r,reasons:['endpoint-version-changed']}))],schedule.cursors.residences),
      questions:rotate(frame.questions.filter(q=>['open','suspended'].includes(q.status)).map(q=>({key:q.id,kind:'question',record:q,reasons:['unresolved-question']})),schedule.cursors.questions),
      inbox:inbox.items.map(i=>({key:String(i.seq),kind:'event',record:store.readBounded(i.eventId,undefined,recordBudget),inbox:i,reasons:['unhandled-observation']})),
      experiences:experiences.items.map(i=>({key:String(i.seq),kind:'event',record:store.readBounded(i.eventId,undefined,recordBudget),inbox:i,reasons:['encounter-not-yet-reviewed']})),
      objects:rows.map(r=>({key:r.id,kind:r.type==='note'?'note':'state',record:r,reasons:[r.kind==='tension'?'unresolved-tension':'retained-view-to-reconsider']}))};
    const cursor={...schedule.cursors},selected=[],omitted=[],covered=[];
    const build=items=>{
      const states=new Map(),materials=new Map(),sourceSeeds=[],processes=new Map(),relations=new Map(),residences=[],questions=[],pending=[];
      const addMaterial=r=>{if(['event','note'].includes(r.type)){materials.set(refKey(r),{ref:pin(r),record:r,historical:store.read(r.id).revision!==r.revision});if(r.type==='note')sourceSeeds.push(...r.evidence);}};
      for(const item of items){const r=item.record;
        if(item.kind==='state'){states.set(refKey(r),stateCard(r));const b=r.basis;sourceSeeds.push(...(b?.observations??[]),...(b?.memories??[]));}
        if(['event','note'].includes(item.kind))addMaterial(r);
        if(item.kind==='event'&&item.inbox.status!=='handled')pending.push({ref:pin(r),seq:item.inbox.seq,status:item.inbox.status});
        if(item.kind==='residence'){
          residences.push(clone(r));if(r.target.kind==='process'){const p=frame.processes.find(p=>p.id===r.target.ref.id);processes.set(p.id,p);}
          else if(r.target.kind==='material')sourceSeeds.push(r.target.ref);
          else {const s=store.read(r.target.ref.id,r.target.ref.revision);states.set(refKey(s),stateCard(s));sourceSeeds.push(...(s.basis?.observations??[]),...(s.basis?.memories??[]));}
        }
        if(item.kind==='relation'){relations.set(r.id,r);for(const end of [r.from,r.to]){const p=frame.processes.find(p=>p.id===end.id);if(p)processes.set(p.id,p);}}
        if(item.kind==='question')questions.push(view.questions.find(q=>q.id===r.id));
      }
      // Supply only directly declared sources; never silently substitute a newly generated summary.
      const sources=[],missingSources=[],seen=new Set(materials.keys());
      for(const source of sourceSeeds){const key=refKey(source);if(seen.has(key))continue;seen.add(key);
        const r=store.readBounded(source.id,source.revision,recordBudget);
        if(!r||!['event','note'].includes(r.type)){missingSources.push({ref:source,reason:'unavailable-or-wrong-type'});continue;}
        if(r.omitted){missingSources.push({ref:source,reason:r.omitted});continue;}
        if(sources.length>=policy.maxSources){missingSources.push({ref:source,reason:'source-budget'});continue;}
        sources.push({ref:pin(r),record:r,historical:store.read(r.id).revision!==r.revision});
      }
      const heads=[...materials.values(),...sources].filter(x=>!x.historical).map(x=>x.ref);
      const responses=questions.flatMap(q=>q.attempts.map(a=>a.ref));
      const mind=[...states.values()].some(s=>s.mind)?mindProjection({records:[...states.values()].map(s=>store.read(s.ref.id,s.ref.revision)),readHead:id=>store.read(id)}):null;
      return {format:'agent-maintenance-v1',identity,subject:pin(subject),generatedAt:now,day:maintenanceSlot(now,policy).day,
        kind:'host-maintenance-opportunity-not-personal-experience',candidates:items.map(i=>({key:i.key,lane:i.lane,kind:i.kind,reasons:i.reasons})),
        continuity:{subject:pin(subject),maxForeground:subject.maxForeground,foreground:[],recalled:[...states.values()],...(mind?{mind}:{}),attention:{frame:pin(frame),residences,
          processes:[...processes.values()],relations:[...relations.values()].filter(r=>activeRelations(frame).some(e=>e.id===r.id)),staleRelations:[...relations.values()].filter(r=>!activeRelations(frame).some(e=>e.id===r.id)),questions,
          ...(frame.focus?{focusSupport:view.focusSupport,materialSupport:{enabled:true,format:'purpose-material-v1'}}:{})}},
        materials:[...materials.values()],sources,missingSources,pendingObservations:pending,
        presentedEncounters:items.filter(i=>i.kind==='event').map(i=>({ref:pin(i.record),seq:i.inbox.seq})),
        guards:{subject:pin(subject),attention:pin(frame),foregroundEpoch:schedule.foregroundEpoch,heads:[...new Map([...heads,...[...states.values()].map(s=>s.ref),...responses].map(r=>[refKey(r),r])).values()],
          observations:pending.map(x=>({ref:x.ref,status:x.status}))},
        omissions:omitted,cursors:cursor,nextLane:items.length?(Object.keys(lanes).indexOf(items.at(-1).lane)+1)%Object.keys(lanes).length:schedule.nextLane};
    };
    // Round-robin between lanes; successful review advances only selected positions, not an unseen page.
    const names=Object.keys(lanes),order=[...names.slice(schedule.nextLane),...names.slice(0,schedule.nextLane)];
    const positions=Object.fromEntries(names.map(k=>[k,0]));let advanced=true;
    while(selected.length<policy.maxCandidates&&advanced){advanced=false;
      for(const lane of order){
        const item=lanes[lane][positions[lane]++];if(!item)continue;advanced=true;
        if(item.record.omitted){omitted.push({lane,key:item.key,reason:item.record.omitted});continue;}
        if(item.kind==='event'&&selected.some(s=>s.kind==='event'&&s.record.id===item.record.id)){covered.push({lane,key:item.key,id:item.record.id});cursor[lane]=item.key;continue;}
        const candidate={...item,lane},oldCursor=cursor[lane];cursor[lane]=item.key;
        try{maintenancePacket(build([...selected,candidate]),policy);selected.push(candidate);}
        catch(error){cursor[lane]=oldCursor;if(error.code!=='MAINTENANCE_OVERFLOW')throw error;omitted.push({lane,key:item.key,reason:'input-budget'});}
        if(selected.length===policy.maxCandidates)break;
      }
    }
    if(!selected.length)return {status:omitted.length?'oversized':'empty',omissions:omitted};
    // Omission diagnostics themselves are bounded; otherwise a small budget could grow its own error payload.
    if(omitted.length>16)omitted.splice(16);
    while(selected.length){
      for(const lane of Object.keys(cursor)){
        cursor[lane]=schedule.cursors[lane];for(const item of selected)if(item.lane===lane)cursor[lane]=item.key;
        for(const item of covered)if(item.lane===lane&&selected.some(s=>s.kind==='event'&&s.record.id===item.id))cursor[lane]=String(Math.max(Number(cursor[lane]??0),Number(item.key)));
      }
      try{return {status:'ready',packet:maintenancePacket(build(selected),policy)};}
      catch(error){if(error.code!=='MAINTENANCE_OVERFLOW')throw error;selected.pop();}
    }
    return {status:'oversized',omissions:omitted};
  });
}

export class MaintenanceSession {
  #store;#subjectId;#identity;#running=null;
  constructor({store,subjectId,policy=MAINTENANCE_DEFAULTS,identity=''}){
    ensure(typeof identity==='string'&&[...identity].length<=4000,'MAINTENANCE_LIMIT','bounded host identity required');
    this.#store=store;this.#subjectId=subjectId;this.#identity=identity;const normalized=maintenancePolicy(policy);
    store.execute({requestId:`maintenance-init:${digest({subjectId,policy:normalized})}`,commands:[{op:'initialize_maintenance',subjectId,policy:normalized}]});
  }
  configure({policy}){
    const schedule=this.#store.read(maintenanceScheduleId(this.#subjectId)),normalized=maintenancePolicy(policy);
    return this.#store.execute({requestId:`maintenance-config:${digest({schedule:pin(schedule),policy:normalized})}`,
      commands:[{op:'configure_maintenance',schedule:pin(schedule),policy:normalized}]}).at(-1);
  }
  inspect({busy=false}={}){
    ensure(typeof busy==='boolean','MAINTENANCE_POLICY','host busy flag must be boolean');
    const schedule=this.#store.read(maintenanceScheduleId(this.#subjectId)),now=this.#store.clockNow(),slot=maintenanceSlot(now,schedule.policy);
    if(!schedule.policy.enabled)return {status:'disabled'};
    if(now<schedule.lastObservedAt)return {status:'clock-regressed'};
    if(!slot.due)return {status:'not-due'};if(busy)return {status:'busy'};
    const existing=this.#store.read(maintenanceJobId(this.#subjectId,slot.day));
    if(existing&&existing.status!=='prepared')return {status:existing.status,job:existing,modelCalled:false};
    const draft=prepareSnapshot(this.#store,this.#subjectId,schedule,this.#identity);if(draft.status!=='ready')return draft;
    const job=this.#store.execute({requestId:`maintenance-prepare:${draft.packet.packetId}`,commands:[{op:'prepare_maintenance',subjectId:this.#subjectId,packet:draft.packet}]}).at(-1);
    return {status:job.status==='prepared'?'ready':job.status,job,modelCalled:false};
  }
  tick(args={}){
    if(this.#running)return this.#running;
    this.#running=this.#tick(args).finally(()=>{this.#running=null;});return this.#running;
  }
  async #tick({busy=false,invoke=null,authorize=null,autoAdopt=true}={}){
    ensure(typeof autoAdopt==='boolean','MAINTENANCE_POLICY','autoAdopt must be boolean');
    const inspected=this.inspect({busy});if(inspected.status!=='ready'||invoke===null)return inspected;
    ensure(typeof invoke==='function'&&typeof authorize==='function','MAINTENANCE_BUDGET_REQUIRED','host metering client and budget gate are both required');
    const job=inspected.job;
    if(await authorize({category:'autonomous-maintenance',maxCalls:1,inputBytes:job.packet.bytes,maxOutputBytes:job.policy.maxOutputBytes,maxOutputTokens:job.policy.maxOutputTokens})!==true)
      return {status:'budget-deferred',job,modelCalled:false};
    let dispatched;
    const claimId=randomUUID();
    try{dispatched=this.#store.execute({requestId:`dispatch:${job.id}:${claimId}`,commands:[{op:'dispatch_maintenance',job:pin(job),claimId}]}).at(-1);}
    catch(error){if(['VERSION_CONFLICT','MAINTENANCE_STALE'].includes(error.code))return {status:'needs-refresh',modelCalled:false};throw error;}
    let raw;
    this.#store.captureDebugPacket(dispatched.packet);
    const debugContext=packetContext(dispatched.packet,{subjectId:this.#subjectId,jobId:dispatched.id}),debugStart=performance.now();
    this.#store.recordDiagnostic({stage:'maintenance.model-started',status:'started',context:debugContext,data:{modelCalled:true,bytes:dispatched.packet.bytes}});
    try{raw=await invoke(maintenanceModelInput(dispatched.packet,dispatched.policy),{category:'autonomous-maintenance',maxOutputTokens:job.policy.maxOutputTokens,automaticRetries:0});}
    catch(error){this.#store.recordDiagnostic({stage:'maintenance.model-failed',status:'uncertain',context:debugContext,data:{...failureMetadata(error,{client:true}),durationMs:Math.round(performance.now()-debugStart)}});
      const uncertain=this.#finish(dispatched,'uncertain','client-error');return {status:'uncertain',job:uncertain,modelCalled:true};}
    this.#store.recordDiagnostic({stage:'maintenance.model-completed',status:'completed',context:debugContext,data:{...outputMetrics(raw),durationMs:Math.round(performance.now()-debugStart)}});
    let envelope=raw;
    if(typeof raw==='string'){try{envelope=JSON.parse(raw);}catch{envelope=null;}}
    if(envelope&&typeof envelope==='object'&&['reasoning_content','reasoning','analysis','chain_of_thought'].some(key=>Object.hasOwn(envelope,key))){
      this.#store.recordDiagnostic({stage:'maintenance.output-rejected',status:'rejected',context:debugContext,data:{errorCode:'CLIENT_OUTPUT_ENVELOPE'}});
      return {status:'failed',job:this.#finish(dispatched,'failed','CLIENT_OUTPUT_ENVELOPE'),modelCalled:true};
    }
    let proposed;
    try{proposed=this.#store.execute({requestId:`capture:${job.id}`,commands:[{op:'capture_maintenance',job:pin(dispatched),output:raw}]}).at(-1);}
    catch(error){const failed=this.#finish(dispatched,'failed',error.code??'invalid-output');return {status:'failed',job:failed,modelCalled:true};}
    if(!autoAdopt)return {status:'proposed',job:proposed,modelCalled:true};
    return {...this.adopt({job:pin(proposed)}),modelCalled:true};
  }
  adopt({job}){
    uniqueRefs([job]);ensure(this.#store.read(job.id,job.revision)?.subject===this.#subjectId,'SUBJECT_MISMATCH','maintenance proposal belongs to another subject');
    try{const result=this.#store.execute({requestId:`adopt:${job.id}:${job.revision}`,commands:[{op:'adopt_maintenance',job}]}).at(-1);return {status:result.status,job:result};}
    catch(error){const current=this.#store.read(job.id);if(current?.status==='proposed')return {status:['MAINTENANCE_STALE','STALE_SUBJECT','STALE_ATTENTION','STALE_STATE','STALE_DELIVERY','VERSION_CONFLICT'].includes(error.code)?'stale':'rejected',
      job:this.#finish(current,['MAINTENANCE_STALE','STALE_SUBJECT','STALE_ATTENTION','STALE_STATE','STALE_DELIVERY','VERSION_CONFLICT'].includes(error.code)?'stale':'failed',error.code??'invalid-proposal')};throw error;}
  }
  #finish(job,status,code){return this.#store.execute({requestId:`finish:${job.id}:${job.revision}:${status}`,commands:[{op:'finish_maintenance',job:pin(job),status,code}]}).at(-1);}
}

export function startMaintenanceHeartbeat({session,isBusy,invoke=null,authorize=null,intervalMs=60000,onResult=()=>{},onError=()=>{}}){
  ensure(session instanceof MaintenanceSession&&typeof isBusy==='function'&&Number.isSafeInteger(intervalMs)&&intervalMs>=1000&&intervalMs<=3600000,'MAINTENANCE_POLICY','bounded host heartbeat required');
  let stopped=false,pending=false;
  const tick=async()=>{if(stopped||pending)return;pending=true;try{const result=await session.tick({busy:await isBusy(),invoke,authorize});if(!stopped)onResult(result);}catch(error){if(!stopped)onError(error);}finally{pending=false;}};
  const timer=setInterval(tick,intervalMs);timer.unref();return {tick,stop(){stopped=true;clearInterval(timer);}};
}
