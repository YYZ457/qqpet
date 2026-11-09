// 纯 QQ 传输连接器：标准 OneBot v11（WebSocket 收事件）↔ 新脑 /v1/reply。
// 这里没有角色卡、记忆、社交决策、主动策略；只做消息搬运。不依赖任何具体 OneBot 实现的代码。
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import WebSocket from 'ws';
import {executeTool,onebotCall} from './tools.mjs';
import {segmentsText} from '../../src/qq-segments.mjs';
import {dataDir,resolveOneBot} from './onebot-config.mjs';

const brainUrl=process.env.BRAIN_URL??'http://127.0.0.1:8787';
const brainToken=process.env.BRAIN_TOKEN??'';
const log=(...args)=>console.log(new Date().toISOString(),...args);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const headers=()=>({'content-type':'application/json',...(brainToken?{'x-brain-token':brainToken}:{})});

// 状态文件给控制台显示“QQ 接上了没有”
const statusFile=dataDir()?join(dataDir(),'ops','qq-status.json'):null;
const status={connected:false,since:null,url:null,source:null,selfId:null,nickname:null,lastError:null,lastMessageAt:null,updatedAt:null};
function saveStatus(patch={}){
  Object.assign(status,patch,{updatedAt:Date.now()});
  if(!statusFile)return;
  try{mkdirSync(join(dataDir(),'ops'),{recursive:true});writeFileSync(statusFile,JSON.stringify(status),'utf8');}catch{}
}

// 只取文字；图片/表情等记成占位，避免空消息被丢弃后她“看不见有人说话”
async function forwardObservation(event){
  const forwards=Array.isArray(event.message)?event.message.filter(s=>s?.type==='forward').slice(0,2):[];
  if(!forwards.length)return '';
  const blocks=[];
  for(let i=0;i<forwards.length;i++){
    const id=forwards[i]?.data?.id;
    if(!id){blocks.push(`[转发内容${i+1}：缺少内容ID]`);continue;}
    try{
      const data=await onebotCall('get_forward_msg',{id:String(id)});
      const messages=Array.isArray(data?.messages)?data.messages:[];
      const lines=messages.slice(0,20).map(m=>{
        const who=m.sender?.card||m.sender?.nickname||m.sender?.user_id||'某人';
        const body=segmentsText(Array.isArray(m.message)?m.message:[]);
        return body?`${who}：${body}`:'';
      }).filter(Boolean);
      blocks.push(lines.length?`[转发内容${i+1}：${lines.join(' / ').slice(0,1200)}]`:`[转发内容${i+1}：空]`);
    }catch(error){blocks.push(`[转发内容${i+1}：读取失败]`);}
  }
  return '\n'+blocks.join('\n');
}

function messageText(event){
  const segs=Array.isArray(event.message)?event.message:null;
  if(!segs)return String(event.raw_message??(typeof event.message==='string'?event.message:'')).trim();
  return segmentsText(segs);
}const seen=new Set();
function once(id){if(seen.has(id))return false;seen.add(id);if(seen.size>500){seen.delete(seen.values().next().value);}return true;}

const MAX_IMAGE_BYTES=4*1024*1024;
function base64From(value){
  const s=String(value??'');
  if(!s)return null;
  if(s.startsWith('base64://'))return s.slice('base64://'.length);
  if(s.startsWith('data:')){const i=s.indexOf(',');return i>=0?s.slice(i+1):null;}
  return null;
}
function mimeOf(buf,fallback='image/jpeg'){
  if(buf?.[0]===0x89&&buf?.[1]===0x50)return 'image/png';
  if(buf?.[0]===0xFF&&buf?.[1]===0xD8)return 'image/jpeg';
  if(buf?.[0]===0x47&&buf?.[1]===0x49)return 'image/gif';
  if(buf?.[0]===0x52&&buf?.[1]===0x49&&buf?.[8]===0x57)return 'image/webp';
  return fallback;
}
async function fetchImageBytes(seg){
  const d=seg?.data??{};
  const direct=base64From(d.file)??base64From(d.url);
  if(direct){const buf=Buffer.from(direct,'base64');return buf.length&&buf.length<=MAX_IMAGE_BYTES?{buf,mimeType:mimeOf(buf)}:null;}
  if(/^https?:\/\//i.test(String(d.url??''))){try{const r=await fetch(d.url);if(!r.ok)return null;const buf=Buffer.from(await r.arrayBuffer());return buf.length&&buf.length<=MAX_IMAGE_BYTES?{buf,mimeType:r.headers.get('content-type')||mimeOf(buf)}:null;}catch{return null;}}
  if(d.file){
    try{const info=await onebotCall('get_image',{file:String(d.file)});
      const b64=base64From(info?.data)??base64From(info?.base64)??base64From(info?.file);
      if(b64){const buf=Buffer.from(b64,'base64');return buf.length&&buf.length<=MAX_IMAGE_BYTES?{buf,mimeType:mimeOf(buf)}:null;}
      if(info?.url){const r=await fetch(info.url);if(r.ok){const buf=Buffer.from(await r.arrayBuffer());return buf.length&&buf.length<=MAX_IMAGE_BYTES?{buf,mimeType:mimeOf(buf)}:null;}}
      if(typeof info?.file==='string'&&existsSync(info.file)){const buf=readFileSync(info.file);return buf.length&&buf.length<=MAX_IMAGE_BYTES?{buf,mimeType:mimeOf(buf)}:null;}
    }catch{}
  }
  return null;
}
async function imageObservation(event){
  const segs=Array.isArray(event.message)?event.message.filter(s=>s?.type==='image').slice(0,2):[];
  if(!segs.length)return '';
  const images=[];
  for(const seg of segs){const got=await fetchImageBytes(seg);if(got)images.push({mimeType:got.mimeType,data:got.buf.toString('base64')});}
  if(!images.length)return '\n[图片：读取失败，没看到画面]';
  try{
    const r=await fetch(`${brainUrl}/v1/vision`,{method:'POST',headers:headers(),body:JSON.stringify({images,question:'客观描述图片里实际可见的内容。只描述看见的，不猜身份、动机或没出现的细节。中文，简短。'})});
    if(!r.ok)throw new Error(`vision ${r.status}`);
    const v=await r.json();const text=String(v.text??'').trim();
    return text?`\n[图片内容：${text.slice(0,1200)}]`:'\n[图片：没有识别出可读内容]';
  }catch(error){log('vision-error',error.message);return '\n[图片：读取失败，没看到画面]';}
}

async function markDelivered(item,outcome='sent',body='QQ发送成功',parts=null){
  if(!item?.response)return;
  try{await fetch(`${brainUrl}/v1/response/delivered`,{method:'POST',headers:headers(),body:JSON.stringify({response:item.response,outcome,body,...(parts?{parts}:{})})});}catch{}
}
async function sendTo(targetScene,text){
  const [target,id]=targetScene.startsWith('qq/group/')?['group',targetScene.slice('qq/group/'.length)]:['private',targetScene.slice('qq/private/'.length)];
  return executeTool('qq_send_message',{target,id,text});
}
function utteranceList(item){
  if(Array.isArray(item?.utterances)&&item.utterances.length)return item.utterances.slice(0,4);
  return [{text:item?.text??'',delayMs:0}];
}
async function sendUtterances(targetScene,item){
  const parts=utteranceList(item),results=[];
  let last=null;
  for(let i=0;i<parts.length;i++){
    if(!parts[i]?.text)continue;
    try{
      last=await sendTo(targetScene,parts[i].text);
      results.push({index:i,text:parts[i].text,status:'sent'});
    }catch(error){
      results.push({index:i,text:parts[i].text,status:'failed',error:error.message});
      const failed=new Error(error.message);failed.parts=results;throw failed;
    }
    if(i<parts.length-1)await sleep(parts[i+1]?.delayMs??450);
  }
  return {last,parts:results};
}
async function deliverInitial(result,scene,event){
  const responses=Array.isArray(result.outbox)?result.outbox.filter(o=>o.kind==='respond'):[];
  for(const item of responses){
    const targetScene=item.scene??scene;
    if(!targetScene.startsWith('qq/'))continue;
    try{const delivery=await sendUtterances(targetScene,item);await markDelivered(item,'sent','QQ发送成功',delivery.parts);}
    catch(error){await markDelivered(item,'failed',error.message,error.parts??null);throw error;}
  }
  let acted=false;
  for(const act of result.outbox??[]){
    if(act.kind!=='act')continue;
    acted=true;
    // 本地记忆动作由脑执行；bridge 只跳过，不重复写。
    if(act.tool==='remember_note'||act.tool==='remember-binding')continue;
    let state='succeeded',body='';
    try{body=JSON.stringify(await executeTool(act.tool,act.args??{}));}
    catch(error){state='failed';body=error.message;}
    await fetch(`${brainUrl}/v1/receipt`,{method:'POST',headers:headers(),
      body:JSON.stringify({scene,action:act.action,status:state,body,eventId:`tool:${act.action.id}:${event.message_id??Date.now()}`,actor:'qq-host'})});
  }
  return acted;
}
async function handle(event){
  consumeIncoming(event);
  const text=messageText(event);if(!text)return;
  const privateChat=event.message_type==='private';
  const scene=privateChat?`qq/private/${event.user_id}`:`qq/group/${event.group_id}`;
  const key=privateChat?`private:${event.user_id}`:`group:${event.group_id}`;
  if(!once(`${scene}:${event.message_id}`))return;
  const imageText=await imageObservation(event);
  const forwardText=await forwardObservation(event);
  const sender={system:'qq',id:String(event.user_id),name:String(event.sender?.card||event.sender?.nickname||event.user_id),nickname:event.sender?.nickname?String(event.sender.nickname):null,isOwner:Boolean(process.env.QQ_OWNER&&String(event.user_id)===String(process.env.QQ_OWNER))};
  const occurredAt=Number.isFinite(Number(event.time))?Number(event.time)*1000:null;
  saveStatus({lastMessageAt:Date.now()});
  const response=await fetch(`${brainUrl}/v1/reply`,{method:'POST',headers:headers(),
    body:JSON.stringify({protocol:'agent-brain-bridge-v1',key,scene,message_id:event.message_id,execute:false,sender,occurredAt,messages:[{role:'user',content:text+imageText+forwardText}]})});
  if(!response.ok)throw new Error(`brain ${response.status} ${await response.text()}`);
  let result=await response.json();
  if(result.error)throw new Error(`brain ${result.error}: ${result.message??''}`);
  let acted=await deliverInitial(result,scene,event);
  // 工具回执/本地记忆回执已入箱：不要等 5 秒心跳，直接允许她连续走下一轮。
  // 续轮由脑的 adapter 直接发 QQ；bridge 不再重复发送，只处理新动作。
  for(let step=0;acted&&step<6;step++){
    // 新消息不一定都该打断任务。
    // 现在只让 owner 的新消息优先；群友/普通来源排到当前动作步骤之后。
    if(pendingOwners>0)break;
    const r=await fetch(`${brainUrl}/v1/turn`,{method:'POST',headers:headers(),body:JSON.stringify({deliver:true,execute:true})});
    if(!r.ok)break;
    const next=await r.json();
    if(next.error||next.busy||next.deferred)break;
    result=next;
    acted=Array.isArray(next.outbox)&&next.outbox.some(o=>o.kind==='act');
    if(!acted)break;
  }
  log(privateChat?'private':'group',scene,'in',text.length,'out',result.text?result.text.length:0,'silent',result.silent===true);
}

// 消息串行处理：同一时刻只服务一条，和脑的串行一致
let chain=Promise.resolve();
let pendingOwners=0;
function isOwnerEvent(event){return Boolean(process.env.QQ_OWNER&&String(event?.user_id)===String(process.env.QQ_OWNER));}
function consumeIncoming(event){if(isOwnerEvent(event))pendingOwners=Math.max(0,pendingOwners-1);}
function onEvent(raw){
  let event;try{event=JSON.parse(String(raw));}catch{return;}
  if(event?.self_id&&!status.selfId)saveStatus({selfId:event.self_id});
  if(event?.post_type!=='message'||!['private','group'].includes(event.message_type))return;
  if(status.selfId&&String(event.user_id)===String(status.selfId))return; // 自己发的不当作别人说话
  if(isOwnerEvent(event))pendingOwners++;
  chain=chain.then(()=>handle(event)).catch(error=>{log('handle-error',error.message);saveStatus({lastError:error.message});});
}

async function connectOnce(){
  const cfg=resolveOneBot();
  const url=cfg.ws+(cfg.wsToken?(cfg.ws.includes('?')?'&':'?')+'access_token='+encodeURIComponent(cfg.wsToken):'');
  await new Promise(resolve=>{
    const socket=new WebSocket(url,{headers:cfg.wsToken?{authorization:`Bearer ${cfg.wsToken}`}:{},handshakeTimeout:8000});
    let alive=true,beat=null,opened=false;
    const finish=reason=>{if(beat)clearInterval(beat);if(opened)log('disconnected',reason);saveStatus({connected:false,lastError:opened?`连接断开：${reason}`:status.lastError});try{socket.terminate();}catch{}resolve(opened);};
    socket.on('open',async()=>{
      opened=true;alive=true;
      saveStatus({connected:true,since:Date.now(),url:cfg.ws,source:cfg.source,lastError:null});
      log('connected',cfg.ws,`(config: ${cfg.source})`);
      try{const me=await onebotCall('get_login_info');saveStatus({selfId:me.user_id,nickname:me.nickname});log('login',me.user_id,me.nickname);}catch(error){log('get_login_info failed',error.message);}
      beat=setInterval(()=>{if(!alive)return finish('心跳超时');alive=false;try{socket.ping();}catch{}},30000);
    });
    socket.on('pong',()=>{alive=true;});
    socket.on('message',data=>{alive=true;onEvent(data);});
    socket.on('error',error=>{if(!opened)saveStatus({connected:false,lastError:`连不上 ${cfg.ws}：${error.code??error.message}`,url:cfg.ws,source:cfg.source});});
    socket.on('close',(code)=>finish(`code ${code}`));
  });
}

saveStatus({connected:false});
log('qq-connect started; brain',brainUrl);
let delay=3000,quiet=0;
for(;;){
  const wasOpen=await connectOnce().catch(()=>false);
  delay=wasOpen?3000:Math.min(60000,Math.round(delay*1.6));
  // 没接上时日志只偶尔提醒，避免刷屏
  if(!wasOpen&&quiet++%10===0)log('等待 QQ 传输（OneBot）…',resolveOneBot().ws,status.lastError??'');
  await sleep(delay);
}
