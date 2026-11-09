// 说话风格包：她的语言层，独立于记忆/B/C/R/Z；可版本化、可切换、可删除。
import {existsSync,mkdirSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

const MAX=16000;
export class StyleStore {
  constructor({directory}={}){this.directory=directory;this.meta={version:1,active:null,items:[]};if(!directory)return;this.index=join(directory,'index.json');this.packs=join(directory,'packs');this.load();}
  load(){
    if(!this.directory)return;
    mkdirSync(this.packs,{recursive:true});
    if(existsSync(this.index)){try{const value=JSON.parse(readFileSync(this.index,'utf8'));if(value&&Array.isArray(value.items))this.meta={version:1,active:value.active??null,items:value.items.filter(x=>x&&typeof x.id==='string')};}catch{}}
    if(!this.meta.active||!this.meta.items.some(x=>x.id===this.meta.active))this.meta.active=this.meta.items.at(-1)?.id??null;
  }
  save(){if(!this.directory)return;mkdirSync(this.packs,{recursive:true});writeFileSync(this.index,JSON.stringify(this.meta,null,2),'utf8');}
  active(){return this.meta.items.find(x=>x.id===this.meta.active)??null;}
  text(){const item=this.active();if(!item)return '';try{return readFileSync(join(this.packs,`${item.id}.md`),'utf8').trim();}catch{return '';}}
  update({text,label='',source='manual'}={}){
    const body=String(text??'').trim();
    if(body.length<200||body.length>MAX)throw Error(`style text must be 200..${MAX} chars`);
    const id=`style-${Date.now()}-${randomUUID().slice(0,8)}`;
    mkdirSync(this.packs,{recursive:true});
    writeFileSync(join(this.packs,`${id}.md`),body+'\n','utf8');
    this.meta.items.push({id,label:String(label??'').slice(0,120),source:String(source??'').slice(0,120),createdAt:Date.now()});
    this.meta.active=id;this.save();return this.status();
  }
  remove(id){
    const item=this.meta.items.find(x=>x.id===id);if(!item)throw Error('style pack not found');
    this.meta.items=this.meta.items.filter(x=>x.id!==id);
    try{rmSync(join(this.packs,`${id}.md`),{force:true});}catch{}
    if(this.meta.active===id)this.meta.active=this.meta.items.at(-1)?.id??null;
    this.save();return this.status();
  }
  status(){const active=this.active();return {format:'style-store-v1',active:active?{id:active.id,label:active.label,source:active.source,createdAt:active.createdAt,chars:(this.text()??'').length}:null,items:this.meta.items.map(x=>({id:x.id,label:x.label,source:x.source,createdAt:x.createdAt}))};}
}
