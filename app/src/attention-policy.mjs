// 注意力闸门：屏蔽某个来源/聊天框的“唤醒”，但事件仍进同一个记忆库；
// 解除屏蔽时可以按时间批量补进工作台。不是新上下文，不创建新 driver。
import {existsSync,mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {ensure,text,time} from './contracts.mjs';

const MAX_BACKLOG=2000;
const norm=prefix=>{text(prefix,'attention prefix');return String(prefix).replace(/\/+$/,'');};
export class AttentionPolicy {
  constructor({file=null}={}){this.file=file;this.prefixes=[];this.backlog=[];this.load();}
  load(){
    if(!this.file||!existsSync(this.file))return;
    try{const j=JSON.parse(readFileSync(this.file,'utf8'));if(Array.isArray(j.prefixes))this.prefixes=[...new Set(j.prefixes.filter(x=>typeof x==='string'))];if(Array.isArray(j.backlog))this.backlog=j.backlog.filter(x=>x&&typeof x.id==='string'&&typeof x.scene==='string').slice(-MAX_BACKLOG);}catch{}
  }
  save(){
    if(!this.file)return;
    mkdirSync(dirname(this.file),{recursive:true});
    const tmp=this.file+'.tmp';
    writeFileSync(tmp,JSON.stringify({prefixes:this.prefixes,backlog:this.backlog}),'utf8');
    renameSync(tmp,this.file);
  }
  matches(scene){const s=String(scene??'');return this.prefixes.some(p=>s===p||s.startsWith(p+'/'));}
  mute(prefix){const p=norm(prefix);if(!this.prefixes.includes(p))this.prefixes.push(p);this.save();return this.status();}
  unmute(prefix){const p=norm(prefix);this.prefixes=this.prefixes.filter(x=>x!==p);this.save();return this.status();}
  add({id,scene,at}){if(!this.backlog.some(x=>x.id===id)){this.backlog.push({id,scene,at:Number.isSafeInteger(at)?at:Date.now()});if(this.backlog.length>MAX_BACKLOG)this.backlog=this.backlog.slice(-MAX_BACKLOG);this.save();}}
  take(prefix,limit=50){const p=norm(prefix);const chosen=this.backlog.filter(x=>x.scene===p||x.scene.startsWith(p+'/')).sort((a,b)=>a.at-b.at||a.id.localeCompare(b.id)).slice(0,Math.max(1,Math.min(200,Number(limit)||50)));const ids=new Set(chosen.map(x=>x.id));this.backlog=this.backlog.filter(x=>!ids.has(x.id));this.save();return chosen;}
  status(){return {format:'attention-policy-v1',prefixes:[...this.prefixes],backlog:this.backlog.length};}
}
