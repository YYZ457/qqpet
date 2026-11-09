// 动词外观：她只说 remember / open / relate / say / do / wait。
// 这里只做形状翻译与边界校验，不访问网络、不写库；真正的检索/执行仍走内部路由。
import {ensure,text} from './contracts.mjs';
import {searchTerms} from './text-cues.mjs';
import {resolveRememberCues} from './cue-resolver.mjs';

const INTERNAL=['respond','turn','lookup','act','continue','pause','wait'];
const plain=value=>value&&Object.getPrototypeOf(value)===Object.prototype;
const MAX_UTTERANCES=4;
function utterances(value){
  ensure(Array.isArray(value)&&value.length>=1&&value.length<=MAX_UTTERANCES,'VERB_SHAPE','1..4 utterances required');
  return value.map((item,index)=>{
    ensure(plain(item),'VERB_SHAPE','utterance must be an object');
    const keys=Object.keys(item);
    ensure(keys.every(k=>['text','delayMs'].includes(k)),'VERB_SHAPE','utterance has unsupported fields');
    ensure(typeof item.text==='string'&&item.text.trim().length>0,'VERB_SHAPE','utterance text required');
    ensure([...item.text].length<=4000,'VERB_SHAPE','utterance too long');
    if(item.delayMs!==undefined)ensure(Number.isSafeInteger(item.delayMs)&&item.delayMs>=0&&item.delayMs<=5000,'VERB_SHAPE','utterance delay 0..5000ms');
    return {text:item.text,delayMs:item.delayMs??(index?500:0)};
  });
}
function respondOption(option){
  const {id,payload}=option;
  ensure(plain(payload),'VERB_SHAPE','respond payload must be an object');
  const keys=Object.keys(payload);
  if(keys.length===1&&typeof payload.text==='string'){
    ensure(payload.text.trim().length>0&&[...payload.text].length<=4000,'VERB_SHAPE','respond text required');
    return option;
  }
  if(keys.length===1&&Array.isArray(payload.utterances))return {id,kind:'respond',payload:{utterances:utterances(payload.utterances)}};
  ensure(false,'VERB_SHAPE','respond needs text or utterances');
}

function actions(value){
  ensure(Array.isArray(value)&&value.length>=1&&value.length<=3,'VERB_SHAPE','1..3 actions required');
  return value.map(item=>{
    ensure(plain(item),'VERB_SHAPE','action must be an object');
    ensure(Object.keys(item).every(k=>['tool','args'].includes(k)),'VERB_SHAPE','action accepts tool/args');
    text(item.tool,'action.tool');
    ensure(plain(item.args),'VERB_SHAPE','action.args must be an object');
    return {tool:item.tool,args:item.args};
  });
}
function turnOption(option){
  const {id,payload}=option;
  ensure(plain(payload),'VERB_SHAPE','turn payload must be an object');
  const keys=Object.keys(payload);
  ensure(keys.length>0&&keys.every(k=>['utterances','actions'].includes(k)),'VERB_SHAPE','turn accepts utterances/actions');
  const out={};
  if(payload.utterances!==undefined)out.utterances=utterances(payload.utterances);
  if(payload.actions!==undefined)out.actions=actions(payload.actions);
  ensure((out.utterances?.length??0)+(out.actions?.length??0)>0,'VERB_SHAPE','turn needs speech or actions');
  return {id,kind:'turn',payload:out};
}
export function normalizeVerbOption(option,{store=null,subjectId=null,now=Date.now(),currentScene=null}={}){
  ensure(plain(option),'VERB_SHAPE','option must be an object');
  const {id,kind,payload}=option;
  if(kind==='turn')return turnOption(option);
  if(kind==='respond')return respondOption(option);
  if(INTERNAL.includes(kind))return option;
  ensure(plain(payload),'VERB_SHAPE','verb payload must be an object');
  const keys=Object.keys(payload);
  if(kind==='remember'){
    ensure(keys.length>=1&&keys.every(k=>['query','cues','ref'].includes(k)),'VERB_SHAPE','remember accepts query/cues/ref');
    if(payload.ref!==undefined){
      ensure(keys.length===1,'VERB_SHAPE','ref cannot be combined with query/cues');
      return {id,kind:'lookup',payload:{ref:payload.ref}};
    }
    if(payload.cues!==undefined){
      const cues=payload.cues;ensure(plain(cues),'VERB_SHAPE','cues must be an object');
      ensure(Object.keys(cues).every(k=>['who','where','when','what'].includes(k)),'VERB_SHAPE','cues accept who/where/when/what');
      const recall={};
      if(cues.who!==undefined){text(cues.who,'who');recall.person=cues.who;}
      if(cues.where!==undefined){text(cues.where,'where');recall.place=cues.where;}
      if(cues.when!==undefined){
        const w=cues.when;ensure(plain(w)&&Number.isSafeInteger(w.from)&&Number.isSafeInteger(w.until)&&w.from<=w.until,'VERB_SHAPE','when needs from/until');
        recall.time={from:w.from,until:w.until};
      }
      const what=[...(Array.isArray(cues.what)?cues.what:[cues.what]).filter(Boolean),...(payload.query?[payload.query]:[])];
      if(what.length)recall.terms=searchTerms(what.join(' '),{max:8});
      ensure(Object.keys(recall).length>=1,'VERB_SHAPE','remember needs at least one cue');
      return {id,kind:'lookup',payload:{recall}};
    }
    text(payload.query,'query');ensure([...payload.query].length<=300,'VERB_SHAPE','query too long');
    const resolved=store&&subjectId?resolveRememberCues({store,subjectId,text:payload.query,now,currentScene}):null;
    if(resolved){
      const recall={};
      if(resolved.cues.who)recall.person=resolved.cues.who;
      if(resolved.cues.where)recall.place=resolved.cues.where;
      if(resolved.cues.when)recall.time=resolved.cues.when;
      if(resolved.cues.entity)return {id,kind:'lookup',payload:{entity:resolved.cues.entity}};
      return {id,kind:'lookup',payload:{recall}};
    }
    return {id,kind:'lookup',payload:{query:payload.query}};
  }
  if(kind==='open'){
    ensure(keys.every(k=>['ref','item'].includes(k))&&payload.ref,'VERB_SHAPE','open needs ref and optional item');
    return {id,kind:'lookup',payload:{open:{ref:payload.ref,...(payload.item!==undefined?{item:payload.item}:{})}}};
  }
  if(kind==='relate'){
    ensure(keys.every(k=>['a','b','relation','label'].includes(k))&&payload.a&&payload.b&&payload.relation,'VERB_SHAPE','relate needs a/b/relation');
    return {id,kind:'act',payload:{tool:'remember-binding',args:{from:payload.a,to:payload.b,relation:payload.relation,...(payload.label!==undefined?{label:payload.label}:{})}}};
  }
  if(kind==='say'){
    ensure(keys.length===1&&typeof payload.text==='string'||keys.length===1&&Array.isArray(payload.utterances),'VERB_SHAPE','say needs text or utterances');
    return respondOption({id,kind:'respond',payload});
  }
  if(kind==='do'){
    ensure(keys.length===2&&typeof payload.tool==='string'&&plain(payload.args),'VERB_SHAPE','do needs tool/args');
    return {id,kind:'act',payload:{tool:payload.tool,args:payload.args}};
  }
  return option;
}
