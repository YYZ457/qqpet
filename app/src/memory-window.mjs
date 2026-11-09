// 记忆材料窗口：从上次真正写下记忆之后，收到的消息 + 她自己的回复 + 她做过的动作。
// 触发计数不在这里；触发只看 memoryPending 的消息数/时间。
const clip=(value,max=600)=>{const s=String(value??'').replace(/\s+/g,' ').trim();return s.length<=max?s:s.slice(0,max)+'…';};
const ref=r=>({id:r.id,revision:r.revision});
export function buildMemoryWindow({store,subjectId,lastMemoryAt=0,messageIds=[],limit=40}={}){
  const items=[];
  const seen=new Set();
  const push=item=>{if(seen.has(item.ref.id))return;seen.add(item.ref.id);items.push(item);};
  for(const id of messageIds){
    try{const event=store.read(id);if(!event?.body)continue;push({kind:'message',at:event.occurredAt??event.recordedAt,scene:event.scene??null,text:clip(event.body),ref:ref(event)});}catch{}
  }
  for(const response of store.all('response')){
    if(response.subject!==subjectId||!response.body)continue;
    const at=response.sentAt??response.createdAt??response.recordedAt;
    if(at<=lastMemoryAt)continue;
    push({kind:'response',at,scene:response.scene??null,text:clip(response.body),status:response.status??null,ref:ref(response)});
  }
  for(const action of store.all('action')){
    if(action.subject&&action.subject!==subjectId)continue;
    if(!['succeeded','failed','uncertain'].includes(action.status))continue;
    if(action.recordedAt<=lastMemoryAt)continue;
    let result=null;
    if(action.receipt){try{const receipt=store.read(action.receipt.id,action.receipt.revision);result=receipt?.body?clip(receipt.body,500):null;}catch{}}
    push({kind:'action',at:action.recordedAt,scene:action.scene??null,text:clip(JSON.stringify({tool:action.tool,args:action.args??{}}),600),status:action.status,result,ref:ref(action)});
  }
  items.sort((a,b)=>(a.at??0)-(b.at??0)||a.ref.id.localeCompare(b.ref.id));
  const selected=items.slice(0,Math.max(1,Math.min(100,limit)));
  return {format:'memory-window-v2',from:lastMemoryAt,to:selected.at(-1)?.at??lastMemoryAt,
    count:items.length,items:selected,truncated:items.length>selected.length,omitted:Math.max(0,items.length-selected.length)};
}
