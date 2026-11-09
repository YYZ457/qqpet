import {canonical,digest,ensure,text,uniqueRefs} from './contracts.mjs';
import {normalizeStream} from './streams.mjs';
import {searchTerms} from './text-cues.mjs';
import {normalizeGraphQuery} from './attention.mjs';
import {traceQuery} from './knowledge-graph.mjs';
import {normalizeConsultation} from './consultation.mjs';
import {recoveryQuery} from './workbench-recovery.mjs';

export const lookupRoundId=(subject,event)=>`lookup-round:${digest({subject,event})}`;
export const lookupResultId=decision=>`lookup-result:${digest(decision)}`;
export const sameRef=(a,b)=>a?.id===b?.id&&a?.revision===b?.revision;
export function normalizeLookupQuery(value) {
  ensure(value&&Object.getPrototypeOf(value)===Object.prototype,'OUTPUT_SHAPE','lookup query must be an object');
  const keys=Object.keys(value);
  ensure(keys.length===1&&['terms','ref','pageAfter','graph','stateRef','trace','context','consult','workbench','person','recall','query','entity','open'].includes(keys[0]),'OUTPUT_SHAPE','lookup requires exactly one registered route');
  if(keys[0]==='open'){
    const o=value.open;ensure(o&&Object.getPrototypeOf(o)===Object.prototype,'OUTPUT_SHAPE','open requires an object');
    const keys=Object.keys(o);ensure(keys.every(k=>['ref','item'].includes(k))&&Object.hasOwn(o,'ref'),'OUTPUT_SHAPE','open accepts ref and optional item');
    const ref=uniqueRefs([o.ref])[0];if(o.item!==undefined){text(o.item,'content item id');}
    return {open:{ref,...(o.item!==undefined?{item:o.item}:{})}};
  }
  if(keys[0]==='entity'){const name=value.entity;text(name,'entity name');ensure([...name].length<=64,'OUTPUT_LIMIT','entity name too long');return {entity:name.trim()};}
  if(keys[0]==='query'){const q=value.query;text(q,'query');ensure([...q].length<=300,'OUTPUT_LIMIT','query too long');const terms=searchTerms(q,{max:12});ensure(terms.length>0,'OUTPUT_SHAPE','query needs searchable words');return {query:{text:q,terms}};}
  if(keys[0]==='recall'){
    const q=value.recall;ensure(q&&Object.getPrototypeOf(q)===Object.prototype,'OUTPUT_SHAPE','recall cues must be an object');
    const allowed=['person','place','time','terms'];
    ensure(Object.keys(q).length>=1&&Object.keys(q).every(k=>allowed.includes(k)),'OUTPUT_SHAPE','recall accepts person/place/time/terms');
    const out={};
    if(q.person!==undefined){text(q.person,'person');ensure([...q.person].length<=64,'OUTPUT_LIMIT','person name too long');out.person=q.person.trim();}
    if(q.place!==undefined)out.place=normalizeStream(q.place).join('/');
    if(q.time!==undefined){
      const t=q.time;ensure(t&&Object.getPrototypeOf(t)===Object.prototype&&canonical(Object.keys(t).sort())===canonical(['from','until']),'OUTPUT_SHAPE','time requires explicit from/until');
      ensure(Number.isSafeInteger(t.from)&&Number.isSafeInteger(t.until)&&t.from>=0&&t.until>=t.from,'OUTPUT_LIMIT','time interval must be explicit and ordered');
      out.time={from:t.from,until:t.until};
    }
    if(q.terms!==undefined)out.terms=normalizeLookupQuery({terms:q.terms}).terms;
    ensure(Object.keys(out).length>=1,'OUTPUT_SHAPE','recall needs at least one usable cue');return {recall:out};
  }
  if(keys[0]==='person'){const name=value.person;text(name,'person name');ensure([...name].length<=64,'OUTPUT_LIMIT','person name too long');return {person:name.trim()};}
  if(keys[0]==='workbench')return {workbench:recoveryQuery(value.workbench)};
  if(keys[0]==='consult')return {consult:normalizeConsultation(value.consult)};
  if(keys[0]==='context'){
    const q=value.context;
    ensure(q&&Object.getPrototypeOf(q)===Object.prototype&&canonical(Object.keys(q).sort())===canonical(['anchor','terms']),'OUTPUT_SHAPE','context requires an explicit pinned anchor and terms');
    return {context:{anchor:uniqueRefs([q.anchor])[0],terms:normalizeLookupQuery({terms:q.terms}).terms}};
  }
  if(keys[0]==='graph')return {graph:normalizeGraphQuery(value.graph)};
  if(keys[0]==='trace')return {trace:traceQuery(value.trace)};
  if(keys[0]!=='terms')return {[keys[0]]:uniqueRefs([value[keys[0]]])[0]};
  ensure(Array.isArray(value.terms)&&value.terms.length>0&&value.terms.length<=8,'OUTPUT_LIMIT','lookup needs 1..8 keywords');
  value.terms.forEach(term=>{text(term,'lookup term');ensure([...term].length<=80,'OUTPUT_LIMIT','lookup term too long');});
  return {terms:[...new Set(value.terms.map(term=>term.toLocaleLowerCase('zh-CN')))].sort()};
}
export function lookupPolicy(value={maxReads:4,maxHits:4}) {
  ensure(value&&Object.getPrototypeOf(value)===Object.prototype&&canonical(Object.keys(value).sort())===canonical(['maxHits','maxReads']),
    'LOOKUP_POLICY','explicit maxReads/maxHits policy required');
  for(const key of ['maxReads','maxHits'])ensure(Number.isSafeInteger(value[key])&&value[key]>0&&value[key]<=8,'LOOKUP_POLICY','local lookup limits must be 1..8');
  return {maxReads:value.maxReads,maxHits:value.maxHits};
}
export function memoryAspect(record) {
  if(record.type==='event')return 'experience';
  if(record.kind==='feeling')return 'feeling';
  if(record.kind==='dream')return 'goal';
  if(record.kind==='skill')return 'knowledge';
  return 'belief';
}
