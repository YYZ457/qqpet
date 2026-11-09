// 欲望是她自己的状态：这里只读她已写下的开放 intention/concern，作为机会材料；不生成欲望、不排任务。
export function desireView({store,subjectId,limit=4}={}){
  const subject=store.read(subjectId);if(subject?.type!=='subject')throw Object.assign(new Error('unknown subject'),{code:'DESIRE_INPUT'});
  const states=[...store.all('personal_state')]
    .filter(s=>s.subject===subjectId&&s.status==='open'&&['intention','concern'].includes(s.kind))
    .sort((a,b)=>(b.recordedAt??0)-(a.recordedAt??0)||a.id.localeCompare(b.id))
    .slice(0,limit)
    .map(s=>({ref:{id:s.id,revision:s.revision},kind:s.kind,body:s.body,role:s.mind?.role??null,
      unresolved:[...(s.mind?.unresolved??[])],confidence:s.mind?.confidence??null}));
  return {format:'desire-view-v1',items:states,
    meaning:'her-own-open-intentions-not-commands; opportunities-are-materials; no automatic action'};
}
