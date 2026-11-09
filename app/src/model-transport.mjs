// 真实模型传输：把"她的决定"接到已计费的模型客户端；日预算、显式凭证、不重试。
// 只负责"问一次、记一次账"，不解释输出、不替她决定。
import {closeSync,existsSync,mkdirSync,openSync,readFileSync,renameSync,unlinkSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonical,ensure,digest} from './contracts.mjs';
import {verifiedModelInput} from './cognition.mjs';
import {DeepSeekStudyClient,RATES,requireStudyNetwork} from './model-client.mjs';
import {writeLedgerAtomically} from './model-ledger.mjs';
import {studyKey} from './model-key.mjs';

const DAY=/^\d{4}-\d{2}-\d{2}$/;
const usedMicros=rows=>rows.reduce((sum,r)=>sum+(r.status==='settled'?r.actualMicros:r.status==='released'?0:r.reserveMicros),0);

export class DailyBudgetLedger {
  constructor(path,{dailyMicros=3000000,dailyCalls=96,dayKey=new Date().toISOString().slice(0,10)}={}){
    textPath(path);
    ensure(Number.isSafeInteger(dailyMicros)&&dailyMicros>0&&dailyMicros<=20000000,'BUDGET_POLICY','dailyMicros 1..20000000');
    ensure(Number.isSafeInteger(dailyCalls)&&dailyCalls>0&&dailyCalls<=1000,'BUDGET_POLICY','dailyCalls 1..1000');
    ensure(DAY.test(dayKey),'BUDGET_POLICY','dayKey must be YYYY-MM-DD');
    this.path=path;this.lock=path+'.lock';mkdirIfNeeded(dirname(path));
    try{this.fd=openSync(this.lock,'wx');}catch{ensure(false,'LEDGER_LOCKED','another writer holds the daily budget; do not auto-resend');}
    try{
      if(existsSync(path)){
        const previous=JSON.parse(readFileSync(path,'utf8'));
        ensure(previous.format==='agent-daily-brain-budget-v1','BUDGET_POLICY','unknown budget file format');
        if(previous.dayKey!==dayKey){
          const archive=`${path}.${previous.dayKey}.json`;
          renameSync(path,existsSync(archive)?`${path}.${previous.dayKey}.${randomUUID()}.json`:archive);
        }else{
          ensure(previous.dailyMicros===dailyMicros&&previous.dailyCalls===dailyCalls,'BUDGET_POLICY','same-day limits cannot change mid-day');
          this.data=previous;this.save();return;
        }
      }
      this.data={format:'agent-daily-brain-budget-v1',dayKey,dailyMicros,dailyCalls,requests:[],halted:null,auditEvents:[]};
      this.save();
    }catch(error){this.close();throw error;}
  }
  save(){
    ensure(this.fd!==undefined&&!this.poisoned,'LEDGER_UNAVAILABLE','closed or failed ledger cannot authorize requests');
    try{writeLedgerAtomically(this.path,this.data);}catch(error){this.poisoned=true;throw error;}
  }
  reserve(id,fingerprint,reserveMicros){
    ensure(this.fd!==undefined&&!this.poisoned,'LEDGER_UNAVAILABLE','ledger unavailable');
    ensure(!this.data.halted,'BUDGET_HALTED','daily budget halted; do not auto-resend');
    ensure(typeof id==='string'&&id.length>0&&typeof fingerprint==='string'&&fingerprint.length>0,'REQUEST_ID','nonempty request and fingerprint required');
    ensure(!this.data.requests.some(r=>r.id===id),'ALREADY_REQUESTED','never automatically resend a request id');
    ensure(this.data.requests.length<this.data.dailyCalls,'CALL_LIMIT','daily call limit reached');
    ensure(Number.isSafeInteger(reserveMicros)&&reserveMicros>0,'RESERVE_AMOUNT','positive integer reservation required');
    ensure(usedMicros(this.data.requests)+reserveMicros<=this.data.dailyMicros,'SPEND_LIMIT','daily budget cannot cover this call');
    this.data.requests.push({id,fingerprint,reserveMicros,status:'reserved'});this.save();
  }
  dispatch(id){const r=this.find(id);ensure(r.status==='reserved','REQUEST_STATE','request is not reserved');r.status='dispatched';this.save();}
  release(id){const r=this.find(id);if(r.status==='released')return;ensure(r.status==='reserved','REQUEST_STATE','only unsent reservation can be released');r.status='released';this.save();}
  settle(id,usage){
    ensure(Number.isSafeInteger(usage?.upperMicros)&&usage.upperMicros>=0,'USAGE_AMOUNT','settlement requires nonnegative safe integer amount');
    const r=this.find(id);if(r.status==='settled')return;
    ensure(r.status==='dispatched','REQUEST_STATE','request not dispatched');
    r.status='settled';r.usage=usage;r.actualMicros=usage.upperMicros;
    if(r.actualMicros>r.reserveMicros)this.data.halted='provider usage exceeded conservative reservation';this.save();
    ensure(!this.data.halted,'RESERVATION_OVERRUN','settled usage exceeded reservation; stop');
  }
  uncertain(id,code){const r=this.find(id);if(r.status==='uncertain')return;ensure(r.status==='dispatched','REQUEST_STATE','only dispatched requests can become cost-unknown');r.status='uncertain';r.error=code;this.data.halted='request cost not confirmed; do not auto-retry';this.save();}
  attachOutput(id,output){const r=this.find(id);ensure(r.status==='settled','REQUEST_STATE','only settled requests keep output');r.output=output;this.save();}
  find(id){const r=this.data.requests.find(r=>r.id===id);ensure(r,'REQUEST_STATE','unknown request');return r;}
  tryFind(id){return this.data.requests.find(r=>r.id===id)??null;}
  state(){const rows=this.data.requests;return {dayKey:this.data.dayKey,calls:rows.length,settled:rows.filter(r=>r.status==='settled').length,uncertain:rows.filter(r=>r.status==='uncertain').length,
    costMicros:rows.reduce((sum,r)=>sum+(r.status==='settled'?r.actualMicros:0),0),limitMicros:this.data.dailyMicros,maxCalls:this.data.dailyCalls,halted:this.data.halted};}
  close(){if(this.fd===undefined)return;closeSync(this.fd);this.fd=undefined;try{unlinkSync(this.lock);}catch{}}
}
function textPath(path){ensure(typeof path==='string'&&path.length>0,'TRANSPORT_CONFIG','ledger path required');}
function mkdirIfNeeded(dir){ensure(typeof dir==='string','TRANSPORT_CONFIG','invalid ledger directory');if(!existsSync(dir))mkdirSync(dir,{recursive:true});}

// 默认：专用 key、真实网络预检、json 输出、low 思考、日预算 3 元/96 次。
export function createModelDecision({ledgerPath,getKey=studyKey,transport=fetch,networkCheck=requireStudyNetwork,profile={},dayKey=null,timeoutMs=120000}={}){
  ensure(typeof ledgerPath==='string'&&ledgerPath.length>0,'TRANSPORT_CONFIG','ledger path required');
  const limits={...(dayKey?{dayKey}:{}),...(Number.isSafeInteger(profile.dailyMicros)?{dailyMicros:profile.dailyMicros}:{}),
    ...(Number.isSafeInteger(profile.dailyCalls)?{dailyCalls:profile.dailyCalls}:{})};
  const ledger=new DailyBudgetLedger(ledgerPath,limits);
  const client=new DeepSeekStudyClient({ledger,getKey,transport,networkCheck,maxTokens:profile.maxTokens??3000,timeoutMs,
    outputFormat:'json',reasoning:profile.reasoning??'low',inputVerifier:verifiedModelInput});
  const maintenanceClient=new DeepSeekStudyClient({ledger,getKey,transport,networkCheck,maxTokens:profile.maxTokens??3000,timeoutMs,
    outputFormat:'json',reasoning:profile.reasoning??'low',inputVerifier:packet=>packet});
  const visionClient=new DeepSeekStudyClient({ledger,getKey,transport,networkCheck,maxTokens:500,timeoutMs,
    outputFormat:'text',reasoning:'off',inputVerifier:packet=>packet});
  async function vision({images,question='描述这张图片里实际可见的内容。只描述看得见的，不猜身份和动机。'}={}){
    ensure(Array.isArray(images)&&images.length>0&&images.length<=2,'VISION_INPUT','one or two images required');
    const parts=[{type:'text',text:String(question)}];
    for(const image of images){
      ensure(typeof image?.mimeType==='string'&&/^image\//.test(image.mimeType),'VISION_INPUT','image mime type required');
      ensure(typeof image?.data==='string'&&image.data.length>100,'VISION_INPUT','image data required');
      parts.push({type:'image_url',image_url:{url:`data:${image.mimeType};base64,${image.data}`}});
    }
    const messages=[{role:'user',content:parts}];
    const id=`vision:${digest({images:images.map(i=>digest({mimeType:i.mimeType,data:i.data})),question})}`;
    const existing=ledger.tryFind(id);
    if(existing?.status==='settled'&&typeof existing.output==='string')return existing.output;
    ensure(!existing,'TRANSPORT_REPLAY','vision request already attempted; never auto-resend');
    // 图片按 base64 字节计费会产生不合理的巨额预留；按视觉输入上界 65536 token 保守预留。
    const response=await visionClient.call({id,packet:{packetId:id,messages,bytes:65536}});
    ensure(response.complete===true&&typeof response.output==='string'&&response.output.trim().length>0,'MODEL_INCOMPLETE','vision returned no final text');
    ledger.attachOutput(id,response.output);
    return response.output.trim();
  }
  async function decide(packet){
    const id=`turn:${packet?.packetId}`;
    const existing=ledger.tryFind(id);
    if(existing?.status==='settled'&&typeof existing.output==='string')return existing.output;
    ensure(!existing,'TRANSPORT_REPLAY','request already attempted; never auto-resend');
    const response=await client.call({id,packet});
    ensure(response.complete===true&&typeof response.output==='string'&&response.output.trim().length>0,
      'MODEL_INCOMPLETE','provider returned no final text; recorded without retry');
    ledger.attachOutput(id,response.output);
    return response.output;
  }
  async function invokeMaintenance(input){
    const id=`maintenance:${input.packetId}`;
    const existing=ledger.tryFind(id);
    if(existing?.status==='settled'&&typeof existing.output==='string')return existing.output;
    ensure(!existing,'TRANSPORT_REPLAY','maintenance request already attempted; never auto-resend');
    const response=await maintenanceClient.call({id,packet:{messages:input.messages}});
    ensure(response.complete===true&&typeof response.output==='string'&&response.output.trim().length>0,
      'MODEL_INCOMPLETE','provider returned no final maintenance text; recorded without retry');
    ledger.attachOutput(id,response.output);
    return response.output;
  }
  return {decide,invokeMaintenance,vision,ledger,state:()=>ledger.state(),close:()=>ledger.close()};
}

export const TRANSPORT_RATES=RATES;
