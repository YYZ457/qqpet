import * as sqlite from 'node:sqlite';
import {APPLICATION_ID} from './schema.mjs';
import {canonical,digest,ensure,refKey} from './contracts.mjs';
import {lookupResultId,normalizeLookupQuery} from './local-query.mjs';
import {normalizeStateDelta} from './personal-state.mjs';
import {checkFocusedConversion} from './focused-audit.mjs';
import {checkWaitDeclaration} from './wait-support.mjs';
const Database=sqlite.Database??sqlite.DatabaseSync;
const ref=r=>r?{id:r.id,revision:r.revision}:null;
const list=v=>Array.isArray(v)?v:[];
const bound=(v,max)=>ensure(Number.isSafeInteger(v)&&v>0&&v<=max,'DEBUG_LIMIT','bounded debug page required');
const navigationView=value=>value?{isPage:value.isPage??null,page:value.page??null,parentPage:value.parentPage??null,fromPage:value.fromPage??null,remaining:value.remaining??null,
  ...(value.menu?{menu:{currentPage:value.menu.currentPage,back:value.menu.back,forward:value.menu.forward.map(c=>({page:c.page,parentPage:c.parentPage,via:c.via})),
    omittedForward:value.menu.omittedForward,history:value.menu.history.map(c=>({page:c.page,parentPage:c.parentPage,via:c.via})),nextHistoryOffset:value.menu.nextHistoryOffset}}:{})}:null;
const consultationView=(value,includeContent)=>value?includeContent?value:{root:value.root,parent:value.parent,via:value.via,trail:value.trail,
  ...(value.navigation?{navigation:navigationView(value.navigation)}:{}),
  ...(value.discovery?{discovery:{method:value.discovery.method,total:value.discovery.total,scanLimited:value.discovery.scanLimited,
    scanned:value.discovery.scanned??null,channelCap:value.discovery.channelCap??null,
    candidates:value.discovery.items.map(c=>({ref:c.ref,type:c.type,representation:c.representation,channels:c.channels??[],currentHead:c.currentHead??null}))}}:{})}:null;
export function publicMaintenanceFinal(raw){
  if(raw===null||raw===undefined)return null;
  try{const out=typeof raw==='string'?JSON.parse(raw):raw;
    return Object.fromEntries(['packetId','disposition','summary','changes','attention','noteUpdates','observations','requests'].filter(k=>Object.hasOwn(out,k)).map(k=>[k,out[k]]));}
  catch{return {status:'unvalidated-raw-client-text-not-exported'};}
}

export function checkStoredInput(packet){
  if(!packet)return {available:false};
  try{
    const messages=[{role:'system',content:packet.instruction},{role:'user',content:canonical({packetId:packet.packetId,...packet.payload})}];
    const bytes=Buffer.byteLength(canonical(packet.messages));
    const budget=packet.budgetBytes??(packet.stage==='focusedMaintenance-v1'?packet.policy?.maxInputBytes:undefined);
    return {available:true,fingerprint:packet.packetId===digest({stage:packet.stage,
       ...(packet.stage==='focusedMaintenance-v1'?{base:packet.basePacket?.packetId}:{}),instruction:packet.instruction,payload:packet.payload}),
      messageBinding:canonical(messages)===canonical(packet.messages),byteCount:bytes===packet.bytes,
      withinBudget:budget===undefined?null:bytes<=budget,bytes,budgetBytes:budget??null,
      meaning:'checks-recorded-input-integrity-not-current-code-or-model-reasoning'};
  }catch{return {available:true,fingerprint:false,messageBinding:false,byteCount:false,withinBudget:null};}
}

export function checkFinalDeclaration(packet,output){
  if(!packet||!output)return {status:'no-final-proposal'};
  const checks=[];
  try{
    const out=typeof output==='string'?JSON.parse(output):output,p=packet.payload;
    ensure(out.packetId===packet.packetId,'WRONG_PACKET','output packet mismatch');checks.push('packet-binding');
    ensure(Array.isArray(out.options)&&out.options.length>0&&out.options.length<=8,'OUTPUT_SHAPE','bounded options required');
    const choice=out.options.find(o=>o.id===out.selected);ensure(choice&&['respond','lookup','act','continue','pause','wait'].includes(choice.kind),'INVALID_CHOICE','valid selected option required');checks.push('selected-option');
    if(choice.kind==='lookup'){normalizeLookupQuery(choice.payload);
      ensure(!choice.payload.consult||p.memoryAccess?.consultation?.enabled===true,'CONSULT_CAPABILITY','consultation capability missing');}
    if(choice.kind==='wait'&&p.waitSupport)checkWaitDeclaration(p.waitSupport,choice.payload);
    if(choice.kind==='act')ensure(p.allowedActionTools.includes(choice.payload.tool),'TOOL_NOT_GRANTED','action tool not granted');checks.push('selected-payload-route');
    const cards=[...list(p.continuity?.foreground),...list(p.continuity?.recalled)],materials=list(p.materials);
    const seen={observations:new Set([refKey(p.current),...materials.filter(m=>m.record.type==='event').map(m=>refKey(m.ref))]),priorStates:new Set(cards.map(c=>refKey(c.ref))),memories:new Set(materials.map(m=>refKey(m.ref)))};
    for(const use of list(out.used))ensure(materials.some(m=>refKey(m.ref)===refKey(use.ref)&&m.aspects.includes(use.aspect)),'UNDELIVERED_REFERENCE','used material not delivered');
    if(p.continuity){const delta=normalizeStateDelta(out.continuity,{attention:Boolean(p.continuity.attention)});
      for(const change of delta.changes)for(const kind of ['observations','priorStates','memories'])for(const basis of list(change.basis?.[kind]))
        ensure(seen[kind].has(refKey(basis)),'UNDELIVERED_BASIS','basis not delivered');}
    checks.push('declaration-shape-and-delivered-basis');return {status:'surface-contract-valid',checks,
      limitations:['not-a-store-commit-replay','no-current-version-or-semantic-correctness-proof']};
  }catch(error){return {status:'rejected',checks,errorCode:error.code??'OUTPUT_JSON_OR_SHAPE',limitations:['read-only-surface-check']};}
}

// This reader never calls ContinuityStore, upgrades a file, calls a provider or executes a proposal.
export class DebugArchive {
  #db;#version;#depth=0;
  constructor(path){
    this.#db=new Database(path,{readOnly:true,timeout:3000});
    try{
      ensure(this.#db.prepare('PRAGMA application_id').get().application_id===APPLICATION_ID,'FOREIGN_DATABASE','not a new-core archive');
      this.#version=this.#db.prepare('PRAGMA user_version').get().user_version;
      ensure(this.#version>=5&&this.#version<=10,'SCHEMA_VERSION','unsupported debug archive schema');
    }catch(error){this.#db.close();throw error;}
  }
  close(){this.#db.close();}
  #view(fn){const outer=this.#depth===0;if(outer)this.#db.exec('BEGIN');this.#depth++;try{const result=fn();if(outer)this.#db.exec('COMMIT');return result;}catch(e){if(outer)this.#db.exec('ROLLBACK');throw e;}finally{this.#depth--;}}
  #read(id,revision){
    if(typeof id!=='string')return null;
    const row=revision===undefined?this.#db.prepare('SELECT v.body FROM objects o JOIN versions v ON v.id=o.id AND v.revision=o.current_revision WHERE o.id=?').get(id)
      :this.#db.prepare('SELECT body FROM versions WHERE id=? AND revision=?').get(id,revision);
    return row?JSON.parse(row.body):null;
  }
  journal({subjectId=null,decisionId=null,packetId=null,jobId=null,afterSeq=0,limit=100}={}){
    bound(limit,200);ensure(Number.isSafeInteger(afterSeq)&&afterSeq>=0,'DEBUG_LIMIT','bounded journal cursor required');
    if(this.#version<8)return {items:[],nextAfterSeq:null,legacy:true};
    return this.#view(()=>{
      const filters=['seq>?'],args=[afterSeq];
      for(const [key,value] of [['subject_id',subjectId],['decision_id',decisionId],['packet_id',packetId],['job_id',jobId]])if(value!==null){filters.push(`${key}=?`);args.push(value);}
      const rows=this.#db.prepare(`SELECT seq,at,entry FROM debug_events WHERE ${filters.join(' AND ')} ORDER BY seq LIMIT ?`).all(...args,limit+1);
      return {items:rows.slice(0,limit).map(r=>({seq:r.seq,at:r.at,...JSON.parse(r.entry)})),nextAfterSeq:rows.length>limit?rows[limit-1].seq:null,legacy:false};
    });
  }
  overview(){return this.#view(()=>({schema:this.#version,readOnly:true,
    objects:this.#db.prepare('SELECT type,count(*) AS count FROM objects GROUP BY type ORDER BY type').all().map(x=>({...x})),
    diagnostics:this.#version<8?{available:false}:{...this.#db.prepare('SELECT count(*) AS count,min(seq) AS firstSeq,max(seq) AS lastSeq FROM debug_events').get()},
    snapshots:this.#version<8?{count:0,bytes:0}:{...this.#db.prepare('SELECT count(*) AS count,coalesce(sum(body_bytes),0) AS bytes FROM debug_packets').get()},
    limitations:['no-hidden-chain-of-thought','declared-basis-not-proof-of-influence','semantic-problems-need-case-review','no-provider-retry-or-action-replay']}));}
  turns({limit=12}={}){
    bound(limit,50);return this.#view(()=>{
      if(this.#version<8)return this.#db.prepare("SELECT v.body FROM objects o JOIN versions v ON o.id=v.id AND o.current_revision=v.revision WHERE o.type='decision' ORDER BY v.rowid DESC LIMIT ?").all(limit)
        .map(x=>{const d=JSON.parse(x.body);return {packetId:d.input.packetId,decisionId:d.id,subjectId:d.input.payload.continuity?.subject.id??null,lastSeq:null,at:d.recordedAt};});
      return this.#db.prepare(`SELECT packet_id AS packetId,max(seq) AS lastSeq,max(at) AS at,max(subject_id) AS subjectId FROM debug_events
        WHERE packet_id IS NOT NULL GROUP BY packet_id ORDER BY lastSeq DESC LIMIT ?`).all(limit).map(x=>({...x}));
    });
  }
  #findDecision(packetId){
    if(!packetId)return null;
    if(this.#version>=8){
      const rows=this.#db.prepare('SELECT decision_id AS id FROM debug_events WHERE packet_id=? AND decision_id IS NOT NULL GROUP BY decision_id ORDER BY max(seq) DESC LIMIT 32').all(packetId);
      for(const r of rows){const d=this.#read(r.id);if(d?.type==='decision')return d;}
    }
    const row=this.#db.prepare(`SELECT v.body FROM objects o JOIN versions v ON v.id=o.id AND v.revision=o.current_revision
      WHERE o.type='decision' AND json_extract(v.body,'$.input.packetId')=? ORDER BY v.rowid DESC LIMIT 1`).get(packetId);
    return row?JSON.parse(row.body):null;
  }
  inspect({decisionId=null,packetId=null,includeContent=false,nextDecisionId=null}={}){
    ensure(typeof includeContent==='boolean'&&(decisionId===null||typeof decisionId==='string'&&decisionId.trim().length>0)
      &&(packetId===null||typeof packetId==='string'&&packetId.trim().length>0)&&(decisionId!==null||packetId!==null),'DEBUG_SELECTION','choose a nonempty decision or prepared packet');
    return this.#view(()=>{
      const decision=decisionId?this.#read(decisionId):this.#findDecision(packetId);
      ensure(!decision||decision.type==='decision','DEBUG_SELECTION','record is not a decision');
      ensure(!decision||packetId===null||decision.input.packetId===packetId,'DEBUG_SELECTION','decision and packet selections disagree');
      let attempt=decisionId?this.#read(`${decisionId}:attempt`):null;
      if(!decision&&!attempt&&packetId&&this.#version>=8){
        const row=this.#db.prepare('SELECT decision_id AS id FROM debug_events WHERE packet_id=? AND decision_id IS NOT NULL ORDER BY seq DESC LIMIT 1').get(packetId);
        if(row){decisionId=row.id;attempt=this.#read(`${decisionId}:attempt`);}
      }
      decisionId=decision?.id??decisionId;packetId=decision?.input.packetId??attempt?.input?.packetId??packetId;
      const snapshot=this.#version>=8?this.#db.prepare('SELECT body FROM debug_packets WHERE packet_id=?').get(packetId):null;
      const packet=decision?.input??attempt?.input??(snapshot?JSON.parse(snapshot.body):null),p=packet?.payload,context=p?.continuity;
      const out=decision?.output??attempt?.output??null,choice=list(out?.options).find(o=>o.id===out?.selected);
      const cards=[...list(context?.foreground),...list(context?.recalled)];
      const after=context&&decision?this.#read(context.subject.id,context.subject.revision+1):null;
      const checkpoint=after?.lastDecision?.id===decisionId?after:null;
      const accepted=list(checkpoint?.changedStates).map(r=>this.#read(r.id,r.revision)).filter(Boolean);
      const materialBindings=frame=>list(frame?.residences).filter(r=>r.target.kind==='material').map(({cue,...metadata})=>({...metadata,...(includeContent?{cue}:{})}));
      const materialBefore=materialBindings(context?.attention),materialAfter=checkpoint?.attentionFrame?materialBindings(this.#read(checkpoint.attentionFrame.id,checkpoint.attentionFrame.revision)):null;
      const beforeFrame=context?.attention?.frame?this.#read(context.attention.frame.id,context.attention.frame.revision):null;
      const afterFrame=checkpoint?.attentionFrame?this.#read(checkpoint.attentionFrame.id,checkpoint.attentionFrame.revision):null;
      const changes=accepted.map(s=>{
        const before=s.predecessor?this.#read(s.predecessor.id,s.predecessor.revision):null;
        const fields=['body','status','scope','nature','reason','basis','mind'].filter(k=>canonical(before?.[k]??null)!==canonical(s[k]??null));
        return {ref:ref(s),before:ref(before),kind:s.kind,fields,basis:s.basis,...(includeContent?{beforeRecord:before,afterRecord:s}:{})};
      });
      const eventPage=this.journal({...packetId?{packetId}:{decisionId},limit:200}),journal=eventPage.items;
      ensure(packet||decision||attempt||journal.length,'DEBUG_NOT_FOUND','no recorded input, proposal or diagnostic for this selection');
      // Later delivery/execution transactions use response/action IDs; find their original rows as well.
      const response=decision?this.#read(`${decision.id}:response`):null,action=decision?.action?this.#read(decision.action.id):null;
      const receipts=[...list(response?.receipts),...(action?.receipt?[action.receipt]:[])].map(r=>{const e=this.#read(r.id,r.revision);return includeContent?e:{ref:r,origin:e?.origin??null,occurredAt:e?.occurredAt??null};});
      const query=decision&&choice?.kind==='lookup'?this.#read(lookupResultId(ref(decision))):null;
      const warnings=[];const flag=(code,level,details={})=>warnings.push({code,level,...details});
      for(const e of journal)if(e.status==='rejected'||e.status==='uncertain')flag(e.data.errorCode??e.stage,'attention',{seq:e.seq});
      const integrity=checkStoredInput(packet);if(packet&&[integrity.fingerprint,integrity.messageBinding,integrity.byteCount,integrity.withinBudget].some(v=>v===false))flag('INPUT_INTEGRITY_MISMATCH','error');
      const starts=journal.filter(e=>e.stage==='model.started').length,ends=journal.filter(e=>['model.completed','model.failed'].includes(e.stage)).length;
      if(starts>ends)flag('CALL_OUTCOME_UNCONFIRMED','attention',{count:starts-ends});
      if(!packet)flag('INPUT_SNAPSHOT_UNAVAILABLE','attention');
      if(journal.some(e=>['quota-exceeded','capture-failed','snapshot-too-large'].includes(e.data.snapshot)))flag('INPUT_CAPTURE_DEGRADED','attention');
      if(list(p?.knowledge?.presentation?.omitted).length)flag(p.knowledge.presentation.stop==='required-overflow'?'REQUIRED_OVERFLOW':'MATERIAL_NOT_DELIVERED','info',{count:p.knowledge.presentation.omitted.length});
      if(list(context?.mind?.gaps).length)flag('UNEXPANDED_OR_STALE_DEPENDENCY','info',{count:context.mind.gaps.length});
      if(cards.some(c=>c.historical)||list(p?.materials).some(m=>m.historical))flag('HISTORICAL_MATERIAL','info');
      if(response&&response.status!=='sent')flag('SPEECH_NOT_CONFIRMED_SENT','info',{status:response.status});
      if(action?.status==='proposed')flag('ACTION_HAS_NO_TERMINAL_RECEIPT','info');
      if(this.#version<8)flag('LEGACY_DIAGNOSTICS_UNAVAILABLE','info');
      if(eventPage.nextAfterSeq!==null)flag('JOURNAL_PAGE_TRUNCATED','attention');
      let continuation=null;
      if(nextDecisionId){
        const next=this.#read(nextDecisionId);ensure(next?.type==='decision'&&next.input.payload.continuity?.subject.id===context?.subject.id,'DEBUG_SELECTION','next comparison must be the same subject');
        const present=[...list(next.input.payload.continuity.foreground),...list(next.input.payload.continuity.recalled)];
        continuation={decision:ref(next),changedStates:accepted.map(s=>({ref:ref(s),status:present.some(c=>refKey(c.ref)===refKey(s))?'delivered':present.some(c=>c.ref.id===s.id)?'different-version-delivered':'not-in-that-input'})),
          interpretation:'not-delivered-does-not-by-itself-mean-lost-memory'};
      }
      return {format:'agent-debug-turn-v1',decision:ref(decision),attempt:attempt?{ref:ref(attempt),status:attempt.status}:null,packetId,
        outcome:decision?'accepted':attempt?'proposal-not-adopted':journal.some(e=>e.status==='rejected')?'rejected':'prepared-or-unconfirmed',
        subjectId:context?.subject.id??journal.find(e=>e.context.subjectId)?.context.subjectId??null,
        input:{stage:packet?.stage??null,integrity,current:p?.current?{ref:ref(p.current),origin:p.current.origin,scene:p.current.scene,occurredAt:p.current.occurredAt}:null,
          workspace:ref(p?.workspace),waitSupport:p?.waitSupport??null,materials:list(p?.materials).map(m=>({ref:m.ref,aspects:m.aspects??[],historical:m.historical})),
          states:cards.map(c=>({ref:c.ref,historical:c.historical,kind:c.record?.kind??c.kind,role:c.record?.mind?.role??c.mind?.role??null})),
          foreground:context?.foreground.map(c=>c.ref)??[],entries:list(context?.attention?.entries).map(({cue,...metadata})=>metadata),mind:context?.mind??null,
          ...(context?.attention?.focusSupport?{focus:{enabled:true,selection:context.attention.focusSupport.selection,validSelection:context.attention.focusSupport.validSelection,
            blocked:context.attention.focusSupport.blocked,materialUses:context.attention.focusSupport.materialUses,
            menu:context.attention.focusSupport.menu.map(({anchor,via,...m})=>({...m,anchor:includeContent?anchor:Object.fromEntries(Object.entries(anchor).filter(([k])=>k!=='label')),
              via:includeContent?via:(via??[]).map(v=>({...v,parent:Object.fromEntries(Object.entries(v.parent).filter(([k])=>k!=='label'))}))}))}}:{}),
          ...(context?.attention?.materialSupport||context?.attention?.materials?.length?{workbenchMaterials:{
            enabled:context?.attention?.materialSupport?.enabled===true,projection:context?.attention?.materials??[],
            bindings:list(context?.attention?.residences).filter(r=>r.target.kind==='material').map(({cue,...metadata})=>metadata)}}:{}),
          processes:list(context?.attention?.processes).map(({body,basis,label,...metadata})=>({...metadata,...(includeContent?{label}:{})})),
          knowledge:p?.knowledge?{presentation:p.knowledge.presentation,paths:p.knowledge.paths,cards:p.knowledge.cards.map(c=>({ref:c.ref,type:c.type,historical:c.historical}))}:null},
        retrieval:{...(p?.information?.progress?{progress:p.information.progress}:{}),...(p?.information?.consultationDesk?{consultationDesk:includeContent?p.information.consultationDesk:{
          root:p.information.consultationDesk.root,continueWith:p.information.consultationDesk.continueWith,
          navigation:navigationView({menu:p.information.consultationDesk.navigation}),
          candidateRefs:p.information.consultationDesk.candidates.map(c=>c.ref),fetchedRefs:p.information.consultationDesk.fetchedRefs,
          omittedCandidates:p.information.consultationDesk.omittedCandidates,historyStop:p.information.consultationDesk.historyStop}}:{}),
          received:list(p?.information?.results).map(r=>({ref:r.ref,outcome:r.outcome,method:r.method,queryRoute:r.query.trace?.route??Object.keys(r.query)[0],remainingReadsAtResult:r.remainingReadsAtResult,
            ...(r.consultation?{consultation:consultationView(r.consultation,includeContent)}:{})})),
          performed:query?{ref:ref(query),outcome:query.outcome,method:query.method,readPerformed:query.readPerformed,remainingReads:query.remainingReads,
            ...(includeContent?{record:query}:{}),
            ...(query.consultation?{consultation:consultationView(query.consultation,includeContent)}:{}),
            trace:query.trace?{nodes:query.trace.nodes.map(n=>({ref:n.ref,type:n.type,historical:n.historical})),paths:query.trace.paths,missing:query.trace.missing,limits:query.trace.limits}:null}:null},
        ...(context?.attention?.recoverySupport?{useRecovery:{enabled:true,proposed:list(out?.continuity?.attention?.residency?.restore),
          reads:list(p?.information?.results).filter(r=>r.workbench).map(r=>({ref:r.ref,outcome:r.outcome,kind:r.workbench.kind,
            source:r.workbench.source??null,...(includeContent?{details:r.workbench}:{})})),interpretation:'local-use-restoration-not-frame-rollback-or-new-experience'}}:{}),
        proposalCheck:checkFinalDeclaration(packet,out),selection:choice?{id:choice.id,kind:choice.kind,tool:choice.payload.tool??null,...(choice.kind==='wait'?{wait:choice.payload,waitInterpretation:p?.waitSupport?'recorded-contract-not-live-wake-check':'untracked-legacy'}:{}),...(includeContent?{payload:choice.payload}:{}),declaredUses:out.used??[],expressionMode:out.continuity?.expressionChoice?.mode??null}:null,
        proposedCount:list(out?.continuity?.changes).length,changes,
        ...(context?.attention?.focusSupport?{focusChange:{before:beforeFrame?.focus??null,after:afterFrame?.focus??null,proposed:out?.continuity?.attention?.focus??null}}:{}),
        ...(context?.attention?.materialSupport||materialBefore.length||materialAfter?.length?{materialResidency:{before:materialBefore,after:materialAfter,
          removed:materialAfter?materialBefore.filter(b=>!materialAfter.some(a=>a.id===b.id)).map(b=>b.id):[],
          added:materialAfter?materialAfter.filter(a=>!materialBefore.some(b=>a.id===b.id)).map(a=>a.id):[]}}:{}),
        execution:action?{ref:ref(action),status:action.status,receipt:action.receipt,asOf:'inspection-time'}:{status:'no-action-intent'},
        delivery:response?{ref:ref(response),status:response.status,receipts:response.receipts,asOf:'inspection-time'}:{status:'no-response-intent'},
        receipts,continuation,warnings,journal,journalNextAfterSeq:eventPage.nextAfterSeq,
        ...(includeContent?{content:{packet,finalProposal:out,proposedChanges:out?.continuity?.changes??[]}}:{}),
        limitations:['final-declarations-not-private-reasoning','semantic-errors-not-automatically-diagnosed','journal-can-be-paged','no-actions-or-model-calls-replayed']};
    });
  }
  maintenanceAudit({jobId,includeContent=false}){
    ensure(typeof jobId==='string'&&typeof includeContent==='boolean','DEBUG_SELECTION','choose maintenance job');
    return this.#view(()=>{
      const job=this.#read(jobId);ensure(job?.type==='maintenance_job','DEBUG_NOT_FOUND','maintenance job not found');
      const snapshots=this.#version>=8?this.#db.prepare(`SELECT body FROM debug_packets WHERE
        json_extract(body,'$.basePacket.packetId')=? OR json_extract(body,'$.payload.corePacketId')=?`).all(job.packet.packetId,job.packet.packetId).map(r=>JSON.parse(r.body)):[];
      const wires=snapshots.filter(p=>p.stage==='focusedMaintenance-v1'),raws=snapshots.filter(p=>p.stage==='focusedMaintenanceAudit-v1'&&p.payload.phase==='raw'),
        expansions=snapshots.filter(p=>p.stage==='focusedMaintenanceAudit-v1'&&p.payload.phase==='expanded');
      const unique=wires.length===1&&raws.length===1&&expansions.length===1;
      const conversion=unique?checkFocusedConversion(wires[0],raws[0],expansions[0]):{status:'not-verified',errorCode:'AUDIT_INCOMPLETE_OR_AMBIGUOUS'};
      let proposalMatchesCapture=false;
      try{proposalMatchesCapture=conversion.status==='conversion-verified'&&job.output!==null&&canonical(JSON.parse(job.output))===canonical(expansions[0].payload.value);}catch{}
      const committedRecords=(job.appliedRefs??[]).map(r=>({ref:r,record:this.#read(r.id,r.revision)}));
      const expected=proposalMatchesCapture?expansions[0].payload.value:null;
      const patchChecks=job.status==='adopted'&&expected?[...expected.noteUpdates.map(p=>({patch:p,keys:['body','kind','change','confidence','status','scope','evidence']})),
        ...expected.changes.map(p=>({patch:p,keys:['body','kind','status','scope','mind']}))].map(({patch,keys})=>{
        const after=committedRecords.find(r=>r.ref.id===patch.id)?.record??this.#read(patch.id,patch.expectedRevision);
        return {id:patch.id,recordPresent:Boolean(after),fieldsMatch:Boolean(after)&&keys.filter(k=>Object.hasOwn(patch,k)).every(k=>canonical(after[k]??null)===canonical(patch[k]))};
      }):[];
      return {job:ref(job),jobStatus:job.status,conversion,proposalMatchesCapture,
        adoptionRecorded:job.status==='adopted',committedRecordsPresent:job.status==='adopted'?committedRecords.every(r=>r.record!==null):null,patchChecks,
        snapshots:{wire:wires.map(p=>p.packetId),raw:raws.map(p=>p.packetId),expanded:expansions.map(p=>p.packetId)},
        ...(includeContent?{content:{snapshots,committedRecords}}:{}),
        limitations:['mechanical-conversion-and-selected-committed-fields-not-semantic-truth','missing-audit-is-not-success','no-provider-calls-or-reexecution']};
    });
  }
  bundle({limit=12,includeContent=false,selections=null}={}){
    bound(limit,50);return this.#view(()=>{
      const turns=(selections??this.turns({limit})).slice(0,limit).map(selection=>this.inspect({...selection,includeContent}));
      const maintenance=this.#db.prepare("SELECT v.body FROM objects o JOIN versions v ON o.id=v.id AND o.current_revision=v.revision WHERE o.type='maintenance_job' ORDER BY v.rowid DESC LIMIT ?").all(limit).map(x=>{
        const j=JSON.parse(x.body);return {ref:ref(j),subject:j.subject,status:j.status,error:j.error??null,appliedRefs:j.appliedRefs??[],
          journal:this.journal({jobId:j.id,limit:100}),...(includeContent?{packet:j.packet,finalOutput:publicMaintenanceFinal(j.output)}:{})};});
      const lastSeq=this.#version>=8?this.#db.prepare('SELECT coalesce(max(seq),0) AS seq FROM debug_events').get().seq:0,afterSeq=Math.max(0,lastSeq-100);
      return {format:'agent-debug-workbench-v1',createdAt:Date.now(),includeContent,overview:this.overview(),turns,maintenance,
        activity:{...this.journal({limit:100,afterSeq}),windowStartAfterSeq:afterSeq,earlierRecordsNotIncluded:afterSeq>0},limitations:['bounded-export-not-entire-history','local-only-no-telemetry','no-hidden-chain-of-thought']};
    });
  }
}
