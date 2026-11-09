// 跨平台启动器（打包版使用，不依赖 PowerShell）：start | stop | status
//   node launch.mjs start [--no-open]
// 目录约定：<包根>/app（本工程）、<包根>/data（记忆与配置）。data 可用环境变量 AGENT_DATA 改位置。
import {spawn,spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,openSync,readFileSync,writeFileSync,unlinkSync,copyFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const app=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const data=resolve(process.env.AGENT_DATA??join(app,'..','data'));
const ops=join(data,'ops'),logs=join(data,'logs');
const BRAIN_PORT=Number(process.env.BRAIN_PORT??8787),UI_PORT=Number(process.env.UI_PORT??8790),OFFICE_PORT=Number(process.env.OFFICE_WORKER_PORT??8791);
const node=process.execPath;
const log=(...a)=>console.log(...a);
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
const pidFile=name=>join(ops,`${name}.pid`);
const readPid=name=>{try{return Number(readFileSync(pidFile(name),'utf8').trim());}catch{return 0;}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function healthy(port,path='/health'){
  try{const r=await fetch(`http://127.0.0.1:${port}${path}`,{signal:AbortSignal.timeout(2500),headers:process.env.BRAIN_TOKEN?{'x-brain-token':process.env.BRAIN_TOKEN}:{}});return r.ok;}catch{return false;}
}
function launch(name,script,env={}){
  const existing=readPid(name);
  if(existing&&alive(existing)){log(`  ${name}: 已在运行 (pid ${existing})`);return existing;}
  mkdirSync(logs,{recursive:true});
  const out=openSync(join(logs,`${name}.out.log`),'a'),err=openSync(join(logs,`${name}.err.log`),'a');
  const child=spawn(node,[script],{cwd:app,detached:true,windowsHide:true,stdio:['ignore',out,err],env:{...process.env,...env}});
  child.unref();writeFileSync(pidFile(name),String(child.pid));
  log(`  ${name}: 已启动 (pid ${child.pid})`);return child.pid;
}
function prepareData(){
  mkdirSync(ops,{recursive:true});mkdirSync(join(data,'state'),{recursive:true});mkdirSync(join(data,'secrets'),{recursive:true});
  // 交接包里的队列/游标快照只是旧状态，首次启动时复制进运行目录（不覆盖已有）
  for(const f of ['context-cursor.json'])if(existsSync(join(data,f))&&!existsSync(join(data,'state',f)))copyFileSync(join(data,f),join(data,'state',f));
}
async function start({open=true}={}){
  if(!existsSync(join(data,'memory.sqlite'))){console.error(`找不到记忆库：${join(data,'memory.sqlite')}\n请确认 data 文件夹和 app 文件夹在同一层。`);process.exit(2);}
  prepareData();
  const officeToken=process.env.OFFICE_WORKER_TOKEN??randomUUID();
  // brain 服务以前没有令牌：本机任何进程都能操控她。现在每次启动生成一个，传给 UI、连接器和看门狗。
  const brainToken=process.env.BRAIN_TOKEN??randomUUID();
  const officeUrl=`http://127.0.0.1:${OFFICE_PORT}`;
  const env={
    AGENT_DATA:data,BRAIN_LIVE:process.env.BRAIN_LIVE??'0',BRAIN_GLOBAL:'1',BRAIN_HEARTBEAT_MS:process.env.BRAIN_HEARTBEAT_MS??'5000',
    BRAIN_STORE:join(data,'memory.sqlite'),BRAIN_IDENTITY_FILE:join(data,'identity.txt'),BRAIN_STYLE_DIR:join(data,'style'),
    BRAIN_STATE:join(data,'state'),BRAIN_LEDGER:join(data,'budget.json'),QQ_STICKERS_FILE:join(data,'stickers.json'),...(process.env.QQ_OWNER?{QQ_OWNER:process.env.QQ_OWNER}:{}),
    OFFICE_WORKER_PORT:String(OFFICE_PORT),OFFICE_WORKER_TOKEN:officeToken,
    OFFICE_WORKER_URL:officeUrl,BRAIN_TOKEN:brainToken,
  };
  writeFileSync(join(ops,'office.token'),officeToken,{encoding:'utf8',mode:0o600});
  writeFileSync(join(ops,'brain.token'),brainToken,{encoding:'utf8',mode:0o600});
  writeFileSync(join(ops,'office.url'),officeUrl,{encoding:'utf8'});
  log('启动智能体…');
  Object.assign(process.env,env);
  launch('office','tools/office-worker/worker.mjs',env);
  for(let i=0;i<20&&!await healthy(OFFICE_PORT);i++)await sleep(250);
  if(!await healthy(OFFICE_PORT)){console.error(`办公室 worker 没起来，请看日志：${join(logs,'office.err.log')}`);process.exit(1);}
  launch('watchdog','tools/ops/watchdog.mjs',env);
  launch('brain','tools/brain-service/run.mjs',env);
  for(let i=0;i<40&&!await healthy(BRAIN_PORT);i++)await sleep(500);
  if(!await healthy(BRAIN_PORT)){console.error(`脑服务没起来，请看日志：${join(logs,'brain.err.log')}`);process.exit(1);}
  launch('ui','tools/ui/server.mjs',env);
  // QQ 连接器常驻：QQ 传输（OneBot）没起来时它只是安静地等，起来后自动接上；状态在控制台“接入 QQ”里看
  launch('connector','tools/qq-connect/bridge.mjs',env);
  for(let i=0;i<20&&!await healthy(UI_PORT);i++)await sleep(250);
  log(`\n完成。控制台：http://127.0.0.1:${UI_PORT}`);
  if(open)openBrowser(`http://127.0.0.1:${UI_PORT}`);
}
function openBrowser(url){
  try{
    if(process.platform==='win32')spawn('cmd',['/c','start','""',url],{detached:true,stdio:'ignore',windowsHide:true}).unref();
    else if(process.platform==='darwin')spawn('open',[url],{detached:true,stdio:'ignore'}).unref();
    else spawn('xdg-open',[url],{detached:true,stdio:'ignore'}).unref();
  }catch{}
}
function stop(){
  for(const name of ['watchdog','connector','ui','brain','office']){
    const pid=readPid(name);
    if(pid&&alive(pid)){
      // 先礼后兵：SIGTERM 让脑服务落盘并释放预算锁；Windows 上 kill 等同强制结束，所以脑服务用 HTTP 之外的 pid 文件+锁文件自愈
      try{process.kill(pid,'SIGTERM');}catch{}
      if(process.platform==='win32')spawnSync('taskkill',['/PID',String(pid),'/T','/F'],{windowsHide:true});
      log(`  已停止 ${name} (pid ${pid})`);
    }
    try{unlinkSync(pidFile(name));}catch{}
  }
  try{unlinkSync(join(data,'budget.json.lock'));}catch{}
  try{unlinkSync(join(data,'state','brain-service.pid'));}catch{}
  log('已停止。');
}
async function status(){
  log(`brain ${await healthy(BRAIN_PORT)?'运行中':'未运行'} · ui ${await healthy(UI_PORT)?'运行中':'未运行'}`);
}
const [cmd='start',...rest]=process.argv.slice(2);
if(cmd==='start')await start({open:!rest.includes('--no-open')});
else if(cmd==='stop')stop();
else if(cmd==='status')await status();
else{console.error('用法: launch.mjs start|stop|status');process.exit(1);}
