// 记忆线的对象维度：anchor 只标记“这条认识主要关于谁/什么”，不是副本。
import {ensure,refKey,text} from './contracts.mjs';

export const ANCHOR_KINDS=['self','entity','scene','process'];
const exact=(x,keys,name)=>ensure(x&&Object.getPrototypeOf(x)===Object.prototype&&Object.keys(x).every(k=>keys.includes(k)),'ANCHOR_SHAPE',`${name} has unsupported fields`);
export function normalizeAnchor(value){
  if(value===null||value===undefined)return null;
  exact(value,['kind','id'],'anchor');
  ensure(ANCHOR_KINDS.includes(value.kind),'ANCHOR_KIND','unsupported anchor kind');
  text(value.id,'anchor id');
  ensure([...value.id].length<=200,'ANCHOR_LIMIT','anchor id too long');
  return {kind:value.kind,id:value.id};
}
export function anchorKey(value){const a=normalizeAnchor(value);return a?`${a.kind}:${a.id}`:null;}
export function sameAnchor(a,b){return anchorKey(a)===anchorKey(b);}

// 读取：只按 anchor 取已持久化的 BCRZ/笔记；不写、不推断新意义。
export function anchorView({store,subjectId,currentEvent=null,limit=8}={}){
  const anchors=[{kind:'self',id:subjectId}];
  if(currentEvent?.scene)anchors.push({kind:'scene',id:currentEvent.scene});
  if(currentEvent?.sender?.entityId)anchors.push({kind:'entity',id:currentEvent.sender.entityId});
  else if(currentEvent?.actor){
    const actor=String(currentEvent.actor);
    const entity=[...store.all('entity')].find(e=>e.id===actor||e.name===actor||(e.aliases??[]).includes(actor));
    if(entity)anchors.push({kind:'entity',id:entity.id});
  }
  const wanted=new Set(anchors.map(anchorKey));
  const sender=currentEvent?.sender??null;
  const personKeys=new Set([sender?.entityId,sender?.id,sender?.name,sender?.nickname].filter(Boolean).map(String));
  const legacyPersonNote=record=>{
    if(!sender||!personKeys.size)return false;
    const people=record.scope?.people;
    return Array.isArray(people)&&people.some(p=>personKeys.has(String(p)));
  };
  const legacySceneNote=record=>{
    if(!currentEvent?.scene)return false;
    const scenes=record.scope?.scenes;
    return Array.isArray(scenes)&&scenes.includes(currentEvent.scene);
  };
  const values=[];
  for(const type of ['personal_state','note']){
    for(const record of store.all(type)){
      if(type==='personal_state'&&record.subject!==subjectId)continue;
      const key=anchorKey(record.anchor);
      if(!((key&&wanted.has(key))||(type==='note'&&!key&&(legacyPersonNote(record)||legacySceneNote(record)))))continue;
      values.push({ref:{id:record.id,revision:record.revision},type,anchor:record.anchor??null,role:record.mind?.role??null,
        body:String(record.body??'').slice(0,1200),kind:record.kind??null,status:record.status??null,asOf:record.recordedAt??null});
    }
  }
  values.sort((a,b)=>(b.asOf??0)-(a.asOf??0)||refKey(a.ref).localeCompare(refKey(b.ref)));
  return {format:'anchor-view-v1',anchors,records:values.slice(0,Math.max(1,Math.min(32,limit))),scope:'explicit-anchor-records-only'};
}
export function queryAnchor({store,subjectId,anchor,role=null,limit=12}={}){
  const key=anchorKey(anchor);ensure(key,'ANCHOR_REQUIRED','anchor required');
  const roleMap={B:['belief','expectation'],C:['concern'],R:['condition'],Z:['readiness']};
  const allowed=role?new Set(roleMap[role]??[role]):null;
  const rows=[];
  for(const type of ['personal_state','note']){
    for(const record of store.all(type)){
      if(type==='personal_state'&&record.subject!==subjectId)continue;
      if(anchorKey(record.anchor)!==key)continue;
      if(allowed&&!allowed.has(record.mind?.role))continue;
      rows.push({ref:{id:record.id,revision:record.revision},type,anchor:record.anchor??null,role:record.mind?.role??null,
        body:record.body,kind:record.kind??null,status:record.status??null,asOf:record.recordedAt??null});
    }
  }
  rows.sort((a,b)=>(b.asOf??0)-(a.asOf??0)||refKey(a.ref).localeCompare(refKey(b.ref)));
  return {format:'anchor-query-v1',anchor:{kind:anchor.kind,id:anchor.id},role,count:rows.length,records:rows.slice(0,Math.max(1,Math.min(32,limit)))};
}
