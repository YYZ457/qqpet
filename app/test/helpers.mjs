// 测试用假模型：按脚本返回决策单，并记录每次收到的输入包。不联网。
import {keepAttention} from '../src/attention.mjs';
import {createBrainService} from '../tools/brain-service/server.mjs';

export const cont=(extra={})=>({changes:[],residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',attention:keepAttention(),...extra});
export const respond=(text,extra={})=>({options:[{id:'r',kind:'respond',payload:{text}}],selected:'r',summary:'reply',used:[],continuity:cont(extra)});
export const wait=()=>({options:[{id:'w',kind:'wait',payload:{}}],selected:'w',summary:'wait',used:[],continuity:cont()});
// 一张新状态卡（以当前消息为依据）
export const card=(packet,id,body,kind='feeling')=>({id,expectedRevision:0,nature:'encounter',reason:'test',kind,body,status:'open',scope:[],
  basis:{observations:[{id:packet.payload.current.id,revision:packet.payload.current.revision}],priorStates:[],memories:[]}});

// decideFn(packet, index) -> 决策对象 或 Promise
export function fakeModel(decideFn){
  const packets=[];
  const decide=async packet=>{const i=packets.length;packets.push(packet);const out=await decideFn(packet,i);return JSON.stringify({packetId:packet.packetId,...out});};
  return {decide,packets};
}
let seq=0;
export function service(opts={}){return createBrainService({storePath:':memory:',identity:'测试身份',heartbeatMs:0,taskTickMs:0,...opts});}
export function qq(svc,chat,text){return svc.observe({source:'qq',key:chat,sourceKey:`qq:${chat}:${++seq}`,text});}
export function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
// 记录所有被拒的提交（包括被 turn-driver 降级吞掉的）
import {ContinuitySession} from '../src/continuity-session.mjs';
export const rejected=[];
const origCommit=ContinuitySession.prototype.commit;
ContinuitySession.prototype.commit=function(a){try{return origCommit.call(this,a);}catch(e){rejected.push({code:e.code,stage:a.packet?.stage,hadContinuity:!!a.output?.continuity});throw e;}};

// 直接驱动 TurnDriver（绕过服务和锁），用来模拟“没走锁的并发提交”
import {ContinuityStore} from '../src/store.mjs';
import {TurnDriver} from '../src/turn-driver.mjs';
export function bareRig({decide,shared={}}){
  const store=new ContinuityStore(':memory:');
  const ws=scene=>store.execute({requestId:`ws:${scene}`,commands:[{op:'set_workspace',id:`ws:${scene}`,expectedRevision:0,scene,focus:{id:'current',label:'当前'},workingRefs:[],continuityRefs:[],actionRefs:[]}]}).at(-1);
  const driver=scene=>{const w=ws(scene);return new TurnDriver({store,subjectId:'agent',workspace:{id:w.id,revision:w.revision},decide,eventBypass:true,allowedActionTools:[],shared});};
  return {store,driver,shared};
}

// —— 仓库里 tools/qq-brain/*.mjs 依赖、但脱敏时没带上的原始测试工具，这里按用法补齐 ——
export const ref=r=>({id:r.id,revision:r.revision});
export function put(store,requestId,command){return store.execute({requestId,commands:[command]});}
export function frame({id='qq',scene='qq/private/1'}={}){
  return {op:'set_workspace',id,expectedRevision:0,scene,focus:{id:'current',label:'当前'},workingRefs:[],continuityRefs:[],actionRefs:[]};
}
export function event(id,{body,origin='reported',scene='qq/private/1',actor='qq-user',occurredAt=Date.now(),source=null}={}){
  return {op:'append_event',id,body,origin,actor,scene,occurredAt,source:source??{system:'test',key:id}};
}
export function note(id,evidence=[],{body,kind='fact_claim',change='self_report',...rest}={}){
  return {op:'write_note',id,expectedRevision:0,kind,change,evidence,body,...rest};
}
