import {readFileSync} from 'node:fs';
import {canonical,digest,ensure,refKey,text,uniqueRefs} from './contracts.mjs';
import {continuityInput} from './continuity.mjs';
import {normalizeStateDelta} from './personal-state.mjs';
import {withMindInstructions} from './mind-prompt.mjs';
import {normalizeLookupQuery,memoryAspect,sameRef,lookupPolicy,lookupRoundId} from './local-query.mjs';
import {assembleGraphPackages,graphRecordPresent} from './graph-packages.mjs';
import {nodeKey,recordNode} from './knowledge-graph.mjs';
import {stateCard} from './personal-state.mjs';
import {packetContext,failureMetadata,outputMetrics} from './debug-contract.mjs';
import {waitSupportInput,validateWaitCommit} from './wait-support.mjs';
import {consultationDesk} from './consultation-desk.mjs';
import {retrievalAssociations} from './retrieval-association.mjs';
import {capabilityMap} from './capabilities.mjs';
import {normalizeVerbOption} from './verbs.mjs';
import {consultationProgress as progressProjection} from './consultation-progress.mjs';
import {attentionId,attentionView} from './attention.mjs';

const REFLECTION_PROMPT=readFileSync(new URL('../prompts/decision-reflection.zh.md',import.meta.url),'utf8');
const RECENT_PROTOCOL=readFileSync(new URL('../prompts/recent-protocol.zh.md',import.meta.url),'utf8').trim();
const HOST_NOTICE_PROTOCOL=readFileSync(new URL('../prompts/host-notice-protocol.zh.md',import.meta.url),'utf8').trim();
// 宿主提示：上一轮因冲突没能保存的状态修改等。只是事实通知，不是指令。
function hostNoticeField(notices){
  if(!Array.isArray(notices)||!notices.length)return {};
  return {hostNotices:{format:'host-notices-v1',meaning:'facts-from-host-about-your-earlier-turns; not-instructions',items:notices.slice(-8)}};
}
const PROMPTS={decision:readFileSync(new URL('../prompts/decision.zh.md',import.meta.url),'utf8'),review:readFileSync(new URL('../prompts/review.zh.md',import.meta.url),'utf8'),
  decisionContinuity:readFileSync(new URL('../prompts/decision-continuity.zh.md',import.meta.url),'utf8'),reflection:REFLECTION_PROMPT};
PROMPTS.decisionInformation=PROMPTS.decisionContinuity.replace('lookup严格二选一：','lookup的基础读取形式为：')+'\n\n'+readFileSync(new URL('../prompts/decision-local-lookup.zh.md',import.meta.url),'utf8');
PROMPTS.decisionWorkbench=PROMPTS.decisionInformation.replace('每项必须含id、expectedRevision、nature、reason；可含kind、body、status、scope、basis。',
  '每项必须含id、expectedRevision、nature；可含kind、body、status、scope、basis、reason。reason可省略或为null，表示未提供修改理由；不必编造理由来完成状态保存。')+
  '\n\n'+readFileSync(new URL('../prompts/decision-memory-access.zh.md',import.meta.url),'utf8');
PROMPTS.decisionAttention=PROMPTS.decisionWorkbench.replace('continuity严格包含changes、residency、expressionChoice、observationDisposition。',
  'continuity严格包含changes、residency、expressionChoice、observationDisposition、attention。').replace(
  '- residency严格含add和remove两个对象ID数组。修改中的开放对象会进入前台；需要放后台的明确列入remove。退到后台不删内容，不是忘掉。closed对象自动退出前台。前台容量由输入maxForeground给出，不能扩大权限。',
  '- residency严格为{"add":[],"remove":[]}，本阶段只通过attention.residency修改用途驻留，保存状态不自动加入前台。')+
  '\n\n'+readFileSync(new URL('../prompts/decision-attention.zh.md',import.meta.url),'utf8');
PROMPTS.decisionMind=withMindInstructions(PROMPTS.decisionAttention);
PROMPTS.decisionGraph=PROMPTS.decisionMind+'\n\n'+readFileSync(new URL('../prompts/decision-graph.zh.md',import.meta.url),'utf8');
const CONSULT_PROMPT=readFileSync(new URL('../prompts/decision-consultation.zh.md',import.meta.url),'utf8');
const MATERIAL_PROMPT=readFileSync(new URL('../prompts/decision-workbench-materials.zh.md',import.meta.url),'utf8');
const FOCUS_PROMPT=readFileSync(new URL('../prompts/decision-workbench-focus.zh.md',import.meta.url),'utf8');
const RECOVERY_PROMPT=readFileSync(new URL('../prompts/decision-workbench-recovery.zh.md',import.meta.url),'utf8');
const ACTIVITY_PROTOCOL=readFileSync(new URL('../prompts/activity-protocol.zh.md',import.meta.url),'utf8');
const TURN_PLAN_PROTOCOL=readFileSync(new URL('../prompts/turn-plan-protocol.zh.md',import.meta.url),'utf8');
const TASK_PROTOCOL=readFileSync(new URL('../prompts/task-protocol.zh.md',import.meta.url),'utf8');
const TASK_WAKE_PROTOCOL=readFileSync(new URL('../prompts/task-wake.zh.md',import.meta.url),'utf8');
const SELF_PROTOCOL=readFileSync(new URL('../prompts/decision-self-protocol.zh.md',import.meta.url),'utf8');
const MEMORY_PROTOCOL=readFileSync(new URL('../prompts/memory-protocol.zh.md',import.meta.url),'utf8');
const SILENCE_PROTOCOL=readFileSync(new URL('../prompts/silence-protocol.zh.md',import.meta.url),'utf8');
const MEMORY_UPDATE_PROMPT='这段时间有新经历。memoryUpdate.window 是自上次真正写下记忆以来的真实材料：她收到的消息、她自己的回复、她做过的动作（被屏蔽的通道和工具回执不在内）。是否要把值得留下的写成自己的记忆由你决定：可以用 do("remember_note", {body, kind?, scene?}) 记一笔；不记、跳过也完全可以。若 window.omitted>0，说明还有未展开的经历，不要假装已经总结了全部。不要为了完成任务而编造记忆。';
const ANTI_ASSISTANT=readFileSync(new URL('../prompts/anti-assistant.zh.md',import.meta.url),'utf8');
const ASPECTS=['experience','feeling','belief','goal','knowledge'];
const KINDS=['respond','turn','lookup','act','continue','pause','wait'];
const clone=x=>JSON.parse(canonical(x));
const asRef=x=>({id:x.id,revision:x.revision});
function exact(x,keys,name) {
  ensure(x && Object.getPrototypeOf(x)===Object.prototype && canonical(Object.keys(x).sort())===canonical([...keys].sort()),'OUTPUT_SHAPE',`${name} fields do not match protocol`);
}
function short(value,name,limit=400) {text(value,name);ensure([...value].length<=limit,'OUTPUT_LIMIT',`${name} too long`);return value;}
function bound(bytes,name) {ensure(Number.isSafeInteger(bytes)&&bytes>0&&bytes<=131072,'INVALID_BUDGET',`${name} must be 1..131072 bytes`);}
function record(store,ref,types) {
  uniqueRefs([ref]);const r=store.read(ref.id,ref.revision);
  ensure(r&&types.includes(r.type),'REFERENCE_TYPE','missing or incorrect reference',ref);return r;
}
function materialList(store,assignments,heads=false) {
  ensure(Array.isArray(assignments)&&assignments.length<=32,'INPUT_LIMIT','up to 32 explicit material assignments');
  const map=new Map();
  for(const a of assignments) {
    uniqueRefs([a.ref]);ensure(ASPECTS.includes(a.aspect),'INVALID_ASPECT','unknown personal material aspect');
    const key=refKey(a.ref), r=record(store,a.ref,['event','note']);
    if(!map.has(key))map.set(key,{ref:asRef(r),aspects:[],record:r,historical:store.read(r.id).revision!==r.revision||r.status==='historical',needsReview:store.basisChanged(asRef(r))});
    if(!map.get(key).aspects.includes(a.aspect))map.get(key).aspects.push(a.aspect);
  }
  return [...map.values()].map(m=>({...m,aspects:m.aspects.sort(),...(heads&&store.read(m.ref.id).revision!==m.ref.revision?
    {currentHead:{ref:asRef(store.read(m.ref.id)),meaning:'pointer-only-not-delivered-body; current-is-not-necessarily-correct'}}:{})})).sort((a,b)=>refKey(a.ref)<refKey(b.ref)?-1:refKey(a.ref)>refKey(b.ref)?1:0);
}
function seal(stage,payload,budgetBytes) {
  bound(budgetBytes,'input budget');
  const focused=payload.continuity?.attention?.focusSupport?.enabled===true;
  let baseInstruction=focused?PROMPTS[stage].replace('continuity在原四字段以外还必须有attention，严格为：','continuity在原四字段以外还必须有attention；基本字段如下，另可含focus：'):PROMPTS[stage];
  if(payload.continuity?.attention?.recoverySupport?.enabled)baseInstruction=baseInstruction.replace('另可含focus：','另可含focus，residency另可含restore：');
  const instruction=baseInstruction+(payload.memoryAccess?.consultation?.enabled?'\n\n'+CONSULT_PROMPT:'')+
    (payload.continuity?.attention?.materialSupport?.enabled&&!focused?'\n\n'+MATERIAL_PROMPT:'')+
    (payload.continuity?.attention?.focusSupport?.enabled?'\n\n'+FOCUS_PROMPT:'')+
    (payload.continuity?.attention?.recoverySupport?.enabled?'\n\n'+RECOVERY_PROMPT:'')+
    (payload.waitSupport?'\n本轮启用waitSupport。选择wait时payload必须明确为{mode:"park"}、{mode:"next-event"}、{mode:"until",wakeAt:未来毫秒}，或仅在sources有值时用{mode:"feedback",source:"实际W短名",wakeAt:未来毫秒}。deadline不得超过maxWakeAt。不写mode不能提交。反馈只能等已交付来源，提出动作不代表已经开工；无来源可自主观察、尝试、暂放或等新消息，不必强迫行动。超时只重新评估，不能当作回答或成功。':'')+
    (payload.continuity?.selfProtocol?.enabled===true?'\n\n'+SELF_PROTOCOL:'')+
    (payload.continuity?.memoryProtocol?.enabled===true?'\n\n'+MEMORY_PROTOCOL:'')+
    (payload.continuity?.silenceProtocol?.enabled===true?'\n\n'+SILENCE_PROTOCOL:'')+
    (payload.memoryUpdate?.due===true?'\n\n'+MEMORY_UPDATE_PROMPT:'')+
    (payload.style?.text?'\n\n'+ANTI_ASSISTANT+'\n\n【她自己的说话方式】\n'+payload.style.text:'')+
    (payload.continuity?.capabilities?.enabled?.length?'\n\n'+capabilityMap({enabled:payload.continuity.capabilities.enabled}).text:'')+
    (stage!=='reflection'&&payload.continuity?.activities?.length?'\n\n'+ACTIVITY_PROTOCOL:'')+(payload.continuity?.turnPlan?.enabled?'\n\n'+TURN_PLAN_PROTOCOL:'')+(payload.continuity?.taskEngine?.enabled?'\n\n'+TASK_PROTOCOL:'')+(payload.taskWake===true?'\n\n'+TASK_WAKE_PROTOCOL:'')+(payload.continuity?.recent?.format==='recent-context-v2'?'\n\n'+RECENT_PROTOCOL:'')+(payload.hostNotices?.items?.length?'\n\n'+HOST_NOTICE_PROTOCOL:''), data=clone(payload), packetId=digest({stage,instruction,payload:data});
  const messages=[{role:'system',content:instruction},{role:'user',content:canonical({packetId,...data})}];
  const bytes=Buffer.byteLength(canonical(messages),'utf8');
  ensure(bytes<=budgetBytes,'INPUT_OVERFLOW','complete model messages exceed byte budget',{requiredBytes:bytes,budgetBytes});
  return {stage,packetId,payload:data,instruction,messages,bytes,budgetBytes,unit:'utf8-bytes'};
}
function verify(packet,stage) {
  ensure(packet?.stage===stage,'PACKET_STAGE','wrong packet stage');
  const rebuilt=seal(stage,packet.payload,packet.budgetBytes);
  ensure(rebuilt.packetId===packet.packetId && canonical(rebuilt.messages)===canonical(packet.messages)
    && packet.instruction===rebuilt.instruction && packet.bytes===rebuilt.bytes,'PACKET_CHANGED','use the exact host-prepared packet');
}
function parse(output,maxOutputBytes) {
  bound(maxOutputBytes,'output budget');
  const raw=typeof output==='string'?output:canonical(output);
  ensure(Buffer.byteLength(raw,'utf8')<=maxOutputBytes,'OUTPUT_OVERFLOW','model output exceeds bound');
  try{return JSON.parse(raw);}catch{ensure(false,'OUTPUT_JSON','valid JSON required');}
}
function permitted(tools) {
  ensure(Array.isArray(tools)&&tools.length<=64,'INPUT_LIMIT','up to 64 granted action tools');tools.forEach(t=>text(t,'tool'));
  return [...new Set(tools)].sort();
}
function inputRefs(payload) {return payload.materials.map(m=>({ref:m.ref,historical:m.historical}));}
const continuityStage=stage=>['decisionContinuity','decisionInformation','decisionWorkbench','decisionAttention','decisionMind','decisionGraph','reflection'].includes(stage);

function lookupInformation(store,{lookupResults,subjectId,currentEvent,workspace,consultation=false}) {
  ensure(Array.isArray(lookupResults)&&lookupResults.length<=4,'INPUT_LIMIT','up to four explicit local lookup results');
  const refs=uniqueRefs(lookupResults);
  const records=refs.map(r=>record(store,r,['lookup_result']));
  if(records.length){
    ensure(subjectId!==null,'MISSING_SUBJECT','lookup results require a continuous subject');
    const subject=store.read(subjectId);
    ensure(records.every(r=>r.subject===subjectId),'SUBJECT_MISMATCH','only own lookup results may be admitted');
    ensure(records.every(r=>(currentEvent?sameRef(r.anchor,currentEvent):r.anchor===null)&&sameRef(r.workspace,workspace)),'LOOKUP_CONTEXT_MISMATCH','lookup results are historical to another current context; use explicit material references to recall them');
    ensure(records.some(r=>sameRef(r.decision,subject.lastDecision)),'SUPERSEDED_LOOKUP','a newer decision has replaced this lookup continuation');
  }
  const candidates=new Map();
  for(const r of records)for(const entry of r.entries){
    if(!['event','note'].includes(entry.type))continue; // entity/binding are directory handles, not material bodies
    const value=record(store,entry.ref,['event','note']);
    if(!candidates.has(refKey(entry.ref)))candidates.set(refKey(entry.ref),{ref:entry.ref,aspect:memoryAspect(value)});
  }
  const active=consultation?records.find(r=>sameRef(r.decision,store.read(subjectId)?.lastDecision)&&r.consultation):null;
  const desk=consultation?consultationDesk({read:(id,rev)=>store.read(id,rev),results:records,subjectId,currentEvent,workspace,lastDecision:store.read(subjectId)?.lastDecision,
    pages:active?store.consultationPages({subjectId,root:active.consultation.root,currentEvent,workspace}):[]}):null;
  const associations=records.length?retrievalAssociations({store,subjectId,currentEvent,results:records,limit:4}):null;
  return {desk,traces:records.filter(r=>r.trace),associations,candidates:[...candidates.values()],
    trace:{format:'retrieval-trace-v1',steps:records.map((r,i)=>({step:i+1,query:r.query,requested:r.requested,outcome:r.outcome,result:asRef(r)}))},
    results:records.map(r=>({ref:asRef(r),decision:r.decision,round:r.round,
    requested:r.requested,query:r.query,outcome:r.outcome,method:r.method,total:r.total,epoch:r.epoch,entries:r.entries,...(r.trace?{asOf:r.recordedAt}:{}),...(r.opened?{opened:r.opened}:{}),
    novelRefs:r.novelRefs,repeatOf:r.repeatOf,remainingReadsAtResult:r.remainingReads,
    nextPage:r.nextOffset===null?null:asRef(r),...(r.workbench?{workbench:r.workbench}:{}),...(r.graph?{graph:r.graph}:{}),...(r.states?{states:r.states}:{}),
    ...(r.consultation?{consultation:r.consultation}:{}),...(r.trace?{trace:{route:r.trace.route,epoch:r.trace.epoch,stop:r.trace.stop,limits:r.trace.limits,missing:r.trace.missing,
      excludedCount:r.trace.excluded.count,checkedEdges:r.trace.checkedEdges,nodeCount:r.trace.nodes.length,pathCount:r.trace.paths.length,
      catalog:'stored-locally-not-delivered-bodies',interpretation:r.trace.interpretation},novelNodes:r.novelNodes}:{}),...(r.failure?{failure:r.failure}:{})}))};
}

export function prepareDecision(args){
  try{
    const packet=buildDecision(args),snapshot=args.store.captureDebugPacket(packet);
    args.store.recordDiagnostic({stage:'input.prepared',status:'ok',context:packetContext(packet),data:{schemaStage:packet.stage,bytes:packet.bytes,budgetBytes:packet.budgetBytes,snapshot}});
    return packet;
  }catch(error){
    if(error.code==='INPUT_OVERFLOW'&&args.workbenchMaterials){
      const frame=args.store.read(attentionId(args.subjectId));
      const required=frame?attentionView(frame,{read:(id,rev)=>args.store.read(id,rev),currentEvent:args.currentEvent,workbenchFocus:args.workbenchFocus===true}).metadata.materials?.filter(m=>m.delivery==='required').map(m=>m.ref)??[]:[];
      if(required.length){error.code='WORKBENCH_REQUIRED_OVERFLOW';error.details={...error.details,requiredMaterials:uniqueRefs(required),interpretation:'bindings-retained; no-partial-required-delivery'};}
    }
    args?.store?.recordDiagnostic({stage:'input.rejected',status:'rejected',context:{subjectId:args.subjectId,eventId:args.currentEvent?.id,workspaceId:args.workspace?.id},
      data:{...failureMetadata(error),...(error.code==='WORKBENCH_REQUIRED_OVERFLOW'?{requiredMaterials:error.details.requiredMaterials,bytes:error.details.requiredBytes,budgetBytes:args.budgetBytes}:{})}});throw error;}
}
function buildDecision({store,currentEvent,workspace,identity='',style='',materials=[],previousDecisions=[],allowedActionTools=[],budgetBytes,subjectId=null,stateRefs=[],stateDetail=false,lookupResults=[],localLookupPolicy=null,mind=false,unified=false,waitSupport=false,consultation=false,consultationProgress=false,workbenchMaterials=false,workbenchFocus=false,workbenchRecovery=false,now=null,capabilities=null,tasks=[],recent=null,hostNotices=[]}) {
  ensure(typeof workbenchRecovery==='boolean'&&(!workbenchRecovery||workbenchFocus&&workbenchMaterials&&localLookupPolicy!==null),'RECOVERY_CAPABILITY','recovery requires focus, materials and a local read budget');
  return store.view(()=>{
    ensure(typeof mind==='boolean'&&(!mind||subjectId!==null),'MIND_PROTOCOL_REQUIRED','mind mode needs an explicit continuous subject');
    ensure(typeof unified==='boolean'&&(!unified||mind&&localLookupPolicy!==null),'UNIFIED_PROTOCOL_REQUIRED','unified mode requires mind, attention and an explicit read policy');
    ensure(typeof consultation==='boolean'&&(!consultation||unified),'CONSULT_CAPABILITY','consultation requires explicit unified mode');
    ensure(typeof consultationProgress==='boolean'&&(!consultationProgress||consultation),'CONSULT_CAPABILITY','progress requires explicit consultation mode');
    ensure(typeof workbenchFocus==='boolean'&&(!workbenchFocus||workbenchMaterials),'FOCUS_CAPABILITY','focus requires explicit material capability');
    ensure(typeof workbenchMaterials==='boolean'&&(!workbenchMaterials||subjectId!==null&&store.read(attentionId(subjectId))),
      'WORKBENCH_CAPABILITY','material residency requires explicit attention and subject');
    ensure(typeof identity==='string'&&[...identity].length<=4000,'INPUT_LIMIT','bounded host-supplied identity required');
    const current=record(store,currentEvent,['event']), w=record(store,workspace,['workspace']);
    ensure(['observed','reported','tool_receipt'].includes(current.origin),'NOT_AN_ENCOUNTER','decision trigger must be an actual received observation');
    ensure(store.read(w.id).revision===w.revision,'STALE_WORKSPACE','fresh workspace required');
    ensure(Array.isArray(previousDecisions)&&previousDecisions.length<=4,'INPUT_LIMIT','up to four previous decisions');
    const prior=previousDecisions.map(ref=>{const d=record(store,ref,['decision']);return {ref:asRef(d),selected:d.output.options.find(o=>o.id===d.output.selected),summary:d.output.summary,action:d.action};});
    const information=lookupInformation(store,{lookupResults,subjectId,currentEvent,workspace,consultation});
    const payload={format:'agent-decision-input-v1',identity,...(style?{style:{format:'style-pack-v1',text:String(style).slice(0,16000)}}:{}),current,workspace:w,materials:materialList(store,materials,consultation),previousDecisions:prior,allowedActionTools:permitted(allowedActionTools),...(now!==null?{now}:{}),...hostNoticeField(hostNotices)};
    ensure(typeof waitSupport==='boolean'&&(!waitSupport||subjectId!==null),'WAIT_CAPABILITY','explicit wait support requires a continuous subject');
    if(waitSupport)payload.waitSupport=waitSupportInput({store,subjectId});
    if(localLookupPolicy!==null){
      ensure(subjectId!==null,'MISSING_SUBJECT','local memory capability requires a continuous subject');
      const policy=lookupPolicy(localLookupPolicy),round=store.read(lookupRoundId(subjectId,currentEvent));
      ensure(!round||round.type==='lookup_round'&&canonical(round.policy)===canonical(policy),'LOOKUP_POLICY','declared lookup policy differs from persistent round');
      payload.memoryAccess={available:true,routes:['terms','ref','pageAfter','context','person','recall','entity','open'],method:'exact-substring-or-pinned-version',
        contextRoute:{shape:{context:{anchor:{id:'explicit-event-id',revision:1},terms:['keyword']}},
          meaning:'prioritize explicit action-input/receipt and evidence lineage for this pinned event; other matches remain pageable; association is not proof of applicability'},
        scope:'own-retained-events-and-notes',maxResultsPerRead:policy.maxHits,remainingReads:policy.maxReads-(round?.reads??0),
        loadedMaterialsAreNotEntireArchive:true};
      if(consultation){payload.memoryAccess.routes.push('consult');payload.memoryAccess.consultation={enabled:true,
        vias:['find','read','grounds','impact','progress','related','versions','back','forward','directory','history'],discovery:'catalog-only; read-full-version-before-citing',
        continuation:'need is a short initial description or a prior consultation result ref',sharedReadBudget:true,
        navigationRemaining:Math.max(0,32-(round?.navigationSteps??0)),navigationMeaning:'cached-page-visit; model-calls-still-cost; no-undo-of-events-or-state'};}
    }
    if(subjectId!==null){
      ensure(store.subjectObservation(subjectId,current.id),'OBSERVATION_NOT_ADMITTED','admit this observation before deciding');
      const resultStates=information.results.flatMap(r=>r.states??[]).map(x=>x.ref);
      payload.format='agent-decision-continuity-v1';payload.continuity=continuityInput({store,subjectId,stateRefs:uniqueRefs([...stateRefs,...resultStates]),detail:stateDetail,currentEvent,mind,workbenchFocus,
        focusProcessIds:information.results.flatMap(r=>r.graph?.nodes??[]).map(p=>p.id),tasks,recent});
      if(capabilities!==null)payload.continuity.capabilities={format:'capability-map-v1',enabled:[...new Set(capabilities)]};
      const attention=Boolean(payload.continuity.attention);
      const retained=payload.continuity.attention?.materials??[];
      ensure(workbenchMaterials||retained.length===0,'WORKBENCH_CAPABILITY','retained material bindings require explicit workbenchMaterials; cannot silently bypass them');
      if(workbenchMaterials){
        payload.continuity.attention.materialSupport={enabled:true,format:'purpose-material-v1',meaning:'pinned-history-not-current-observation; binding-not-adoption; required-bodies-delivered-together'};
        if(workbenchRecovery){payload.continuity.attention.recoverySupport={enabled:true,format:'material-use-history-v1',frame:payload.continuity.attention.frame};payload.memoryAccess.routes.push('workbench');}
        const combined=new Map(materials.map(m=>[canonical([m.ref,m.aspect]),m]));
        for(const entry of retained.filter(m=>m.delivery==='required')){
          const assignment={ref:entry.ref,aspect:memoryAspect(record(store,entry.ref,['event','note']))};combined.set(canonical([assignment.ref,assignment.aspect]),assignment);
        }
        materials=[...combined.values()];payload.materials=materialList(store,materials,true);
      }
      ensure(!mind||attention,'MIND_PROTOCOL_REQUIRED','mind mode requires explicit purpose-based attention');
      const stage=unified?'decisionGraph':mind?'decisionMind':attention?'decisionAttention':localLookupPolicy!==null?'decisionWorkbench':'decisionInformation';
      if(attention&&payload.memoryAccess){payload.memoryAccess.routes.push('graph','stateRef');payload.memoryAccess.scope='own-retained-events-notes-states-and-processes';}
      if(unified){payload.memoryAccess.routes.push('trace');payload.memoryAccess.scope='own-retained-content-and-explicit-operational-context';}
      ensure(!information.traces.length||unified,'UNIFIED_PROTOCOL_REQUIRED','cross-type results require unified mode to deliver complete packages');
      if(!information.results.length){if(unified)payload.format='agent-decision-graph-v1';else if(mind)payload.format='agent-decision-mind-v1';else if(attention)payload.format='agent-decision-attention-v1';else if(localLookupPolicy!==null)payload.format='agent-decision-workbench-v1';return seal(attention||localLookupPolicy!==null?stage:'decisionContinuity',payload,budgetBytes);}
      payload.format=unified?'agent-decision-graph-v1':mind?'agent-decision-mind-v1':attention?'agent-decision-attention-v1':localLookupPolicy!==null?'agent-decision-workbench-v1':'agent-decision-local-lookup-v1';
      const render=assignments=>{
        const delivered=materialList(store,assignments,consultation),keys=new Set([refKey(current),...delivered.map(m=>refKey(m.ref))]);
        const presented=information.candidates.filter(c=>keys.has(refKey(c.ref))).map(c=>c.ref);
        const omitted=information.candidates.filter(c=>!keys.has(refKey(c.ref))).map(c=>({ref:c.ref,reason:'input-budget-or-material-limit'}));
        const data={...payload,materials:delivered,information:{kind:'local-memory-results',originalTrigger:currentEvent,
          ...(information.trace?{trace:information.trace}:{}),
          ...(information.associations?{associations:information.associations}:{}),
          results:information.results,...(information.desk?{consultationDesk:information.desk}:{}),presentation:{presented,omitted}}};
        if(consultationProgress)data.information.progress=progressProjection({read:(id,rev)=>store.read(id,rev),lastDecision:store.read(subjectId).lastDecision,
          subjectId,currentEvent,workspace,payload:data});
        return seal(stage,data,budgetBytes);
      };
      const assignments=[...materials];let packet=render(assignments);
      for(const candidate of information.candidates){
        if(sameRef(candidate.ref,currentEvent)||assignments.some(a=>sameRef(a.ref,candidate.ref))||assignments.length>=32)continue;
        try{const next=render([...assignments,candidate]);assignments.push(candidate);packet=next;}
        catch(error){if(error.code!=='INPUT_OVERFLOW')throw error;}
      }
      if(!information.traces.length)return packet;
      const base=packet.payload,loaded=new Map(),load=n=>{
        const key=nodeKey(n.ref);if(!loaded.has(key))loaded.set(key,store.readGraphNode({subjectId,ref:n.ref}));
        const value=loaded.get(key);ensure(value,'TRACE_REF','a pinned graph source is no longer available');return value;
      };
      const baseRecords=information.traces.flatMap(r=>r.trace.nodes).filter(n=>graphRecordPresent(base,n.ref)).map(n=>n.ref);
      return assembleGraphPackages({baseRecords,traces:information.traces,render:(selected,presentation)=>{
        const full=selected.map(load),stateNodes=full.filter(x=>x.descriptor.type==='personal_state');
        const continuity=continuityInput({store,subjectId,stateRefs:uniqueRefs([...stateRefs,...resultStates,...stateNodes.map(x=>asRef(x.record))]),detail:stateDetail,currentEvent,mind,workbenchFocus,
          focusProcessIds:full.filter(x=>x.descriptor.type==='process').map(x=>x.record.id),tasks,recent});
        const stateKeys=new Set(stateNodes.map(x=>nodeKey(x.descriptor.ref)));
        for(const group of ['foreground','recalled'])continuity[group]=continuity[group].map(card=>stateKeys.has(nodeKey(recordNode(card.ref)))?
          stateCard(store.read(card.ref.id,card.ref.revision),{historical:card.historical,detail:true}):card);
        const extras=full.filter(x=>['event','note'].includes(x.descriptor.type)).map(x=>({ref:asRef(x.record),aspect:memoryAspect(x.record)}));
        const delivered=materialList(store,[...base.materials.flatMap(m=>m.aspects.map(aspect=>({ref:m.ref,aspect}))),...extras],consultation);
        const cards=full.filter(x=>!['event','note','personal_state'].includes(x.descriptor.type)).map(x=>({ref:x.descriptor.ref,
          type:x.descriptor.type,historical:x.descriptor.historical,latestOwner:x.descriptor.latestOwner,representation:x.representation,
          record:x.record,interpretation:'retained-process-or-operation-context-not-new-observation'}));
        const deliveredKeys=new Set([...baseRecords,...selected.map(n=>n.ref)].map(nodeKey));
        const paths=[...new Map(information.traces.flatMap(r=>r.trace.paths).filter(e=>deliveredKeys.has(nodeKey(e.from))&&deliveredKeys.has(nodeKey(e.to)))
          .map(e=>[`${e.key}:${e.direction}`,{...e,historicalAtDelivery:store.read(e.owner.id)?.revision!==e.owner.revision,
            interpretation:'recorded-relation-at-query-not-new-evidence'}])).values()];
        if(workbenchMaterials)continuity.attention.materialSupport=base.continuity.attention.materialSupport;
        if(workbenchRecovery)continuity.attention.recoverySupport=base.continuity.attention.recoverySupport;
        const data={...base,continuity,materials:delivered,knowledge:{format:'agent-graph-packages-v1',cards,paths,presentation}};
        if(consultationProgress)data.information={...data.information,progress:progressProjection({read:(id,rev)=>store.read(id,rev),lastDecision:store.read(subjectId).lastDecision,
          subjectId,currentEvent,workspace,payload:data})};
        return seal(stage,data,budgetBytes);
      }});
    }
    ensure(stateRefs.length===0&&!stateDetail,'MISSING_SUBJECT','state reads require an explicit subject');
    return seal('decision',payload,budgetBytes);
  });
}

// 反射轮：没有世界观察，只给内部时间/注意力摘要；决定仍由她做。
export function prepareReflection({store,subjectId,workspace,identity='',style='',internal,budgetBytes,allowedActionTools=[],lookupResults=[],capabilities=null,memoryUpdateDue=false,tasks=[],taskWake=false,taskDue=null,memoryWindow=null,recent=null,hostNotices=[]}){
  text(subjectId,'subject id');
  ensure(typeof identity==='string'&&[...identity].length<=4000,'INPUT_LIMIT','bounded host-supplied identity required');
  ensure(internal?.format==='reflection-frame-v1','REFLECTION_INPUT','reflection frame required');
  return store.view(()=>{
    const w=store.read(workspace?.id??workspace,workspace?.revision);
    ensure(w?.type==='workspace','MISSING_WORKSPACE','existing workspace required');
    const continuity=continuityInput({store,subjectId,currentEvent:null,mind:true,workbenchFocus:true,focusProcessIds:[],tasks,recent});
    if(capabilities!==null)continuity.capabilities={format:'capability-map-v1',enabled:[...new Set(capabilities)]};
    const information=lookupResults.length?lookupInformation(store,{lookupResults,subjectId,currentEvent:null,workspace:asRef(w),consultation:false}):null;
    const payload={format:'agent-reflection-input-v1',identity,...(style?{style:{format:'style-pack-v1',text:String(style).slice(0,16000)}}:{}),workspace:w,internal,...(taskWake?{taskWake:true}:{}),...(taskDue?{taskDue}:{}),materials:[],allowedActionTools:permitted(allowedActionTools),continuity,...hostNoticeField(hostNotices),
      ...(memoryUpdateDue?{memoryUpdate:{format:'memory-update-opportunity-v1',due:true,...(memoryWindow?{window:memoryWindow}:{})}}:{}),
      ...(information?{information:{kind:'local-memory-results',originalTrigger:null,...(information.trace?{trace:information.trace}:{}),...(information.associations?{associations:information.associations}:{}),results:information.results,
        presentation:{presented:information.candidates.map(c=>c.ref),omitted:[]}}}:{})};
    return seal('reflection',payload,budgetBytes);
  });
}

export function commitDecision(args){  const context=packetContext(args?.packet,{decisionId:args?.decisionId,requestId:args?.requestId});
  try{
    const result=commitDecisionChecked(args),choice=result.output.options.find(o=>o.id===result.output.selected);
    args.store.recordDiagnostic({stage:'decision.accepted',status:'ok',context,data:{selectedKind:choice.kind,changeCount:result.output.continuity?.changes.length??0}});
    return result;
  }catch(error){args?.store?.recordDiagnostic({stage:'decision.rejected',status:'rejected',context,data:{...failureMetadata(error),...outputMetrics(args?.output)}});throw error;}
}
function commitDecisionChecked({store,packet,output,requestId,decisionId,allowedActionTools=[],maxOutputBytes=16384,invocationKey=null,guardRefs=[]}) {
  const reflection=packet?.stage==='reflection';
  const hasContinuity=continuityStage(packet?.stage);verify(packet,hasContinuity?packet.stage:'decision');text(requestId,'request id');text(decisionId,'decision id');
  ensure(!reflection||packet.payload.current===undefined,'REFLECTION_INPUT','reflection packet has no world observation');
  ensure(invocationKey===null||typeof invocationKey==='string'&&/^[a-f0-9]{64}$/.test(invocationKey),'INVALID_INPUT','invocation key must be null or a SHA256 digest');
  const out=parse(output,maxOutputBytes);exact(out,['packetId','options','selected','summary','used',...(hasContinuity?['continuity']:[])],'decision');
  ensure(out.packetId===packet.packetId,'WRONG_PACKET','output belongs to another input');
  ensure(Array.isArray(out.options)&&out.options.length>0&&out.options.length<=8,'OUTPUT_LIMIT','1..8 options required');
  out.options=out.options.map(option=>normalizeVerbOption(option,{store,subjectId:packet.payload.continuity?.subject?.id??null,now:packet.payload.now??Date.now(),currentScene:packet.payload.workspace?.scene??null}));
  // Preserve bounded, correctly bound final proposals before per-field validation.
  // A malformed reference remains unadopted, never becomes memory, and must not trigger another paid call on re-entry.
  const attempt=hasContinuity?store.execute({requestId:`capture:${requestId}`,commands:[{op:'capture_decision_attempt',id:`${decisionId}:attempt`,decisionId,input:packet,output:out,requestKey:requestId,invocationKey}]}).at(-1):null;
  try{
  if(hasContinuity)normalizeStateDelta(out.continuity,{attention:['decisionAttention','decisionMind','decisionGraph','reflection'].includes(packet.stage),reflection});
  short(out.summary,'summary');
  const ids=new Set();
  for(const o of out.options) {
    exact(o,['id','kind','payload'],'option');text(o.id,'option id');ensure(!ids.has(o.id),'DUPLICATE_OPTION','unique option ids');ids.add(o.id);
    ensure(KINDS.includes(o.kind)&&o.payload&&Object.getPrototypeOf(o.payload)===Object.prototype,'OUTPUT_SHAPE','invalid option');
    if(o.kind==='act'){exact(o.payload,['tool','args'],'action payload');text(o.payload.tool,'tool');ensure(o.payload.args&&Object.getPrototypeOf(o.payload.args)===Object.prototype,'OUTPUT_SHAPE','action args must be an object');}
    if(o.kind==='respond'){
      if(Array.isArray(o.payload.utterances)){
        exact(o.payload,['utterances'],'response payload');
        ensure(o.payload.utterances.length>=1&&o.payload.utterances.length<=4,'OUTPUT_LIMIT','1..4 utterances required');
        for(const u of o.payload.utterances){exact(u,['text','delayMs'],'utterance');short(u.text,'utterance',4000);ensure(Number.isSafeInteger(u.delayMs)&&u.delayMs>=0&&u.delayMs<=5000,'OUTPUT_LIMIT','utterance delay out of range');}
      }else{exact(o.payload,['text'],'response payload');short(o.payload.text,'message',4000);}
    }
    if(o.kind==='turn'){
      const keys=Object.keys(o.payload);
      ensure(keys.length>0&&keys.every(k=>['utterances','actions'].includes(k)),'OUTPUT_SHAPE','turn accepts utterances/actions');
      const utterances=o.payload.utterances,actions=o.payload.actions;
      ensure(utterances===undefined||Array.isArray(utterances)&&utterances.length>=1&&utterances.length<=4,'OUTPUT_LIMIT','turn utterances 1..4');
      ensure(actions===undefined||Array.isArray(actions)&&actions.length>=1&&actions.length<=3,'OUTPUT_LIMIT','turn actions 1..3');
      ensure((utterances?.length??0)+(actions?.length??0)>0,'OUTPUT_SHAPE','turn needs speech or actions');
      for(const u of utterances??[]){exact(u,['text','delayMs'],'utterance');short(u.text,'utterance',4000);ensure(Number.isSafeInteger(u.delayMs)&&u.delayMs>=0&&u.delayMs<=5000,'OUTPUT_LIMIT','utterance delay out of range');}
      for(const a of actions??[]){exact(a,['tool','args'],'turn action');text(a.tool,'tool');ensure(a.args&&Object.getPrototypeOf(a.args)===Object.prototype,'OUTPUT_SHAPE','action args must be an object');}
    }
    if(o.kind==='lookup'){
      normalizeLookupQuery(o.payload);
      ensure(!o.payload.consult||packet.payload.memoryAccess?.consultation?.enabled===true,'CONSULT_CAPABILITY','consultation was not granted in this input');
      ensure(!o.payload.graph&&!o.payload.stateRef||['decisionAttention','decisionMind','decisionGraph','reflection'].includes(packet.stage),'ATTENTION_REQUIRED','extended reads require attention mode');
      ensure(!o.payload.trace||packet.stage==='decisionGraph','UNIFIED_PROTOCOL_REQUIRED','cross-type reads require explicit unified mode');
      ensure(!o.payload.workbench||packet.payload.continuity?.attention?.recoverySupport?.enabled===true,'RECOVERY_CAPABILITY','history route was not granted');
      if(o.payload.workbench){const r=o.payload.workbench.frame??o.payload.workbench.source.frame,f=packet.payload.continuity.attention.frame;
        ensure(r.id===f.id&&r.revision<=f.revision,'RECOVERY_SCOPE','history must be an own delivered-or-older frame');}
    }
  }
  const selected=out.options.find(o=>o.id===out.selected);ensure(selected,'INVALID_CHOICE','selected option is missing');
  const waitGuards=selected.kind==='wait'&&packet.payload.waitSupport?validateWaitCommit({store,support:packet.payload.waitSupport,payload:selected.payload}):[];
  ensure(Array.isArray(out.used)&&out.used.length<=16,'OUTPUT_LIMIT','up to sixteen used references');
  const delivered=new Map(packet.payload.materials.map(m=>[refKey(m.ref),m])), uses=new Set();
  for(const u of out.used){exact(u,['ref','aspect','effect'],'used');uniqueRefs([u.ref]);
    ensure(delivered.get(refKey(u.ref))?.aspects.includes(u.aspect),'UNDELIVERED_REFERENCE','used material or aspect was not in this input');
    ensure(['support','oppose','context','uncertain'].includes(u.effect),'OUTPUT_SHAPE','invalid use effect');
    const key=canonical([u.ref,u.aspect]);ensure(!uses.has(key),'DUPLICATE_USE','one use declaration per reference/aspect');uses.add(key);
  }
  ensure(Array.isArray(guardRefs)&&guardRefs.length<=16,'INPUT_LIMIT','up to sixteen explicit host commit guards');
  const commands=uniqueRefs([...guardRefs,...waitGuards]).map(ref=>({op:'assert_current',ref})), workspace=asRef(packet.payload.workspace), encounter=reflection?null:asRef(packet.payload.current);
  let action=null,actions=[];
  if(selected.kind==='act'){
    const tool=selected.payload.tool;
    ensure(packet.payload.allowedActionTools.includes(tool)&&permitted(allowedActionTools).includes(tool),'TOOL_NOT_GRANTED','tool not granted at preparation or commit');
    action={id:`${decisionId}:action`,revision:1};
    // The actual trigger is host execution context, not a fabricated model-use declaration.
    commands.push({op:'propose_action',id:action.id,workspace,tool,args:selected.payload.args,inputRefs:uniqueRefs(reflection?out.used.map(u=>u.ref):[encounter,...out.used.map(u=>u.ref)])});
  }else if(selected.kind==='turn'){
    const refs=uniqueRefs(reflection?out.used.map(u=>u.ref):[encounter,...out.used.map(u=>u.ref)]);
    for(const [index,item] of (selected.payload.actions??[]).entries()){
      ensure(packet.payload.allowedActionTools.includes(item.tool)&&permitted(allowedActionTools).includes(item.tool),'TOOL_NOT_GRANTED','tool not granted at preparation or commit');
      const ref={id:`${decisionId}:action:${index}`,revision:1};
      commands.push({op:'propose_action',id:ref.id,workspace,tool:item.tool,args:item.args,inputRefs:refs});
      actions.push(ref);
    }
  }
  commands.push({op:'record_decision',id:decisionId,currentEvent:encounter,workspace,materials:inputRefs(packet.payload),input:packet,output:out,action,actions,
    ...(reflection?{reflection:true}:{}),...(hasContinuity?{requestKey:requestId,invocationKey}:{})});
  if(hasContinuity){
    commands.push({op:'advance_subject',subject:packet.payload.continuity.subject,decision:{id:decisionId,revision:1},attempt:asRef(attempt)});
    return store.execute({requestId,commands}).find(r=>r.type==='decision');
  }
  return store.execute({requestId,commands}).at(-1);
  }catch(error){if(attempt&&error.details)error.details={...error.details,attempt:asRef(attempt)};throw error;}
}

export function prepareReview({store,decision,feedbackRefs=[],materials=[],budgetBytes}) {
  return store.view(()=>{
    const d=record(store,decision,['decision']);
    const selected=d.output.options.find(o=>o.id===d.output.selected);
    let action=null;const feedback=uniqueRefs(feedbackRefs);
    if(d.action){
      action=store.read(d.action.id);ensure(action?.type==='action'&&action.status!=='proposed'&&action.receipt,'REVIEW_NOT_READY','actual terminal action receipt required');
      if(!feedback.some(r=>refKey(r)===refKey(action.receipt)))feedback.push(action.receipt);
    }
    ensure(feedback.length>0&&feedback.length<=16,'FEEDBACK_REQUIRED','one to sixteen actual feedback records required');
    const observations=feedback.map(ref=>record(store,ref,['event']));
    ensure(observations.every(r=>['observed','reported','tool_receipt'].includes(r.origin)),'NOT_AN_ENCOUNTER','background or imagination is not actual feedback');
    return seal('review',{format:'agent-review-input-v1',decision:{ref:asRef(d),selected,summary:d.output.summary,used:d.output.used},
      identityAtDecision:d.input.payload.identity,
      action:action?{ref:asRef(action),status:action.status,receipt:action.receipt}:null,
      executionStatus:action?'receipt-received':'no-execution-receipt',feedback:observations,materials:materialList(store,materials)},budgetBytes);
  });
}

export function stageReview({store,packet,output,requestId,reviewId,maxOutputBytes=32768}) {
  verify(packet,'review');text(requestId,'request id');text(reviewId,'review id');
  const out=parse(output,maxOutputBytes);exact(out,['packetId','disposition','summary','updates','questions'],'review');
  ensure(out.packetId===packet.packetId,'WRONG_PACKET','review belongs to another input');
  short(out.summary,'summary');ensure(['keep','update','defer','lookup'].includes(out.disposition),'OUTPUT_SHAPE','invalid review disposition');
  ensure(Array.isArray(out.updates)&&out.updates.length<=4&&(out.disposition==='update'?out.updates.length>0:out.updates.length===0),'OUTPUT_SHAPE','updates do not match disposition');
  ensure(Array.isArray(out.questions)&&out.questions.length<=4,'OUTPUT_LIMIT','up to four questions');out.questions.forEach(q=>short(q,'question',300));
  const delivered=new Set([...packet.payload.materials.map(m=>refKey(m.ref)),...packet.payload.feedback.map(r=>refKey(r))]), ids=new Set();
  for(const u of out.updates){
    exact(u,['id','expectedRevision','body','kind','change','confidence','status','scope','evidence'],'note proposal');
    text(u.id,'note id');ensure(!ids.has(u.id),'DUPLICATE_UPDATE','one update per note');ids.add(u.id);short(u.body,'note body',4000);
    ensure(Number.isSafeInteger(u.expectedRevision)&&u.expectedRevision>=0,'OUTPUT_SHAPE','invalid expected revision');
    if(u.expectedRevision>0)ensure(packet.payload.materials.some(m=>m.ref.id===u.id&&m.ref.revision===u.expectedRevision),'UNREAD_TARGET','read exact prior note revision before changing it');
    for(const ref of uniqueRefs(u.evidence))ensure(delivered.has(refKey(ref)),'UNDELIVERED_REFERENCE','evidence must have been delivered');
    ensure(u.evidence.every(ref=>ref.id!==u.id),'SELF_SUPPORT','proposal cannot cite itself');
    ensure(['fact_claim','interpretation','value','preference','dream','tension','feeling','skill'].includes(u.kind)
      && ['new_evidence','reinterpretation','self_report'].includes(u.change)&&['tentative','uncertain','confident'].includes(u.confidence)
      && ['current','suspended','historical'].includes(u.status),'OUTPUT_SHAPE','invalid note classification');
    exact(u.scope,['scenes','people','validFrom','validUntil'],'scope');
    ensure(Array.isArray(u.scope.scenes)&&Array.isArray(u.scope.people),'OUTPUT_SHAPE','scope arrays required');
    [...u.scope.scenes,...u.scope.people].forEach(s=>text(s,'scope entry'));
    for(const t of [u.scope.validFrom,u.scope.validUntil])ensure(t===null||Number.isSafeInteger(t)&&t>=0,'OUTPUT_SHAPE','scope time must be integer ms or null');
    ensure(u.scope.validFrom===null||u.scope.validUntil===null||u.scope.validUntil>u.scope.validFrom,'OUTPUT_SHAPE','invalid scope interval');
  }
  return store.execute({requestId,commands:[{op:'stage_review',id:reviewId,decision:packet.payload.decision.ref,action:packet.payload.action?.ref??null,
    feedbackRefs:packet.payload.feedback.map(asRef),materials:inputRefs(packet.payload),input:packet,output:out}]}).at(-1);
}

export function adoptReview({store,review,requestId}) {
  uniqueRefs([review]);return store.execute({requestId,commands:[{op:'adopt_review',review}]}).at(-1);
}

// Explicit own-history access; operational logs remain outside ordinary personal-memory search.
export function readCognitionRecord({store,ref}) {return clone(record(store,ref,['decision','review']));}

export function ablateDecisionPacket(packet,aspect) {
  const stage=continuityStage(packet?.stage)?packet.stage:'decision';verify(packet,stage);ensure(ASPECTS.includes(aspect),'INVALID_ASPECT','unknown ablation aspect');
  const payload=clone(packet.payload),removed=[],retainedShared=[];
  payload.materials=payload.materials.flatMap(m=>{
    if(!m.aspects.includes(aspect))return [m];
    const aspects=m.aspects.filter(a=>a!==aspect);
    if(aspects.length){retainedShared.push(m.ref);return [{...m,aspects}];}
    removed.push(m.ref);return [];
  });
  return {packet:seal(stage,payload,packet.budgetBytes),intervention:{aspect,removed,retainedShared,
    limitation:'removes this material channel only; current observation, prior decisions, continuity states, lookup catalogs and shared material may still contain related content'}};
}

// Network evaluators receive only a validated copy of the exact prepared messages.
export function verifiedModelInput(packet) {
  ensure(['decision','decisionContinuity','decisionInformation','decisionWorkbench','decisionAttention','decisionMind','decisionGraph','reflection','review'].includes(packet?.stage),'PACKET_STAGE','unsupported stage');
  verify(packet,packet.stage);
  return {packetId:packet.packetId,messages:clone(packet.messages),bytes:packet.bytes};
}
