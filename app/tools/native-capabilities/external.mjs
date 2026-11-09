// 加载本仓库之外的原生能力模块（桌宠、MC 等）。
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export function notConfigured(name,vars){
  const error=new Error(`${name} capability is not configured; set ${vars}`);
  error.code='CAPABILITY_NOT_CONFIGURED';
  return error;
}
export async function loadExternal(modulePath,exportName){
  const mod=await import(pathToFileURL(resolve(modulePath)).href);
  if(typeof mod[exportName]!=='function')throw Object.assign(new Error(`${modulePath} does not export ${exportName}`),{code:'CAPABILITY_MODULE'});
  return mod;
}
