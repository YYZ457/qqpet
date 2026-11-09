// 办公室插件：她自己写的工具扩展。插件是受控子进程，不拿 brain/QQ 凭据。
import {existsSync,mkdirSync,readFileSync,rmSync,renameSync,statSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {officeRoot} from './office.mjs';

const NAME=/^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/;
const MAX_OUTPUT=20000;
const fail=(code,message)=>Object.assign(new Error(message),{code});
function pluginDir(root,name){
  if(!NAME.test(String(name??'')))throw fail('PLUGIN_NAME','invalid plugin name');
  return join(root,'plugins',name);
}
function manifestAt(dir,expectedName=null){
  const file=join(dir,'manifest.json');
  if(!existsSync(file))throw fail('PLUGIN_MISSING','plugin manifest missing');
  let manifest;
  try{manifest=JSON.parse(readFileSync(file,'utf8'));}catch(error){throw fail('PLUGIN_MANIFEST',`invalid manifest: ${error.message}`);}
  if(!manifest||typeof manifest.name!=='string'||!NAME.test(manifest.name))throw fail('PLUGIN_MANIFEST','manifest name invalid');
  if(expectedName!==null&&manifest.name!==expectedName)throw fail('PLUGIN_MANIFEST','manifest name mismatch');
  if(typeof manifest.entry!=='string'||!manifest.entry)throw fail('PLUGIN_MANIFEST','entry required');
  const entry=resolve(dir,manifest.entry);
  if(!entry.startsWith(dir+sep)&&entry!==dir)throw fail('PLUGIN_PATH','entry escapes plugin directory');
  if(!existsSync(entry)||!statSync(entry).isFile())throw fail('PLUGIN_ENTRY','entry missing');
  if(!Array.isArray(manifest.actions)||manifest.actions.length>32)throw fail('PLUGIN_MANIFEST','actions array required');
  return {dir,entry,name:manifest.name,actions:[...new Set(manifest.actions.filter(a=>typeof a==='string'))],description:String(manifest.description??'').slice(0,500),version:String(manifest.version??'').slice(0,40)};
}
// 校验刚克隆下来的插件目录：manifest 名字必须和安装名一致（运行时按目录名找插件），且至少声明一个动作。
export function validateClonedPlugin(dir,pluginName){
  const manifest=manifestAt(dir,pluginName);
  if(!manifest.actions.length)throw fail('PLUGIN_MANIFEST','plugin declares no actions');
  return manifest;
}
function manifestOf(root,name){
  return manifestAt(pluginDir(root,name),name);
}export function listPlugins({root=null}={}){
  const base=officeRoot(root),dir=join(base,'plugins');
  if(!existsSync(dir))return {root:base,plugins:[]};
  const plugins=[];
  for(const name of (readdirSyncSafe(dir))){try{const m=manifestOf(base,name);plugins.push({name,version:m.version,description:m.description,actions:m.actions});}catch{}}
  return {root:base,plugins};
}
function readdirSyncSafe(dir){try{return readdirSync(dir);}catch{return [];}}
import {readdirSync} from 'node:fs';
export async function installPlugin({root=null,url,name=null,ref=null}={}){
  const base=officeRoot(root),raw=String(url??'');
  let parsed;try{parsed=new URL(raw);}catch{throw fail('PLUGIN_URL','invalid plugin URL');}
  if(parsed.protocol!=='https:'||parsed.hostname!=='github.com')throw fail('PLUGIN_URL','only public github.com HTTPS repositories are allowed');
  const parts=parsed.pathname.replace(/^\/+|\/+$/g,'').split('/').filter(Boolean);
  if(parts.length<2)throw fail('PLUGIN_URL','repository path required');
  const repoName=parts[1].replace(/\.git$/,'');
  const pluginName=name??repoName;
  if(!NAME.test(pluginName))throw fail('PLUGIN_NAME','invalid plugin name');
  if(ref!==null&&!/^[A-Za-z0-9._/-]{1,120}$/.test(String(ref)))throw fail('PLUGIN_REF','invalid ref');
  const dir=pluginDir(base,pluginName);
  if(existsSync(dir))throw fail('PLUGIN_EXISTS','plugin already installed');
  const pluginsDir=join(base,'plugins');mkdirSync(pluginsDir,{recursive:true});
  const tempName=`.install-${randomUUID()}`;const temp=join(pluginsDir,tempName);
  const {runOffice}=await import('./office.mjs');
  try{
    const args=['clone','--depth','1',...(ref?['--branch',String(ref)]:[]),raw,tempName];
    const result=await runOffice({root:base,command:'git',args,cwd:'.',timeoutMs:60000});
    if(result.exitCode!==0)throw fail('PLUGIN_CLONE',String(result.stderr||'git clone failed').slice(0,500));
    // 以前这里用 manifestOf(plugins 目录, …) 校验，内部又拼了一层 plugins，路径永远不存在，安装必然失败。
    const tempManifest=validateClonedPlugin(temp,pluginName);
    renameSync(temp,dir);
    return {name:pluginName,version:tempManifest.version,description:tempManifest.description,actions:tempManifest.actions,path:'plugins/'+pluginName};
  }catch(error){
    try{rmSync(temp,{recursive:true,force:true});}catch{}
    throw error;
  }
}export function runPlugin({root=null,name,action,args={},timeoutMs=20000}={}){
  const base=officeRoot(root),m=manifestOf(base,name);
  if(!m.actions.includes(action))throw fail('PLUGIN_ACTION','action not declared in manifest');
  if(!args||Object.getPrototypeOf(args)!==Object.prototype)throw fail('PLUGIN_INPUT','args object required');
  return new Promise((resolvePromise,reject)=>{
    const limit=Math.max(1,Math.min(30000,Number(timeoutMs)||20000));
    const env={PATH:process.env.PATH??'',SystemRoot:process.env.SystemRoot??'',TEMP:process.env.TEMP??'',TMP:process.env.TMP??'',OFFICE_PLUGIN_ROOT:base};
    let stdout='',stderr='',done=false,timedOut=false;
    const child=spawn(process.execPath,[m.entry,action,JSON.stringify(args)],{cwd:m.dir,env,shell:false,windowsHide:true});
    const append=(s,chunk)=>s.length>=MAX_OUTPUT?s:s+chunk.toString('utf8').slice(0,MAX_OUTPUT-s.length);
    const timer=setTimeout(()=>{timedOut=true;try{child.kill('SIGKILL');}catch{}},limit);
    child.stdout?.on('data',c=>{stdout=append(stdout,c);});
    child.stderr?.on('data',c=>{stderr=append(stderr,c);});
    child.once('error',error=>{if(done)return;done=true;clearTimeout(timer);reject(error);});
    child.once('close',(code,signal)=>{if(done)return;done=true;clearTimeout(timer);resolvePromise({plugin:name,action,exitCode:code,signal,timedOut,stdout,stderr});});
  });
}
