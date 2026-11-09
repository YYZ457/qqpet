// 独立办公室 worker：只执行办公室工具，不拥有目标、不写记忆、不发 QQ。
import {createServer} from 'node:http';
import {appendFileSync,existsSync,mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {officeStatus,listOffice,readOffice,writeOffice,editOffice,searchOffice,runOffice,runNpm,officeRoot} from '../../src/office.mjs';
import {listPlugins,runPlugin,installPlugin} from '../../src/plugins.mjs';

const port=Number(process.env.OFFICE_WORKER_PORT??8791);
const token=String(process.env.OFFICE_WORKER_TOKEN??'');
const auditFile=process.env.OFFICE_AUDIT_FILE??join(officeRoot(),'.office','audit.jsonl');
const idempotencyFile=process.env.OFFICE_IDEMPOTENCY_FILE??join(officeRoot(),'.office','idempotency.json');
mkdirSync(dirname(auditFile),{recursive:true});
let idempotency={};
try{idempotency=JSON.parse(readFileSync(idempotencyFile,'utf8'));}catch{idempotency={};}
const mutating=new Set(['office_write','office_edit','office_run','office_plugin_run','office_plugin_install']);
function saveIdempotency(){
  try{const entries=Object.entries(idempotency).sort((a,b)=>b[1].at-a[1].at).slice(0,2000);idempotency=Object.fromEntries(entries);const temp=`${idempotencyFile}.tmp`;writeFileSync(temp,JSON.stringify(idempotency),'utf8');renameSync(temp,idempotencyFile);}catch{}
}
function idemKey(tool,key){return key?`${tool}:${key}`:null;}
function audit(tool,args,ok,error=null,taskId=null){
  try{appendFileSync(auditFile,JSON.stringify({at:new Date().toISOString(),tool,taskId,ok,args:Object.fromEntries(Object.entries(args??{}).map(([k,v])=>[k,String(typeof v==='string'?v:JSON.stringify(v)).slice(0,300)])),error})+'\n','utf8');}catch{}
}
function auditTail(limit=50){
  try{const lines=readFileSync(auditFile,'utf8').trim().split(/\r?\n/).filter(Boolean);return lines.slice(-Math.max(1,Math.min(200,limit))).map(line=>{try{return JSON.parse(line);}catch{return {raw:line};}});}catch{return [];}
}
const json=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
const authorized=req=>!token||req.headers['x-office-token']===token;
const EXEC_TOOLS=new Set(['office_run','office_npm','office_plugin_run','office_plugin_install']);
const tools={
  office_status:()=>officeStatus({}),
  office_list:a=>listOffice({path:a.path??'.',max:a.max}),
  office_read:a=>readOffice({path:a.path}),
  office_write:a=>writeOffice({path:a.path,content:a.content,append:a.append===true}),
  office_edit:a=>editOffice({path:a.path,oldText:a.oldText,newText:a.newText}),
  office_search:a=>searchOffice({path:a.path??'.',query:a.query,max:a.max}),
  office_run:a=>runOffice({command:a.command,args:a.args??[],cwd:a.cwd??'.',timeoutMs:a.timeoutMs??20000}),
  office_npm:a=>runNpm({cwd:a.cwd??'.',args:a.args??[],timeoutMs:a.timeoutMs??120000}),
  office_plugin_list:()=>listPlugins({}),
  office_plugin_run:a=>runPlugin({name:a.name,action:a.action,args:a.args??{},timeoutMs:a.timeoutMs}),
  office_plugin_install:a=>installPlugin({url:a.url,name:a.name??null,ref:a.ref??null})
};
function body(req){return new Promise((resolve,reject)=>{let bytes=0;const parts=[];req.on('data',chunk=>{bytes+=chunk.length;if(bytes>1024*1024){reject(new Error('body too large'));return;}parts.push(chunk);});req.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(parts).toString('utf8')||'{}'));}catch{reject(new Error('invalid json'));}});req.on('error',reject);});}
const server=createServer(async(req,res)=>{
  try{
    if(req.method==='GET'&&req.url.startsWith('/audit')){const u=new URL(req.url,'http://127.0.0.1');return json(res,200,{ok:true,format:'agent-office-audit-v1',file:auditFile,events:auditTail(u.searchParams.get('limit')??50)});}
    if(req.method==='GET'&&req.url==='/health')return json(res,200,{ok:true,format:'agent-office-worker-v1',root:officeStatus({}).root,auditFile});
    if(req.method!=='POST'||req.url!=='/call')return json(res,404,{error:'NOT_FOUND'});
    if(!authorized(req))return json(res,401,{error:'UNAUTHORIZED'});
    const input=await body(req);
    const tool=String(input.tool??'');
    const fn=tools[tool];
    if(!fn)return json(res,400,{error:'OFFICE_TOOL',message:'unknown office tool'});
    // 执行类工具（跑命令、npm、装/跑插件）等于让模型在这台电脑上执行任意代码，而接 QQ 的模型可以被群友的消息诱导。
    // 默认关闭；确认工作区已经放进容器或虚拟机后，再设 THREADLINE_OFFICE_EXEC=1 打开。
    if(EXEC_TOOLS.has(tool)&&process.env.THREADLINE_OFFICE_EXEC!=='1')return json(res,403,{error:'OFFICE_EXEC_DISABLED',message:'command execution tools are disabled; set THREADLINE_OFFICE_EXEC=1 after sandboxing the office'});
    if(!input.args||Object.getPrototypeOf(input.args)!==Object.prototype)return json(res,400,{error:'OFFICE_INPUT',message:'args object required'});
    const key=mutating.has(tool)?idemKey(tool,input.idempotencyKey):null;
    if(key&&idempotency[key]){
      const hit=idempotency[key];
      audit(tool,input.args,hit.ok,hit.ok?null:hit.error,input.taskId??null);
      if(!hit.ok)return json(res,400,{error:hit.code??'OFFICE_ERROR',message:hit.error,cached:true});
      return json(res,200,{ok:true,tool,cached:true,result:hit.result});
    }
    try{
      const result=await fn(input.args);
      audit(tool,input.args,true,null,input.taskId??null);
      if(key){idempotency[key]={ok:true,result,at:Date.now()};saveIdempotency();}
      return json(res,200,{ok:true,tool,result});
    }
    catch(error){
      audit(tool,input.args,false,error.message,input.taskId??null);
      if(key){idempotency[key]={ok:false,code:error.code??'OFFICE_ERROR',error:error.message,at:Date.now()};saveIdempotency();}
      return json(res,400,{error:error.code??'OFFICE_ERROR',message:error.message});
    }
  }catch(error){return json(res,400,{error:error.code??'OFFICE_ERROR',message:error.message});}
});
server.listen(port,'127.0.0.1',()=>console.log(JSON.stringify({ok:true,kind:'office-worker',port,root:officeStatus({}).root})));
const shutdown=()=>server.close(()=>process.exit(0));
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
