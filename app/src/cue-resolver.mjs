// 从一句自然话里提取已知线索：实体名/别名、已知流路径、明确时间。
// 只做精确匹配与固定日历规则；多个候选时不替她选。
import {normalizeStream} from './streams.mjs';
import {parseTimeCue} from './time-cues.mjs';

const hits=(text,needle)=>needle.length>=2&&String(text).toLocaleLowerCase('zh-CN').includes(String(needle).toLocaleLowerCase('zh-CN'));

export function resolveRememberCues({store,subjectId,text,now=Date.now(),currentScene=null}){
  const source=String(text??'');
  const entities=[...store.all('entity')].filter(e=>e.status==='current'&&[e.name,...(e.aliases??[])].some(n=>hits(source,n)));
  const people=entities.filter(e=>e.kind==='person');
  const places=[...new Set([...store.all('event')].map(e=>e.scene).filter(Boolean)
    .concat([...store.all('note')].flatMap(n=>n.scope?.scenes??[])))];
  const matchedPlaces=places.filter(p=>{try{return hits(source,p)||hits(source,normalizeStream(p).join(' '));}catch{return false;}});
  const time=parseTimeCue(source,{now});
  const cues={};
  if(people.length===1)cues.who=people[0].name;
  else if(people.length===0&&entities.length===1&&entities[0].kind!=='person')cues.entity=entities[0].name;
  if(matchedPlaces.length===1)cues.where=matchedPlaces[0];
  else if(!cues.where&&currentScene){
    if(/群里|群聊/.test(source)&&currentScene.includes('/group/'))cues.where=currentScene;
    if(/私聊|私信/.test(source)&&currentScene.includes('/private/'))cues.where=currentScene;
  }
  if(time)cues.when={from:time.from,until:time.until};
  const matched=Object.keys(cues).length>0;
  return matched?{cues,matched:{people:people.map(e=>e.name),places:matchedPlaces,time:time?.phrase??null}}:null;
}
