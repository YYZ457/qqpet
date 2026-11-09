import {digest,ensure,text} from './contracts.mjs';
import {initializeSubject,admitSubjectEvent} from './continuity.mjs';
import {prepareDecision,commitDecision,verifiedModelInput} from './cognition.mjs';
import {attentionId} from './attention.mjs';
import {packetContext,failureMetadata,outputMetrics} from './debug-contract.mjs';

// One request in, one decision out. The injected client owns metering and provider configuration.
// There is no default provider, key loader, automatic retry, autonomous loop, or QQ sender here.
export class ContinuitySession {
  #store; #subjectId; #pending=new Map();
  constructor({store,subjectId,maxForeground=8,attention=false}) {
    text(subjectId,'subject id');this.#store=store;this.#subjectId=subjectId;
    initializeSubject({store,subjectId,maxForeground,requestId:`subject-session:${subjectId}`});
    ensure(typeof attention==='boolean','INVALID_INPUT','attention must be explicit boolean');
    if(attention)store.execute({requestId:`initialize:${attentionId(subjectId)}`,commands:[{op:'initialize_attention',subjectId}]});
  }
  prepare(args) {
    ensure(args&&args.subjectId===undefined,'SUBJECT_FIXED','session subject cannot be changed per activity');
    admitSubjectEvent({store:this.#store,subjectId:this.#subjectId,event:args.currentEvent,
      requestId:`subject-admission:${digest({subjectId:this.#subjectId,event:args.currentEvent})}`});
    const packet=prepareDecision({...args,store:this.#store,subjectId:this.#subjectId});
    this.#store.notifyForeground({subjectId:this.#subjectId,packetId:packet.packetId,subject:packet.payload.continuity.subject,attention:packet.payload.continuity.attention?.frame});
    return packet;
  }
  commit(args) {
    ensure(['decisionContinuity','decisionInformation','decisionWorkbench','decisionAttention','decisionMind','decisionGraph','reflection'].includes(args.packet?.stage)&&args.packet.payload.continuity.subject.id===this.#subjectId,'SUBJECT_FIXED','input belongs to another subject/session');
    return commitDecision({...args,store:this.#store});
  }
  run(args) {
    text(args?.requestId,'request id');text(args?.decisionId,'decision id');
    const {invoke,...content}=args,key=digest(content),existing=this.#pending.get(args.decisionId);
    if(existing){ensure(existing.key===key,'DECISION_ID_COLLISION','in-flight invocation changed content');return existing.promise;}
    const promise=this.#run(args).finally(()=>this.#pending.delete(args.decisionId));
    this.#pending.set(args.decisionId,{key,promise});return promise;
  }
  async #run({invoke,requestId,decisionId,maxOutputBytes=16384,...prepareArgs}) {
    ensure(typeof invoke==='function','MODEL_CLIENT_REQUIRED','provide an explicitly metered model client');
    text(requestId,'request id');text(decisionId,'decision id');
    ensure(prepareArgs.subjectId===undefined,'SUBJECT_FIXED','session subject cannot be changed per activity');
    const invocationKey=digest({requestId,decisionId,currentEvent:prepareArgs.currentEvent,workspace:prepareArgs.workspace,
      identity:prepareArgs.identity??'',materials:prepareArgs.materials??[],previousDecisions:prepareArgs.previousDecisions??[],
      allowedActionTools:prepareArgs.allowedActionTools??[],stateRefs:prepareArgs.stateRefs??[],stateDetail:prepareArgs.stateDetail??false,
      ...(prepareArgs.lookupResults?.length?{lookupResults:prepareArgs.lookupResults}:{}),
      ...(prepareArgs.localLookupPolicy?{localLookupPolicy:prepareArgs.localLookupPolicy}:{}),
      mind:prepareArgs.mind??false,...(prepareArgs.unified?{unified:true}:{}),...(prepareArgs.waitSupport?{waitSupport:true}:{}),...(prepareArgs.consultation?{consultation:true}:{}),
      ...(prepareArgs.consultationProgress?{consultationProgress:true}:{}),...(prepareArgs.workbenchMaterials?{workbenchMaterials:true}:{}),...(prepareArgs.workbenchFocus?{workbenchFocus:true}:{}),...(prepareArgs.workbenchRecovery?{workbenchRecovery:true}:{}),budgetBytes:prepareArgs.budgetBytes??null,maxOutputBytes});
    // Deterministic completed-turn resume avoids a second provider request after a committed turn.
    const existing=this.#store.read(decisionId);
    if(existing){
      ensure(existing.type==='decision'&&existing.invocationKey===invocationKey&&existing.requestKey===requestId&&existing.input.payload.continuity?.subject.id===this.#subjectId
        && existing.currentEvent.id===prepareArgs.currentEvent.id&&existing.currentEvent.revision===prepareArgs.currentEvent.revision
        && existing.workspace.id===prepareArgs.workspace.id&&existing.workspace.revision===prepareArgs.workspace.revision,
        'DECISION_ID_COLLISION','cannot reuse a decision id for another request');
      this.#store.recordDiagnostic({stage:'run.resumed',status:'replayed',context:packetContext(existing.input,{decisionId}),data:{modelCalled:false,reason:'committed-decision'}});
      return {decision:existing,packet:existing.input,resumed:true,modelCalled:false};
    }
    const pending=this.#store.read(`${decisionId}:attempt`);
    if(pending){
      ensure(pending.type==='decision_attempt'&&pending.invocationKey===invocationKey&&pending.requestKey===requestId
        &&pending.input.payload.continuity?.subject.id===this.#subjectId,'DECISION_ID_COLLISION','captured proposal belongs to another invocation');
      this.#store.recordDiagnostic({stage:'run.resumed',status:'replayed',context:packetContext(pending.input,{decisionId}),data:{modelCalled:false,reason:'captured-proposal'}});
      return {decision:null,attempt:pending,packet:pending.input,status:'pending-proposal',resumed:true,modelCalled:false};
    }
    const packet=this.prepare(prepareArgs);
    const context=packetContext(packet,{decisionId,requestId}),start=performance.now();
    this.#store.recordDiagnostic({stage:'model.started',status:'started',context,data:{modelCalled:true,bytes:packet.bytes}});
    let response;
    try{response=await invoke(verifiedModelInput(packet));}
    catch(error){this.#store.recordDiagnostic({stage:'model.failed',status:'uncertain',context,data:{...failureMetadata(error,{client:true}),durationMs:Math.round(performance.now()-start)}});throw error;}
    this.#store.recordDiagnostic({stage:'model.completed',status:'completed',context,data:{...outputMetrics(response),durationMs:Math.round(performance.now()-start)}});
    try{ensure(typeof response==='string'||response&&Object.getPrototypeOf(response)===Object.prototype,'MODEL_OUTPUT_REQUIRED','client must return final JSON text or parsed output, never private reasoning');}
    catch(error){this.#store.recordDiagnostic({stage:'model.output-rejected',status:'rejected',context,data:failureMetadata(error)});throw error;}
    const decision=this.commit({packet,output:response,requestId,decisionId,maxOutputBytes,allowedActionTools:prepareArgs.allowedActionTools??[],invocationKey});
    return {packet,decision,resumed:false,modelCalled:true};
  }
}
