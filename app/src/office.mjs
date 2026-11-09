// 她的办公室：只允许在独立工作区内读写；不是整机文件权限。
import {
  existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync,
  statSync, unlinkSync, writeFileSync
} from 'node:fs';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {spawn} from 'node:child_process';
import {rootCertificates} from 'node:tls';
import {fileURLToPath} from 'node:url';

const DEFAULT_ROOT=fileURLToPath(new URL('../../workspace/agent-office', import.meta.url));
const MAX_READ=512*1024;
const MAX_WRITE=5*1024*1024;
const MAX_LIST=2000;
const MAX_SCAN_FILES=4000;
const MAX_RESULTS=50;
const SKIP_DIRS=new Set(['.git','node_modules','.office','__pycache__','.venv','dist','build']);

const fail=(code,message)=>{const error=new Error(message);error.code=code;throw error;};
export function officeRoot(override=null){
  const root=resolve(override??process.env.THREADLINE_OFFICE_ROOT??process.env.JY_OFFICE_ROOT??DEFAULT_ROOT);
  if(!existsSync(root))fail('OFFICE_MISSING','office root does not exist');
  return root;
}
function inside(root,target){
  const rel=relative(root,target);
  return rel===''||(!rel.startsWith('..'+sep)&&rel!=='..'&&!isAbsolute(rel));
}
function relativePath(root,absolute){
  return relative(root,absolute).split(sep).join('/')||'.';
}
function resolveExisting(root,value){
  if(typeof value!=='string'||value.length===0)fail('OFFICE_PATH','path required');
  if(isAbsolute(value))fail('OFFICE_PATH','absolute paths are not allowed');
  const candidate=resolve(root,value);
  if(!inside(root,candidate))fail('OFFICE_PATH','path escapes office root');
  let real;
  try{real=realpathSync(candidate);}catch{fail('OFFICE_NOT_FOUND','path does not exist');}
  if(!inside(root,real))fail('OFFICE_PATH','path resolves outside office root');
  return real;
}
function resolveForWrite(root,value){
  if(typeof value!=='string'||value.length===0)fail('OFFICE_PATH','path required');
  if(isAbsolute(value))fail('OFFICE_PATH','absolute paths are not allowed');
  const candidate=resolve(root,value);
  if(!inside(root,candidate))fail('OFFICE_PATH','path escapes office root');
  const parent=dirname(candidate);
  if(!existsSync(parent)){
    const parentRel=relative(root,parent);
    if(parentRel.startsWith('..')||isAbsolute(parentRel))fail('OFFICE_PATH','parent escapes office root');
    mkdirSync(parent,{recursive:true});
  }
  const realParent=realpathSync(parent);
  if(!inside(root,realParent))fail('OFFICE_PATH','parent resolves outside office root');
  if(existsSync(candidate)){
    const real=realpathSync(candidate);
    if(!inside(root,real))fail('OFFICE_PATH','target resolves outside office root');
    return real;
  }
  return join(realParent,candidate.slice(parent.length).replace(/^[\\/]+/,''));
}
function text(value,name,max){
  if(typeof value!=='string')fail('OFFICE_INPUT',`${name} must be a string`);
  if(value.length>max)fail('OFFICE_LIMIT',`${name} too long`);
  return value;
}
export function listOffice({root=null,path='.',max=200}={}){
  const base=officeRoot(root);
  const dir=resolveExisting(base,path);
  if(!statSync(dir).isDirectory())fail('OFFICE_TYPE','not a directory');
  const limit=Math.max(1,Math.min(MAX_LIST,Number(max)||200));
  const entries=readdirSync(dir,{withFileTypes:true}).slice(0,limit).map(entry=>{
    const full=join(dir,entry.name);
    const stat=statSync(full);
    return {name:entry.name,path:relativePath(base,full),type:entry.isDirectory()?'dir':entry.isSymbolicLink()?'symlink':'file',size:entry.isFile()?stat.size:null};
  });
  return {root:base,path:relativePath(base,dir),entries,truncated:entries.length>=limit};
}
export function readOffice({root=null,path}={}){
  const base=officeRoot(root);
  const file=resolveExisting(base,path);
  if(!statSync(file).isFile())fail('OFFICE_TYPE','not a file');
  if(statSync(file).size>MAX_READ)fail('OFFICE_LIMIT','file too large to read');
  const buf=readFileSync(file);
  if(buf.includes(0))fail('OFFICE_TYPE','binary file is not readable as text');
  return {root:base,path:relativePath(base,file),text:buf.toString('utf8'),bytes:buf.length};
}
export function writeOffice({root=null,path,content,append=false}={}){
  const base=officeRoot(root);
  const file=resolveForWrite(base,path);
  const body=text(content,'content',MAX_WRITE);
  const before=existsSync(file)?readFileSync(file,'utf8'):'';
  const next=append?before+body:body;
  if(Buffer.byteLength(next,'utf8')>MAX_WRITE)fail('OFFICE_LIMIT','file too large after write');
  const temp=`${file}.tmp-${process.pid}-${Date.now()}`;
  try{writeFileSync(temp,next,'utf8');renameSync(temp,file);}catch(error){try{unlinkSync(temp);}catch{}throw error;}
  return {root:base,path:relativePath(base,file),bytes:Buffer.byteLength(next,'utf8'),appended:append===true};
}
export function editOffice({root=null,path,oldText,newText}={}){
  const base=officeRoot(root);
  const file=resolveExisting(base,path);
  if(!statSync(file).isFile())fail('OFFICE_TYPE','not a file');
  const before=readFileSync(file,'utf8');
  const oldValue=text(oldText,'oldText',MAX_WRITE),newValue=text(newText,'newText',MAX_WRITE);
  if(!oldValue)fail('OFFICE_INPUT','oldText required');
  const at=before.indexOf(oldValue);
  if(at<0)fail('OFFICE_MATCH','oldText not found');
  const next=before.slice(0,at)+newValue+before.slice(at+oldValue.length);
  if(Buffer.byteLength(next,'utf8')>MAX_WRITE)fail('OFFICE_LIMIT','file too large after edit');
  writeFileSync(file,next,'utf8');
  return {root:base,path:relativePath(base,file),bytes:Buffer.byteLength(next,'utf8'),replaced:1};
}
function walk(base,dir,out){
  if(out.files>=MAX_SCAN_FILES)return;
  for(const entry of readdirSync(dir,{withFileTypes:true})){
    if(out.files>=MAX_SCAN_FILES)break;
    if(entry.isDirectory()){
      if(SKIP_DIRS.has(entry.name))continue;
      const child=join(dir,entry.name);
      if(!inside(base,child))continue;
      walk(base,child,out);
    }else if(entry.isFile()){
      const full=join(dir,entry.name);
      if(!inside(base,full))continue;
      out.files++;
      try{if(statSync(full).size<=MAX_READ)out.paths.push(full);}catch{}
    }
  }
}
export function searchOffice({root=null,path='.',query,max=20}={}){
  const base=officeRoot(root);
  const start=resolveExisting(base,path);
  const needle=text(query,'query',200).toLocaleLowerCase('zh-CN');
  if(!needle)fail('OFFICE_INPUT','query required');
  const limit=Math.max(1,Math.min(MAX_RESULTS,Number(max)||20));
  const out={files:0,paths:[]};walk(base,start,out);
  const hits=[];
  for(const file of out.paths){
    if(hits.length>=limit)break;
    let content;try{content=readFileSync(file,'utf8');}catch{continue;}
    if(content.includes(0))continue;
    const lines=content.split(/\r?\n/);
    for(let i=0;i<lines.length&&hits.length<limit;i++){
      if(lines[i].toLocaleLowerCase('zh-CN').includes(needle))hits.push({path:relativePath(base,file),line:i+1,text:lines[i].slice(0,300)});
    }
  }
  return {root:base,query,scannedFiles:out.files,total:hits.length,items:hits,truncated:out.files>=MAX_SCAN_FILES||hits.length>=limit};
}
const MAX_COMMAND_OUTPUT=20000;
const GIT_CA=fileURLToPath(new URL('../../data/state/git-ca-bundle.pem',import.meta.url));
// 旧的 JY_* 变量名仍然认，避免已有部署失效；默认只在 Windows 上找 Git for Windows 的固定路径。
const GIT_EXE=process.env.THREADLINE_GIT_EXE??process.env.JY_GIT_EXE??(process.platform==='win32'?'C:\\Program Files\\Git\\cmd\\git.exe':'git');
const COMMANDS=new Set(['node','node.exe','python','python3','py','git','git.exe','rg','rg.exe']);
export function runOffice({root=null,command,args=[],cwd='.',timeoutMs=20000}={}){
  return new Promise((resolve,reject)=>{
    const base=officeRoot(root);
    const name=String(command??'').trim().toLocaleLowerCase('en-US');
    if(!COMMANDS.has(name))fail('OFFICE_COMMAND','command is not in the office allowlist');
    if(name.includes('/')||name.includes('\\'))fail('OFFICE_COMMAND','command must be a bare executable name');
    if(!Array.isArray(args)||args.length>64)fail('OFFICE_INPUT','command args must be an array of at most 64');
    const env={PATH:process.env.PATH??'',SystemRoot:process.env.SystemRoot??'',TEMP:process.env.TEMP??'',TMP:process.env.TMP??'',USERPROFILE:process.env.USERPROFILE??''};
    let argv=args.map((value,index)=>text(String(value),`args[${index}]`,2000));
    if(name==='git'||name==='git.exe'){
      if(!existsSync(GIT_CA)){mkdirSync(dirname(GIT_CA),{recursive:true});writeFileSync(GIT_CA,rootCertificates.join('\n')+'\n','utf8');}
      env.GIT_SSL_CAINFO=GIT_CA;
      argv=['-c','http.sslBackend=openssl','-c',`http.sslCAInfo=${GIT_CA}`,...argv];
    }
    const dir=resolveExisting(base,cwd||'.');
    if(!statSync(dir).isDirectory())fail('OFFICE_TYPE','command cwd must be a directory');
    const limit=Number.isSafeInteger(timeoutMs)?Math.max(1,Math.min(30000,timeoutMs)):20000;
    let child;
    const exe=(name==='git'||name==='git.exe')&&existsSync(GIT_EXE)?GIT_EXE:name;
    try{child=spawn(exe,argv,{cwd:dir,env,shell:false,windowsHide:true});}catch(error){reject(error);return;}
    let stdout='',stderr='',done=false,timedOut=false;
    const append=(current,chunk)=>{if(current.length>=MAX_COMMAND_OUTPUT)return current;const next=current+chunk.toString('utf8');return next.length>MAX_COMMAND_OUTPUT?next.slice(0,MAX_COMMAND_OUTPUT)+'\n…[输出截断]':next;};
    const finish=(code,signal)=>{if(done)return;done=true;clearTimeout(timer);resolve({root:base,path:relativePath(base,dir),command:name,args:argv,exitCode:code,signal,timedOut,stdout,stderr});};
    const timer=setTimeout(()=>{timedOut=true;try{child.kill('SIGKILL');}catch{}},limit);
    child.stdout?.on('data',chunk=>{stdout=append(stdout,chunk);});
    child.stderr?.on('data',chunk=>{stderr=append(stderr,chunk);});
    child.once('error',error=>{if(done)return;done=true;clearTimeout(timer);reject(error);});
    child.once('close',(code,signal)=>finish(code,signal));
  });
}
const NPM_SUBCOMMANDS=new Set(['install','ci','test','run','--version']);
const SAFE_NPM_ARG=/^[@A-Za-z0-9._:/=+~-]{1,120}$/;
export function runNpm({root=null,cwd='.',args=[],timeoutMs=120000}={}){
  const base=officeRoot(root);
  if(!Array.isArray(args)||args.length>8||args.some(a=>typeof a!=='string'||!SAFE_NPM_ARG.test(a)))fail('OFFICE_INPUT','npm args invalid');
  const sub=args[0];
  if(!NPM_SUBCOMMANDS.has(sub))fail('OFFICE_COMMAND','npm subcommand not allowed');
  if(sub==='run'&&(!args[1]||!/^[A-Za-z0-9:_-]{1,80}$/.test(args[1])))fail('OFFICE_INPUT','npm script name invalid');
  const dir=resolveExisting(base,cwd||'.');
  if(!statSync(dir).isDirectory())fail('OFFICE_TYPE','npm cwd must be a directory');
  const limit=Math.max(1000,Math.min(120000,Number(timeoutMs)||120000));
  return new Promise((resolve,reject)=>{
    const env={PATH:process.env.PATH??'',SystemRoot:process.env.SystemRoot??'',TEMP:process.env.TEMP??'',TMP:process.env.TMP??'',USERPROFILE:process.env.USERPROFILE??''};

    let child;try{child=spawn('npm',args,{cwd:dir,env,shell:true,windowsHide:true});}catch(error){reject(error);return;}
    let stdout='',stderr='',done=false,timedOut=false;
    const append=(cur,chunk)=>{if(cur.length>=MAX_COMMAND_OUTPUT)return cur;const next=cur+chunk.toString('utf8');return next.length>MAX_COMMAND_OUTPUT?next.slice(0,MAX_COMMAND_OUTPUT)+'\n…[输出截断]':next;};
    const timer=setTimeout(()=>{timedOut=true;try{child.kill('SIGKILL');}catch{}},limit);
    child.stdout?.on('data',c=>{stdout=append(stdout,c);});child.stderr?.on('data',c=>{stderr=append(stderr,c);});
    child.once('error',e=>{if(done)return;done=true;clearTimeout(timer);reject(e);});
    child.once('close',(code,signal)=>{if(done)return;done=true;clearTimeout(timer);resolve({root:base,path:relativePath(base,dir),command:'npm',args,exitCode:code,signal,timedOut,stdout,stderr});});
  });
}export function officeStatus({root=null}={}){
  const base=officeRoot(root);
  const entries=readdirSync(base,{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>e.name).sort();
  return {root:base,dirs:entries,limits:{readBytes:MAX_READ,writeBytes:MAX_WRITE,list:MAX_LIST,scanFiles:MAX_SCAN_FILES,results:MAX_RESULTS}};
}
