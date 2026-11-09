// 可选本地小模型：只把一句话提议成线索，不写库、不执行、不决定。
// 输出必须用已知实体/场景/时间校验；失败/超时/幻觉一律退回确定性。
import {ensure,text} from './contracts.mjs';

const MAX_WHAT=6,MAX_SPAN=366*86400000;
const strip=raw=>String(raw??'').replace(/^```json\s*/i,'').replace(/^```\s*/,'').replace(/```$/,'').trim();

export async function proposeCues({text:value,entities=[],scenes=[],now=Date.now(),endpoint,model='qwen2.5:1.5b',fetchImpl=fetch,timeoutMs=5000}={}){
  text(value,'text');ensure(typeof endpoint==='string'&&/^https?:\/\//.test(endpoint),'LOCAL_CUE','explicit local endpoint required');
  const names=[...new Set(entities.flatMap(e=>[e.name,...(e.aliases??[])]).filter(Boolean))];
  const prompt=[
    '把用户这句话拆成记忆检索线索，只输出 JSON：',
    '{"who":string|null,"where":string|null,"when":{"from":number,"until":number}|null,"what":string[]}',
    '只允许使用给定的实体名/别名与场景路径；不确定就填 null；不要解释。',
    `实体：${names.join('、')||'（无）'}`,
    `场景：${scenes.join('、')||'（无）'}`,
    `现在：${now}`,
    `句子：${value}`,
  ].join('\n');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const response=await fetchImpl(endpoint.replace(/\/+$/,'')+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({model,temperature:0,response_format:{type:'json_object'},messages:[{role:'user',content:prompt}]}),signal:controller.signal});
    ensure(response.ok,'LOCAL_CUE_HTTP',`http ${response.status}`);
    const bodyText=await response.text();let body;try{body=JSON.parse(bodyText);}catch{return {ok:false,error:'LOCAL_CUE_JSON',fallback:true};}
    const raw=body?.choices?.[0]?.message?.content;
    let parsed;try{parsed=JSON.parse(strip(raw));}catch{return {ok:false,error:'LOCAL_CUE_JSON',fallback:true};}
    const rejected=[],cues={};
    if(parsed.who!==null&&parsed.who!==undefined){
      const lower=String(parsed.who).toLocaleLowerCase('zh-CN');
      const match=entities.find(e=>[e.name,...(e.aliases??[])].some(n=>n.toLocaleLowerCase('zh-CN')===lower));
      if(match)cues.who=match.name;else rejected.push('who');
    }
    if(parsed.where!==null&&parsed.where!==undefined){
      if(scenes.includes(parsed.where))cues.where=parsed.where;else rejected.push('where');
    }
    if(parsed.when!==null&&parsed.when!==undefined){
      const w=parsed.when;
      if(w&&Number.isSafeInteger(w.from)&&Number.isSafeInteger(w.until)&&w.from<=w.until&&w.until-w.from<=MAX_SPAN)cues.when={from:w.from,until:w.until};
      else rejected.push('when');
    }
    if(Array.isArray(parsed.what)){const what=parsed.what.filter(x=>typeof x==='string'&&x.trim()).slice(0,MAX_WHAT);if(what.length)cues.what=what;}
    return {ok:true,cues,rejected,accepted:Object.keys(cues).length>0,fallback:rejected.length>0};
  }catch(error){
    return {ok:false,error:error.code??'LOCAL_CUE_FAILED',fallback:true};
  }finally{clearTimeout(timer);}
}
