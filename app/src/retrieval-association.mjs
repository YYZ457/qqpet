// 检索结果触发的联想：读到一段，它自己勾出一点影子。
// 只一跳、只由她真正读到的结果触发、只给指针、不带正文、不自动再查。
import {canonical,ensure,text} from './contracts.mjs';
import {streamInfo,streamRelation} from './streams.mjs';
import {searchTerms} from './text-cues.mjs';

const MAX_TRIGGERS=2,PER_TRIGGER=2,MAX_SHADOWS=4;
const clean=body=>String(body??'').replace(/\s+/g,' ').trim();
const same=(a,b)=>a?.id===b?.id&&a?.revision===b?.revision;

export function retrievalAssociations({store,subjectId,currentEvent,results=[],limit=MAX_SHADOWS}={}){
  text(subjectId,'subject id');
  ensure(Array.isArray(results)&&results.length<=4,'RETRIEVAL_ASSOCIATION','up to four read results');
  ensure(Number.isSafeInteger(limit)&&limit>=1&&limit<=MAX_SHADOWS,'RETRIEVAL_ASSOCIATION','limit 1..4');
  const current=currentEvent?store.read(currentEvent.id,currentEvent.revision):null;
  const delivered=new Set();
  for(const result of results)for(const entry of result.entries??[])delivered.add(canonical([entry.ref.id,entry.ref.revision]));
  const out=[],seen=new Set();
  const push=(head,via,trigger,triggerLabel)=>{
    if(!head||out.length>=limit)return false;
    const key=canonical([head.id,head.revision]);
    if((current&&head.id===current.id)||same(head,trigger)||delivered.has(key)||seen.has(key))return false;
    seen.add(key);
    const scene=head.type==='event'?head.scene:(head.scope?.scenes?.[0]??null);
    const relation=scene&&current?.scene?streamRelation(current.scene,scene):'same-flow';
    const scope=relation==='same-flow'?'same':'other';
    const snippet=clean(head.body).slice(0,24);
    const kind=head.type==='note'?head.kind:'经历';
    const label=scope==='same'
      ?`${kind}：${snippet}${snippet.length>=24?'…':''}`
      :`他处（${streamInfo(scene).label}）似乎有一段相关的记忆`;
    out.push({ref:{id:head.id,revision:head.revision},type:head.type,noteKind:head.type==='note'?head.kind:null,
      via,scene,scope,relation,label,trigger:{ref:{id:trigger.id,revision:trigger.revision},label:triggerLabel}});
    return true;
  };
  const triggers=[...results].reverse().slice(0,MAX_TRIGGERS);
  for(const result of triggers){
    const entries=[...(result.entries??[])].slice(0,PER_TRIGGER);
    for(const entry of entries){
      if(out.length>=limit)break;
      const trigger=store.read(entry.ref.id,entry.ref.revision);if(!trigger)continue;
      const triggerLabel=clean(trigger.body).slice(0,20);
      let perTrigger=0;
      for(const edge of store.activeAssociationEdges()){
        if(perTrigger>=PER_TRIGGER||out.length>=limit)break;
        const other=same(edge.from,entry.ref)?edge.to:same(edge.to,entry.ref)?edge.from:null;
        if(!other)continue;
        let head=null;try{head=store.read(other.id,other.revision);}catch{head=null;}
        if(push(head,'retrieval-graph',trigger,triggerLabel))perTrigger++;
      }
      if(perTrigger>=PER_TRIGGER||out.length>=limit)continue;
      const terms=searchTerms(trigger.body,{max:4});
      if(!terms.length)continue;
      const hits=store.search({terms,types:['event','note'],limit:4});
      for(const hit of hits.items){
        if(perTrigger>=PER_TRIGGER||out.length>=limit)break;
        let head=null;try{head=store.read(hit.ref.id,hit.ref.revision);}catch{head=null;}
        if(push(head,'retrieval-lexical',trigger,triggerLabel))perTrigger++;
      }
    }
  }
  return {format:'retrieval-associations-v1',candidates:out,
    meaning:'one-hop-shadows-from-what-you-just-read; not-facts; not-auto-read; to inspect use lookup'};
}
