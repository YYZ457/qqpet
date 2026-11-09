// 长期倾向的生产适配：从已有动作/回执/纠错记录派生出经历片段，喂给既有学习账本。
// 不新增表、不新增人格分数；账本本身是版本化 note（kind='skill'），图形索引只是派生视图。
import {canonical,ensure,refKey,text} from './contracts.mjs';

const pin=r=>({id:r.id,revision:r.revision});
function parseBody(record){try{return JSON.parse(record.body);}catch{return null;}}

// 只收最终动作（非 proposed、带真实回执）；纠错只收能沿 previous 串起来的链。
export function productionEpisodes(store,{tool}={}){
  text(tool,'tool');
  const correctionsByAction=new Map();
  for(const e of store.all('event')){
    const d=parseBody(e);if(!d||d.format!=='learning-correction-v1')continue;
    const actionId=d.action?.id;if(!actionId)continue;
    const list=correctionsByAction.get(actionId)??[];list.push({ref:pin(e),previous:d.previous,at:e.recordedAt??0});correctionsByAction.set(actionId,list);
  }
  const entries=[],skipped=[];
  for(const action of store.all('action')){
    if(action.tool!==tool)continue;
    if(action.revision<2||!action.receipt||action.status==='proposed'){skipped.push({id:action.id,reason:'not-final'});continue;}
    let current=action.receipt,chain=[];
    const candidates=(correctionsByAction.get(action.id)??[]).slice().sort((a,b)=>a.at-b.at||a.ref.id.localeCompare(b.ref.id));
    const unused=new Set(candidates);
    for(let guard=0;guard<32;guard++){
      const next=[...unused].find(c=>refKey(c.previous??{})===refKey(current));
      if(!next)break;
      chain.push(next.ref);unused.delete(next);current=next.ref;
    }
    if(unused.size)skipped.push({id:action.id,reason:'correction-chain-broken',count:unused.size});
    entries.push({action:pin(action),corrections:chain});
  }
  return {entries,skipped};
}

// 把派生片段写进既有学习账本：observe 对新尝试追加、对重复动作幂等；correct 对纠正追加、重复幂等。
export function recordEpisodes({learning,store,spec}){
  ensure(learning&&typeof learning.observe==='function'&&typeof learning.correct==='function','TENDENCY_ADAPTER','existing learning session required');
  const before=learning.inspect();
  const {entries,skipped}=productionEpisodes(store,{tool:spec.tool});
  for(const entry of entries)learning.observe({action:entry.action});
  for(const entry of entries)for(const correction of entry.corrections)learning.correct({event:correction});
  const after=learning.inspect();
  const added=after.projection.attempts-before.projection.attempts;
  const corrections=(after.ref.revision-before.ref.revision)-added;
  return {added,corrections,attempts:after.projection.attempts,known:after.projection.known,unknown:after.projection.unknown,skipped,
    book:after.ref,projection:after.projection};
}

// 行为统计：只描述已确认结果与实际使用，不给价值判断、不折算成单一分数。
export function behaviorSummary(learning,spec){
  const {projection}=learning.inspect();
  return {method:'conditional-dirichlet-counts',known:projection.known,unknown:projection.unknown,attempts:projection.attempts,
    selection:projection.selection,
    rows:spec.actions.map(action=>{
      const observed=spec.outcomes.reduce((n,o)=>n+(projection.base[action]?.[o]??0),0);
      const counts=Object.fromEntries(spec.outcomes.map(o=>[o,projection.base[action]?.[o]??0]));
      const denom=observed+spec.prior*spec.outcomes.length;
      return {action,observed,counts,probabilities:Object.fromEntries(spec.outcomes.map(o=>[o,(counts[o]+spec.prior)/denom])),
        familiarity:projection.familiarity[action]??0};
    }),
    meaning:'counts-are-observed-results-not-values-trust-or-importance; familiarity-is-actual-use-only; unknown-is-not-failure'};
}

// 只交付紧凑经验卡；不含内部账本、不规定她必须采用。
export function behaviorCard(summary,spec,{limit=1024}={}){
  const lines=[`在${spec.domain}中的经验线索（不是行为指令）：`];
  for(const row of summary.rows){
    const counts=spec.outcomes.map(o=>`${o} ${row.counts[o]}次`).join('，');
    lines.push(`${row.action}：已知结果${row.observed}次（${counts}）；实际使用${row.familiarity}次。`);
  }
  lines.push(`未知或未执行的结果${summary.unknown}次，未计为失败；熟悉不等于有效，也不等于你愿意采用。`);
  lines.push(`未出现的条件、其他领域未验证；这只是过去的结果统计，不构成对你自己或别人的评价。`);
  ensure(Array.isArray(spec.actions)&&spec.actions.length>0,'TENDENCY_ADAPTER','spec actions required');
  const body=lines.join('\n');
  ensure([...body].length<=limit,'TENDENCY_LIMIT','card exceeds bound');
  return body;
}
