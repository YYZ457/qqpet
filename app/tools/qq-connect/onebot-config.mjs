// OneBot v11 连接配置解析。本工程只说标准 OneBot v11（WebSocket 收事件、HTTP 发动作），
// 不包含也不依赖任何具体实现的代码（SnowLuma / NapCat / LLOneBot 等都行）。
// 优先级：环境变量 → <data>/qq.json → 自动发现 SnowLuma 的 config → 默认端口(ws 3001 / http 3000)。
import {existsSync,readFileSync,readdirSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const app=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
export const dataDir=()=>process.env.AGENT_DATA?resolve(process.env.AGENT_DATA):null;

function fromFile(){
  const dir=dataDir();if(!dir)return null;
  const file=join(dir,'qq.json');if(!existsSync(file))return null;
  try{const j=JSON.parse(readFileSync(file,'utf8').replace(/^﻿/,''));return {ws:j.ws,http:j.http,token:j.token,source:'data/qq.json'};}catch{return null;}
}
function snowlumaHomes(){
  return [process.env.SNOWLUMA_HOME,resolve(app,'../SnowLuma/dist'),resolve(app,'../SnowLuma'),resolve(app,'../../SnowLuma/dist'),resolve(app,'../../SnowLuma')].filter(Boolean);
}
function fromSnowLuma(){
  for(const home of snowlumaHomes()){
    const dir=join(home,'config');if(!existsSync(dir))continue;
    const want=process.env.QQ_UIN?`onebot_${process.env.QQ_UIN}.json`:null;
    const names=readdirSync(dir),file=(want&&names.find(n=>n===want))??names.find(n=>/^onebot_\d+\.json$/.test(n));
    if(!file)continue;
    try{
      const nets=JSON.parse(readFileSync(join(dir,file),'utf8').replace(/^﻿/,'')).networks??{};
      const http=(nets.httpServers??[])[0],ws=(nets.wsServers??[])[0];
      return {uin:file.match(/\d+/)[0],source:`SnowLuma(${home})`,
        ws:ws?`ws://${ws.host&&ws.host!=='0.0.0.0'?ws.host:'127.0.0.1'}:${ws.port||3001}/`:undefined,wsToken:ws?.accessToken,
        http:http?`http://${http.host&&http.host!=='0.0.0.0'?http.host:'127.0.0.1'}:${http.port||3000}`:undefined,httpToken:http?.accessToken};
    }catch{}
  }
  return null;
}
export function resolveOneBot(env=process.env){
  const e=env.QQ_WS_URL||env.QQ_HTTP_URL||env.QQ_TOKEN?{ws:env.QQ_WS_URL,http:env.QQ_HTTP_URL,token:env.QQ_TOKEN,source:'environment'}:null;
  const f=e??fromFile();
  const s=fromSnowLuma();
  const pick=f??s??{source:'default'};
  const token=String(f?.token??s?.wsToken??s?.httpToken??'');
  return {
    ws:String(f?.ws??s?.ws??'ws://127.0.0.1:3001/'),
    http:String(f?.http??s?.http??'http://127.0.0.1:3000').replace(/\/+$/,''),
    wsToken:String(f?.token??s?.wsToken??token),httpToken:String(f?.token??s?.httpToken??token),
    uin:s?.uin??null,source:pick.source,
  };
}
