// 合成任务对比：六动词（query / cues）与旧路由在同一个记忆库上的成功率与字段负担。
// 不调模型、不联网；只验证接口翻译是否丢能力、哪里需要精确线索。
import {ContinuitySession} from '../../src/continuity-session.mjs';
import {commitDecision} from '../../src/cognition.mjs';
import {LocalLookupSession} from '../../src/local-lookup.mjs';
import {keepAttention} from '../../src/attention.mjs';
import {event,note,frame,put,ref} from '../../test/helpers.mjs';
import {ContinuityStore} from '../../src/store.mjs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

const t0=Date.UTC(2026,10,7,10,0,0);
const attention=()=>({...keepAttention()});
const text=(id,body,{scene='qq/group/9',at=t0,actor='brother',people=null,content=null}={})=>({
  id,body,scene,at,actor,people,content,
});

function seed(store){
  put(store,'workspace',frame({id:'qq',scene:'qq/group/9'}));
  put(store,'n:roof',note('n:roof',[],{body:'上次修屋顶用了木头',status:'current',scope:{scenes:['qq/group/9'],people:[],validFrom:null,validUntil:null}}));
  put(store,'e:hong',event('e:hong',{body:'今天见到小红，她说周末休息',origin:'reported',scene:'qq/group/9',actor:'小红',occurredAt:t0}));
  put(store,'n:photo',note('n:photo',[],{body:'群里发了一张海边照片',status:'current',scope:{scenes:['qq/group/9'],people:[],validFrom:null,validUntil:null}}));
  put(store,'e:time',event('e:time',{body:'那天聊了修房子的事',origin:'reported',scene:'qq/group/9',actor:'brother',occurredAt:t0}));
  put(store,'n:album',note('n:album',[],{body:'海边相册',status:'current',scope:{scenes:['qq/group/9'],people:[],validFrom:null,validUntil:null}}));
  put(store,'attach:album',{op:'attach_content',node:ref(store.read('n:album')),items:[{id:'c1',kind:'text',label:'说明',text:'照片背后的文字'}]});
  return store;
}

function tasks(store){
  const r=id=>ref(store.read(id));
  return [
    {id:'lexical',text:'屋顶 木头',cues:{what:['屋顶']},route:{terms:['屋顶']},expect:['n:roof']},
    {id:'person',text:'小红 休息',cues:{who:'小红'},route:{person:'小红'},expect:['e:hong']},
    {id:'place',text:'群里 照片 海边',cues:{where:'qq/group/9',what:['照片']},route:{recall:{place:'qq/group/9',terms:['照片']}},expect:['n:photo']},
    {id:'time',text:'今天 我们 说 什么',cues:{when:{from:t0-86400000,until:t0+86400000}},route:{recall:{time:{from:t0-86400000,until:t0+86400000}}},expect:['e:time']},
    {id:'open',text:'打开海边相册',cues:{ref:r('n:album')},route:{open:{ref:r('n:album')}},expect:['n:album'],open:true},
  ];
}

function runMode(store,{mode}){
  const results=[];
  for(const task of tasks(store)){
    const current=put(store,`cur:${mode}:${task.id}`,event(`cur:${mode}:${task.id}`,{body:'开始',origin:'reported',scene:'qq/group/9',occurredAt:t0+100*86400000}))[0];
    const session=new ContinuitySession({store,subjectId:'actor',attention:true,maxForeground:16});
    const packet=session.prepare({currentEvent:ref(current),workspace:ref(store.read('qq')),identity:'你是智能体。',materials:[],mind:true,unified:true,
      workbenchMaterials:true,workbenchFocus:true,budgetBytes:90000,localLookupPolicy:{maxReads:4,maxHits:8},now:t0});
    let kind='lookup',payload=null;
    if(mode==='verb-query'){kind=task.open?'open':'remember';payload=task.open?{ref:task.cues.ref}:{query:task.text};}
    else if(mode==='verb-cues'){kind=task.open?'open':'remember';payload=task.open?{ref:task.cues.ref}:{cues:task.cues};}
    else if(mode==='route')payload=task.route;
    const option={id:'o',kind,payload};
    const output=JSON.stringify({packetId:packet.packetId,options:[option],selected:'o',summary:'对比',used:[],
      continuity:{changes:[],residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',attention:attention()}});
    const d=commitDecision({store,packet,output,requestId:`cmp:${mode}:${task.id}`,decisionId:`cmp:${mode}:${task.id}`,allowedActionTools:[]});
    const result=new LocalLookupSession({store,subjectId:'actor',policy:{maxReads:4,maxHits:8}}).execute({decision:ref(d)});
    const found=new Set((result.entries??[]).map(e=>e.ref.id));
    for(const id of (result.opened?.items??[]).map(x=>result.opened.ref.id))found.add(id);
    if(result.opened)found.add(result.opened.ref.id);
    const ok=task.expect.every(id=>found.has(id));
    results.push({id:task.id,ok,found:[...found],method:result.method,query:result.query,fields:Object.keys(payload).length});
  }
  return results;
}

function summarize(results){return {tasks:results.length,success:results.filter(r=>r.ok).length,failed:results.filter(r=>!r.ok).map(r=>({id:r.id,found:r.found,method:r.method,query:r.query})),avgFields:results.reduce((s,r)=>s+r.fields,0)/results.length};}

export function runBenchmark(){
  const store=new ContinuityStore(':memory:');
  try{
    seed(store);
    const out={verbQuery:summarize(runMode(store,{mode:'verb-query'})),verbCues:summarize(runMode(store,{mode:'verb-cues'})),route:summarize(runMode(store,{mode:'route'}))};
    out.note='pure local; no model calls; success = expected memory ref appears in results/opened';
    return out;
  }finally{store.close();}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(runBenchmark(),null,2));
