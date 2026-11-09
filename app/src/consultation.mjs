import {canonical,ensure,refKey,text,uniqueRefs} from './contracts.mjs';
import {recordNode} from './knowledge-graph.mjs';
import {NAVIGATION_VIAS} from './consultation-navigation.mjs';

const exactKeys=(v,required,optional=[])=>{
  ensure(v&&Object.getPrototypeOf(v)===Object.prototype,'CONSULT_SHAPE','plain consultation object required');
  ensure(required.every(k=>Object.hasOwn(v,k))&&Object.keys(v).every(k=>[...required,...optional].includes(k)),
    'CONSULT_SHAPE','consultation fields do not match this operation');
};
const bounded=(v,max)=>{text(v,'consultation text');ensure([...v].length<=max,'CONSULT_LIMIT','consultation text exceeds bound');return v;};
const norm=s=>s.normalize('NFKC').toLocaleLowerCase('zh-CN');
const pin=r=>uniqueRefs([r])[0];
const compare=(a,b)=>refKey(a.ref)<refKey(b.ref)?-1:refKey(a.ref)>refKey(b.ref)?1:0;
export const CONSULT_VIAS=['find','read','grounds','impact','progress','related','versions',...NAVIGATION_VIAS];
export function normalizeConsultation(v){
  ensure(v&&CONSULT_VIAS.includes(v.via),'CONSULT_SHAPE','registered consultation operation required');
  if(NAVIGATION_VIAS.includes(v.via)){
    exactKeys(v,['need','via'],['assessment',...(['forward','history'].includes(v.via)?['target']:[]),...(v.via==='history'?['offset']:[])]);
    ensure(typeof v.need!=='string','CONSULT_SHAPE','navigation continues an existing result reference');
    const q={need:pin(v.need),via:v.via};if(v.target!==undefined)q.target=pin(v.target);
    if(v.assessment!==undefined)q.assessment=bounded(v.assessment,240);
    if(v.offset!==undefined){ensure(Number.isSafeInteger(v.offset)&&v.offset>=0&&v.offset<=32,'CONSULT_LIMIT','history offset must be 0..32');q.offset=v.offset;}
    return q;
  }
  exactKeys(v,['need','via',...(v.via==='find'?['text']:['target'])],['assessment',...(v.via==='find'?['aliases','anchor']:[])]);
  const need=typeof v.need==='string'?bounded(v.need,240):pin(v.need);
  const q={need,via:v.via};
  if(v.assessment!==undefined)q.assessment=bounded(v.assessment,240);
  if(v.via==='find'){
    q.text=bounded(v.text,240);
    if(v.aliases!==undefined){ensure(Array.isArray(v.aliases)&&v.aliases.length<=6,'CONSULT_LIMIT','up to six explicit aliases');
      q.aliases=[...new Set(v.aliases.map(x=>norm(bounded(x,80))))].sort();}
    if(v.anchor!==undefined)q.anchor=pin(v.anchor);
  }else q.target=pin(v.target);
  return q;
}
// Physical read identity excludes prose about need/assessment. It is not a semantic equivalence detector.
export function consultationOperation(q,{read,subjectId}){
  if(NAVIGATION_VIAS.includes(q.via))return {navigate:{via:q.via,...(q.target?{target:q.target}:{}),...(q.offset!==undefined?{offset:q.offset}:{})}};
  if(q.via==='find')return {find:{text:norm(q.text),aliases:q.aliases??[],...(q.anchor?{anchor:q.anchor}:{})}};
  if(q.via==='versions')return {versions:q.target};
  if(q.via==='read'){
    const r=read(q.target.id,q.target.revision);
    if(!r||['event','note'].includes(r.type))return {ref:q.target};
    if(r.type==='personal_state'){
      ensure(r.subject===subjectId,'SUBJECT_MISMATCH','only own personal state may be read');return {stateRef:q.target};
    }
    ensure(['workspace','action'].includes(r.type),'CONSULT_TARGET','target is not readable personal content or explicit operation context');
  }
  return {trace:{route:q.via==='related'?'associations':q.via==='read'?'grounds':q.via,seeds:[recordNode(q.target)],
    maxDepth:q.via==='read'?0:2,maxNodes:8,maxBytes:8192,includeHistorical:false,offset:0,scope:[],need:'explicit-consultation'}};
}
export function consultationState(q,{load,subjectId,roundId,workspace,resultRef}){
  let root=resultRef,need=q.need,parent=null,trail=[];
  if(typeof q.need!=='string'){
    const prior=load(q.need.id,q.need.revision);
    ensure(prior?.type==='lookup_result'&&prior.subject===subjectId&&prior.round.id===roundId
      &&canonical(prior.workspace)===canonical(workspace)&&prior.consultation,'CONSULT_CONTINUATION','continue only own consultation in the same event/workspace');
    root=prior.consultation.root;need=prior.consultation.need;parent=q.need;
    trail=[...(prior.consultation.trail??[]),{ref:q.need,via:prior.consultation.via,outcome:prior.outcome}].slice(-3);
  }
  return {root,need,parent,via:q.via,assessment:q.assessment??null,trail,
    meaning:'query-process-not-personal-memory; found-is-not-sufficient; catalog-is-not-read'};
}

// Sparse lexical baseline: CJK adjacent pairs and Latin/number words; never a semantic embedding.
export function consultationTokens(s){
  const out=[];
  for(const m of norm(s).matchAll(/[\p{Script=Han}]+|[\p{L}\p{N}_]+/gu)){
    const chars=[...m[0]];
    if(/^\p{Script=Han}+$/u.test(m[0])){if(chars.length===1)out.push(chars[0]);else for(let i=0;i<chars.length-1;i++)out.push(chars[i]+chars[i+1]);}
    else out.push(m[0]);
  }
  return out;
}
export function fuseConsultationRanks(channels,{k=60,cap=32}={}){
  const merged=new Map();
  for(const [name,rows] of Object.entries(channels)){
    const unique=[...new Map(rows.map(r=>[refKey(r.ref),r])).values()].slice(0,cap);
    unique.forEach((r,i)=>{const key=refKey(r.ref),v=merged.get(key)??{ref:r.ref,score:0,channels:[]};
      v.score+=1/(k+i+1);v.channels.push({name,rank:i+1});merged.set(key,v);});
  }
  return [...merged.values()].sort((a,b)=>b.score-a.score||compare(a,b));
}
export function rankConsultation(records,q,{contextRefs=[],cap=32}={}){
  const phrases=[...new Set([q.text,...(q.aliases??[])].map(norm))],terms=new Set(phrases.flatMap(consultationTokens));
  const docs=records.map(r=>{const tokens=consultationTokens(r.body),tf=new Map();for(const t of tokens)tf.set(t,(tf.get(t)??0)+1);
    return {ref:{id:r.id,revision:r.revision},body:norm(r.body),tf,length:tokens.length};});
  const N=docs.length,avg=docs.reduce((sum,d)=>sum+d.length,0)/(N||1)||1,df=new Map();
  for(const d of docs)for(const t of terms)if(d.tf.has(t))df.set(t,(df.get(t)??0)+1);
  const lexical=[],bm25=[];
  for(const d of docs){
    const hits=phrases.filter(t=>d.body.includes(t));if(hits.length)lexical.push({ref:d.ref,score:hits.length});
    let score=0;
    for(const t of terms){const f=d.tf.get(t)??0;if(f)score+=Math.log(1+(N-(df.get(t)??0)+0.5)/((df.get(t)??0)+0.5))*f*2.2/(f+1.2*(0.25+0.75*d.length/avg));}
    if(score>0)bm25.push({ref:d.ref,score});
  }
  for(const rows of [lexical,bm25])rows.sort((a,b)=>b.score-a.score||compare(a,b));
  const contexts=new Set(contextRefs.map(refKey)),context=docs.filter(d=>contexts.has(refKey(d.ref))).sort(compare);
  return {ranked:fuseConsultationRanks({substring:lexical,'char-bm25':bm25,'explicit-lineage':context},{cap}),
    channels:{substring:lexical.slice(0,cap).map(x=>x.ref),'char-bm25':bm25.slice(0,cap).map(x=>x.ref),'explicit-lineage':context.slice(0,cap).map(x=>x.ref)},
    method:'bounded-lexical-rrf-not-semantic',matchingScope:'record-body-and-explicit-lineage; no-implicit-synonyms'};
}
export function consultationCandidate(record,match,{head,needsReview=false}={}){
  const excerpt=[...record.body].slice(0,96).join('');
  return {ref:pin(record),type:record.type,kind:record.kind??null,status:record.status??null,origin:record.origin??null,
    scope:record.scope??{scene:record.scene??null,actor:record.actor??null},occurredAt:record.occurredAt??null,recordedAt:record.recordedAt,
    confidence:record.confidence??null,needsReview,historical:head.revision!==record.revision||record.status==='historical',
    currentHead:pin(head),channels:match.channels,
    preview:{text:excerpt,truncated:[...record.body].length>96,meaning:'verbatim-search-fragment-not-complete-evidence'},
    representation:'catalog-only-not-delivered-body',applicability:'not-assessed'};
}
