// 一次真实冒烟：反射包 → 真实模型 → 提交 → 记账。默认不运行，必须显式 --live。
// 只花一次调用；失败不重试、不补发；不接 QQ、不写在线库。
import {mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {ContinuityStore} from '../../src/store.mjs';
import {ContinuitySession} from '../../src/continuity-session.mjs';
import {prepareReflection,commitDecision} from '../../src/cognition.mjs';
import {reflectionFrame} from '../../src/reflection-frame.mjs';
import {createModelDecision} from '../../src/model-transport.mjs';
import {frame,put,ref} from '../../test/helpers.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const args=process.argv.slice(2);const live=args.includes('--live');
const opt=(name,fallback)=>{const i=args.indexOf(name);return i>=0?args[i+1]:fallback;};
if(!live){console.log(JSON.stringify({ran:false,reason:'pass --live to spend one real call'}));process.exit(0);}

const runDir=join(root,'evaluation','qq-brain-smoke_2026-11-07');mkdirSync(runDir,{recursive:true});
const storePath=join(runDir,'smoke.sqlite'),ledgerPath=join(runDir,'budget.json');
const store=new ContinuityStore(storePath);
let transport=null;
try{
  const subjectId='agent';new ContinuitySession({store,subjectId,attention:true,maxForeground:16});
  const workspace=store.read('qq')??put(store,'workspace',frame())[0];
  const internal=reflectionFrame({read:(id,rev)=>store.read(id,rev),subjectId,workspace:ref(workspace),now:Date.now(),
    sinceLastInteraction:null,waitingUntil:null});
  const packet=prepareReflection({store,subjectId,workspace:ref(workspace),identity:'你是智能体，一个在持续生长的人。',
    internal,budgetBytes:90000,allowedActionTools:[]});
  transport=createModelDecision({ledgerPath,profile:{maxTokens:3000,reasoning:'low',
    dailyMicros:Number(opt('--cap',200000)),dailyCalls:Number(opt('--calls',2))}});
  const output=await transport.decide(packet);
  const decision=commitDecision({store,packet,output,requestId:'smoke:1',decisionId:'smoke:1',allowedActionTools:[],maxOutputBytes:32768});
  const choice=decision.output.options.find(o=>o.id===decision.output.selected);
  console.log(JSON.stringify({ran:true,packetId:packet.packetId,packetBytes:packet.bytes,decisionId:decision.id,
    choice:choice.kind,reflection:decision.reflection===true,currentEvent:decision.currentEvent,
    ledger:transport.state(),outputChars:[...output].length},null,2));
}catch(error){
  console.log(JSON.stringify({ran:false,error:error.code??'ERROR',message:error.message,
    ledger:transport?.state?.()??null},null,2));
  process.exitCode=1;
}finally{transport?.close();store.close();}
