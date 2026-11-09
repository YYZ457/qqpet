// 通用来源→人物路由：把外部系统的 sender 解析成稳定 person 实体/anchor。
// 只记录身份事实（来自哪个系统、外部 id、显示名），不自动写关系或态度。
import {ensure,text} from './contracts.mjs';

const SYSTEMS=/^[a-z0-9_-]+$/i;
const ref=x=>({id:x.id,revision:x.revision});
const clip=(x,n=200)=>String(x??'').trim().slice(0,n);

export function normalizeSender({system,id,name,nickname=null,isOwner=false,entityId=null}={}){
  ensure(typeof system==='string'&&SYSTEMS.test(system),'SENDER_SYSTEM','sender system required');
  text(String(id),'sender id');
  const external=clip(id,200),display=clip(name||nickname||external,200);
  const entity=entityId?clip(entityId,200):`person:${system}:${external}`;
  return {system,id:external,name:display,nickname:nickname?clip(nickname,200):null,isOwner:isOwner===true,entityId:entity};
}
export function findPerson(store,{system,id,entityId=null}){
  const ext=String(id),wanted=entityId?String(entityId):`person:${system}:${ext}`;
  return [...store.all('entity')].find(e=>e.kind==='person'&&(e.id===wanted||e.id===ext||(e.aliases??[]).includes(ext)||e.name===ext))??null;
}
export function ensurePerson(store,{system,id,name,nickname=null,isOwner=false,entityId=null}={}){
  const sender=normalizeSender({system,id,name,nickname,isOwner,entityId});
  const existing=findPerson(store,{system,id,entityId:sender.entityId});
  if(existing)return {...sender,entityId:existing.id};
  const resolvedEntityId=sender.entityId;
  store.execute({requestId:`person:${system}:${sender.id}`,commands:[{op:'write_entity',id:resolvedEntityId,expectedRevision:0,kind:'person',
    name:sender.name,aliases:[...new Set([sender.id,...(sender.nickname?[sender.nickname]:[])])],description:`来源 ${system} 的外部联系人 ${sender.id}`,status:'current'}]});
  return {...sender,entityId:resolvedEntityId};
}
export function actorOf(sender){return sender?.entityId??sender?.id??null;}
