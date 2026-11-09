// 办公室客户端：给 DSH/外部工具环境使用；只调用 worker，不拥有目标、不碰记忆。
// 用法：node tools/office-worker/client.mjs <tool> '<json args>'
import {existsSync,readFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const app=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const data=resolve(process.env.AGENT_DATA??join(app,'..','data'));
const read=(name,fallback)=>{try{return readFileSync(join(data,'ops',name),'utf8').trim()||fallback;}catch{return fallback;}};
const url=process.env.OFFICE_WORKER_URL??read('office.url','http://127.0.0.1:8791');
const token=process.env.OFFICE_WORKER_TOKEN??read('office.token','');
const tool=process.argv[2];
const raw=process.argv[3]??'{}';
if(!url){console.error('OFFICE_WORKER_URL is not set');process.exit(2);}
if(!tool){console.error('usage: client.mjs <office_tool> [json-args]');process.exit(2);}
let args;
try{args=JSON.parse(raw);}catch(error){console.error(`invalid json args: ${error.message}`);process.exit(2);}
const response=await fetch(url+'/call',{method:'POST',headers:{'content-type':'application/json',...(token?{'x-office-token':token}:{})},body:JSON.stringify({tool,args})});
const body=await response.json().catch(()=>null);
if(!response.ok||!body?.ok){console.error(JSON.stringify(body??{error:response.status}));process.exit(1);}
console.log(JSON.stringify(body.result,null,2));
