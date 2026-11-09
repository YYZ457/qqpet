// 她的一轮：收观察 → 问她的节律 → 组装最合理的处境 → 把决定权交给她 → 执行她的选择 → 收出站/等待。
// 宿主只提供事实、结构、资源与执行；不替她挑焦点、不替她写记忆、不替她解释。
import {canonical,digest,ensure,text} from './contracts.mjs';
import {ContinuitySession} from './continuity-session.mjs';
import {LocalLookupSession} from './local-lookup.mjs';
import {prepareReflection} from './cognition.mjs';
import {reflectionFrame} from './reflection-frame.mjs';
import {rhythmConfig,rhythmTick} from './rhythm.mjs';
import {recordEpisodes} from './tendency.mjs';
import {observeAssociation} from './association-observe.mjs';
import {keepAttention} from './attention.mjs';
import {resolveLimits} from './limits.mjs';

const ref=r=>({id:r.id,revision:r.revision});
// 别的会话先提交导致的过期：可以在最新状态上重放
const STALE_ERRORS=new Set(['STALE_SUBJECT','STALE_ATTENTION','STALE_STATE','STALE_DELIVERY']);
// 状态增量层面的问题：可以丢掉状态增量、保留说话和动作
const STATE_ERRORS=new Set([...STALE_ERRORS,'RESIDENCY_CONFLICT','UNDELIVERED_BASIS','UNREAD_STATE','MIND_KIND','STATE_CONFLICT','VERSION_CONFLICT',
  'MISSING_STATE','CLOSED_FOREGROUND','FOREGROUND_CAPACITY','ID_COLLISION','MIND_PROTOCOL_REQUIRED']);
// 真实模型客户端返回 JSON 字符串；旧的降级逻辑只认对象，所以对真模型从来没生效过。
function parseOutput(output){
  if(output&&typeof output==='object')return output;
  if(typeof output!=='string')return null;
  try{const v=JSON.parse(output);return v&&typeof v==='object'?v:null;}catch{return null;}
}
function droppedChanges(continuity){
  const clip=v=>typeof v==='string'?v.slice(0,160):v;
  return [
    ...(continuity.changes??[]).map(c=>({op:c.expectedRevision===0?'create':'revise',id:c.id,kind:c.kind??null,body:clip(c.body??null),status:c.status??null})),
    ...(continuity.residency?.add??[]).map(id=>({op:'foreground-add',id})),
    ...(continuity.residency?.remove??[]).map(id=>({op:'foreground-remove',id})),
    ...(continuity.attention?.residency?.upsert??[]).map(r=>({op:'attention-upsert',id:r.id})),
  ].slice(0,16);
}

export class TurnDriver {
  #store;#subjectId;#session;#lookup;#decide;#config;#lookupPolicy;#workspace;#identity;#style;#eventBypass;#materialsFor;#maxCalls;#box;#shared;#limits;#outbox;#tendency;#allowed;#capabilities;#tickChain;#tasks;
  constructor({store,subjectId,decide,workspace,identity='',style='',eventBypass=false,materialsFor=null,rhythm={},lookupPolicy=null,maxCallsPerTurn=null,maxForeground=null,tendency=null,allowedActionTools=[],capabilities=null,tasks=null,shared=null,limits=null}={}){
    // 容量统一来自 limits；显式参数仍然优先，保持旧调用方式可用。
    this.#limits=limits??resolveLimits();
    lookupPolicy??={maxReads:this.#limits.lookupReads,maxHits:this.#limits.lookupHits};
    maxCallsPerTurn??=this.#limits.callsPerTurn;maxForeground??=this.#limits.foreground;
    ensure(store&&typeof store.execute==='function','TURN_DRIVER','store required');
    text(subjectId,'subject id');ensure(typeof decide==='function','TURN_DRIVER','decide function required');
    const w=store.read(workspace?.id??workspace,workspace?.revision);
    ensure(w?.type==='workspace','TURN_DRIVER','existing workspace required');
    ensure(typeof identity==='string'&&[...identity].length<=4000,'TURN_DRIVER','bounded identity required');
    ensure(Number.isSafeInteger(maxCallsPerTurn)&&maxCallsPerTurn>=1&&maxCallsPerTurn<=8,'TURN_DRIVER','1..8 calls per turn');
    ensure(tendency===null||(tendency?.learning&&typeof tendency.learning.material==='function'&&typeof tendency.learning.observe==='function'
      &&tendency.spec&&typeof tendency.contextFor==='function'),'TURN_DRIVER','explicit tendency session and context provider required');
    ensure(Array.isArray(allowedActionTools)&&allowedActionTools.length<=64,'TURN_DRIVER','up to 64 granted action tools');
    allowedActionTools.forEach(t=>text(t,'tool'));
    this.#store=store;this.#subjectId=subjectId;this.#decide=decide;this.#workspace=ref(w);
    this.#identity=identity;this.#style=String(style??'').slice(0,16000);this.#eventBypass=eventBypass===true;this.#materialsFor=typeof materialsFor==='function'?materialsFor:()=>[];
    this.#maxCalls=maxCallsPerTurn;this.#lookupPolicy=lookupPolicy;this.#tendency=tendency;
    this.#allowed=[...new Set(allowedActionTools)].sort();
    ensure(capabilities===null||Array.isArray(capabilities)&&capabilities.every(c=>typeof c==='string'),'TURN_DRIVER','capabilities must be null or a string array');
    this.#capabilities=capabilities;this.#tasks=typeof tasks==='function'?tasks:null;
    this.#session=new ContinuitySession({store,subjectId,attention:true,maxForeground});
    this.#lookup=new LocalLookupSession({store,subjectId,policy:lookupPolicy});
    this.#config=rhythmConfig(rhythm);
    // 同一主体的多个会话（每个 QQ 聊天一个 driver）共享一份节律/预算状态和宿主提示；
    // 以前每个 driver 各记各的，写回同一条 rhythm note 时互相覆盖，日调用上限也按会话数放大。
    this.#shared=shared??{};
    this.#shared.rhythm??={state:{lastWakeAt:null,nextWakeAt:null,callsToday:0,dayKey:null}};
    this.#shared.notices??=[];
    this.#box=this.#shared.rhythm;
    this.#outbox=[];
    this.#tickChain=Promise.resolve();
  }
  get state(){return {...this.#box.state};}
  get subjectId(){return this.#subjectId;}
  setStyle(style){this.#style=String(style??'').slice(0,16000);}

  // 观察入账：同一 source key 幂等；admit 让收件箱可见（重复也幂等）。不决定事情，只记事实。
  ingest({key,body,actor='brother',sender=null,scene='local-chat',origin='reported',at=Date.now(),sourceSystem='turn-driver',sourceKey=null,admit=true}){
    text(key,'observation key');text(body,'observation body');
    const id='obs:'+key;
    const ev=this.#store.execute({requestId:`ingest:${id}`,commands:[{op:'append_event',id,body,origin,actor,scene,...(sender?{sender}:{}),occurredAt:at,source:{system:sourceSystem,key:sourceKey??id}}]}).at(-1);
    if(admit)this.#store.execute({requestId:`admit:${digest({subject:this.#subjectId,event:ref(ev)})}`,
      commands:[{op:'admit_subject_event',subjectId:this.#subjectId,event:ref(ev)}]});
    return ref(ev);
  }

  // 节律机会：醒来 ≠ 必须思考。没有待处理观察时只是空闲；预算门由节律层给出。
  // eventId：只处理这一条观察（调用方已按收件箱确定）；不给则取最早的“新收到”观察，
  // 已 deferred 的旧观察排在新观察之后，不再堵住队首（否则会处理 A 却留下 B，或旧消息反复出现）。
  tick(options={}){
    // 同一主体的 tick 串行：上一条决策/回复提交完成后，下一条才准备 packet。
    const run=this.#tickChain.then(()=>this.#runTick(options));
    this.#tickChain=run.catch(()=>{});
    return run;
  }
  async #runTick({now=Date.now(),localHour=null,dayKey=null,memoryUpdate=false,memoryWindow=null,eventBypass=this.#eventBypass,eventId=null}={}){
    let pending=this.#store.subjectInbox({subjectId:this.#subjectId,limit:100,pendingOnly:true}).items;
    if(eventId!==null){
      pending=pending.filter(item=>item.eventId===eventId);
      if(pending.length===0)return {wake:false,reason:'not-pending',stale:true,eventId};
    }else{
      pending=[...pending.filter(item=>item.status==='received'),...pending.filter(item=>item.status!=='received')];
    }
    const day=dayKey??new Date(now).toISOString().slice(0,10);
    const calls=day===this.#box.state.dayKey?this.#box.state.callsToday:0;
    // 记忆机会不受“节律还没到”限制；否则 idleReflect 在非 beat 时刻永远返回 wake:false。
    // 但仍尊重当天模型调用上限，不绕过预算。
    if(memoryUpdate&&pending.length===0){
      if(calls>=this.#config.dailyCallCap)return {wake:true,reason:'memory-update',action:'budget-blocked',pending:0};
      return this.#runReflection({now,reason:'memory-update',memoryUpdate:true,memoryWindow});
    }
    const hour=localHour??new Date(now).getHours();
    // 事件旁路只为“新收到”的观察破节律；deferred 的旧观察只能等节律醒来或被明确指定，避免每次心跳都重复烧调用。
    const fresh=eventId!==null?pending:pending.filter(item=>item.status==='received');
    if(eventBypass&&fresh.length>0){
      const dayKeyNow=dayKey??new Date(now).toISOString().slice(0,10);
      const callsNow=dayKeyNow===this.#box.state.dayKey?this.#box.state.callsToday:0;
      if(callsNow>=this.#config.dailyCallCap)return {wake:false,reason:'budget',pending:pending.length};
      if(dayKeyNow!==this.#box.state.dayKey)this.#box.state.callsToday=0; // 跨天重置，否则旁路路径的日上限永不归零
      this.#box.state.lastWakeAt=now;this.#box.state.dayKey=dayKeyNow;
      return this.#runDecision({now,observation:fresh[0],reason:'event'});
    }
    const r=rhythmTick({now,localHour:hour,state:{lastWakeAt:this.#box.state.lastWakeAt??(now),nextWakeAt:this.#box.state.nextWakeAt,
      callsToday:calls,clockSuspect:false,pendingEvents:pending.length},config:this.#config});
    this.#box.state={lastWakeAt:r.state.lastWakeAt,nextWakeAt:r.state.nextWakeAt,callsToday:r.state.callsToday,dayKey:day};
    if(!r.wake)return {wake:false,reason:r.reason,nextAt:r.nextAt};
    if(!r.modelAllowed)return {wake:true,reason:r.reason,action:'budget-blocked',pending:pending.length,nextAt:r.nextAt};
    if(pending.length===0)return this.#runReflection({now,reason:r.reason});
    return this.#runDecision({now,observation:pending[0],reason:r.reason});
  }

  // 节律醒来但没有新观察：给内部时间/注意力摘要，让她自己决定要不要做点什么（不写事件）。
  async taskWake({now=Date.now(),task=null}={}){
    const run=this.#tickChain.then(()=>this.#runReflection({now,reason:'task-due',task}));
    this.#tickChain=run.catch(()=>{});return run;
  }
  async #runReflection({now,reason,memoryUpdate=false,task=null,memoryWindow=null}){
    const internal=reflectionFrame({read:(id,rev)=>this.#store.read(id,rev),subjectId:this.#subjectId,workspace:this.#workspace,now,
      sinceLastInteraction:this.#box.state.lastWakeAt===null?null:Math.max(0,now-this.#box.state.lastWakeAt),
      waitingUntil:this.#box.state.nextWakeAt});
    const lookups=[],outbox=[];let decision=null,choiceKind=null;
    const taskDue=task?{id:task.id,goal:task.goal,currentStep:task.currentStep,nextStep:task.nextStep,checkpoint:task.checkpoint,status:task.status}:null;
    for(let c=0;c<this.#maxCalls;c++){
      const build=extra=>prepareReflection({store:this.#store,subjectId:this.#subjectId,workspace:this.#workspace,identity:this.#identity,
        internal,budgetBytes:this.#limits.inputBytes,allowedActionTools:this.#allowed,lookupResults:lookups,capabilities:this.#capabilities,tasks:this.#tasks?.()??[],memoryUpdateDue:memoryUpdate,memoryWindow,style:this.#style,taskWake:reason==='task-due',taskDue,...extra});
      const {packet,rebuild,notices}=this.#prepareAdaptive(build);
      this.#box.state.callsToday++;
      const output=await this.#decide(packet);
      const decisionId=`reflection:${packet.packetId}:${Date.now().toString(36)}`;
      const committed=this.#commitWithFallback({packet,output,decisionId,requestId:decisionId,rebuild,notices});
      decision=committed.decision;
      observeAssociation({store:this.#store,packet:committed.packet,decision});
      const choice=decision.output.options.find(o=>o.id===decision.output.selected);choiceKind=choice.kind;
      if(choice.kind==='lookup'){
        if(c+1>=this.#maxCalls)return {wake:true,reason,action:'lookup-exhausted',decision:ref(decision),lookups};
        lookups.push(ref(this.#lookup.execute({decision:ref(decision)})));
        continue;
      }
      this.#pushChoice(outbox,choice,decision);
      if(choice.kind==='wait'&&Number.isSafeInteger(choice.payload?.wakeAt)&&choice.payload.wakeAt>now)this.#box.state.nextWakeAt=choice.payload.wakeAt;
      break;
    }
    this.#outbox.push(...outbox);
    return {wake:true,reason,action:'reflected',decision:ref(decision),choice:choiceKind,silent:!outbox.some(o=>o.kind==='respond'),outbox:[...outbox],lookups};
  }

  async #runDecision({now,observation,reason}){
    const event=this.#store.read(observation.eventId);
    ensure(event?.type==='event','TURN_DRIVER','pending observation must be an existing event');
    const current=ref(event),lookups=[],outbox=[];
    const materials=[...(this.#materialsFor({store:this.#store,subjectId:this.#subjectId,event:current,now})??[])];
    // 长期经验卡：宿主先确认这是"她自己的学习语境"，才生成并作为知识材料交付；卡片不是指令。
    if(this.#tendency){
      const context=this.#tendency.contextFor({store:this.#store,event:current,now});
      if(context){const card=this.#tendency.learning.material({context});materials.push({ref:card.ref,aspect:'knowledge'});}
    }
    let decision=null,choiceKind=null;
    for(let c=0;c<this.#maxCalls;c++){
      const build=extra=>this.#session.prepare({currentEvent:current,workspace:this.#workspace,identity:this.#identity,style:this.#style,materials,previousDecisions:[],
        mind:true,unified:true,workbenchMaterials:true,workbenchFocus:true,workbenchRecovery:true,
        localLookupPolicy:this.#lookupPolicy,lookupResults:lookups,allowedActionTools:this.#allowed,budgetBytes:this.#limits.inputBytes,now,capabilities:this.#capabilities,tasks:this.#tasks?.()??[],...extra});
      const {packet,rebuild,notices}=this.#prepareAdaptive(build);
      this.#box.state.callsToday++;
      const output=await this.#decide(packet);
      const decisionId=`${event.id}:decision:${c}:${Date.now().toString(36)}`;
      const committed=this.#commitWithFallback({packet,output,decisionId,requestId:`turn:${event.id}:${c}:${Date.now().toString(36)}`,rebuild,notices});
      decision=committed.decision;
      observeAssociation({store:this.#store,packet:committed.packet,decision});
      const choice=decision.output.options.find(o=>o.id===decision.output.selected);choiceKind=choice.kind;
      if(choice.kind==='lookup'){
        if(c+1>=this.#maxCalls)return {wake:true,reason,action:'lookup-exhausted',decision:ref(decision),outbox,lookups};
        lookups.push(ref(this.#lookup.execute({decision:ref(decision)})));
        continue;
      }
      this.#pushChoice(outbox,choice,decision);
      if(choice.kind==='wait'&&Number.isSafeInteger(choice.payload?.wakeAt)&&choice.payload.wakeAt>now)this.#box.state.nextWakeAt=choice.payload.wakeAt;
      break;
    }
    this.#outbox.push(...outbox);
    return {wake:true,reason,action:'decided',decision:ref(decision),choice:choiceKind,silent:!outbox.some(o=>o.kind==='respond'),outbox:[...outbox],lookups};
  }

  // 组装输入包。最近上下文不再固定 50 条：超出字节预算时逐步缩小最近上下文再试，
  // 而不是整轮 INPUT_OVERFLOW 没有回复。返回的 rebuild 用同样的规模在最新状态上重新组装。
  #prepareAdaptive(build){
    const notices=this.#shared.notices.slice(-this.#limits.hostNotices);
    let recent={items:this.#limits.recentItems,bytes:this.#limits.recentBytes,chats:this.#limits.recentChats,
      chatTail:this.#limits.recentChatTail,chatWindowMs:this.#limits.recentChatWindowHours*3600000};
    for(let attempt=0;;attempt++){
      const extra={recent,hostNotices:notices};
      try{
        const packet=build(extra);
        if(attempt>0)this.#diagnose('input.shrunk','ok',{packet,data:{attempts:attempt,recent}});
        return {packet,rebuild:()=>build(extra),notices};
      }catch(error){
        if(error.code!=='INPUT_OVERFLOW'||recent.items<=4)throw error;
        // 先缩其他会话的预览，再缩当前聊天；会话列表本身（谁在等她）尽量保留
        recent={...recent,items:Math.max(4,Math.floor(recent.items*0.6)),bytes:Math.max(2000,Math.floor(recent.bytes*0.6)),
          chatTail:Math.max(1,Math.floor(recent.chatTail/2))};
      }
    }
  }

  // 提交她的决定。
  // 1) 并发导致的过期（STALE_*）：她的决定没有错，只是别的会话先提交了。在最新状态上重新组装输入、
  //    原样重放这个决定（不再调用模型）。只有她改的状态在此期间被别处改过时才会真正冲突。
  // 2) 状态增量本身不合法或确实冲突：保留说话/动作，丢弃状态增量——但不再静默：写诊断，
  //    并在下一轮输入的 hostNotices 里告诉她哪些修改没存上，让她自己决定要不要重做。
  #commitWithFallback({packet,output,decisionId,requestId,rebuild=null,notices=[]}){
    const commit=(p,o,suffix)=>this.#session.commit({packet:p,output:o,decisionId:decisionId+suffix,requestId:requestId+suffix,allowedActionTools:this.#allowed,maxOutputBytes:32768});
    const done=(decision,p,mode)=>{this.#consumeNotices(notices);if(mode!=='direct')this.#diagnose('decision.'+mode,'ok',{packet:p,data:{decisionId:decision.id}});return {decision,packet:p,mode};};
    try{return done(commit(packet,output,''),packet,'direct');}
    catch(error){
      if(!STATE_ERRORS.has(error.code))throw error;
      const parsed=parseOutput(output);
      if(!parsed?.continuity)throw error;
      let base=packet,lastError=error;
      if(STALE_ERRORS.has(error.code)&&rebuild){
        try{
          base=rebuild();
          return done(commit(base,{...parsed,packetId:base.packetId},':rebased'),base,'rebased');
        }catch(second){if(!STATE_ERRORS.has(second.code))throw second;lastError=second;}
      }
      const dropped=droppedChanges(parsed.continuity);
      const stripped={...parsed,packetId:base.packetId,continuity:{...parsed.continuity,changes:[],residency:{add:[],remove:[]},attention:keepAttention()}};
      let decision;
      try{decision=commit(base,stripped,':stripped');}
      catch(third){
        if(!STATE_ERRORS.has(third.code))throw third;
        const bare={...parsed,packetId:base.packetId};delete bare.continuity;
        decision=commit(base,bare,':bare');
      }
      this.#remember({kind:'state-not-saved',code:lastError.code,message:String(lastError.message).slice(0,200),decision:ref(decision),scene:base.payload?.workspace?.scene??null,dropped});
      return done(decision,base,'degraded');
    }
  }
  #remember(notice){
    if(this.#limits.hostNotices===0)return;
    this.#shared.notices.push({format:'host-notice-v1',at:Date.now(),...notice});
    while(this.#shared.notices.length>this.#limits.hostNotices)this.#shared.notices.shift();
    this.#diagnose('decision.state-dropped','degraded',{data:notice});
    console.warn('[threadline] state changes not saved:',notice.code,JSON.stringify(notice.dropped).slice(0,300));
  }
  #consumeNotices(delivered){
    if(!delivered.length)return;
    const keys=new Set(delivered.map(n=>canonical(n)));
    this.#shared.notices=this.#shared.notices.filter(n=>!keys.has(canonical(n)));
  }
  #diagnose(stage,status,{packet=null,data={}}={}){
    try{this.#store.recordDiagnostic({stage,status,context:{subjectId:this.#subjectId,...(packet?{packetId:packet.packetId}:{})},data});}catch{}
  }
  get notices(){return this.#shared.notices.map(n=>({...n}));}
  #pushChoice(outbox,choice,decision){
    const speech=choice.kind==='respond'||(choice.kind==='turn'&&Array.isArray(choice.payload.utterances)&&choice.payload.utterances.length)?choice.payload:null;
    if(speech){const response=this.#store.read(`${decision.id}:response`);outbox.push({kind:'respond',text:speech.text??speech.utterances?.[0]?.text??'',...(Array.isArray(speech.utterances)?{utterances:speech.utterances}:{}),...(response?{response:{id:response.id,revision:response.revision}}:{})});}
    if(choice.kind==='act')outbox.push({kind:'act',tool:choice.payload.tool,args:choice.payload.args,action:decision.action??null});
    else if(choice.kind==='turn')for(const [index,item] of (choice.payload.actions??[]).entries())
      outbox.push({kind:'act',tool:item.tool,args:item.args,action:decision.actions?.[index]??null});
  }
  takeOutbox(){const out=this.#outbox;this.#outbox=[];return out;}

  // 真实回执入账（执行结果只能来自宿主；这里只记录，不推断她是否“学到”）。
  applyReceipt({action,status,body,eventId,actor='host',sourceSystem='host',occurredAt}={}){
    ensure(action,'TURN_DRIVER','action reference required');
    const existing=this.#store.read(eventId);
    if(existing?.type==='event'&&existing.origin==='tool_receipt'){
      const tendency=this.#tendency?recordEpisodes({learning:this.#tendency.learning,store:this.#store,spec:this.#tendency.spec}):null;
      return {receipt:ref(existing),tendency,replayed:true};
    }
    const live=this.#store.read(action.id,action.revision);
    ensure(live?.type==='action','TURN_DRIVER','existing action required');
    const ev=this.#store.execute({requestId:`receipt:${eventId}`,commands:[{op:'record_receipt',actionId:live.id,
      expectedRevision:live.revision,status,eventId,body,source:{system:sourceSystem,key:eventId},actor,occurredAt:occurredAt??Date.now()}]}).at(-1);
    const receipt=ev.receipt;
    this.#store.execute({requestId:'receipt-admit:'+eventId,commands:[{op:'admit_subject_event',subjectId:this.#subjectId,event:receipt}]});
    const tendency=this.#tendency?recordEpisodes({learning:this.#tendency.learning,store:this.#store,spec:this.#tendency.spec}):null;
    return {receipt,tendency};
  }

  // 节律状态存成版本化 note：重启后接得上；内容只是时钟与预算，不是经历。
  loadState(){
    const id=`rhythm:${this.#subjectId}`,note=this.#store.read(id);
    if(!note?.body)return false;
    let data;try{data=JSON.parse(note.body);}catch{return false;}
    if(data?.format!=='rhythm-state-v1')return false;
    this.restore({state:{lastWakeAt:data.lastWakeAt??null,nextWakeAt:data.nextWakeAt??null,callsToday:data.callsToday??0,dayKey:data.dayKey??null}});
    return true;
  }
  persistState(){
    const id=`rhythm:${this.#subjectId}`,old=this.#store.read(id),body=canonical({format:'rhythm-state-v1',...this.#box.state});
    const out=this.#store.execute({requestId:`rhythm-state:${digest({id,body,expected:old?.revision??0})}`,
      commands:[{op:'write_note',id,expectedRevision:old?.revision??0,kind:'skill',change:'self_report',evidence:[],body}]}).at(-1);
    return ref(out.record);
  }

  snapshot(){return {state:{...this.#box.state},outbox:[...this.#outbox]};}
  restore(snapshot){
    ensure(snapshot&&typeof snapshot==='object','TURN_DRIVER','snapshot required');
    const s=snapshot.state??{};
    for(const key of ['lastWakeAt','nextWakeAt'])ensure(s[key]===null||Number.isSafeInteger(s[key]),'TURN_DRIVER',`invalid ${key}`);
    ensure(Number.isSafeInteger(s.callsToday??0)&&(s.callsToday??0)>=0,'TURN_DRIVER','invalid callsToday');
    this.#box.state={lastWakeAt:s.lastWakeAt??null,nextWakeAt:s.nextWakeAt??null,callsToday:s.callsToday??0,dayKey:s.dayKey??null};
    this.#outbox=Array.isArray(snapshot.outbox)?[...snapshot.outbox]:[];
  }
}
