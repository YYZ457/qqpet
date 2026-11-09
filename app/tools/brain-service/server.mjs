// 本机脑服务：串行队列 + 一个主体；默认 dry-run，不调模型、不联网。
import {createServer} from 'node:http';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {ensure,text} from '../../src/contracts.mjs';
import {ContinuityStore} from '../../src/store.mjs';
import {ContinuitySession} from '../../src/continuity-session.mjs';
import {TurnDriver} from '../../src/turn-driver.mjs';
import {SceneScheduler} from '../../src/scheduler.mjs';
import {keepAttention} from '../../src/attention.mjs';
import {normalizeInbound} from './adapters.mjs';
import {bindingCommands} from '../../src/binding-action.mjs';
import {CAPABILITIES} from '../../src/capabilities.mjs';
import {TOOL_NAMES} from '../qq-connect/tools.mjs';
import {AttentionPolicy} from '../../src/attention-policy.mjs';
import {rememberNote} from '../../src/remember.mjs';
import {randomUUID} from 'node:crypto';
import {queryAnchor} from '../../src/anchor.mjs';
import {ensurePerson} from '../../src/identity.mjs';
import {claimResponse,recordResponseDelivery} from '../../src/continuity.mjs';
import {StyleStore} from '../../src/style-store.mjs';
import {TaskStore} from '../../src/tasks.mjs';
import {buildMemoryWindow} from '../../src/memory-window.mjs';
import {SubjectLock} from '../../src/subject-lock.mjs';
import {resolveLimits} from '../../src/limits.mjs';

const MAX_BODY=1024*1024;
const MAX_VISION_BODY=12*1024*1024;
const ATTENTION=()=>({...keepAttention()});

function dryDecide(packet){
  const reflection=packet.stage==='reflection';
  const continuity=reflection?{changes:[],residency:{add:[],remove:[]},attention:ATTENTION()}
    :{changes:[],residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',attention:ATTENTION()};
  return JSON.stringify({packetId:packet.packetId,options:[{id:'w',kind:'wait',payload:{}}],selected:'w',summary:'dry-run',used:[],continuity});
}
function ensureWorkspace(store,scene){
  const id=`ws:${scene}`,old=store.read(id);
  const persona=store.read('legacy:persona:agent');
  const refs=persona?[{id:persona.id,revision:persona.revision}]:[];
  if(old){
    if(persona&&old.workingRefs?.[0]?.id!==persona.id){
      return store.execute({requestId:`workspace:persona:${id}:${old.revision}`,commands:[{op:'set_workspace',id,expectedRevision:old.revision,scene,
        focus:old.focus,workingRefs:[...refs,...old.workingRefs.filter(r=>r.id!==persona.id)],continuityRefs:old.continuityRefs,actionRefs:old.actionRefs}]}).at(-1);
    }
    return old;
  }
  return store.execute({requestId:`workspace:${id}`,commands:[{op:'set_workspace',id,expectedRevision:0,scene,focus:{id:'current',label:'当前'},
    workingRefs:refs,continuityRefs:[],actionRefs:[]}]}).at(-1);
}
function keyFor(scene,key){
  if(key)return key;
  if(scene.startsWith('qq/private/'))return `private:${scene.slice('qq/private/'.length)}`;
  if(scene.startsWith('qq/group/'))return `group:${scene.slice('qq/group/'.length)}`;
  if(scene.startsWith('mc/'))return scene.slice('mc/'.length);
  if(scene.startsWith('local/'))return scene.slice('local/'.length);
  if(key)return key;
  const prefix=scene.split('/')[0],rest=scene.slice(prefix.length+1);
  if(prefix&&rest)return `${prefix}:${rest}`;
  throw Object.assign(new Error('cannot derive source key from scene'),{code:'ADAPTER'});
}
// 队列项只是“去看哪条观察”的指针；收件箱才是唯一事实源。
const eventIdOf=item=>item?.eventId??(String(item?.key??'').startsWith('obs:')?item.key:`obs:${item?.key}`);
// 这些错误重试没有意义（没钥匙/没网/预算停了/同一请求已发过），立刻停下并退避，别空转也别重复烧钱
const HARD_ERRORS=new Set(['STUDY_KEY_REQUIRED','MISSING_CREDENTIAL','NETWORK_PREFLIGHT_FAILED','BUDGET_HALTED','CALL_LIMIT','SPEND_LIMIT','TRANSPORT_REPLAY','ALREADY_REQUESTED','LEDGER_LOCKED','LEDGER_UNAVAILABLE','UNCERTAIN_REQUEST','PROVIDER_HTTP']);
const MAX_RECEIPT_CHAIN=4; // 无人说话时，工具回执连续触发下一轮的上限，防止 act→回执→act 无限循环
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function firstText(messages){
  const list=Array.isArray(messages)?messages:[];
  const last=[...list].reverse().find(m=>m&&typeof m.content==='string');
  return last?.content??'';
}

export function createBrainService({storePath=':memory:',subjectId='agent',identity='你是智能体。',decide=dryDecide,rhythm={},clock=Date.now,capabilities=CAPABILITIES.map(c=>c.id),allowedActionTools=[...TOOL_NAMES,'remember_note'],adapter=null,stateDirectory=null,styleDirectory=null,heartbeatMs=0,global=false,eventBypass=true,keyFile=null,extraStatus=null,vision=null,taskStorePath=null,taskStore=null,taskTickMs=5000,limits=null}={}){
  const L=resolveLimits(limits??{});
  // 一个主体一把锁：聊天回合、任务唤醒、记忆整理、后台维护都在锁里调用模型和提交，彼此不再互相覆盖。
  const lock=new SubjectLock();
  // 所有会话的 driver 共享节律/预算与宿主提示（她是同一个人）。
  const shared={};
  ensure(typeof storePath==='string'&&storePath.length>0,'BRAIN_SERVICE','store path required');
  const store=new ContinuityStore(storePath);
  const tasks=taskStore??new TaskStore(taskStorePath??':memory:');
  new ContinuitySession({store,subjectId,attention:true,maxForeground:L.foreground});
  const scheduler=new SceneScheduler({clock});
  const drivers=new Map();
  let globalDriver=null;
  const stateFile=stateDirectory?join(stateDirectory,'scheduler.json'):null;
  if(stateDirectory)mkdirSync(stateDirectory,{recursive:true});
  const policy=new AttentionPolicy({file:stateDirectory?join(stateDirectory,'attention.json'):null});
  const styles=new StyleStore({directory:styleDirectory});
  const driverFor=scene=>{
    if(global){
      if(globalDriver)return globalDriver;
      const workspace=ensureWorkspace(store,'global');
      globalDriver=new TurnDriver({store,subjectId,workspace:{id:workspace.id,revision:workspace.revision},identity,style:styles.text(),eventBypass,decide,rhythm,capabilities,allowedActionTools,tasks:()=>tasks.summary({subject:subjectId}),shared,limits:L});
      globalDriver.loadState();return globalDriver;
    }
    if(drivers.has(scene))return drivers.get(scene);
    const workspace=ensureWorkspace(store,scene);
    const driver=new TurnDriver({store,subjectId,workspace:{id:workspace.id,revision:workspace.revision},identity,style:styles.text(),eventBypass,decide,rhythm,capabilities,allowedActionTools,tasks:()=>tasks.summary({subject:subjectId}),shared,limits:L});
    driver.loadState();
    drivers.set(scene,driver);return driver;
  };
  function observe(input){
    const normalized=normalizeInbound(input);
    if(normalized.sender){const person=ensurePerson(store,normalized.sender);normalized.sender=person;normalized.actor=person.entityId;}
    const queueKey=global?'global':normalized.scene;
    const driver=driverFor(global?'global':normalized.scene);
    const at=normalized.at??clock();
    if(policy.matches(normalized.scene)){
      const event=driver.ingest({key:normalized.key,body:normalized.body,actor:normalized.actor,sender:normalized.sender,scene:normalized.scene,at,sourceSystem:normalized.source,sourceKey:normalized.key,admit:false});
      policy.add({id:event.id,scene:normalized.scene,at});
      saveState();
      return {queued:false,muted:true,scene:normalized.scene,pending:scheduler.pending()};
    }
    const before=store.read('obs:'+normalized.key);
    const event=driver.ingest({key:normalized.key,body:normalized.body,actor:normalized.actor,sender:normalized.sender,scene:normalized.scene,at,sourceSystem:normalized.source,sourceKey:normalized.key});
    receiptChain=0;
    // 只统计“她真正收到的新消息”：非屏蔽、非重复投递。
    // 动作/工具回执/她自己的回复不算消息；muted 分支已经提前返回。
    const obs=store.subjectObservation(subjectId,event.id);
    if(!before&&obs?.status==='received'){
      cursor={...cursor,lastEventId:event.id,lastAt:at,eventsSince:cursor.eventsSince+1,
        memoryPending:[...cursor.memoryPending,event.id]};
      saveCursor();
    }
    // 同一条消息重复送达（幂等入账）时，已处理过的不再排队
    if(obs&&obs.status==='received')enqueueEvent(queueKey,{eventId:event.id,key:normalized.key,body:normalized.body,scene:normalized.scene,actor:normalized.actor,at});
    saveState();
    return {queued:obs?.status==='received',eventId:event.id,scene:normalized.scene,pending:scheduler.pending()};
  }
  function enqueueEvent(queueKey,item){
    const eventId=eventIdOf(item);
    for(const scene of scheduler.snapshot().scenes)if(scene.queue.some(q=>eventIdOf(q)===eventId))return false;
    scheduler.enqueue(queueKey,{...item,eventId});return true;
  }
  let receiptChain=0,lastError=null,blockedUntil=0;
  function mute(prefix){return policy.mute(prefix);}
  function unmute(prefix,{load=true}={}){const next=policy.unmute(prefix);if(load)loadBacklog(prefix,50);return next;}
  function loadBacklog(prefix,limit=50){
    const entries=policy.take(prefix,limit);
    for(const entry of entries){
      const event=store.read(entry.id);if(!event)continue;
      store.execute({requestId:`attention:${entry.id}:admit`,commands:[{op:'admit_subject_event',subjectId,event:{id:event.id,revision:event.revision}}]});
      enqueueEvent(global?'global':entry.scene,{eventId:event.id,key:event.id,body:event.body,scene:entry.scene,actor:event.actor,at:event.occurredAt??event.recordedAt});
    }
    saveState();
    return {loaded:entries.length,pending:scheduler.pending()};
  }
  function executeAction(actionRef){
    const action=store.read(actionRef.id,actionRef.revision);
    ensure(action?.type==='action','ACTION','existing action required');
    if(action.tool==='remember_note'){
      const args=action.args??{};
      const kindAlias={person:'fact_claim',identity:'fact_claim',fact:'fact_claim',memory:'fact_claim',note:'fact_claim'};
      const kind=kindAlias[args.kind]??args.kind??'fact_claim';
      let anchor=args.anchor??null;
      if(anchor?.kind==='entity'){
        const raw=String(anchor.id);
        const entity=[...store.all('entity')].find(e=>e.kind==='person'&&(e.id===raw||e.name===raw||(e.aliases??[]).includes(raw)));
        if(entity)anchor={kind:'entity',id:entity.id};
      }else if(anchor&&['place','scene','group','channel'].includes(String(anchor.kind))){
        anchor={kind:'scene',id:String(anchor.id)};
      }else if(anchor?.kind==='self'){
        anchor={kind:'self',id:'agent'};
      }
      const note=rememberNote({store,id:`note:${randomUUID()}`,body:args.body,kind,scene:args.scene??null,anchor});
      const eventId=`remember-receipt:${action.id}`;
      const recorded=store.execute({requestId:`execute:${action.id}`,commands:[{op:'record_receipt',actionId:action.id,expectedRevision:action.revision,status:'succeeded',eventId,body:'已记下',source:{system:'host',key:eventId},actor:'host',occurredAt:clock()}]}).at(-1);
      const receipt=recorded?.receipt;
      if(receipt){
        const sourceEvent=action.inputRefs?.[0]?store.read(action.inputRefs[0].id):null;
        const scene=sourceEvent?.scene??store.read(action.workspace?.id)?.scene??'global';
        try{store.execute({requestId:`admit-receipt:${action.id}`,commands:[{op:'admit_subject_event',subjectId,event:receipt}]});}catch{}
        try{enqueueEvent(global?'global':scene,{eventId:receipt.id,key:receipt.id,body:'已记下',scene,actor:'host',at:clock()});}catch{}
      }
      return recorded;
    }
    ensure(action.tool==='remember-binding','ACTION','only remember-binding/remember_note are executable locally');
    const commands=bindingCommands({store,action,eventId:`${action.id}:receipt`,body:'已记下绑定'});
    return store.execute({requestId:`execute:${action.id}`,commands});
  }
  function recoverUncertainActions(){
    for(const action of [...store.all('action')]){
      if(action.status!=='proposed')continue;
      try{
        const eventId=`recover:${action.id}:${randomUUID()}`;
        const recorded=store.execute({requestId:`recover:${action.id}`,commands:[{op:'record_receipt',actionId:action.id,expectedRevision:action.revision,
          status:'uncertain',eventId,body:'动作结果未知：进程中断，未自动重试',source:{system:'host',key:eventId},actor:'host',occurredAt:clock()}]}).at(-1);
        const receipt=recorded?.receipt;if(!receipt)continue;
        // 恢复只改 action 终态；不逐条入队叫醒她，避免恢复风暴。
      }catch(error){process.emitWarning(`action recovery failed: ${error.message}`);}
    }
  }  function sourceSceneOfAction(action,fallback){
    for(const ref of action?.inputRefs??[]){try{const event=store.read(ref.id,ref.revision);if(event?.scene)return event.scene;}catch{}}
    try{const workspace=action?.workspace?.id?store.read(action.workspace.id):null;if(workspace?.scene)return workspace.scene;}catch{}
    return fallback;
  }
  async function dispatch(outbox,{scene,execute=false,taskRef=null}={}){
    const sent=[];let speechFailed=false;
    for(const item of outbox??[]){
      try{
        if(item.kind==='respond'){
          if(execute&&adapter?.send){
            let outcome='sent',detail='',parts=null;
            try{
              const value=await adapter.send({scene:item.scene??scene,text:item.text,...(item.utterances?{utterances:item.utterances}:{})});
              parts=value?.parts??null;sent.push(value);
              if(value?.delivered===false){outcome='failed';detail=value.error??value.reason??'adapter did not deliver';}
            }catch(error){outcome='failed';detail=error.message;parts=error.parts??null;sent.push({kind:'respond',delivered:false,error:error.message});}
            if(outcome!=='sent')speechFailed=true;
            if(item.response)markDelivered(item.response,outcome,outcome==='sent'?'发送成功':`发送失败：${detail}`,parts);
          }
          else sent.push({kind:'respond',text:item.text,delivered:false});
        }else if(item.kind==='act'){
          if(speechFailed){sent.push({kind:'act',tool:item.tool,delivered:false,error:'speech not delivered; action skipped'});continue;}
          if(item.action&&['remember-binding','remember_note'].includes(item.tool)){
            try{sent.push(executeAction(item.action));}
            catch(error){
              sent.push({kind:'act',tool:item.tool,delivered:false,error:error.message});
              try{receipt({scene:sourceSceneOfAction(item.action,item.scene??scene),action:item.action,status:'failed',body:error.message,eventId:`tool:${item.action.id}:host`,actor:'host'});}catch{}
            }
          }
          else if(execute&&adapter?.act){
            let status='succeeded',body='';
            try{const value=await adapter.act({scene,tool:item.tool,args:item.args,action:item.action,taskId:taskRef});body=JSON.stringify(value??null).slice(0,20000);sent.push(value);}
            catch(error){status=error.code==='OFFICE_UNAVAILABLE'?'uncertain':'failed';body=error.message;sent.push({kind:'act',tool:item.tool,delivered:false,error:error.message});}
            // 工具回执必须回到收件箱，她才能看到结果并继续（闭环）
            if(item.action)try{receipt({scene:sourceSceneOfAction(item.action,item.scene??scene),action:item.action,status,body,eventId:`tool:${item.action.id}:host`,actor:'host'});}catch(error){process.emitWarning(`receipt skipped: ${error.message}`);}
          }
          else sent.push({kind:'act',tool:item.tool,delivered:false});
        }
      }catch(error){sent.push({kind:item.kind,delivered:false,error:error.message});}
    }
    return sent;
  }
  function markDelivered(responseRef,outcome,body,parts=null){
    try{return responseDelivered({response:responseRef,outcome,body,...(parts?{parts}:{})});}
    catch(error){process.emitWarning(`delivery state not recorded: ${error.message}`);return null;}
  }
  // 取下一条“确实还待处理”的观察。队列项只是指针：收件箱里已 handled/不存在的直接丢弃，
  // 工具回执链过长时直接收掉，不再叫醒她。
  function takeNext(queueKey){
    for(;;){
      if(!scheduler.pending().some(s=>s.key===queueKey))return null;
      const candidate=scheduler.shift(queueKey);
      const eventId=eventIdOf(candidate);
      const observation=store.subjectObservation(subjectId,eventId);
      if(!observation||observation.status!=='received')continue;
      const event=store.read(eventId);
      if(event?.origin==='tool_receipt'){
        if(receiptChain>=MAX_RECEIPT_CHAIN){
          store.execute({requestId:'retire-chain:'+randomUUID(),commands:[{op:'retire_subject_events',subjectId,eventIds:[eventId]}]});
          continue;
        }
        receiptChain++;
      }
      return {...candidate,eventId};
    }
  }
  function gatherBurst(queueKey,scene,max){
    if(max<=0)return [];
    let count=0;
    return scheduler.take(queueKey,candidate=>{
      if(count>=max||(candidate.scene??queueKey)!==scene)return false;
      const eventId=eventIdOf(candidate),obs=store.subjectObservation(subjectId,eventId),event=store.read(eventId);
      if(obs?.status!=='received'||!['observed','reported'].includes(event?.origin))return false;
      count++;return true;
    }).map(c=>({...c,eventId:eventIdOf(c)}));
  }
  async function turn({preferred=null,deliver=false,execute=false}={}){
    const queueKey=scheduler.next({preferred:global?null:preferred});
    if(queueKey===null)return {ok:true,busy:true,pending:scheduler.pending()};
    scheduler.activate(queueKey);
    try{
      const first=takeNext(queueKey);
      if(!first){saveState();return {ok:true,busy:true,empty:true,pending:scheduler.pending()};}
      const scene=first.scene??queueKey;
      // 连发合并：同一个聊天里排着的其他未读一起取出，以最新一条为 current；
      // 前面几条在会话面板的 here 里标 unread，她一次读完再回，而不是一条一条各回一次。
      const burst=[first,...gatherBurst(queueKey,scene,L.burstMax-1)];
      const item=burst.at(-1),absorbed=burst.slice(0,-1);
      const requeue=()=>{for(const x of [...burst].reverse())scheduler.unshift(queueKey,x);};
      const driver=driverFor(global?'global':scene);
      let result;
      try{result=await lock.run(`turn:${scene}`,()=>driver.tick({now:clock(),eventId:item.eventId}));}
      catch(error){
        console.error('[turn-error]', item.eventId, error.message, JSON.stringify(error.details??{}), error.stack??error);
        requeue();driver.persistState();saveState();
        const code=error.code??'TURN_ERROR';
        lastError={code,message:error.message,at:clock(),eventId:item.eventId};
        blockedUntil=clock()+(HARD_ERRORS.has(code)?60_000:8_000);
        return {ok:false,error:code,message:error.message,retryable:!HARD_ERRORS.has(code),pending:scheduler.pending()};
      }
      if(result?.stale){saveState();return {ok:true,busy:true,empty:true,pending:scheduler.pending()};}
      if(!result?.decision&&(result?.wake===false||result?.action==='budget-blocked')){
        requeue();
        driver.persistState();saveState();
        return {ok:true,busy:true,deferred:true,result,pending:scheduler.pending()};
      }
      if(absorbed.length&&result.decision&&store.subjectObservation(subjectId,item.eventId)?.status==='handled')
        store.execute({requestId:'burst:'+randomUUID(),commands:[{op:'retire_subject_events',subjectId,eventIds:absorbed.map(x=>x.eventId),decision:result.decision}]});
      else if(absorbed.length)for(const x of [...absorbed].reverse())scheduler.unshift(queueKey,x);
      try{store.execute({requestId:'release:'+randomUUID(),commands:[{op:'release_completed_workbench',subjectId}]});}catch{}
      const outbox=driver.takeOutbox();
      let targetScene=scene;
      if(result.decision){
        try{const dec=store.read(result.decision.id);const ev=dec?.currentEvent?store.read(dec.currentEvent.id):null;if(ev?.scene)targetScene=ev.scene;}catch{}
      }
      for(const o of outbox)o.scene=targetScene;
      driver.persistState();saveState();
      const delivery=deliver?await dispatch(outbox,{scene:targetScene,execute}):null;
      return {ok:true,scene:targetScene,item:item.key??null,eventId:item.eventId,absorbed:absorbed.map(x=>x.eventId),result,outbox,delivery,silent:!outbox.some(o=>o.kind==='respond'),pending:scheduler.pending()};
    }finally{scheduler.complete(queueKey);}
  }
  async function reply(input){
    const execute=input.execute!==false;
    const scene=String(input.scene??input.key??'');
    ensure(scene,'ADAPTER','scene required');
    const source=String(input.source??(scene.split('/')[0]||'qq'));
    const body=firstText(input.messages??[{role:'user',content:input.text??''}]);
    ensure(body,'ADAPTER','reply needs message text');
    const chatKey=source==='local'?scene.slice('local/'.length):keyFor(scene,input.key);
    const sourceKey=`${chatKey}:${input.message_id??`${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
    const queued=observe({source,key:chatKey,sourceKey,text:body,scene,sender:input.sender??null,occurredAt:input.occurredAt??input.message_time??null});
    if(queued.muted)return {ok:true,scene,text:'',outbox:[],silent:true,busy:false,muted:true};
    const eventId=queued.eventId;
    const outbox=[];let failure=null,waited=false;
    // 全局队列里可能先排着别的观察：一直处理到“这一条”被处理为止（上限防止卡死）。
    for(let attempt=0;attempt<12;attempt++){
      const state=store.subjectObservation(subjectId,eventId);
      if(!state||state.status!=='received')break;
      if(clock()<blockedUntil&&attempt>0)break;
      const result=await turn({preferred:global?null:scene,deliver:true,execute});
      if(result.ok&&!result.busy)lastError=null;
      if(result?.error){failure=result;if(!result.retryable)break;await sleep(700);continue;}
      failure=null;
      if(result.busy||result.deferred){waited=true;await sleep(500);continue;}
      outbox.push(...(result.outbox??[]));
    }
    // 本地聊天没有外部连接器：显示出来就是送达，由服务端自己回写状态
    for(const item of outbox)if(item.kind==='respond'&&item.response&&String(item.scene??'').startsWith('local/'))markDelivered(item.response,'sent','本地聊天已显示');
    const finalState=store.subjectObservation(subjectId,eventId);
    const stillPending=finalState?.status==='received';
    if(stillPending&&failure)return {ok:false,error:failure.error,message:failure.message,retryable:failure.retryable!==false,scene,outbox,silent:outbox.length===0,busy:false};
    // 仍在队列里（忙/预算）：不丢，由心跳稍后处理并直接发送；这里如实告知“还没回”。
    const text=outbox.find(o=>o.kind==='respond'&&(o.scene??scene)===scene)?.text??'';
    return {ok:true,scene,text,outbox,silent:!outbox.some(o=>o.kind==='respond'),busy:stillPending&&waited,queued:stillPending,eventId};
  }
  function receipt({scene,action,status,body,eventId,actor='host',occurredAt=clock()}){
    ensure(scene&&action,'ADAPTER','receipt needs scene/action');
    const driver=driverFor(global?'global':scene);
    const out=driver.applyReceipt({action,status,body,eventId,actor,occurredAt});
    if(!out.replayed&&out.receipt?.id){
      // 回执必须进入 subject inbox，否则 takeNext 会把它当作未接收事件跳过，
      // 造成动作失败但下一轮完全看不到回执。
      try{store.execute({requestId:`admit-receipt:${out.receipt.id}`,commands:[{op:'admit_subject_event',subjectId,event:out.receipt}]});}catch(error){process.emitWarning(`receipt admission skipped: ${error.message}`);}
      enqueueEvent(global?'global':scene,{eventId:out.receipt.id,key:out.receipt.id,body:String(body??''),scene,actor,at:occurredAt});
    }
    saveState();
    return out;
  }
  function responseDelivered(input){
    const response=store.read(input.response?.id);ensure(response?.type==='response','RESPONSE_REQUIRED','response required');
    // 幂等：已有终态的不重复入账（连接器重试/重复回调不应报错）
    if(['sent','failed'].includes(response.status))return response;
    const claimId='claim:'+input.response.id+':'+randomUUID();
    const claimed=claimResponse({store,response:{id:response.id,revision:response.revision},claimId,worker:'qq-connector',requestId:'claim:'+claimId});
    const receiptId='delivery:'+input.response.id+':'+randomUUID();
    return recordResponseDelivery({store,response:{id:claimed.id,revision:claimed.revision},claimId,outcome:input.outcome??'sent',eventId:receiptId,body:input.body??'QQ发送成功',...(input.parts?{parts:input.parts}:{}),source:{system:'qq-host',key:receiptId},actor:'qq-connector',requestId:'delivery:'+receiptId});
  }
  // 本地聊天窗口读取：按场景前缀取最近的真实消息与她的回复（来自 store，不是缓存）
  function chatView(params){
    const prefix=params.get('scene')||'local/';
    const limit=Math.max(1,Math.min(200,Number(params.get('limit')||60)));
    const items=[];
    for(const event of store.all('event')){
      if(!['observed','reported'].includes(event.origin)||!String(event.scene??'').startsWith(prefix))continue;
      items.push({at:event.occurredAt??event.recordedAt,role:'user',text:event.body,id:event.id});
    }
    for(const response of store.all('response')){
      if(response.subject!==subjectId||!response.body)continue;
      let scene=response.scene;
      try{const d=store.read(response.decision?.id);const e=d?.currentEvent?store.read(d.currentEvent.id):null;if(e?.scene)scene=e.scene;}catch{}
      if(!String(scene??'').startsWith(prefix))continue;
      let at=response.recordedAt;try{at=store.read(response.id,1)?.recordedAt??at;}catch{}
      items.push({at,role:'her',text:response.body,id:response.id,status:response.status});
    }
    items.sort((a,b)=>(a.at??0)-(b.at??0));
    return {ok:true,items:items.slice(-limit)};
  }
  const lastTaskWake=new Map(),taskRetryAt=new Map();
  let taskTimer=null;
  async function sweepTasks(){
    try{
      if(health().active!==null||lock.busy()||scheduler.pending().length>0)return;
      const due=tasks.open({subject:subjectId,limit:8}).filter(t=>Number.isFinite(t.nextWakeAt)&&t.nextWakeAt<=clock());
      for(const task of due){
        if(lastTaskWake.get(task.id)>=task.nextWakeAt)continue;
        if((taskRetryAt.get(task.id)??0)>clock())continue;
        if(tasks.wokenBefore({id:task.id,wakeAt:task.nextWakeAt}))continue;
        const driver=global?globalDriver:driverFor(task.scene??'global');
        if(!driver)continue;
        lastTaskWake.set(task.id,task.nextWakeAt);
        let result;
        // 以前先标记“已唤醒”再调用模型：这一轮一失败（比如和聊天并发撞车），这次唤醒就永久丢了。
        // 现在成功后才标记；失败的一分钟后再试。
        try{result=await lock.run(`task:${task.id}`,()=>driver.taskWake({now:clock(),task}));}
        catch(error){lastTaskWake.delete(task.id);taskRetryAt.set(task.id,clock()+60_000);throw error;}
        taskRetryAt.delete(task.id);
        try{tasks.markWoken({id:task.id,wakeAt:task.nextWakeAt});}catch{}
        if(result?.outbox?.length){
          for(const item of result.outbox)if(item.action?.id)try{tasks.linkAction({taskId:task.id,actionId:item.action.id});}catch{}
          await dispatch(result.outbox,{scene:task.scene??'global',execute:true,taskRef:task.id});
        }
        driver.persistState();saveState();
        break;
      }
    }catch(error){process.emitWarning(`task wake failed: ${error.message}`);}
  }  function tasksApi(input={}){
    const op=input.op??'list';
    if(op==='create')return tasks.create({subject:subjectId,goal:input.goal,plan:input.plan??[],origin:input.origin??'self',budget:input.budget??null,scene:input.scene??null});
    if(op==='get')return tasks.get(input.id);
    if(op==='update')return tasks.update({id:input.id,expectedRevision:input.expectedRevision,patch:input.patch??{}});
    if(op==='step')return tasks.step({id:input.id,expectedRevision:input.expectedRevision,stepId:input.stepId,status:input.status,checkpoint:input.checkpoint,nextStep:input.nextStep,nextWakeAt:input.nextWakeAt});
    if(op==='history')return tasks.history({id:input.id,subject:subjectId,limit:input.limit});
    if(op==='open')return tasks.open({subject:subjectId,limit:input.limit??8});
    if(op==='list')return tasks.list({subject:subjectId,status:input.status??null,limit:input.limit??20});
    ensure(false,'TASK_OP','unknown task operation');
  }  function auditView({limit=50}={}){
    const n=Math.max(1,Math.min(200,Number(limit)||50));
    const actions=[...store.all('action')].sort((a,b)=>a.recordedAt-b.recordedAt).slice(-n).map(a=>({
      at:a.recordedAt,tool:a.tool,status:a.status,args:String(JSON.stringify(a.args??{})).slice(0,800),
      receipt:a.receipt?.id??null
    }));
    const taskRows=tasks.list({subject:subjectId,limit:n}).map(t=>({at:t.updatedAt,id:t.id,goal:t.goal,status:t.status,currentStep:t.currentStep,nextStep:t.nextStep,checkpoint:t.checkpoint,scene:t.scene??null,history:tasks.history({id:t.id,limit:5}),linkedActions:tasks.actions({id:t.id,limit:10})}));
    const permissions={officeWorker:process.env.OFFICE_WORKER_URL??null,officeCommands:['node','python','git','rg'],actionTools:[...TOOL_NAMES]};
    return {format:'agent-audit-v1',permissions,actions,tasks:taskRows};
  }  function settingsView(){
    const key=keyFile?existsSync(keyFile):false;
    return {ok:true,keyFile:Boolean(keyFile),keyConfigured:key||Boolean(process.env.DEEPSEEK_API_KEY),runtime:extraStatus?extraStatus():null};
  }
  function saveKey(value){
    const key=String(value??'').trim();
    ensure(keyFile,'SETTINGS','this service has no key file configured');
    ensure(/^sk-[A-Za-z0-9_-]{12,}$/.test(key),'SETTINGS','密钥格式不对：应以 sk- 开头，且不含空格');
    mkdirSync(dirname(keyFile),{recursive:true});
    writeFileSync(keyFile,key+'\n',{encoding:'utf8',mode:0o600});
    lastError=null;blockedUntil=0;
    return {ok:true,keyConfigured:true};
  }
  function stats(){const counts={};for(const type of ['event','note','entity','binding','personal_state','workspace','action','decision','link'])counts[type]=[...store.all(type)].length;return {ok:true,subjectId,counts,style:styles.status(),attention:policy.status(),context:cursor};}
  function health(){return {ok:true,...(extraStatus?{runtime:extraStatus()}:{}),mode:decide===dryDecide?'dry-run':'custom',subjectId,global,lastError,active:scheduler.active(),mind:lock.holder(),pending:scheduler.pending(),scenes:global?1:drivers.size,attention:policy.status()};}
  function saveState(){if(!stateFile)return;try{writeFileSync(stateFile,JSON.stringify({scheduler:scheduler.snapshot()}),'utf8');}catch{}}
  function restoreState(){
    if(!stateFile||!existsSync(stateFile))return;
    try{
      const saved=JSON.parse(readFileSync(stateFile,'utf8')),snap=saved.scheduler;
      if(!snap||!Array.isArray(snap.scenes))return;
      for(const s of snap.scenes)for(const item of s.queue??[]){
        driverFor(global?'global':s.key);
        enqueueEvent(global?'global':s.key,item);
      }
    }catch(error){process.emitWarning(`scheduler restore skipped: ${error.message}`);}
  }
  // 收件箱里“新收到”却不在队列里的观察（崩溃/重启/回执）补回队列；deferred 的不补，免得旧消息反复。
  function rehydrateInbox(){
    let added=0;
    try{
      for(const row of store.subjectInbox({subjectId,pendingOnly:true,limit:100}).items){
        if(row.status!=='received')continue;
        const event=store.read(row.eventId);if(!event)continue;
        const at=event.occurredAt??event.recordedAt;
        if(enqueueEvent(global?'global':event.scene,{eventId:event.id,key:event.id,body:event.body,scene:event.scene,actor:event.actor,at}))added++;
      }
    }catch(error){process.emitWarning(`inbox rehydrate skipped: ${error.message}`);}
    return added;
  }
  const cursorFile=stateDirectory?join(stateDirectory,'context-cursor.json'):null;
  let cursor={lastEventId:null,lastAt:null,eventsSince:0,lastMemoryAt:null,lastMemoryPromptAt:clock(),memoryPending:[]};
  if(cursorFile&&existsSync(cursorFile)){
    try{const saved=JSON.parse(readFileSync(cursorFile,'utf8'));if(saved&&Number.isSafeInteger(saved.eventsSince)&&saved.eventsSince>=0)cursor={...cursor,...saved};}catch{}
  }
  if(!Array.isArray(cursor.memoryPending))cursor={...cursor,memoryPending:[]};
  if(!Number.isSafeInteger(cursor.lastMemoryPromptAt))cursor={...cursor,lastMemoryPromptAt:clock()};
  if(!Number.isSafeInteger(cursor.lastMemoryAt))cursor={...cursor,lastMemoryAt:clock()};
  function saveCursor(){if(!cursorFile)return;try{writeFileSync(cursorFile,JSON.stringify(cursor),'utf8');}catch{}}
  restoreState();
  rehydrateInbox();
  const memoryDue=()=>cursor.memoryPending.length>0&&(cursor.memoryPending.length>=L.memoryDueMessages||clock()-cursor.lastMemoryPromptAt>=L.memoryDueMinutes*60*1000);
  function memoryWindow(){
    return buildMemoryWindow({store,subjectId,lastMemoryAt:cursor.lastMemoryAt??0,messageIds:cursor.memoryPending,limit:L.memoryWindowItems});
  }  async function idleReflect(){
    if(!global||!memoryDue()||scheduler.active()!==null||lock.busy()||scheduler.pending().length)return {skipped:true};
    const window=memoryWindow();
    const driver=driverFor('global');const notesBefore=[...store.all('note')].length;
    const result=await lock.run('memory-update',()=>driver.tick({now:clock(),memoryUpdate:true,memoryWindow:window}));
    const outbox=driver.takeOutbox();
    // 记忆提示是内部整理，不应向任何聊天窗口发消息；只执行本地动作（例如 remember_note）。
    const acts=outbox.filter(item=>item.kind==='act');
    if(acts.length)await dispatch(acts,{scene:'global',execute:true});
    const wrote=[...store.all('note')].length>notesBefore;
    cursor={...cursor,eventsSince:0,lastMemoryPromptAt:clock()};
    if(wrote){
      const covered=new Set(window.items.filter(item=>item.kind==='message').map(item=>item.ref.id));
      const coveredAt=window.items.reduce((max,item)=>Math.max(max,item.at??0),cursor.lastMemoryAt??0);
      cursor={...cursor,lastMemoryAt:coveredAt||clock(),memoryPending:cursor.memoryPending.filter(id=>!covered.has(id))};
    }
    driver.persistState();saveCursor();
    return result;
  }
  let beating=false;
  async function beat(){
    if(beating||scheduler.active()!==null||lock.busy()||clock()<blockedUntil)return;
    beating=true;
    try{
      // 先清待处理观察，再谈整理：否则“该整理了”会永远饿死用户消息
      if(!scheduler.pending().length)rehydrateInbox();
      if(scheduler.pending().length)await idleTurn();
      else if(global&&memoryDue())await idleReflect();
      else await idleTurn();
    }catch(error){process.emitWarning(`heartbeat: ${error.message}`);}
    finally{beating=false;}
  }
  const timer=heartbeatMs>0?setInterval(()=>{beat();},heartbeatMs):null;if(timer?.unref)timer.unref();
  function close(){if(timer)clearInterval(timer);if(taskTimer)clearInterval(taskTimer);saveState();try{tasks.close();}catch{}store.close();}
  const server=createServer(async (req,res)=>{
    // 只接受本机直连：浏览器网页（带 Origin）或 DNS 重绑定（Host 不是本机）都拒绝，防止别的网页远程操控她
    const host=String(req.headers.host??'').replace(/:\d+$/,'');
    if(req.headers.origin||!['127.0.0.1','localhost','[::1]'].includes(host)){res.writeHead(403,{'content-type':'application/json'});return res.end(JSON.stringify({error:'FORBIDDEN_ORIGIN'}));}
    const token=req.headers['x-brain-token'];
    if(service.token&&token!==service.token){res.writeHead(401,{'content-type':'application/json'});return res.end(JSON.stringify({error:'UNAUTHORIZED'}));}
    try{
      if(req.method==='GET'&&req.url==='/health')return json(res,200,health());
      if(req.method==='POST'&&req.url==='/v1/observe')return json(res,200,observe(await readBody(req)));
      if(req.method==='POST'&&req.url==='/v1/turn'){const body=await readBody(req);return json(res,200,await turn({preferred:body.preferred??null,deliver:body.deliver===true,execute:body.execute===true}));}
      if(req.method==='POST'&&req.url==='/v1/reply'){const body=await readBody(req);ensure(body.protocol?body.protocol==='agent-brain-bridge-v1':true,'ADAPTER','unsupported protocol');return json(res,200,await reply(body));}
      if(req.method==='POST'&&req.url==='/v1/receipt'){return json(res,200,receipt(await readBody(req)));}
      if(req.method==='GET'&&req.url.startsWith('/v1/audit')){const u=new URL(req.url,'http://127.0.0.1');return json(res,200,auditView({limit:u.searchParams.get('limit')}));}
      if(req.method==='GET'&&req.url.startsWith('/v1/tasks')){const u=new URL(req.url,'http://127.0.0.1');return json(res,200,tasksApi({op:u.searchParams.get('op')??'list',status:u.searchParams.get('status'),limit:u.searchParams.get('limit'),id:u.searchParams.get('id')}));}
  if(req.method==='POST'&&req.url==='/v1/tasks'){return json(res,200,tasksApi(await readBody(req)));}
  if(req.method==='POST'&&req.url==='/v1/vision'){ensure(typeof vision==='function','VISION_UNAVAILABLE','vision is not configured');const b=await readBody(req,MAX_VISION_BODY);return json(res,200,{text:await vision({images:b.images,question:b.question})});}
      if(req.method==='POST'&&req.url==='/v1/attention/mute'){const b=await readBody(req);return json(res,200,mute(b.prefix));}
      if(req.method==='POST'&&req.url==='/v1/attention/unmute'){const b=await readBody(req);return json(res,200,unmute(b.prefix,{load:b.load!==false}));}
      if(req.method==='POST'&&req.url==='/v1/attention/load'){const b=await readBody(req);return json(res,200,loadBacklog(b.prefix,b.limit??50));}
      if(req.method==='GET'&&req.url==='/v1/stats')return json(res,200,stats());
      if(req.method==='POST'&&req.url==='/v1/response/delivered'){const b=await readBody(req);return json(res,200,responseDelivered(b));}
      if(req.method==='GET'&&req.url==='/v1/context')return json(res,200,{format:'context-cursor-v1',cursor});
      if(req.method==='GET'&&req.url==='/v1/style')return json(res,200,styles.status());
      if(req.method==='GET'&&req.url==='/v1/style/text')return json(res,200,{...styles.status(),text:styles.text()});
      if(req.method==='POST'&&req.url==='/v1/style'){const b=await readBody(req);const out=styles.update({text:b.text,label:b.label,source:b.source});for(const d of [globalDriver,...drivers.values()])d?.setStyle(styles.text());return json(res,200,out);}
      if(req.method==='POST'&&req.url==='/v1/style/delete'){const b=await readBody(req);const out=styles.remove(b.id);for(const d of [globalDriver,...drivers.values()])d?.setStyle(styles.text());return json(res,200,out);}
      if(req.method==='POST'&&req.url==='/v1/anchor/query'){const b=await readBody(req);return json(res,200,queryAnchor({store,subjectId,anchor:b.anchor,role:b.role??null,limit:b.limit??12}));}
      if(req.method==='GET'&&req.url==='/v1/attention')return json(res,200,policy.status());
      if(req.method==='GET'&&req.url.startsWith('/v1/chat'))return json(res,200,chatView(new URL(req.url,'http://x').searchParams));
      if(req.method==='GET'&&req.url==='/v1/settings')return json(res,200,settingsView());
      if(req.method==='POST'&&req.url==='/v1/settings/key'){const b=await readBody(req);return json(res,200,saveKey(b.key));}
      return json(res,404,{error:'NOT_FOUND'});
    }catch(error){return json(res,400,{error:error.code??'ERROR',message:error.message});}
  });
  async function idleTurn(){
    if(scheduler.active()!==null)return {ok:true,idle:true,skipped:'busy'};
    if(!scheduler.pending().length)rehydrateInbox();
    if(scheduler.pending().length){
      // 有待处理观察（用户消息漏网、重启遗留、工具回执）：照常走一轮并直接发送/执行。
      const result=await turn({deliver:true,execute:true});
      return {idle:true,...result};
    }
    if(!global)return {ok:true,idle:true,skipped:'nothing-pending'};
    const driver=driverFor('global'),result=await lock.run('idle',()=>driver.tick({now:clock()}));
    if(!result?.wake)return {ok:true,idle:true,result};
    const outbox=driver.takeOutbox();
    const delivery=outbox.length?await dispatch(outbox,{scene:'global',execute:true}):null;
    driver.persistState();saveState();
    return {ok:true,idle:true,result,outbox,delivery};
  }
  recoverUncertainActions();
  if(taskTickMs>0){taskTimer=setInterval(()=>{void sweepTasks();},taskTickMs);taskTimer.unref?.();}
  const service={server,observe,turn,reply,receipt,responseDelivered,health,stats,close,idleTurn,dispatch,executeAction,mute,unmute,loadBacklog,attention:()=>policy.status(),context:()=>cursor,style:()=>styles.status(),styleUpdate:(v)=>styles.update(v),styleDelete:(id)=>styles.remove(id),tick:()=>turn(),idleReflect,store,tasks,tasksApi,withSubjectLock:(label,fn)=>lock.run(label,fn),limits:L,notices:()=>shared.notices??[],token:null,vision};
  return service;
}

function json(res,status,value){res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));}
function readBody(req,limit=MAX_BODY){return new Promise((resolve,reject)=>{let bytes=0;const parts=[];req.on('data',chunk=>{bytes+=chunk.length;if(bytes>limit)reject(Object.assign(new Error('body too large'),{code:'BODY_LIMIT'}));else parts.push(chunk);});
  req.on('end',()=>{try{const text=Buffer.concat(parts).toString('utf8');resolve(text?JSON.parse(text):{});}catch{reject(Object.assign(new Error('invalid json'),{code:'INVALID_JSON'}));}});req.on('error',reject);});}

export async function startBrainService(options={}){
  const service=createBrainService(options);service.token=options.token??null;
  await new Promise(resolve=>service.server.listen(options.port??0,'127.0.0.1',resolve));
  service.port=service.server.address().port;service.url=`http://127.0.0.1:${service.port}`;
  return service;
}
