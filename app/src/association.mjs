// 自动联想：像人一样"浮起一点影子"——只提名，不给正文、不写事件、不算使用。
// 顺序由激活模型决定（docs/104/105）：绑定 > 同一件事/旧链接 > 字面；扇出降权、情境门控、阈值截断。
import {canonical,ensure,text} from './contracts.mjs';
import {attentionId} from './attention.mjs';
import {streamInfo,streamRelation} from './streams.mjs';
import {searchTerms} from './text-cues.mjs';
import {ACTIVATION,activation,bindingWeight,gateFor,passes,simScore} from './activation.mjs';

const MAX_TERMS=6,MAX_BINDING=2,MAX_PROCESS=2,MAX_GRAPH=2,MAX_SAME=2,MAX_CROSS=2;
const clean=body=>String(body??'').replace(/\s+/g,' ').trim();
const same=(a,b)=>a?.id===b?.id&&a?.revision===b?.revision;
const mentions=(body,entity)=>{
  const hay=String(body??'').toLocaleLowerCase('zh-CN');
  return [entity.name,...(entity.aliases??[])].some(name=>[...name].length>=2&&hay.includes(name.toLocaleLowerCase('zh-CN')));
};
const timeOf=record=>record?.type==='event'?(record.occurredAt??record.recordedAt??0):(record?.recordedAt??0);
const daysBetween=(a,b)=>Math.abs(a-b)/86400000;

export function associationCandidates({store,subjectId,currentEvent,limit=6}={}){
  text(subjectId,'subject id');ensure(currentEvent,'ASSOCIATION_INPUT','current observation required');
  ensure(Number.isSafeInteger(limit)&&limit>=1&&limit<=8,'ASSOCIATION_INPUT','limit 1..8');
  const subject=store.read(subjectId);ensure(subject?.type==='subject','ASSOCIATION_INPUT','unknown subject');
  const event=store.read(currentEvent.id,currentEvent.revision);
  ensure(event?.type==='event','ASSOCIATION_INPUT','current event required');
  const terms=searchTerms(event.body,{max:MAX_TERMS});
  if(!terms.length)return [];
  const frame=store.read(attentionId(subjectId));
  const edges=store.activeAssociationEdges();
  const bindings=[...store.all('binding')].filter(b=>b.status==='active');
  const foreground=new Set((subject.foreground??[]).map(r=>canonical([r.id,r.revision])));
  const resident=new Set((frame?.residences??[]).filter(r=>r.target?.kind==='material').map(r=>canonical([r.target.ref.id,r.target.ref.revision])));
  const fanOf=(head,ref)=>{
    let fan=edges.filter(e=>same(e.from,ref)||same(e.to,ref)).length;
    if(head.type==='entity')fan+=bindings.filter(b=>b.from.id===head.id||b.to.id===head.id).length;
    return fan;
  };

  const out=[],seen=new Set();
  const push=(head,via,{strength=0.5,forceGate=null,extra={}}={})=>{
    if(!head||out.length>=limit*2)return false;
    const key=canonical([head.id,head.revision]);
    if(head.id===event.id||seen.has(key)||foreground.has(key)||resident.has(key))return false;
    seen.add(key);
    const scene=head.type==='event'?head.scene:(head.scope?.scenes?.[0]??null);
    const relation=forceGate??(scene&&event.scene?streamRelation(event.scene,scene):'same-flow');
    const gate=gateFor(relation);
    const sim=simScore({gate,days:daysBetween(timeOf(event),timeOf(head))});
    const fan=fanOf(head,extra.ref??{id:head.id,revision:head.revision});
    const snippet=clean(head.body).slice(0,24);
    const kind=head.type==='note'?head.kind:(head.type==='entity'?'实体':'经历');
    const label=gate===ACTIVATION.gates.same
      ?`${kind}：${snippet}${snippet.length>=24?'…':''}`
      :`他处（${streamInfo(scene).label}）似乎有一段相关的记忆`;
    out.push({ref:{id:head.id,revision:head.revision},type:head.type,noteKind:head.type==='note'?head.kind:null,via,
      scene,scope:gate===ACTIVATION.gates.same?'same':'other',relation,label,historical:false,strength,sim,fan,...extra});
    return true;
  };

  // 绑定：当前话语精确命中实体（含别名）→ 一跳绑定。
  let bindingCount=0;
  const mentionedEntities=[...store.all('entity')].filter(e=>e.status==='current'&&mentions(event.body,e))
    .sort((a,b)=>[...b.name].length-[...a.name].length||a.id.localeCompare(b.id)).slice(0,2);
  for(const entity of mentionedEntities){
    const own=bindings.filter(b=>b.from.id===entity.id||b.to.id===entity.id);
    const degree=own.length;
    for(const b of own){
      if(bindingCount>=MAX_BINDING||out.length>=limit*2)break;
      const other=b.from.id===entity.id?b.to:b.from;
      let head=null;try{head=store.read(other.id,other.revision);}catch{head=null;}
      if(!head)continue;
      const strength=bindingWeight(b.relation)*(b.source==='import'?0.7:1);
      const key=canonical([head.id,head.revision]);if(seen.has(key))continue;
      seen.add(key);
      const label=`${entity.name} ${b.relation} ${head.name}${b.label?`（${b.label}）`:''}`;
      const score=activation({strength,sim:1,fan:degree});
      if(!passes(score)){seen.delete(key);continue;}
      out.push({ref:{id:head.id,revision:head.revision},type:'entity',noteKind:null,via:'binding',scene:null,scope:'same',relation:'binding',
        label,historical:false,strength,sim:1,fan:degree,
        binding:{relation:b.relation,label:b.label??null,source:b.source,direction:b.direction},score});
      bindingCount++;
    }
  }

  // 同一件事：当前观察作为依据的过程，它依据里的其他材料。
  let processCount=0;
  for(const p of frame?.processes??[]){
    if(processCount>=MAX_PROCESS)break;
    if(!(p.basis??[]).some(r=>same(r,currentEvent)))continue;
    for(const b of p.basis??[]){
      if(same(b,currentEvent))continue;
      let head=null;try{head=store.read(b.id,b.revision);}catch{head=null;}
      if(push(head,'process',{strength:0.8}))processCount++;
      if(processCount>=MAX_PROCESS)break;
    }
  }

  // 旧链接：当前事件身上显式的 related/similar 边（一跳，不扩散）。
  let graphCount=0;
  for(const edge of edges){
    if(graphCount>=MAX_GRAPH)break;
    const other=same(edge.from,currentEvent)?edge.to:same(edge.to,currentEvent)?edge.from:null;
    if(!other)continue;
    let head=null;try{head=store.read(other.id,other.revision);}catch{head=null;}
    if(push(head,'graph',{strength:edge.strength??0.5}))graphCount++;
  }

  // 字面相关：同流先给摘要，兄弟/他处只给指针。
  let sameCount=0,crossCount=0;
  const sameHits=store.search({terms,types:['event','note'],scene:event.scene,limit:limit+4,excludeRefs:[currentEvent]});
  for(const hit of sameHits.items){
    if(sameCount>=MAX_SAME)break;
    let head=null;try{head=store.read(hit.ref.id,hit.ref.revision);}catch{head=null;}
    if(push(head,'lexical',{strength:0.5+0.5*(hit.hits.length/Math.max(1,terms.length))}))sameCount++;
  }
  if(out.length<limit){
    const allHits=store.search({terms,types:['event','note'],limit:limit+8,excludeRefs:[currentEvent]});
    for(const hit of allHits.items){
      if(crossCount>=MAX_CROSS)break;
      let head=null;try{head=store.read(hit.ref.id,hit.ref.revision);}catch{head=null;}
      if(!head)continue;
      const scene=head.type==='event'?head.scene:(head.scope?.scenes?.[0]??null);
      if(scene===event.scene)continue;
      if(push(head,'lexical',{strength:0.5+0.5*(hit.hits.length/Math.max(1,terms.length))}))crossCount++;
    }
  }

  return out.map(c=>{
    const score=c.score??activation({strength:c.strength,sim:c.sim,fan:c.fan});
    const {strength,sim,fan,score:ignored,...rest}=c;
    return {...rest,_score:score};
  }).filter(c=>passes(c._score))
    .sort((a,b)=>b._score-a._score||a.ref.id.localeCompare(b.ref.id))
    .slice(0,limit)
    .map(({_score,...c})=>c);
}
