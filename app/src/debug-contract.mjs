import {canonical,digest,ensure} from './contracts.mjs';

const identifier=x=>typeof x==='string'&&x.length?x.length<=240?x:`sha256:${digest(x)}`:null;
const contexts=['subjectId','decisionId','packetId','eventId','workspaceId','jobId','requestId'];
const attributes=new Set(['schemaStage','bytes','budgetBytes','selectedKind','changeCount','outputBytes','outputHash','durationMs','errorCode','errorSite',
  'operations','writes','attemptedWrites','writeCount','source','modelCalled','snapshot','reason','status','httpStatus','requiredMaterials']);
const denied=/^(api[_-]?key|authorization|access[_-]?token|password|secret|reasoning(_content)?|chain_of_thought|analysis)$/i;
const safe=(x,depth=0)=>{
  ensure(depth<=8,'DEBUG_LIMIT','diagnostic metadata too deep');
  if(x===null||typeof x==='boolean'||typeof x==='number')return x;
  if(typeof x==='string')return x.length<=400?x:`sha256:${digest(x)}`;
  if(Array.isArray(x))return x.slice(0,128).map(v=>safe(v,depth+1));
  ensure(x&&Object.getPrototypeOf(x)===Object.prototype,'DEBUG_SHAPE','plain metadata required');
  return Object.fromEntries(Object.entries(x).filter(([k])=>!denied.test(k)).slice(0,32).map(([k,v])=>[k,safe(v,depth+1)]));
};
export function debugContext(value={}){return Object.fromEntries(contexts.map(k=>[k,identifier(value?.[k])]));}
export function diagnostic({stage,status,context={},data={}}){
  ensure(typeof stage==='string'&&/^[a-z][a-z0-9.-]{0,79}$/.test(stage),'DEBUG_SHAPE','bounded diagnostic stage required');
  ensure(['ok','started','completed','rejected','uncertain','replayed'].includes(status),'DEBUG_SHAPE','known diagnostic status required');
  ensure(data&&Object.getPrototypeOf(data)===Object.prototype,'DEBUG_SHAPE','diagnostic attributes required');
  for(const key of Object.keys(data))ensure(attributes.has(key),'DEBUG_SHAPE','diagnostic field is not in the metadata contract');
  const entry={stage,status,context:debugContext(context),data:safe(data)};
  ensure(Buffer.byteLength(canonical(entry))<=16384,'DEBUG_LIMIT','diagnostic entry exceeds 16KiB');return entry;
}
export function failureMetadata(error,{client=false}={}){
  try{
  const known=client?'MODEL_CLIENT_ERROR':typeof error?.code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(error.code)?error.code:'INTERNAL_ERROR';
  const matches=client?[]:[...(String(error?.stack??'').matchAll(/[/\\](src|scripts)[/\\]([^/\\\s:)]+\.mjs):(\d+):(\d+)/g))].slice(0,3);
  const status=error?.status??error?.statusCode;
  return {errorCode:known,errorSite:matches.map(m=>({file:`${m[1]}/${m[2]}`,line:Number(m[3]),column:Number(m[4])})),
    ...(client&&Number.isSafeInteger(status)&&status>=100&&status<=599?{httpStatus:status}:{})};
  }catch{return {errorCode:client?'MODEL_CLIENT_ERROR':'INTERNAL_ERROR',errorSite:[]};}
}
export function transactionContext({requestId,commands}={}){
  const context={requestId},ops=Array.isArray(commands)?commands:[];
  for(const c of ops){
    if(!c||typeof c!=='object')continue;
    const input=c.input?.payload??c.packet?.payload;
    context.subjectId??=c.subjectId??c.subject?.id??input?.continuity?.subject?.id??input?.subject?.id;
    context.packetId??=c.input?.packetId??c.packet?.packetId;
    context.decisionId??=c.decisionId??c.decision?.id??(c.op==='record_decision'?c.id:null);
    context.eventId??=c.currentEvent?.id??c.event?.id;
    context.workspaceId??=c.workspace?.id??input?.workspace?.id;
    context.jobId??=c.job?.id;
  }
  return debugContext(context);
}
export const debugRef=r=>({id:identifier(r.id),revision:r.revision,type:r.type});
export function packetContext(packet,extra={}){return {subjectId:packet?.payload?.continuity?.subject?.id??packet?.payload?.subject?.id,
  packetId:packet?.packetId,eventId:packet?.payload?.current?.id,workspaceId:packet?.payload?.workspace?.id,...extra};}
export function outputMetrics(value){
  try{
    const final=typeof value==='string'?value:Object.fromEntries(['packetId','options','selected','summary','used','continuity','disposition','changes','attention','noteUpdates','observations','requests'].filter(k=>value&&Object.hasOwn(value,k)).map(k=>[k,value[k]]));
    const raw=typeof final==='string'?final:canonical(final);return {outputBytes:Buffer.byteLength(raw),outputHash:digest(raw),source:typeof value==='string'?'client-final-text':'public-final-projection'};
  }catch{return {outputBytes:null,outputHash:null};}
}
