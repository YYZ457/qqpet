// 本机脑服务启动器：默认 dry-run；BRAIN_LIVE=1 时接真实模型，日预算封顶。
import {startBrainService} from './server.mjs';
import {createModelDecision} from '../../src/model-transport.mjs';
import {MaintenanceSession,startMaintenanceHeartbeat} from '../../src/maintenance.mjs';
import {executeTool} from '../qq-connect/tools.mjs';
import {studyKey} from '../../src/model-key.mjs';
import {existsSync,mkdirSync,readFileSync,renameSync,unlinkSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {resolveLimits} from '../../src/limits.mjs';

const limits=resolveLimits();

const port=Number(process.env.BRAIN_PORT??8787);
const token=process.env.BRAIN_TOKEN??null;
const stateDirectory=resolve(process.env.BRAIN_STATE??'_local/brain/state');
const styleDirectory=resolve(process.env.BRAIN_STYLE_DIR??'_local/style');
const storePath=resolve(process.env.BRAIN_STORE??'_local/brain/subject.sqlite');
const heartbeatMs=Number(process.env.BRAIN_HEARTBEAT_MS??60000);
const identityFile=resolve(process.env.BRAIN_IDENTITY_FILE??'_local/migrate/persona.txt');
const ledgerPath=resolve(process.env.BRAIN_LEDGER??'_local/brain/budget.json');
const pidFile=resolve(stateDirectory,'brain-service.pid');
const live=process.env.BRAIN_LIVE==='1';
let identity='你是智能体。';try{identity=readFileSync(identityFile,'utf8').trim().slice(0,8000)||identity;}catch{}
mkdirSync(stateDirectory,{recursive:true});

const alive=pid=>{try{process.kill(Number(pid),0);return true;}catch{return false;}};
if(live){
  if(existsSync(pidFile)){
    const old=Number(readFileSync(pidFile,'utf8').trim());
    if(Number.isSafeInteger(old)&&old>0&&alive(old))throw new Error(`brain service already running: pid ${old}`);
  }
  const lock=`${ledgerPath}.lock`;
  if(existsSync(lock)){
    // 没有活着的 pid 文件时，才把旧锁归档；有活进程则拒绝启动。
    if(existsSync(pidFile)&&alive(Number(readFileSync(pidFile,'utf8').trim())))throw new Error('budget lock held by a live service');
    renameSync(lock,`${lock}.stale-${Date.now()}`);
  }
  writeFileSync(pidFile,String(process.pid),'utf8');
}

let model=null,decide=undefined;
try{
  if(live){
    model=createModelDecision({ledgerPath,getKey:studyKey,profile:{dailyMicros:10_000_000,dailyCalls:limits.dailyCalls,maxTokens:3000,reasoning:'low'}});
    decide=model.decide;
  }
  const service=await startBrainService({port,token,storePath,taskStorePath:resolve(process.env.BRAIN_TASKS??'../data/tasks.sqlite'),stateDirectory,styleDirectory,heartbeatMs,decide,identity,rhythm:{dailyCallCap:limits.dailyCalls},limits,extraStatus:()=>({mode:model?'live':'dry-run',budget:model?.state?.()??null}),vision:model?.vision??null,adapter:{act:({tool,args,action,taskId})=>executeTool(tool,args,{actionId:action?.id,taskId}),send:async({scene,text,utterances})=>{
    if(scene?.startsWith('local/'))return {delivered:true,local:true};
    const parts=Array.isArray(utterances)&&utterances.length?utterances:[{text,delayMs:0}];
    const target=scene?.startsWith('qq/private/')?{kind:'private',id:scene.slice('qq/private/'.length)}:scene?.startsWith('qq/group/')?{kind:'group',id:scene.slice('qq/group/'.length)}:null;
    if(!target)return {delivered:false,scene};
    const results=[];let last=null;
    for(let i=0;i<parts.length;i++){
      try{last=await executeTool('qq_send_message',{target:target.kind,id:target.id,text:parts[i].text});results.push({index:i,text:parts[i].text,status:'sent'});}
      catch(error){results.push({index:i,text:parts[i].text,status:'failed',error:error.message});const failed=new Error(error.message);failed.parts=results;throw failed;}
      if(i<parts.length-1)await new Promise(r=>setTimeout(r,parts[i+1]?.delayMs??450));
    }
    return {last,parts:results};
  }},global:process.env.BRAIN_GLOBAL==='1'});
  let maintenanceHeartbeat=null;
  if(model){
    const maintenance=new MaintenanceSession({store:service.store,subjectId:'agent',identity});
    // 后台维护也会改她的状态：和聊天回合走同一把锁，否则两边并发时总有一边的修改作废。
    const rawTick=maintenance.tick.bind(maintenance);
    maintenance.tick=options=>service.withSubjectLock('maintenance',()=>rawTick(options));
    maintenanceHeartbeat=startMaintenanceHeartbeat({session:maintenance,isBusy:()=>{const h=service.health();return h.active!==null||h.mind!==null||(h.pending?.length??0)>0;},invoke:model.invokeMaintenance,
      authorize:async()=>true,onResult:r=>console.error('[maintenance]',r.status??'unknown'),onError:e=>console.error('[maintenance]',e.message)});
  }
  console.log(JSON.stringify({url:service.url,port:service.port,mode:model?'live':'dry-run',storePath,stateDirectory,heartbeatMs,identityFile,identityChars:identity.length,maintenance:!!maintenanceHeartbeat}));
  const stop=async()=>{try{maintenanceHeartbeat?.stop();}catch{}try{await new Promise(r=>service.server.close(r));}catch{}try{service.close();}catch{}if(model)try{model.close();}catch{}try{unlinkSync(pidFile);}catch{}process.exit(0);};
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
}catch(error){
  try{unlinkSync(pidFile);}catch{}
  throw error;
}
