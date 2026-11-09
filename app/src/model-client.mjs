import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {dirname} from 'node:path';
import {lookup as systemLookup} from 'node:dns/promises';
import {canonical,digest,ensure} from './contracts.mjs';
import {verifiedModelInput} from './cognition.mjs';
import {writeLedgerAtomically} from './model-ledger.mjs';

const PUBLIC_API=process.env.DEEPSEEK_API_URL||'https://api.deepseek.com/chat/completions';
const safeNetworkCode=e=>{
  const value=e?.cause?.code??e?.code??e?.name;
  return typeof value==='string'&&/^[A-Za-z0-9_]{1,80}$/.test(value)?value:'NETWORK_ERROR';
};
// Credential-free transport check. A 401 here is EXPECTED, not a key/account check.
// Local DNS is advisory: an authorized proxy can resolve remotely even if local lookup fails.
export async function probeStudyNetwork({transport=fetch,lookup=systemLookup,timeoutMs=6000,signal}={}){
  ensure(Number.isSafeInteger(timeoutMs)&&timeoutMs>=1&&timeoutMs<=20000,'NETWORK_PROBE_LIMIT','bounded public probe timeout');
  let timer,dns;
  try{
    const answer=await Promise.race([lookup('api.deepseek.com'),new Promise((_,reject)=>{
      timer=setTimeout(()=>{const e=new Error('DNS deadline');e.code='DNS_TIMEOUT';reject(e);},timeoutMs);
    })]);dns={ok:true,family:answer.family};
  }catch(e){dns={ok:false,code:safeNetworkCode(e)};}finally{clearTimeout(timer);}
  const base={endpoint:PUBLIC_API,method:'HEAD',dns,credentialsUsed:false,modelRequestsSent:0,
    meaning:'public-transport-only-not-authentication-balance-or-inference'};
  try{
    const response=await transport(PUBLIC_API,{method:'HEAD',redirect:'error',
      signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs)});
    const ok=[200,401,405].includes(response.status);
    const classification=response.status===401?'reachable-authentication-required':response.status===405?'reachable-head-not-supported':
      response.status===200?'reachable-public-response':response.status===403?'public-endpoint-forbidden':response.status===429?'public-endpoint-rate-limited':
        response.status>=500?'public-service-unavailable':'unexpected-public-http';
    // No response body, balance amounts, browser credentials or API key are read.
    try{await response.body?.cancel();}catch{}
    return {...base,ok,httpStatus:response.status,classification};
  }catch(e){return {...base,ok:false,httpStatus:null,classification:'network-unavailable',safeCode:safeNetworkCode(e)};}
}
export async function requireStudyNetwork(options={}){
  const result=await probeStudyNetwork(options);
  ensure(result.ok,'NETWORK_PREFLIGHT_FAILED','Public connectivity check failed; no inference or budget reservation was made',
    {classification:result.classification,code:result.safeCode??null,httpStatus:result.httpStatus,dns:result.dns});
  return result;
}

// Official peak rates, CNY per 1M tokens, checked 2026-11-02.
export const RATES=Object.freeze({hit:0.04,miss:2,output:8,source:'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'});
export function pricedUsage(u) {
  const values=[u?.prompt_tokens,u?.completion_tokens,u?.prompt_cache_hit_tokens,u?.prompt_cache_miss_tokens];
  ensure(values.every(v=>Number.isSafeInteger(v)&&v>=0)&&values[2]+values[3]===values[0], 'UNKNOWN_USAGE','complete consistent provider usage required');
  return {prompt:values[0],completion:values[1],hit:values[2],miss:values[3],
    reasoning:Number.isSafeInteger(u.completion_tokens_details?.reasoning_tokens)?u.completion_tokens_details.reasoning_tokens:null,
    upperMicros:Math.ceil(values[2]*RATES.hit+values[3]*RATES.miss+values[1]*RATES.output)};
}

// The default remains the legacy JSON contract. Reading experiments can explicitly
// select text without silently inheriting a contradictory JSON-only API setting.
export function buildStudyRequest(messages,{maxTokens=6000,outputFormat='json',reasoning='high'}={}) {
  ensure(Number.isSafeInteger(maxTokens)&&maxTokens>0&&maxTokens<=6000,'OUTPUT_LIMIT','bounded model output required');
  ensure(['json','text'].includes(outputFormat),'OUTPUT_FORMAT','explicit JSON or text output required');
  ensure(['high','low','off'].includes(reasoning),'REASONING_CONFIG','explicit high, low or off configuration required');
  return {model:process.env.DEEPSEEK_MODEL||'deepseek-flash',thinking:{type:reasoning==='off'?'disabled':'enabled'},...(reasoning==='off'?{}:{reasoning_effort:reasoning}),
    ...(outputFormat==='json'?{response_format:{type:'json_object'}}:{}),stream:false,max_tokens:maxTokens,messages};
}

export class StudyLedger {
  constructor(path,{limitMicros=1000000,maxCalls=24,continueHoldingUncertain=false}={}) {
    ensure(Number.isSafeInteger(limitMicros)&&limitMicros>0&&limitMicros<=1000000&&Number.isSafeInteger(maxCalls)&&maxCalls>0&&maxCalls<=24,'BUDGET_POLICY','study ceiling may only be reduced');
    this.path=path;this.lock=`${path}.lock`;mkdirSync(dirname(path),{recursive:true});
    try{this.fd=openSync(this.lock,'wx');}catch{ensure(false,'LEDGER_LOCKED','another study run or unclosed lock exists; do not auto-resend');}
    try{
      this.data=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{format:'jingyang-model-study-budget-v1',limitMicros,maxCalls,requests:[],halted:null};
      ensure(this.data.format==='jingyang-model-study-budget-v1'&&this.data.limitMicros===limitMicros&&this.data.maxCalls===maxCalls,'BUDGET_POLICY','persistent policy mismatch');
      if(continueHoldingUncertain){
        const uncertain=this.data.requests.filter(r=>r.status==='uncertain');
        ensure(uncertain.length>0&&this.data.halted==='request cost not confirmed; do not auto-retry'
          && !this.data.requests.some(r=>['reserved','dispatched'].includes(r.status)),'UNCERTAIN_POLICY','only explicitly acknowledged uncertain holds may be quarantined');
        for(const r of uncertain)r.status='held-uncertain';
        (this.data.auditEvents??=[]).push({operation:'continue-with-full-uncertain-reserves',requestIds:uncertain.map(r=>r.id),noResend:true});
        this.data.halted=null;
      }
      ensure(!this.data.halted&&!this.data.requests.some(r=>['reserved','dispatched','uncertain'].includes(r.status)),'UNCERTAIN_SPEND','unfinished request blocks automatic continuation');
      this.save();
    }catch(e){this.close();throw e;}
  }
  save(){
    ensure(this.fd!==undefined&&!this.poisoned,'LEDGER_UNAVAILABLE','closed or failed ledger cannot authorize requests');
    try{writeLedgerAtomically(this.path,this.data);}catch(error){this.poisoned=true;throw error;}
  }
  reserve(id,fingerprint,reserveMicros) {
    ensure(this.fd!==undefined&&!this.poisoned,'LEDGER_UNAVAILABLE','closed or failed ledger cannot authorize requests');
    ensure(!this.data.halted,'STUDY_HALTED','study halted');
    ensure(typeof id==='string'&&id.length>0&&typeof fingerprint==='string'&&fingerprint.length>0,'REQUEST_ID','nonempty request and fingerprint required');
    ensure(!this.data.requests.some(r=>r.id===id),'ALREADY_REQUESTED','never automatically resend a study id');
    ensure(this.data.requests.length<this.data.maxCalls,'CALL_LIMIT','attempt limit counts released reservations too');
    const used=this.data.requests.reduce((sum,r)=>sum+(r.status==='settled'?r.actualMicros:r.status==='released'?0:r.reserveMicros),0);
    ensure(Number.isSafeInteger(reserveMicros)&&reserveMicros>0&&used+reserveMicros<=this.data.limitMicros,'SPEND_LIMIT','cannot reserve within study limit');
    this.data.requests.push({id,fingerprint,reserveMicros,status:'reserved'});this.save();
  }
  dispatch(id){ensure(this.fd!==undefined&&!this.poisoned,'LEDGER_UNAVAILABLE','ledger unavailable');const r=this.find(id);ensure(r.status==='reserved','REQUEST_STATE','request is not reserved');r.status='dispatched';this.save();}
  release(id){ensure(this.fd!==undefined&&!this.poisoned,'LEDGER_UNAVAILABLE','ledger unavailable');const r=this.find(id);if(r.status==='released')return;ensure(r.status==='reserved','REQUEST_STATE','only unsent reservation can be released');r.status='released';this.save();}
  settle(id,usage){
    ensure(this.fd!==undefined&&!this.poisoned,'LEDGER_UNAVAILABLE','ledger unavailable');
    ensure(Number.isSafeInteger(usage?.upperMicros)&&usage.upperMicros>=0,'USAGE_AMOUNT','settlement requires a nonnegative safe integer amount');
    const r=this.find(id);
    if(r.status==='settled'){ensure(canonical(r.usage)===canonical(usage),'SETTLEMENT_CONFLICT','cannot replace an already accounted receipt');return;}
    ensure(r.status==='dispatched','REQUEST_STATE','request not dispatched');r.status='settled';r.usage=usage;r.actualMicros=usage.upperMicros;
    if(r.actualMicros>r.reserveMicros)this.data.halted='provider usage exceeded conservative reservation';this.save();
    ensure(!this.data.halted,'RESERVATION_OVERRUN','settled usage exceeded reservation; stop');}
  uncertain(id,code){ensure(this.fd!==undefined&&!this.poisoned,'LEDGER_UNAVAILABLE','ledger unavailable');const r=this.find(id);if(r.status==='uncertain')return;ensure(r.status==='dispatched','REQUEST_STATE','only dispatched requests can become cost-unknown');r.status='uncertain';r.error=code;this.data.halted='request cost not confirmed; do not auto-retry';this.save();}
  recordUnsentMonitorStop(id,phase){
    ensure(this.fd!==undefined&&!this.poisoned,'LEDGER_UNAVAILABLE','ledger unavailable');
    ensure(['before-dispatch','before-transport'].includes(phase),'REQUEST_STATE','known pre-transport monitor failure required');
    const r=this.find(id);
    ensure(r.status===(phase==='before-dispatch'?'reserved':'dispatched'),'REQUEST_STATE','reservation stage does not match unsent stop');
    // Keep the status and full reservation. A local dispatch registration is not a send.
    r.error='MONITOR_REQUIRED_UNAVAILABLE';r.transportInvoked=false;r.stopPhase=phase;
    this.data.halted='mandatory monitor failed before transport; full reservation retained; do not auto-retry';
    this.save();
  }
  find(id){const r=this.data.requests.find(r=>r.id===id);ensure(r,'REQUEST_STATE','unknown request');return r;}
  close(){if(this.fd!==undefined){closeSync(this.fd);this.fd=undefined;unlinkSync(this.lock);}}
}

export class DeepSeekStudyClient {
  constructor({ledger,getKey,transport=fetch,maxTokens=6000,timeoutMs=120000,outputFormat='json',reasoning='high',inputVerifier=verifiedModelInput,monitor=null,requireMonitor=false,
    networkCheck=transport===fetch?requireStudyNetwork:async()=>({ok:true,classification:'explicitly-injected-transport'})}={}) {
    ensure(Number.isSafeInteger(maxTokens)&&maxTokens>0&&maxTokens<=6000,'OUTPUT_LIMIT','bounded model output required');
    ensure(typeof inputVerifier==='function','INPUT_VERIFIER','explicit packet verifier required');
    ensure(typeof networkCheck==='function','NETWORK_PREFLIGHT_REQUIRED','explicit network preflight function required');
    ensure(['json','text'].includes(outputFormat),'OUTPUT_FORMAT','explicit JSON or text output required');
    ensure(['high','low','off'].includes(reasoning),'REASONING_CONFIG','explicit high, low or off configuration required');
    ensure(monitor===null||typeof monitor.start==='function','MONITOR_CONFIG','optional explicit local monitor required');
    ensure(typeof requireMonitor==='boolean'&&(!requireMonitor||monitor!==null),'MONITOR_CONFIG','mandatory recording requires an explicit monitor');
    ensure(!requireMonitor||typeof ledger?.recordUnsentMonitorStop==='function','LEDGER_CONFIG','mandatory recording requires unsent-stop ledger support');
    Object.assign(this,{ledger,getKey,transport,maxTokens,timeoutMs,outputFormat,reasoning,inputVerifier,networkCheck,monitor,requireMonitor});
  }
  async call({id,packet,signal,expectedRequestFingerprint=null}) {
    const input=this.inputVerifier(packet);
    ensure(!signal?.aborted,'CANCELLED','cancelled before preflight, credentials or reservation');
    const request=buildStudyRequest(input.messages,{maxTokens:this.maxTokens,outputFormat:this.outputFormat,reasoning:this.reasoning});
    ensure(expectedRequestFingerprint===null||typeof expectedRequestFingerprint==='string'&&/^[a-f0-9]{64}$/.test(expectedRequestFingerprint)
      &&digest(request)===expectedRequestFingerprint,'REQUEST_FINGERPRINT','actual request differs from frozen configuration; nothing sent');
    const trace=this.monitor?.start({id,packet,request});
    let transportInvoked=false,monitorStopPhase=null;
    const requireTrace=phase=>{
      if(!this.requireMonitor)return;
      const state=trace?.summary?.();
      if(state?.status!=='recorded-so-far'||!(state.events>0))monitorStopPhase=phase;
      ensure(state?.status==='recorded-so-far'&&state.events>0,'MONITOR_REQUIRED_UNAVAILABLE',
        'mandatory trace is unavailable before transport; no inference may be sent',{phase});
    };
    try {
    requireTrace('startup');
    trace?.record('network.preflight.started');
    const network=await this.networkCheck({signal});
    trace?.record('network.preflight.completed',{status:network?.ok===true?'ok':'failed',classification:network?.classification??null});
    ensure(network?.ok===true,'NETWORK_PREFLIGHT_FAILED','Network preflight did not confirm transport; no inference was reserved');
    ensure(!signal?.aborted,'CANCELLED','cancelled during preflight before credentials or reservation');
    requireTrace('before-credentials');
    const key=this.getKey();
    ensure(typeof key==='string'&&/^sk-[A-Za-z0-9_-]{12,}$/.test(key),'MISSING_CREDENTIAL','existing credential unavailable');
    const reserveMicros=Math.ceil((input.bytes+4096)*RATES.miss+this.maxTokens*RATES.output);
    requireTrace('before-reserve');
    this.ledger.reserve(id,digest(request),reserveMicros);
    trace?.record('budget.reserved',{reserveMicros});
    if(signal?.aborted){this.ledger.release(id);ensure(false,'CANCELLED','cancelled before dispatch');}
    requireTrace('before-dispatch');
    this.ledger.dispatch(id);const started=performance.now(),startedAt=new Date().toISOString();let accounted=false;
    trace?.record('request.dispatch-registered',{status:'local-registration-not-confirmed-remote-execution'});
    try {
      requireTrace('before-transport');
      transportInvoked=true;
      const response=await this.transport(PUBLIC_API,{method:'POST',redirect:'error',
        headers:{'content-type':'application/json',authorization:`Bearer ${key}`},body:JSON.stringify(request),
        signal:signal?AbortSignal.any([signal,AbortSignal.timeout(this.timeoutMs)]):AbortSignal.timeout(this.timeoutMs)});
      trace?.record('transport.response',{httpStatus:response.status});
      ensure(response.ok,'PROVIDER_HTTP',`provider returned HTTP ${response.status}`,{httpStatus:response.status});
      const reader=response.body.getReader(),parts=[];let length=0;
      try{while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;
        ensure(length<=1024*1024,'RESPONSE_LIMIT','bounded provider response required');parts.push(Buffer.from(value));}}
      finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
      let body;try{body=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{ensure(false,'PROVIDER_JSON','provider response was not JSON');}
      trace?.parsed(body);
      const usage=pricedUsage(body.usage);this.ledger.settle(id,usage);accounted=true;
      trace?.record('budget.settled',{usage,status:'settled'});
      const choice=body.choices?.[0],content=choice?.message?.content;
      const complete=choice?.finish_reason==='stop'&&typeof content==='string'&&content.trim().length>0;
      trace?.record('call.completed',{complete,finishReason:choice?.finish_reason??null,latencyMs:Math.round(performance.now()-started)});
      return {id,packetId:input.packetId,model:body.model??request.model,finishReason:choice?.finish_reason??null,
        reportedModel:typeof body.model==='string'?body.model:null,providerResponseId:typeof body.id==='string'?body.id:null,
        providerCreated:Number.isSafeInteger(body.created)?body.created:null,startedAt,completedAt:new Date().toISOString(),
        output:typeof content==='string'?content:'',usage,latencyMs:Math.round(performance.now()-started),
        transportOk:true,complete,...(trace?{monitor:trace.summary()}: {})};
      // Provider reasoning is kept only in an explicitly enabled local sidecar, never in the public output.
    }catch(error){
      if(!transportInvoked)throw error;
      if(this.ledger.find(id).status==='settled')accounted=true;
      if(!accounted){
        this.ledger.uncertain(id,error.cause?.code??error.code??'NETWORK_OR_PROVIDER_ERROR');
        if(Number.isInteger(error.details?.httpStatus)) {this.ledger.find(id).httpStatus=error.details.httpStatus;this.ledger.save();}
      }
      const safe=new Error(accounted?'provider response unusable after accounting':'request outcome/cost uncertain; stopped without retry');
      safe.code=accounted?(error.code??'PROVIDER_OUTPUT'):'UNCERTAIN_REQUEST';throw safe;}
    }catch(error){
      if(this.requireMonitor&&!transportInvoked&&monitorStopPhase
        &&this.ledger.data.requests.some(r=>r.id===id&&['reserved','dispatched'].includes(r.status))){
        // A separate ledger write may itself fail. Keep the original stop and expose that gap;
        // never retry, release the hold, or claim that the reason reached durable storage.
        try{this.ledger.recordUnsentMonitorStop(id,monitorStopPhase);error.ledgerStopRecording='recorded';}
        catch(recordError){error.ledgerStopRecording='failed';error.ledgerStopError=safeNetworkCode(recordError);}
      }
      trace?.record('call.failed',{errorCode:typeof error.code==='string'?error.code:'CALL_FAILED',
        costStatus:this.ledger.data.requests.find(r=>r.id===id)?.status??'not-reserved'});
      if(trace)error.monitor=trace.summary();
      if(this.requireMonitor)error.transportInvoked=transportInvoked;
      throw error;
    }
  }
}
