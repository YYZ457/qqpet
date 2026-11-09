// 办公室 worker 看门狗：只负责把挂掉的办公室拉回来，不碰 brain、不碰目标。
import {spawn} from 'node:child_process';
import {existsSync,mkdirSync,openSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const app=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const data=resolve(process.env.AGENT_DATA??join(app,'..','data'));
const ops=join(data,'ops'),logs=join(data,'logs');
const port=Number(process.env.OFFICE_WORKER_PORT??8791);
const url=process.env.OFFICE_WORKER_URL??`http://127.0.0.1:${port}`;
const token=process.env.OFFICE_WORKER_TOKEN??'';
const pidFile=join(ops,'office.pid');
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
const readPid=()=>{try{return Number(readFileSync(pidFile,'utf8').trim());}catch{return 0;}};
const log=msg=>console.log(`${new Date().toISOString()} ${msg}`);
let child=null,lastStart=0;

async function healthy(){
  try{const r=await fetch(url+'/health',{signal:AbortSignal.timeout(2000)});return r.ok;}catch{return false;}
}
function startWorker(){
  const existing=readPid();
  if(existing&&alive(existing))return;
  if(Date.now()-lastStart<3000)return;
  lastStart=Date.now();
  mkdirSync(logs,{recursive:true});
  const out=join(logs,'office.out.log'),err=join(logs,'office.err.log');
  child=spawn(process.execPath,['tools/office-worker/worker.mjs'],{cwd:app,detached:true,windowsHide:true,
    stdio:['ignore',requireFd(out),requireFd(err)],env:{...process.env,OFFICE_WORKER_PORT:String(port),OFFICE_WORKER_TOKEN:token,OFFICE_WORKER_URL:url}});
  child.unref();writeFileSync(pidFile,String(child.pid));log(`office restarted pid ${child.pid}`);
}
function requireFd(path){
  return openSync(path,'a');
}
async function tick(){
  if(await healthy())return;
  log('office unhealthy; restarting');
  startWorker();
}
const timer=setInterval(()=>{void tick();},5000);
process.on('SIGTERM',()=>process.exit(0));process.on('SIGINT',()=>process.exit(0));
log(`watchdog started for ${url}`);
