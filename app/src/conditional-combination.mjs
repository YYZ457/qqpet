// 条件组合的结果计数：只声明过一次的组合才有自己的统计；没验证过的组合必须明说"未验证"。
// 纯函数，不依赖存储；参数全部来自显式 spec（有界、可版本化），不藏默认心理常数。
import {canonical,ensure,text} from './contracts.mjs';

const keyOf=values=>canonical(Object.fromEntries(Object.entries(values).sort(([a],[b])=>a.localeCompare(b))));
function exact(x,keys,name){ensure(x&&Object.getPrototypeOf(x)===Object.prototype&&Object.keys(x).every(k=>keys.includes(k)),'COMBINATION_SHAPE',`${name} has unsupported fields`);}
function names(xs,name,min,max){ensure(Array.isArray(xs)&&xs.length>=min&&xs.length<=max,'COMBINATION_LIMIT',`${name} size`);xs.forEach(x=>text(x,name));ensure(new Set(xs).size===xs.length,'COMBINATION_SHAPE',`${name} must be unique`);return [...xs];}

export function combinationSpec(value){
  exact(value,['domain','subject','tool','actions','outcomes','features','combination','prior','maxEpisodes','maxCells'],'spec');
  const domain=text(value.domain,'domain'),subject=text(value.subject,'subject'),tool=text(value.tool,'tool');
  const actions=names(value.actions,'actions',2,16),outcomes=names(value.outcomes,'outcomes',2,8);
  const featureEntries=Object.entries(value.features??{}).sort(([a],[b])=>a.localeCompare(b)).map(([key,values])=>[key,names(values,'feature values',2,8)]);
  ensure(featureEntries.length<=8,'COMBINATION_LIMIT','up to eight declared features');
  const combination=names(value.combination,'combination',2,3);
  ensure(combination.every(k=>featureEntries.some(([name])=>name===k)),'COMBINATION_SHAPE','combination must use declared features');
  const cells=combination.reduce((n,k)=>n*(featureEntries.find(([name])=>name===k)[1].length),1);
  const prior=value.prior??1,maxEpisodes=value.maxEpisodes??96,maxCells=value.maxCells??64;
  ensure(Number.isFinite(prior)&&prior>=1e-6&&prior<=100,'COMBINATION_LIMIT','bounded prior required');
  ensure(Number.isSafeInteger(maxEpisodes)&&maxEpisodes>=4&&maxEpisodes<=96,'COMBINATION_LIMIT','episodes 4..96');
  ensure(Number.isSafeInteger(maxCells)&&maxCells>=1&&maxCells<=256,'COMBINATION_LIMIT','maxCells 1..256');
  ensure(cells<=maxCells,'COMBINATION_LIMIT','declared combination exceeds cell budget');
  return {domain,subject,tool,actions,outcomes,features:Object.fromEntries(featureEntries),combination,prior,maxEpisodes,maxCells};
}

function featuresOf(spec,value,name){exact(value,Object.keys(spec.features),name);
  for(const [key,allowed] of Object.entries(spec.features))ensure(allowed.includes(value[key]),'COMBINATION_CONTEXT',`unknown ${key} value`);return JSON.parse(canonical(value));}
const cellKey=(spec,features)=>keyOf(Object.fromEntries(spec.combination.map(k=>[k,features[k]])));
const counts=spec=>Object.fromEntries(spec.actions.map(a=>[a,Object.fromEntries(spec.outcomes.map(o=>[o,0]))]));
const distribution=(spec,table,action)=>{const observed=spec.outcomes.reduce((n,o)=>n+table[action][o],0);
  return {observed,counts:{...table[action]},probabilities:Object.fromEntries(spec.outcomes.map(o=>[o,(table[action][o]+spec.prior)/(observed+spec.prior*spec.outcomes.length)]))};};

// 先声明组合、再看结果；episode 去重；未执行/未知不计结果；熟悉性单独计数。
export function replayCombination(inputSpec,episodes){
  const spec=combinationSpec(inputSpec);
  ensure(Array.isArray(episodes)&&episodes.length<=spec.maxEpisodes,'COMBINATION_CAPACITY','bounded retained episodes required');
  const base=counts(spec),familiarity=Object.fromEntries(spec.actions.map(a=>[a,0])),cells=new Map();
  let known=0,unknown=0;const seen=new Set();
  for(const e of episodes){
    exact(e,['key','features','action','executed','outcome'],'episode');text(e.key,'episode key');
    ensure(!seen.has(e.key),'COMBINATION_DUPLICATE','one outcome contribution per episode');seen.add(e.key);
    const features=featuresOf(spec,e.features,'observed features');
    ensure(spec.actions.includes(e.action)&&typeof e.executed==='boolean'&&(e.outcome===null||spec.outcomes.includes(e.outcome)),'COMBINATION_EPISODE','invalid action, execution or outcome');
    ensure(e.executed||e.outcome===null,'COMBINATION_EPISODE','unexecuted action has no observed outcome');
    if(e.executed)familiarity[e.action]++;
    if(!e.executed||e.outcome===null){unknown++;continue;}
    known++;base[e.action][e.outcome]++;
    const key=cellKey(spec,features),cell=cells.get(key)??{features:Object.fromEntries(spec.combination.map(k=>[k,features[k]])),counts:counts(spec),known:0};
    cell.counts[e.action][e.outcome]++;cell.known++;cells.set(key,cell);
  }
  return {format:'conditional-combination-projection-v1',spec,base,familiarity,cells:[...cells.entries()].sort(([a],[b])=>a.localeCompare(b))
    .map(([key,cell])=>({key,...cell})),known,unknown,attempts:episodes.length,
    meaning:'condition-cell-counts-are-observed-results-not-causes; unseen-combination-is-unknown; single-condition-does-not-prove-combination'};
}

// 查询：组合没被声明过或没有已确认结果，只能给较宽范围并明确“未验证”。
export function predictCombination(specInput,projection,featuresInput){
  const spec=combinationSpec(specInput),features=featuresOf(spec,featuresInput,'query features');
  const key=cellKey(spec,features),cell=projection.cells.find(c=>c.key===key)??null;
  const verified=Boolean(cell&&cell.known>0);
  return {method:'combination-dirichlet-counts',combination:Object.fromEntries(spec.combination.map(k=>[k,features[k]])),
    cellKey:key,verified,applied:verified?'observed-combination':'unseen-combination-broad-fallback',
    cell:cell?{...cell}:null,actions:spec.actions.map(action=>({action,...(verified?distribution(spec,cell.counts,action):distribution(spec,projection.base,action)),
      familiarity:projection.familiarity[action],
      applicability:verified?'observed-combination':'unseen-combination-not-validated'}))};
}

// 只交付统计卡；“组合未验证”必须写在卡上，不能拿宽范围概率冒充组合经验。
export function combinationCard(prediction,{limit=1024}={}){
  const terms=Object.entries(prediction.combination).map(([k,v])=>`${k}=${v}`).join('、');
  const lines=[`条件组合（${terms}）的经验线索（不是行为指令）：`];
  for(const row of prediction.actions){
    const counts=Object.entries(row.counts).filter(([,n])=>n>0).map(([o,n])=>`${o} ${n}次`).join('，')||'无已确认结果';
    if(row.applicability==='observed-combination')lines.push(`${row.action}：在该组合下已知结果${row.observed}次（${counts}）。`);
    else lines.push(`${row.action}：该组合未验证；以上仅较宽范围的经验，不能当作该组合的结果。`);
  }
  lines.push('未验证的组合、未执行或未知结果都没有被当成失败；这只是过去结果的统计。');
  const body=lines.join('\n');ensure([...body].length<=limit,'COMBINATION_LIMIT','card exceeds bound');return body;
}
