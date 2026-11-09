// 原生桌宠：复用外部的 DesktopLink/动画协议（不在本仓库里）。
// 以前这里 import 了作者本机的 ../../../整理版_2026-10-16/... 路径，别人一调用就崩。
// 现在通过配置指向外部模块；没配置时返回明确的“未配置”错误。
//   THREADLINE_DESKTOP_LINK  desktop-link.js 的路径（导出 DesktopLink）
//   THREADLINE_DESKTOP_DIR   desktop-companion 目录
import {join,resolve} from 'node:path';
import {loadExternal,notConfigured} from './external.mjs';

let link=null;
async function getLink(){
  if(link)return link;
  const modulePath=process.env.THREADLINE_DESKTOP_LINK,directory=process.env.THREADLINE_DESKTOP_DIR;
  if(!modulePath||!directory)throw notConfigured('desktop','THREADLINE_DESKTOP_LINK and THREADLINE_DESKTOP_DIR');
  const {DesktopLink}=await loadExternal(modulePath,'DesktopLink');
  link=new DesktopLink({directory:resolve(directory),logDirectory:join(resolve(process.env.AGENT_DATA??'data'),'logs','desktop'),
    enabled:()=>true,renderer:()=>'animation'});
  return link;
}
export async function runDesktop(input={}){
  const action=input.action??'status';
  if(action==='status'&&(!process.env.THREADLINE_DESKTOP_LINK||!process.env.THREADLINE_DESKTOP_DIR))return {configured:false};
  const l=await getLink();
  if(action==='status')return l.status();
  if(action==='start')return l.start();
  if(action==='stop')return l.stop();
  return l.request(action,input.args??{});
}
