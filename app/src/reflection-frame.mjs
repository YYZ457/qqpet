// 反射帧：给"节律醒来、没有新观察"的思考机会提供最小内部上下文。
// 它只是处境的一部分，不是世界观察：不写事件、不进经历、不作为 basis、不携带正文。
// 只列她自己工作台上仍开放的过程（带父子路径）与未决问题；要看正文必须显式 lookup。
import {canonical,ensure,text,time} from './contracts.mjs';
import {attentionId} from './attention.mjs';

const ref=r=>({id:r.id,revision:r.revision});
const OPEN=['active','proposed','paused','suspended','open'];
const rank=s=>s==='active'?0:s==='proposed'?1:s==='paused'?2:s==='suspended'?3:4;

function parentPath(processId,relations,maxDepth=4){
  const parents=new Map();
  for(const r of relations){
    if(r.type!=='task-part-of'||r.status!=='active')continue;
    const list=parents.get(r.from.id)??[];list.push(r.to);parents.set(r.from.id,list);
  }
  const path=[],seen=new Set([processId]);
  let current=processId;
  for(let depth=0;depth<maxDepth;depth++){
    const up=(parents.get(current)??[]).slice().sort((a,b)=>a.id.localeCompare(b.id)||a.revision-b.revision);
    if(!up.length)break;
    const next=up[0];
    if(seen.has(next.id))break; // 环不展开，也不删除记录
    seen.add(next.id);path.push(ref(next));current=next.id;
  }
  return path;
}

export function reflectionFrame({read,subjectId,workspace,now,sinceLastInteraction=null,waitingUntil=null,
  maxProcesses=12,maxQuestions=6,maxBytes=16384}={}){
  ensure(typeof read==='function','REFLECTION_FRAME','read accessor required');
  text(subjectId,'subject id');time(now);
  ensure(Number.isSafeInteger(maxProcesses)&&maxProcesses>=1&&maxProcesses<=32,'REFLECTION_FRAME','maxProcesses 1..32');
  ensure(Number.isSafeInteger(maxQuestions)&&maxQuestions>=1&&maxQuestions<=16,'REFLECTION_FRAME','maxQuestions 1..16');
  ensure(typeof maxBytes==='number'&&maxBytes>0&&maxBytes<=65536,'REFLECTION_FRAME','bounded frame bytes');
  const subject=read(subjectId);ensure(subject?.type==='subject','REFLECTION_FRAME','unknown subject');
  const frame=read(attentionId(subjectId));ensure(frame?.type==='attention_frame'&&frame.subject===subjectId,'REFLECTION_FRAME','attention frame required');
  let ws=null;
  if(workspace){ws=read(workspace.id,workspace.revision);ensure(ws?.type==='workspace','REFLECTION_FRAME','workspace must exist and be current');}

  const processes=frame.processes.filter(p=>OPEN.includes(p.status)).sort((a,b)=>rank(a.status)-rank(b.status)||a.id.localeCompare(b.id));
  const questions=frame.questions.filter(q=>['open','suspended'].includes(q.status)).sort((a,b)=>a.id.localeCompare(b.id));
  const shownProcesses=processes.slice(0,maxProcesses).map(p=>({ref:ref(p),label:p.label,status:p.status,world:p.world,parentPath:parentPath(p.id,frame.relations??[])}));
  const shownQuestions=questions.slice(0,maxQuestions).map(q=>({ref:ref(q),text:q.text,status:q.status}));

  const result={format:'reflection-frame-v1',asOf:now,
    scope:{subjectId,subject:ref(subject),...(ws?{workspace:{id:ws.id,revision:ws.revision}}:{})},
    sinceLastInteraction:sinceLastInteraction===null?null:sinceLastInteraction,
    waitingUntil:waitingUntil===null?null:waitingUntil,
    processes:shownProcesses,questions:shownQuestions,
    counts:{processes:processes.length,questions:questions.length,residences:(frame.residences??[]).length},
    truncated:{processes:Math.max(0,processes.length-shownProcesses.length),questions:Math.max(0,questions.length-shownQuestions.length)},
    meaning:'internal-time-frame-not-world-observation; no event bodies, no observation basis; expand via explicit lookup only'};
  ensure(typeof result.sinceLastInteraction!=='number'||result.sinceLastInteraction>=0,'REFLECTION_FRAME','sinceLastInteraction must be nonnegative');
  ensure(Buffer.byteLength(canonical(result),'utf8')<=maxBytes,'REFLECTION_FRAME','frame exceeds bound');
  return result;
}
