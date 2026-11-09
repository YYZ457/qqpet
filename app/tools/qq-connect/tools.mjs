// 新 QQ 能力宿主：直接走 OneBot HTTP，不经过旧 bridge。
// 只执行显式工具调用；没有角色卡、记忆、社交决策。
import {readFileSync,writeFileSync,readdirSync,existsSync,statSync,mkdirSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolveOneBot} from './onebot-config.mjs';
import {listOffice,readOffice,writeOffice,editOffice,searchOffice,officeStatus,runOffice,runNpm} from '../../src/office.mjs';
import {listPlugins,runPlugin,installPlugin} from '../../src/plugins.mjs';
import {createGitHubClient,githubConfig} from '../../src/github.mjs';

const PROJECT=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const STICKERS=process.env.QQ_STICKERS_FILE??resolve(PROJECT,'_local/migrate/stickers.json');
const BRAIN_URL=process.env.BRAIN_URL??'http://127.0.0.1:8787';
const BRAIN_TOKEN=process.env.BRAIN_TOKEN??'';

async function githubTool(op,args={}){
  const config=githubConfig();
  if(op==='status')return {configured:config.configured,writable:config.writable,owner:config.owner,repo:config.repo,secret:config.secretPath};
  if(!config.configured)throw new Error('github owner/repo not configured');
  const gh=createGitHubClient(config);
  if(op==='repo')return gh.repoInfo();
  if(op==='issues')return gh.issues({state:args.state,limit:args.limit});
  if(op==='issue')return gh.issue(args.number);
  if(op==='pulls')return gh.pulls({state:args.state,limit:args.limit});
  if(op==='branches')return gh.branches(args.limit);
  if(op==='create_branch')return gh.createBranch(args.branch,{from:args.from??'main'});
  if(op==='put_file')return gh.putFile({branch:args.branch,path:args.path,content:args.content,message:args.message});
  if(op==='create_pr')return gh.createPull({title:args.title,body:args.body??'',head:args.head,base:args.base??'main'});
  throw new Error(`unknown github op: ${op}`);
}async function call(action,params={}){
  const cfg=resolveOneBot();
  const r=await fetch(`${cfg.http}/${action}`,{method:'POST',headers:{'content-type':'application/json',...(cfg.httpToken?{authorization:`Bearer ${cfg.httpToken}`}:{})},body:JSON.stringify(params),signal:AbortSignal.timeout(20000)});
  const body=await r.json().catch(()=>null);
  if(!r.ok||body?.status==='failed'||(body?.retcode!==undefined&&body.retcode!==0))throw new Error(`${action}: ${body?.message??body?.wording??r.status}`);
  return body?.data??body;
}
export const onebotCall=call;
async function taskTool(op,params={}){
  const r=await fetch(`${BRAIN_URL}/v1/tasks`,{method:'POST',headers:{'content-type':'application/json',...(BRAIN_TOKEN?{'x-brain-token':BRAIN_TOKEN}:{})},body:JSON.stringify({op,...params}),signal:AbortSignal.timeout(20000)});
  const body=await r.json().catch(()=>null);
  if(!r.ok)throw new Error(`task ${op}: ${body?.message??body?.error??r.status}`);
  return body;
}
async function officeCall(tool,args={},meta={}){
  const base=process.env.OFFICE_WORKER_URL;
  if(base){
    let response;
    try{
      response=await fetch(base+'/call',{method:'POST',headers:{'content-type':'application/json',...(process.env.OFFICE_WORKER_TOKEN?{'x-office-token':process.env.OFFICE_WORKER_TOKEN}:{})},body:JSON.stringify({tool,args,idempotencyKey:meta.actionId??null,taskId:meta.taskId??null}),signal:AbortSignal.timeout(35000)});
    }catch(error){
      const unavailable=new Error(`office worker unavailable: ${error.message}`);
      unavailable.code='OFFICE_UNAVAILABLE';throw unavailable;
    }
    const body=await response.json().catch(()=>null);
    if(!response.ok||!body?.ok)throw new Error(`office worker: ${body?.message??body?.error??response.status}`);
    return body.result;
  }
  const direct={office_status:()=>officeStatus({}),office_list:a=>listOffice({path:a.path??'.',max:a.max}),office_read:a=>readOffice({path:a.path}),office_write:a=>writeOffice({path:a.path,content:a.content,append:a.append===true}),office_edit:a=>editOffice({path:a.path,oldText:a.oldText,newText:a.newText}),office_search:a=>searchOffice({path:a.path??'.',query:a.query,max:a.max}),office_run:a=>runOffice({command:a.command,args:a.args??[],cwd:a.cwd??'.',timeoutMs:a.timeoutMs??20000}),office_npm:a=>runNpm({cwd:a.cwd??'.',args:a.args??[],timeoutMs:a.timeoutMs??120000}),office_plugin_list:()=>listPlugins({}),office_plugin_run:a=>runPlugin({name:a.name,action:a.action,args:a.args??{},timeoutMs:a.timeoutMs}),office_plugin_install:a=>installPlugin({url:a.url,name:a.name??null,ref:a.ref??null}),office_audit:a=>{const file=resolve(PROJECT,'../workspace/agent-office/.office/audit.jsonl');if(!existsSync(file))return {format:'agent-office-audit-v1',file,events:[]};const lines=readFileSync(file,'utf8').trim().split(/\r?\n/).filter(Boolean).slice(-Number(a.limit??50));return {format:'agent-office-audit-v1',file,events:lines.map(line=>{try{return JSON.parse(line);}catch{return {raw:line};}})};}};
  const fn=direct[tool];if(!fn)throw new Error('unknown office tool');
  return fn(args);
}
const textSeg=t=>({type:'text',data:{text:String(t)}});
const targetArgs=(a={})=>{
  const target=a.target??(a.group_id?'group':a.user_id?'private':null);
  const id=a.id??a.group_id??a.user_id;
  if(!target||!id)throw new Error('target and id required');
  return {target,id:String(id)};
};
async function send(a){
  const {target,id}=targetArgs(a);const message=Array.isArray(a.message)?a.message:[textSeg(a.text??'')];
  return call(target==='group'?'send_group_msg':'send_private_msg',target==='group'?{group_id:Number(id),message}:{user_id:Number(id),message});
}
function plainMessage(m){
  const segs=Array.isArray(m?.message)?m.message:[];
  return segs.map(s=>s?.type==='text'?s.data?.text??'':s?.type==='image'?'[图片]':s?.type==='face'?'[表情]':s?.type==='record'?'[语音]':s?.type==='at'?`@${s.data?.qq??''}`:'').join('').trim()||String(m?.raw_message??'');
}
export const TOOL_NAMES=Object.freeze([
  'qq_send_message','qq_send_private_message','qq_send_group_message',
  'qq_get_group_history','qq_get_friend_history','qq_get_group_members','qq_list_groups','qq_list_friends',
  'qq_list_stickers','qq_send_sticker','qq_send_voice','qq_send_poke','qq_get_forward_msg','qq_necklace','qq_watch_video','qq_pet','qq_minecraft','qq_speak','qq_list_voices','qq_sticker_note','attention_mute','attention_unmute','attention_load','attention_status','anchor_recall','style_status','style_update','style_delete','web_search','web_fetch',
  'office_status','office_list','office_read','office_write','office_edit','office_search','office_run','office_npm','office_audit','office_plugin_list','office_plugin_run','office_plugin_install','github_status','github_repo','github_issues','github_issue','github_pulls','github_branches','github_create_branch','github_put_file','github_create_pr','task_list','task_get','task_create','task_update','task_step','task_history','audit_view',
]);

// 语音、音色列表、联网搜索依赖外部的旧 qq-bridge 项目（不在本仓库里）。
// 以前写死成作者本机的 ../整理版_2026-10-16/qq-bridge；现在用 THREADLINE_LEGACY_BRIDGE 指定，没配置时给出明确错误。
function legacyBridgeDir(){
  const dir=process.env.THREADLINE_LEGACY_BRIDGE;
  if(!dir||!existsSync(resolve(dir)))throw Object.assign(new Error('voice/web tools need THREADLINE_LEGACY_BRIDGE pointing to a qq-bridge checkout'),{code:'CAPABILITY_NOT_CONFIGURED'});
  return resolve(dir);
}
async function speak(args={}){
  const legacy=legacyBridgeDir();
  const {speechPlan,synthesizeMinimax}=await import(pathToFileURL(join(legacy,'src/companion-life/speech.js')).href);
  const cfg=JSON.parse(readFileSync(join(legacy,'config.json'),'utf8'));
  const style=/^(bright|soft)$/.test(String(args.style??''))?String(args.style):(/亮|轻|活泼|明快/.test(String(args.style??''))?'bright':'soft');
  const emotionMap={'得意':'happy','开心':'happy','高兴':'happy','自信':'happy','兴奋':'happy','难过':'sad','伤心':'sad','低落':'sad','生气':'angry','愤怒':'angry','害怕':'fearful','恐惧':'fearful','惊讶':'surprised','吃惊':'surprised','平静':'calm','日常':'calm','温柔':'calm','自动':'auto','auto':'auto'};
  const emotion=emotionMap[String(args.emotion??'auto')]??'auto';
  const plan=speechPlan(cfg.socialV2?.life?.speech??{provider:'minimax'},{...args,style,emotion},{maxChars:160});
  const dir=join(legacy,'audio/generated');mkdirSync(dir,{recursive:true});
  const file=join(dir,`tts-${Date.now()}-${Math.random().toString(16).slice(2)}.mp3`);
  const synth=await synthesizeMinimax({root:legacy,plan,output:file});
  const target=args.target??'private',id=String(args.id??args.user_id??args.group_id??'');
  if(!id)throw new Error('target id required');
  await call(target==='group'?'send_group_msg':'send_private_msg',target==='group'?{group_id:Number(id),message:[{type:'record',data:{file}}]}:{user_id:Number(id),message:[{type:'record',data:{file}}]});
  return {...synth,file,delivered:true};
}
async function listVoices(args={}){
  const legacy=legacyBridgeDir();
  const {listAudioFiles}=await import(pathToFileURL(join(legacy,'src/voice-core.js')).href);
  return listAudioFiles(join(legacy,'audio')).slice(0,Number(args.limit??30));
}
async function stickerNote(args={}){
  if(!existsSync(STICKERS))throw new Error('sticker library missing');
  const list=JSON.parse(readFileSync(STICKERS,'utf8'));
  const item=list.find(s=>s.id===args.id);
  if(!item)throw new Error('sticker not found');
  if(typeof args.note==='string')item.localNote=args.note.slice(0,800);
  if(Array.isArray(args.tags))item.tags=args.tags.filter(x=>typeof x==='string').slice(0,12);
  item.updatedAt=new Date().toISOString();
  writeFileSync(STICKERS,JSON.stringify(list,null,2)+'\n','utf8');
  return {id:item.id,desc:item.desc,localNote:item.localNote,tags:item.tags,updatedAt:item.updatedAt};
}
async function brainJson(path,body=null,method='POST'){
  const response=await fetch(BRAIN_URL+path,{method,headers:{'content-type':'application/json',...(BRAIN_TOKEN?{'x-brain-token':BRAIN_TOKEN}:{})},...(body!==null?{body:JSON.stringify(body)}:{})});
  const value=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(value.error??`brain ${response.status}`);
  return value;
}
async function webTool(name,toolArgs){  const legacy=legacyBridgeDir();
  const {Client}=await import(pathToFileURL(join(legacy,'node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js')).href);
  const {StdioClientTransport}=await import(pathToFileURL(join(legacy,'node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js')).href);
  const transport=new StdioClientTransport({command:process.execPath,args:[join(legacy,'src/mcp-web-search-safe.js')],cwd:legacy,stderr:'pipe'});
  const client=new Client({name:'qq-capability-host',version:'1.0.0'});
  try{await client.connect(transport);return await client.callTool({name,arguments:toolArgs});}
  finally{try{await client.close();}catch{}}
}
export async function executeTool(tool,args={},meta={}){
  switch(tool){
    case 'qq_send_message':return send(args);
    case 'qq_send_private_message':return send({...args,target:'private'});
    case 'qq_send_group_message':return send({...args,target:'group'});
    case 'qq_list_groups':return (await call('get_group_list')).map(g=>({group_id:g.group_id,group_name:g.group_name,member_count:g.member_count}));
    case 'qq_list_friends':return (await call('get_friend_list')).map(f=>({user_id:f.user_id,nickname:f.nickname,remark:f.remark??''}));
    case 'qq_get_group_members':{
      const gid=args.group_id??args.id;if(!gid)throw new Error('group_id required');
      return (await call('get_group_member_list',{group_id:Number(gid)})).map(m=>({user_id:m.user_id,nickname:m.nickname,card:m.card}));
    }
    case 'qq_get_group_history':{
      const gid=args.group_id??args.id;if(!gid)throw new Error('group_id required');
      const count=Math.max(1,Math.min(20,Number(args.count??5)));
      const data=await call('get_group_msg_history',{group_id:Number(gid),count});
      return (data.messages??[]).map(m=>({message_id:m.message_id,time:m.time,user_id:m.user_id,nickname:m.sender?.nickname??'',text:plainMessage(m)}));
    }
    case 'qq_get_friend_history':{
      const uid=args.user_id??args.id;if(!uid)throw new Error('user_id required');
      const count=Math.max(1,Math.min(20,Number(args.count??5)));
      const data=await call('get_friend_msg_history',{user_id:Number(uid),count});
      return (data.messages??[]).map(m=>({message_id:m.message_id,time:m.time,user_id:m.user_id,text:plainMessage(m)}));
    }
    case 'qq_get_forward_msg':{
      if(!args.id)throw new Error('forward id required');
      return call('get_forward_msg',{id:String(args.id)});
    }
    case 'qq_list_stickers':{
      if(!existsSync(STICKERS))return [];
      const list=JSON.parse(readFileSync(STICKERS,'utf8'));
      return list.filter(s=>s.url).slice(0,Number(args.limit??30)).map(s=>({id:s.id,desc:s.desc,usage:s.usage,localNote:s.localNote,tags:s.tags,url:s.url}));
    }
    case 'qq_send_sticker':{
      const {target,id}=targetArgs(args);const url=args.url??args.sticker;
      if(!url)throw new Error('sticker url required');
      return call(target==='group'?'send_group_msg':'send_private_msg',target==='group'?{group_id:Number(id),message:[{type:'image',data:{file:String(url)}}]}:{user_id:Number(id),message:[{type:'image',data:{file:String(url)}}]});
    }
    case 'qq_send_voice':{
      const {target,id}=targetArgs(args);const file=args.file;
      if(!file||!existsSync(file))throw new Error('voice file required');
      return call(target==='group'?'send_group_msg':'send_private_msg',target==='group'?{group_id:Number(id),message:[{type:'record',data:{file:String(file)}}]}:{user_id:Number(id),message:[{type:'record',data:{file:String(file)}}]});
    }
    case 'qq_necklace':{const {runNecklace}=await import('../native-capabilities/necklace/adapter.mjs');return runNecklace(args);}
    case 'qq_watch_video':{const {runVideo}=await import('../native-capabilities/video/adapter.mjs');return runVideo(args);}
    case 'qq_pet':{const {runDesktop}=await import('../native-capabilities/desktop.mjs');return runDesktop(args);}
    case 'qq_minecraft':{const {runMinecraft}=await import('../native-capabilities/minecraft.mjs');return runMinecraft(args);}
    case 'qq_speak':return speak(args);
    case 'qq_list_voices':return listVoices(args);
    case 'qq_sticker_note':return stickerNote(args);
    case 'attention_mute':return brainJson('/v1/attention/mute',{prefix:args.prefix});
    case 'attention_unmute':return brainJson('/v1/attention/unmute',{prefix:args.prefix,load:args.load!==false});
    case 'attention_load':return brainJson('/v1/attention/load',{prefix:args.prefix,limit:args.limit??50});
    case 'attention_status':return brainJson('/v1/attention',null,'GET');
    case 'anchor_recall':return brainJson('/v1/anchor/query',{anchor:args.anchor,role:args.role??null,limit:args.limit??12});
    case 'style_status':return brainJson('/v1/style',null,'GET');
    case 'style_update':return brainJson('/v1/style',{text:args.text,label:args.label,source:args.source??'agent'});
    case 'style_delete':return brainJson('/v1/style/delete',{id:args.id});
    case 'web_search':return webTool('web_search',{query:args.query,maxResults:args.maxResults??5});
    case 'web_fetch':return webTool('web_fetch',{url:args.url});
    case 'office_status':return officeCall('office_status',{},meta);
    case 'office_list':return officeCall('office_list',args,meta);
    case 'office_read':return officeCall('office_read',args,meta);
    case 'office_write':return officeCall('office_write',args,meta);
    case 'office_edit':return officeCall('office_edit',args,meta);
    case 'office_search':return officeCall('office_search',args,meta);
    case 'office_run':return officeCall('office_run',args,meta);
    case 'office_npm':return officeCall('office_npm',args,meta);
    case 'office_audit':return officeCall('office_audit',args,meta);
    case 'office_plugin_list':return officeCall('office_plugin_list',args,meta);
    case 'office_plugin_run':return officeCall('office_plugin_run',args,meta);
    case 'office_plugin_install':return officeCall('office_plugin_install',args,meta);
    case 'github_status':return githubTool('status',args);
    case 'github_repo':return githubTool('repo',args);
    case 'github_issues':return githubTool('issues',args);
    case 'github_issue':return githubTool('issue',args);
    case 'github_pulls':return githubTool('pulls',args);
    case 'github_branches':return githubTool('branches',args);
    case 'github_create_branch':return githubTool('create_branch',args);
    case 'github_put_file':return githubTool('put_file',args);
    case 'github_create_pr':return githubTool('create_pr',args);
    case 'task_list':return taskTool('list',{status:args.status??null,limit:args.limit});
    case 'task_get':return taskTool('get',{id:args.id});
    case 'task_create':return taskTool('create',{goal:args.goal,plan:args.plan??[],origin:args.origin??'self',budget:args.budget??null,scene:args.scene??null});
    case 'task_update':{
      const fields=['goal','status','plan','currentStep','checkpoint','nextStep','artifacts','budget','attempts','failure','nextWakeAt','scene'];
      const patch=args.patch??Object.fromEntries(fields.filter(k=>args[k]!==undefined).map(k=>[k,args[k]]));
      return taskTool('update',{id:args.id,expectedRevision:args.expectedRevision,patch});
    }
    case 'task_step':return taskTool('step',{id:args.id,expectedRevision:args.expectedRevision,stepId:args.stepId,status:args.status,checkpoint:args.checkpoint,nextStep:args.nextStep,nextWakeAt:args.nextWakeAt});
    case 'task_history':return taskTool('history',{id:args.id,limit:args.limit});
    case 'audit_view':return brainJson(`/v1/audit?limit=${encodeURIComponent(String(args.limit??50))}`,null,'GET');
    case 'qq_send_poke':{
      if(!args.user_id)throw new Error('user_id required');
      return call('send_poke',{user_id:Number(args.user_id),...(args.group_id?{group_id:Number(args.group_id)}:{})});
    }
    default:throw new Error(`tool not migrated: ${tool}`);
  }
}
