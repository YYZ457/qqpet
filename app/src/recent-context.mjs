// 最近上下文：她“刚刚各处发生了什么”的视图。有当前聊天时组织成会话面板，没有时按时间合并。
// 与长期记忆分开：这里只回答“刚刚各处发生了什么”，不做摘要。
import {refKey} from './contracts.mjs';

const MAX_BYTES=32000; // 默认值；实际预算由 limits.recentBytes 传入，超预算时 turn-driver 会自动缩小再试
const clip=(text,max=300)=>{const s=String(text??'').replace(/\s+/g,' ').trim();return s.length<=max?s:s.slice(0,max)+'…';};
const SELF_ACTION_TOOLS=new Set(['qq_send_message','qq_send_private_message','qq_send_group_message','qq_send_sticker','qq_send_voice','qq_speak','qq_send_poke','remember_note']);
const ownAction=tool=>SELF_ACTION_TOOLS.has(tool)||String(tool).startsWith('office_')||String(tool).startsWith('task_')||String(tool).startsWith('github_');
function actionScene(store,action){
  const args=action?.args??{};
  const id=args.id??args.user_id??args.group_id;
  if(args.target==='group'&&id)return `qq/group/${id}`;
  if(args.target==='private'&&id)return `qq/private/${id}`;
  for(const ref of action?.inputRefs??[]){try{const e=store.read(ref.id,ref.revision);if(e?.scene)return e.scene;}catch{}}
  return action?.scene??null;
}
function actionText(action){
  const args=action?.args??{},failed=action?.status==='failed',uncertain=action?.status==='uncertain';
  let text='';
  if(action.tool==='remember_note')text=`记下：${clip(args.body??'',180)}`;
  else if(action.tool==='qq_send_sticker')text='[表情]';
  else if(action.tool==='qq_send_voice')text='[语音]';
  else if(action.tool==='qq_speak')text=`[语音] ${clip(args.text??'',180)}`;
  else if(action.tool==='qq_send_poke')text='[戳一戳]';
  else if(action.tool==='office_write')text=`写办公室：${clip(args.path??'',120)}`;
  else if(action.tool==='office_read')text=`读办公室：${clip(args.path??'',120)}`;
  else if(action.tool==='office_edit')text=`改办公室：${clip(args.path??'',120)}`;
  else if(action.tool==='office_list')text=`列办公室：${clip(args.path??'.',120)}`;
  else if(action.tool==='office_search')text=`搜办公室：${clip(args.query??'',120)}`;
  else if(action.tool==='task_create')text=`建任务：${clip(args.goal??'',180)}`;
  else if(action.tool==='task_update')text=`更新任务：${clip(args.id??'',80)}`;
  else if(action.tool==='task_list')text='看自己的任务';
  else if(action.tool==='task_get')text=`看任务：${clip(args.id??'',80)}`;
  else if(action.tool==='github_status')text='看GitHub配置';
  else if(action.tool==='github_repo')text='看GitHub仓库';
  else if(action.tool==='github_issues')text='看GitHub issue列表';
  else if(action.tool==='github_issue')text=`看GitHub issue #${args.number??''}`;
  else if(action.tool==='github_pulls')text='看GitHub PR列表';
  else if(action.tool==='github_branches')text='看GitHub分支';
  else if(action.tool==='github_create_branch')text=`开GitHub分支：${clip(args.branch??'',120)}`;
  else if(action.tool==='github_put_file')text=`写GitHub文件：${clip(args.path??'',120)} @ ${clip(args.branch??'',80)}`;
  else if(action.tool==='github_create_pr')text=`开PR：${clip(args.title??'',120)}`;
  else text=clip(args.text??args.message??'',300);
  return `${uncertain?'[结果未知] ':failed?'[未发出] ':''}${text}`.trim();
}
// 会话面板（recent-context-v2）：像一个人挂着 QQ——
//   here   当前打开的聊天：完整的最近记录（她自己说的、对方说的、她做的动作）
//   chats  所有其他活跃会话：未读几条、最后谁说的、是不是在等她回、她上一句发出去没有、最近几条预览
// 规模全部来自参数（limits.mjs），超出字节预算时先缩其他会话的预览，最后才缩当前聊天。
export function recentContext({store,subjectId,currentEvent=null,scene=null,items:hereLimit,limit,bytes=MAX_BYTES,
  chats:chatLimit=24,chatTail=8,chatWindowMs=48*3600000,now=Date.now()}={}){
  hereLimit=hereLimit??limit??50;
  const all=collectItems({store,subjectId,currentEvent});
  if(scene===null)return legacyView(all,hereLimit,bytes);

  // 未读：收件箱里还没处理的观察，按会话统计
  const unread=new Map(),pendingIds=new Set();
  for(const entry of pendingInbox(store,subjectId)){
    if(currentEvent&&entry.eventId===currentEvent.id)continue;
    pendingIds.add(entry.eventId);
    let ev=null;try{ev=store.read(entry.eventId);}catch{}
    const key=ev?.scene??null;if(!key)continue;
    unread.set(key,(unread.get(key)??0)+1);
  }
  const byScene=new Map();
  for(const item of all){
    const key=item.scene??scene; // 没有场景的自身动作（比如记笔记）算在当前聊天
    if(!byScene.has(key))byScene.set(key,[]);
    byScene.get(key).push(item);
  }
  let here=(byScene.get(scene)??[]).slice(-Math.max(1,hereLimit)).map(x=>!x.self&&pendingIds.has(x.ref.id)?{...x,unread:true}:x);
  byScene.delete(scene);
  for(const key of unread.keys())if(key!==scene&&!byScene.has(key))byScene.set(key,[]);

  let chats=[...byScene.entries()].map(([key,list])=>chatEntry(key,list,unread.get(key)??0))
    .filter(c=>c.unread>0||now-(c.lastAt??0)<=chatWindowMs)
    .sort((a,b)=>(b.unread>0)-(a.unread>0)||(b.lastAt??0)-(a.lastAt??0)||a.scene.localeCompare(b.scene));
  const omittedChats=Math.max(0,chats.length-chatLimit);
  chats=chats.slice(0,chatLimit);
  // 预览条数按活跃度分配：越靠前（有未读/最近有动静）给得越多
  chats=chats.map((c,i)=>{const tail=Math.max(chatTail>0?1:0,Math.ceil(chatTail*(i<3?1:i<8?0.6:0.35)));
    const list=byScene.get(c.scene)??[];return {...c,tail:list.slice(-tail),omitted:Math.max(0,list.length-tail)};});

  const size=()=>Buffer.byteLength(JSON.stringify({here,chats}));
  // 超预算：先从排得最靠后的会话开始砍预览，再砍当前聊天最旧的记录
  for(let i=chats.length-1;size()>bytes&&i>=0;i--){
    while(chats[i].tail.length>1&&size()>bytes){chats[i].tail.shift();chats[i].omitted++;}
  }
  while(here.length>1&&size()>bytes)here=here.slice(1);
  return {format:'recent-context-v2',scope:'current-chat-plus-session-list',scene,
    here:{scene,label:streamLabel(scene),count:here.length,unread:here.filter(x=>x.unread).length,items:here},
    chats,omittedChats,
    meaning:'here=the-chat-you-are-answering; chats=other-live-sessions-you-can-see-like-a-qq-session-list; tails-are-recent-not-complete'};
}

function pendingInbox(store,subjectId,maxPages=5){
  const out=[];let afterSeq=0;
  for(let i=0;i<maxPages;i++){const page=store.subjectInbox({subjectId,afterSeq,limit:100,pendingOnly:true});out.push(...page.items);if(page.next===null)break;afterSeq=page.next;}
  return out;
}
function chatEntry(scene,list,unread){
  const last=list.at(-1)??null,lastSelf=[...list].reverse().find(x=>x.self)??null,lastOther=[...list].reverse().find(x=>!x.self)??null;
  return {scene,label:streamLabel(scene),kind:scene.startsWith('qq/group/')?'group':scene.startsWith('qq/private/')?'private':scene.split('/')[0]||'other',
    unread,lastAt:last?.at??null,lastSpeaker:last?(last.self?'self':'other'):null,
    // 最后一句是别人说的，而且她还没处理完：像 QQ 里“有人在等你回”
    waitingOnYou:unread>0||(last!==null&&!last.self),
    yourLastMessage:lastSelf?{text:lastSelf.text,status:lastSelf.status??null,at:lastSelf.at}:null,
    lastFromOthersAt:lastOther?.at??null};
}
function streamLabel(scene){
  const parts=String(scene??'').split('/');
  if(parts[0]==='qq'&&parts[1]==='group')return `群 ${parts.slice(2).join('/')}`;
  if(parts[0]==='qq'&&parts[1]==='private')return `私聊 ${parts.slice(2).join('/')}`;
  return parts.join('·');
}
function legacyView(items,limit,bytes){
  // 没有当前聊天（反思/任务唤醒）：按时间合并所有来源，和旧行为一致
  let selected=items.slice(-Math.max(1,Math.min(200,limit)));
  let size=Buffer.byteLength(JSON.stringify(selected));
  while(selected.length>1&&size>bytes){size-=Buffer.byteLength(JSON.stringify(selected[0]))+1;selected=selected.slice(1);}
  return {format:'recent-context-v1',scope:'all-sources',count:selected.length,items:selected};
}

function collectItems({store,subjectId,currentEvent}){
  const items=[];
  for(const event of store.all('event')){
    if(!['observed','reported'].includes(event.origin))continue;
    if(currentEvent&&event.id===currentEvent.id)continue; // 当前这条已单独作为 currentEvent 进入输入，不重复
    const raw=String(event.body??'');
    const unavailable=/(^|\n)\[图片\]\s*$/.test(raw.trim())&&!raw.includes('[图片内容');
    const isSelf=event.actor===subjectId||event.sender?.id===subjectId||event.sender?.isSelf===true;
    items.push({at:event.occurredAt??event.recordedAt,role:isSelf?'self':'user',author:isSelf?'self':'other',self:isSelf,source:event.source?.system??null,scene:event.scene,sender:event.sender??null,
      ...(unavailable?{imageUnavailable:true}:{}),text:unavailable?'[旧图片记录：当时未接入看图，内容不可用]':clip(raw),ref:{id:event.id,revision:event.revision}});
  }
  const responseScene=response=>{
    try{const d=store.read(response.decision?.id);const e=d?.currentEvent?store.read(d.currentEvent.id):null;if(e?.scene)return e.scene;}catch{}
    return response.scene??null;
  };
  for(const response of store.all('response')){
    if(response.subject!==subjectId||!response.body)continue;
    // response 每次改状态（认领/送达）都会重写 recordedAt；排序要用她“说出口”的首个版本时间，否则送达后会跳到最后
    let first=null;try{first=store.read(response.id,1);}catch{}
    const at=response.sentAt??response.createdAt??first?.createdAt??first?.recordedAt??response.recordedAt;
    items.push({at,role:'self',author:'self',self:true,kind:'message',scene:responseScene(response),text:clip(response.body),status:response.status,ref:{id:response.id,revision:response.revision}});
  }
  for(const action of store.all('action')){
    if((action.subject&&action.subject!==subjectId)||!ownAction(action.tool))continue;
    if(!['succeeded','failed','uncertain'].includes(action.status))continue;
    const text=actionText(action);
    if(!text)continue;
    let result=null;
    if(action.receipt){try{const receipt=store.read(action.receipt.id,action.receipt.revision);if(receipt?.body)result=clip(receipt.body,240);}catch{}}
    items.push({at:action.recordedAt,role:'self',author:'self',self:true,kind:'action',tool:action.tool,status:action.status,
      scene:actionScene(store,action),text,...(result?{result}:{}),ref:{id:action.id,revision:action.revision}});
  }
  items.sort((a,b)=>(a.at??0)-(b.at??0)||refKey(a.ref).localeCompare(refKey(b.ref)));
  return items;
}
