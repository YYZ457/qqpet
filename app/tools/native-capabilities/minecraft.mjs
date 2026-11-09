// 原生 MC：复用外部的 MinecraftLink/协议（不在本仓库里）。
// 以前写死了作者本机的 ../../../整理版_2026-10-16/... 路径；现在通过配置指向外部模块。
//   THREADLINE_MINECRAFT_LINK    minecraft-link.js 的路径（导出 MinecraftLink）
//   THREADLINE_MINECRAFT_DIR     minecraft-companion 目录
//   THREADLINE_MINECRAFT_CONFIG  可选，含 {"minecraft":{...}} 的 JSON 配置文件
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {loadExternal,notConfigured} from './external.mjs';

let link=null;
async function getLink(){
  if(link)return link;
  const modulePath=process.env.THREADLINE_MINECRAFT_LINK,directory=process.env.THREADLINE_MINECRAFT_DIR;
  if(!modulePath||!directory)throw notConfigured('minecraft','THREADLINE_MINECRAFT_LINK and THREADLINE_MINECRAFT_DIR');
  const {MinecraftLink}=await loadExternal(modulePath,'MinecraftLink');
  const configFile=process.env.THREADLINE_MINECRAFT_CONFIG;
  const cfg=configFile?JSON.parse(readFileSync(resolve(configFile),'utf8')).minecraft??{}:{};
  link=new MinecraftLink({
    directory:resolve(directory),
    getConfig:()=>({...cfg,enabled:true,supportEnabled:false,backend:'native',host:'127.0.0.1',port:Number(cfg.port??34824),version:String(cfg.version??'26.1'),username:String(cfg.username??'Agent'),ownerUsername:String(cfg.ownerUsername??'Owner')}),
    allowed:()=>true,busy:()=>false,onBatch:async()=>false,
    log:message=>console.error('[mc-native]',String(message).slice(0,300)),
  });
  return link;
}
export async function runMinecraft(input={}){
  const action=input.action??'status';
  if(action==='status'&&(!process.env.THREADLINE_MINECRAFT_LINK||!process.env.THREADLINE_MINECRAFT_DIR))return {configured:false};
  const l=await getLink();
  if(action==='status')return l.status();
  if(action==='catalog')return l.request({action:'catalog',name:input.name});
  if(action==='call')return l.request({action:'call',name:input.name,args:input.args??{},requestId:input.requestId});
  if(action==='start')return l.start();
  if(action==='stop')return l.stop();
  throw new Error('unknown minecraft action');
}
