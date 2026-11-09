import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {NecklaceMailbox} from './necklace-mailbox.js';
import {NecklaceAlbum} from './necklace-album.js';
import {necklaceAppearance} from './necklace-appearance.js';

export const NECKLACE_GIFT_AT = Date.parse('2026-10-28T00:00:00+08:00');
const fresh = () => ({ wearing:false, opened:false, inspecting:false, view:'object', light:{on:false,color:'ocean',brightness:0.35}, nightLight:true, zoom:1, memories:[] });
const copy = value => structuredClone(value);
const idOk = id => typeof id==='string' && /^[a-zA-Z0-9-]{1,80}$/.test(id);
const lightColors = ['ocean','ice','starlight'];

// A possession, not a personality or a memory store. Preview never becomes a gift.
export class Necklace {
  constructor({file, ownerKey, memory, experiences, journal, audit=()=>{}, canReadMemory=()=>true, now=Date.now}={}) {
    Object.assign(this,{file,ownerKey,memory,experiences,journal,audit,canReadMemory,now});
    this.mailbox=new NecklaceMailbox({file:path.join(path.dirname(file),'necklace-mailbox.sqlite'),now:()=>this.now(),audit});
    this.album=new NecklaceAlbum({directory:path.join(path.dirname(file),'necklace-album'),now:()=>this.now(),audit});
    this.amuletStatus=()=>({active:false,verified:false,hint:'护身符模组尚未连接'});
    this.data={version:1,revision:0,presentedAt:null,state:fresh(),preview:fresh()};
    this.available=true;
    try {
      if(fs.existsSync(file)) {
        if(fs.statSync(file).size>64000)throw Error('项链文件过大');
        const saved=JSON.parse(fs.readFileSync(file,'utf8'));
        if(saved.version!==1||!Number.isSafeInteger(saved.revision)||!(saved.presentedAt===null||Number.isFinite(saved.presentedAt)))throw Error('项链版本不支持');
        this.validate(saved.state);this.validate(saved.preview);this.data=saved;
      } else if(fs.existsSync(file+'.initialized'))throw Error('项链记录丢失');
    } catch {this.available=false;}
  }
  validate(s) {
    if(s?.mcWearCommand&&(!/^[a-f0-9-]{36}$/.test(s.mcWearCommand.id)||typeof s.mcWearCommand.wearing!=='boolean'||!Number.isSafeInteger(s.mcWearCommand.at)))throw Error('MC穿戴请求损坏');
    if(s?.amulet&&(!['light','keepInventory','mobVeil'].every(k=>typeof s.amulet[k]==='boolean')))throw Error('护身符开关损坏');
    if(!s||!['wearing','opened','inspecting'].every(k=>typeof s[k]==='boolean')||!['object','starfield','memories','mailbox'].includes(s.view)
      ||!(s.nightLight===undefined||typeof s.nightLight==='boolean')
      ||!s.light||typeof s.light.on!=='boolean'||!lightColors.includes(s.light.color)||!Number.isFinite(s.light.brightness)||s.light.brightness<0||s.light.brightness>1
      ||!Number.isFinite(s.zoom)||s.zoom<1||s.zoom>4||!Array.isArray(s.memories)||s.memories.length>20)throw Error('项链状态损坏');
    for(const r of s.memories)if(!idOk(r.id)||!['self','event','thought'].includes(r.kind)||!Number.isSafeInteger(r.revision)||r.revision<1||typeof r.title!=='string'||r.title.length>60)throw Error('项链收藏损坏');
  }
  ready(){if(!this.available)throw Error('项链记录暂不可用，原文件保留，未清空重建');}
  presented(){return this.available&&this.data.presentedAt!==null;}
  persist(next) {
    if(Buffer.byteLength(JSON.stringify(next))>64000)throw Error('项链收藏空间已满');
    this.validate(next.state);this.validate(next.preview);
    fs.mkdirSync(path.dirname(this.file),{recursive:true});
    const temp=this.file+'.tmp-'+crypto.randomUUID();
    try {
      fs.writeFileSync(temp,JSON.stringify(next,null,2)+'\n',{mode:0o600});
      const fd=fs.openSync(temp,'r+');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      if(fs.existsSync(this.file))fs.copyFileSync(this.file,this.file+'.bak');
      fs.renameSync(temp,this.file);
      if(!fs.existsSync(this.file+'.initialized'))fs.writeFileSync(this.file+'.initialized','necklace-v1\n',{flag:'wx',mode:0o600});
      this.data=next;
    } finally {try{fs.unlinkSync(temp);}catch{}}
  }
  publicState() {
    if(!this.presented())return null;
    const state=copy(this.data.state);
    return {id:'blue-gem-v2',revision:this.data.revision,presentedAt:this.data.presentedAt,...state,
      location:state.inspecting?'held':state.wearing?'worn':'box',mailbox:this.mailboxStatus('gift')};
  }
  mailboxStatus(scope){try{return {unreadForJingyang:this.mailbox.summary(scope,'jingyang').unread,unreadForOwner:this.mailbox.summary(scope,'owner').unread};}catch{return {available:false};}}
  context() {
    if(!this.presented())return '';
    return '【随身物品】哥哥已通过实际赠送操作送给你一条蓝色晶石项链，收到时间为'+new Date(this.data.presentedAt).toISOString()+'。佩戴、取下、打开、检视和内部功能由你按兴趣选择，可用qq_necklace工具；不必每轮调用，也不因此改写人设或编造生日经历。在MC里它是占用头盔栏的真实蓝晶项链，可手动从背包装备，或用qq_necklace_wear发起穿脱；以amulet的新鲜回执和equippedInHelmetSlot为准，不凭桌宠佩戴状态判断MC效果。拿起检视或appearance会返回外观参考图片；打开项链或starfield会返回内部星海图片，收到图后才描述实际看见的内容。想认识自己的外貌，可在相册list查找个人形象参考，再read看图，不把设定图当生活往事。';
  }
  status(preview=false) {
    this.ready();const state=copy(preview?this.data.preview:this.data.state);
    return {available:true,preview,revision:this.data.revision,presented:this.presented(),presentedAt:this.data.presentedAt,
      canPresent:this.now()>=NECKLACE_GIFT_AT&&!this.presented(),giftDate:'2026-10-28',state:{...state,location:state.inspecting?'held':state.wearing?'worn':'box'},
      public:this.publicState(),features:['appearance','starfield','light','memories','mailbox','album','amulet'],mailbox:this.mailboxStatus(preview?'preview':'gift'),amulet:{settings:state.amulet||{light:true,keepInventory:true,mobVeil:true},...(preview?{active:false,verified:false,preview:true,hint:'仅预览，MC效果在正式赠送、佩戴并加载模组后才可生效。'}:this.amuletStatus())},
      animation:{characterClipsAvailable:false,kind:'jewelry-object-transition',hint:'开合、佩戴显示和放大是物品表现；没有专门的戴取／拿起肢体动画，不伪称已经播放。'}};
  }
  memoryItem(kind,id) {
    if(!this.canReadMemory(kind))throw Error('对应记忆功能目前已关闭');
    let item;
    if(kind==='self') {
      if(this.memory?.enabled===false)throw Error('原记忆已关闭');
      const e=this.memory?.store.data.self.entries.find(e=>e.id===id);
      if(e)item={id:e.id,kind,revision:e.revision||1,title:(e.summary||e.fact).slice(0,60),body:e.fact,caution:'这是已有自我记忆，按原来源与时间理解，不证明所有叙述已独立核实。'};
    } else if(kind==='event'&&this.experiences?.enabled()) {
      const e=this.experiences.entries(this.ownerKey).find(e=>e.id===id);
      if(e)item={id:e.id,kind,revision:e.version,title:e.summary.slice(0,60),body:e.summary,caution:e.caution};
    } else if(kind==='thought') {
      const e=this.journal?.notes(this.ownerKey).find(e=>e.id===id);
      if(e)item={id:e.id,kind,revision:e.version,title:e.thought.slice(0,60),body:e.thought,caution:'个人理解可以改变，不是人物事实。'};
    }
    if(!item)throw Error('这段记忆已不可用或不在项链可引用范围内');
    this.audit(item.body);return item;
  }
  candidates() {
    const refs=[
      ...(this.memory?.enabled===false?[]:this.memory?.store.data.self.entries||[]).filter(e=>e.meta?.temporal!=='past').map(e=>({kind:'self',id:e.id})),
      ...(this.experiences?.enabled()?this.experiences.entries(this.ownerKey):[]).map(e=>({kind:'event',id:e.id})),
      ...(this.journal?.db?this.journal.notes(this.ownerKey):[]).map(e=>({kind:'thought',id:e.id})),
    ];
    return refs.slice(-60).reverse().flatMap(ref=>{try{const {body,...view}=this.memoryItem(ref.kind,ref.id);return [view];}catch{return [];}});
  }
  request(input={}, {actor='agent'}={}) {
    this.ready();if(!['agent','operator'].includes(actor))throw Error('项链调用来源无效');
    const action=String(input.action||'status');
    if(action==='public'){if(actor!=='operator')throw Error('项链尚不可用');return {public:this.publicState()};}
    if(action==='present'){
      if(actor!=='operator')throw Error('赠送只由哥哥在本机操作');
      if(this.presented())return this.status(false);
      if(this.now()<NECKLACE_GIFT_AT)throw Error('现在只预览；生日当天再由哥哥亲手送出');
      const next=copy(this.data);next.presentedAt=this.now();next.state=fresh();next.revision++;this.persist(next);
      return {...this.status(false),stateSaved:true};
    }
    if(actor==='agent'&&!this.presented())throw Error('这件随身物品当前尚不可用');
    const preview=actor==='operator'&&(input.preview===true||!this.presented());
    if(action==='status')return this.status(preview);
    if(action==='feature'&&input.feature==='appearance'){const s=preview?this.data.preview:this.data.state;return {...this.status(preview),...necklaceAppearance(s.opened?'opened':'closed',{zoom:s.zoom}),stateSaved:false};}
    if(action==='feature'&&input.feature==='album'){
      if(!(preview?this.data.preview:this.data.state).opened)throw Error('先打开项链，再使用相册');
      return this.album.request(input,{scope:preview?'preview':'gift',actor}).then(result=>{if(actor==='agent'&&!this.presented())throw Error('项链权限已变化');return {...this.status(preview),...result,stateSaved:true};});
    }
    if(!['open','wear','inspect','feature'].includes(action))throw Error('未知项链动作');
    const next=copy(this.data),state=preview?next.preview:next.state;
    let result={};
    if(action==='open'){
      if(typeof input.opened!=='boolean')throw Error('需要明确打开或合上');
      state.opened=input.opened;if(!state.opened)state.view='object';else result=necklaceAppearance('opened',{zoom:state.zoom});
    } else if(action==='wear'){
      if(typeof input.wearing!=='boolean')throw Error('需要明确佩戴或取下');
      state.wearing=input.wearing;if(!preview)state.mcWearCommand={id:crypto.randomUUID(),wearing:input.wearing,at:this.now()};state.inspecting=false;state.opened=false;state.view='object';
    } else if(action==='inspect'){
      if(typeof input.inspecting!=='boolean')throw Error('需要明确开始或结束检视');
      state.inspecting=input.inspecting;if(state.inspecting)result=necklaceAppearance(state.opened?'opened':'closed',{zoom:state.zoom});if(!state.inspecting){state.opened=false;state.view='object';state.zoom=1;}
    } else {
      if(!state.opened)throw Error('先打开项链，再使用内部功能');
      if(input.feature==='starfield'){
        if(input.zoom!==undefined&&(!Number.isFinite(input.zoom)||input.zoom<1||input.zoom>4))throw Error('放大倍数为1至4');
        state.view='starfield';state.zoom=input.zoom??state.zoom;result=necklaceAppearance('starfield',{zoom:state.zoom});
      } else if(input.feature==='light'){
        if(input.nightLight!==undefined&&typeof input.nightLight!=='boolean')throw Error('夜间微光开关必须明确');
        if(input.nightLight!==undefined)state.nightLight=input.nightLight;
        if(input.on!==undefined&&typeof input.on!=='boolean')throw Error('微光开关必须明确');
        if(input.color!==undefined&&!lightColors.includes(input.color))throw Error('请选择海蓝、冰蓝或星光色');
        if(input.brightness!==undefined&&(!Number.isFinite(input.brightness)||input.brightness<0||input.brightness>1))throw Error('亮度为0至1');
        state.light={on:input.on??state.light.on,color:input.color??state.light.color,brightness:input.brightness??state.light.brightness};
      } else if(input.feature==='amulet'){
        if(actor!=='operator'&&preview)throw Error('预览仅哥哥可用');
        const settings={...(state.amulet||{light:true,keepInventory:true,mobVeil:true})};
        for(const k of ['light','keepInventory','mobVeil'])if(input[k]!==undefined){if(typeof input[k]!=='boolean')throw Error('护身符开关需要明确');settings[k]=input[k];}state.amulet=settings;
      } else if(input.feature==='mailbox'){
        state.view='mailbox';result=this.mailbox.request(input,{scope:preview?'preview':'gift',viewer:actor==='agent'?'jingyang':'owner'});
      } else if(input.feature==='memories'){
        state.view='memories';const operation=input.operation||'list';
        if(operation==='candidates')result.candidates=this.candidates();
        else if(operation==='list')result.memories=state.memories.map(r=>{try{const item=this.memoryItem(r.kind,r.id);return item.revision===r.revision?{...r,valid:true}:{...r,valid:false,caution:'原记忆已修订，请重新查看并选择收藏，不沿用旧版本'};}catch{return {...r,valid:false,caution:'原记忆已不可用，收藏不会复活旧内容'};}});
        else if(!idOk(input.memoryId)||!['self','event','thought'].includes(input.memoryKind))throw Error('请选择已有记忆');
        else if(operation==='remove')state.memories=state.memories.filter(r=>r.id!==input.memoryId||r.kind!==input.memoryKind);
        else if(operation==='add'){
          const item=this.memoryItem(input.memoryKind,input.memoryId);
          if(state.memories.length>=20&&!state.memories.some(r=>r.id===item.id&&r.kind===item.kind))throw Error('项链最多收藏二十段回忆');
          state.memories=state.memories.filter(r=>r.id!==item.id||r.kind!==item.kind);
          state.memories.push({id:item.id,kind:item.kind,revision:item.revision,title:item.title});
        } else if(operation==='read'){
          const ref=state.memories.find(r=>r.id===input.memoryId&&r.kind===input.memoryKind);
          if(!ref)throw Error('这段记忆尚未收藏');
          const item=this.memoryItem(ref.kind,ref.id);if(item.revision!==ref.revision)throw Error('原记忆已修订，请重新查看和收藏');
          result.memory=item;
        } else throw Error('未知收藏操作');
      } else throw Error('未开放这项项链功能');
    }
    next.revision++;this.persist(next);
    return {...this.status(preview),...result,stateSaved:true,modelCalls:0};
  }
}
