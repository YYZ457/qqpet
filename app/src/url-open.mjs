// 显式打开 URL/API：必须给白名单；只取文本、限长、超时；不自动调用。
import {ensure,text} from './contracts.mjs';

const MAX_TEXT=64*1024;
export async function openUrl({url,allowlist=[],fetchImpl=fetch,timeoutMs=10000,maxBytes=MAX_TEXT}={}){
  text(url,'url');ensure(/^https?:\/\//.test(url),'URL_OPEN','http(s) url required');
  ensure(Array.isArray(allowlist)&&allowlist.length>0,'URL_ALLOWLIST','explicit allowlist required');
  const host=new URL(url).hostname.toLowerCase();
  ensure(allowlist.some(a=>host===String(a).toLowerCase()||host.endsWith('.'+String(a).toLowerCase())),'URL_ALLOWLIST','host not allowlisted');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const response=await fetchImpl(url,{method:'GET',redirect:'error',signal:controller.signal});
    ensure(response.ok,'URL_HTTP',`http ${response.status}`);
    const raw=await response.text();ensure(Buffer.byteLength(raw,'utf8')<=maxBytes,'URL_LIMIT','response too large');
    return {text:raw,maxBytes};
  }finally{clearTimeout(timer);}
}
