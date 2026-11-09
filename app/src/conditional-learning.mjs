// A bounded finite-domain estimator. Counts and predictive scores are not personal values.
import {canonical,ensure,text} from './contracts.mjs';

function exact(x,keys,name){
  ensure(x&&Object.getPrototypeOf(x)===Object.prototype&&Object.keys(x).every(k=>keys.includes(k)),
    'LEARNING_SHAPE',`${name} has unsupported fields`);
}
function name(x,label){text(x,label);ensure(x.length<=120,'LEARNING_LIMIT',`${label} too long`);return x;}
function names(xs,label,min=1,max=16){
  ensure(Array.isArray(xs)&&xs.length>=min&&xs.length<=max,'LEARNING_LIMIT',`${label} size`);
  xs.forEach(x=>name(x,label));ensure(new Set(xs).size===xs.length,'LEARNING_SHAPE',`${label} must be unique`);return [...xs];
}
export function learningSpec(value){
  exact(value,['domain','subject','tool','actions','outcomes','features','prior','penalty','enterMargin','switchMargin','exitMargin','maxEpisodes'],'spec');
  const domain=name(value.domain,'domain'),subject=name(value.subject,'subject'),tool=name(value.tool,'tool');
  const actions=names(value.actions,'actions',2),outcomes=names(value.outcomes,'outcomes',2,8);
  exact(value.features??{},Object.keys(value.features??{}),'features');
  ensure(Object.keys(value.features??{}).length<=8,'LEARNING_LIMIT','up to eight predefined categorical features');
  const features=Object.fromEntries(Object.entries(value.features??{}).sort(([a],[b])=>a.localeCompare(b)).map(([key,values])=>{
    name(key,'feature');return [key,names(values,'feature values',2,8)];
  }));
  const result={domain,subject,tool,actions,outcomes,features,prior:value.prior??1,penalty:value.penalty??1,
    enterMargin:value.enterMargin??1,switchMargin:value.switchMargin??1,exitMargin:value.exitMargin??1,maxEpisodes:value.maxEpisodes??96};
  for(const key of ['prior','penalty','enterMargin','switchMargin','exitMargin'])ensure(Number.isFinite(result[key])&&result[key]>=0&&result[key]<=100,
    'LEARNING_LIMIT',`bounded ${key} required`);
  ensure(result.prior>=1e-6&&Number.isSafeInteger(result.maxEpisodes)&&result.maxEpisodes>=4&&result.maxEpisodes<=96,
    'LEARNING_LIMIT','numerically bounded prior and 4..96 episodes required');return result;
}
export function learningFeatures(spec,value){
  exact(value,Object.keys(spec.features),'observed features');
  for(const [key,v] of Object.entries(value))ensure(spec.features[key].includes(v),'LEARNING_CONTEXT','unknown feature value');
  return JSON.parse(canonical(value));
}
function counts(spec){return Object.fromEntries(spec.actions.map(a=>[a,Object.fromEntries(spec.outcomes.map(o=>[o,0]))]));}
function distribution(spec,table,action){
  const observed=spec.outcomes.reduce((n,o)=>n+table[action][o],0),denom=observed+spec.prior*spec.outcomes.length;
  return {observed,counts:{...table[action]},probabilities:Object.fromEntries(spec.outcomes.map(o=>[o,(table[action][o]+spec.prior)/denom]))};
}

// Candidate predicates are fixed in spec BEFORE any result. No answer-driven feature discovery here.
export function replayLearning(inputSpec,episodes){
  const spec=learningSpec(inputSpec);
  ensure(Array.isArray(episodes)&&episodes.length<=spec.maxEpisodes,'LEARNING_CAPACITY','bounded retained episodes required');
  const base=counts(spec),familiarity=Object.fromEntries(spec.actions.map(a=>[a,0]));
  const candidates=Object.fromEntries(Object.entries(spec.features).map(([key,values])=>[key,{loss:0,
    penalty:spec.penalty*(values.length-1)*spec.actions.length*(spec.outcomes.length-1),
    familiarity:Object.fromEntries(values.map(v=>[v,Object.fromEntries(spec.actions.map(a=>[a,0]))])),
    branches:Object.fromEntries(values.map(v=>[v,counts(spec)]))}]));
  let baseLoss=0,known=0,selection=null;
  const seen=new Set();
  for(const e of episodes){
    exact(e,['key','features','action','executed','outcome'],'episode');name(e.key,'episode key');
    ensure(!seen.has(e.key),'LEARNING_DUPLICATE','one outcome contribution per action');seen.add(e.key);
    learningFeatures(spec,e.features);
    ensure(spec.actions.includes(e.action)&&typeof e.executed==='boolean'&&(e.outcome===null||spec.outcomes.includes(e.outcome)),
      'LEARNING_EPISODE','invalid action, execution or outcome');
    ensure(e.executed||e.outcome===null,'LEARNING_EPISODE','unexecuted action has no observed task outcome');
    if(e.executed){
      familiarity[e.action]++;
      for(const [key,c] of Object.entries(candidates))if(Object.hasOwn(e.features,key))c.familiarity[e.features[key]][e.action]++;
    }
    if(e.outcome===null)continue;
    const baseProbability=distribution(spec,base,e.action).probabilities[e.outcome];
    baseLoss-=Math.log(baseProbability);known++;
    for(const [key,c] of Object.entries(candidates)){
      const branch=Object.hasOwn(e.features,key)?c.branches[e.features[key]]:null;
      c.loss-=Math.log(branch?distribution(spec,branch,e.action).probabilities[e.outcome]:baseProbability);
      if(branch)branch[e.action][e.outcome]++;
    }
    base[e.action][e.outcome]++;
    const scored=Object.entries(candidates).map(([feature,c])=>({feature,gain:baseLoss-c.loss-c.penalty}))
      .sort((a,b)=>b.gain-a.gain||a.feature.localeCompare(b.feature));
    const current=selection===null?null:scored.find(x=>x.feature===selection);
    if(current&&current.gain < -spec.exitMargin)selection=null;
    const best=scored[0],incumbent=selection===null?null:scored.find(x=>x.feature===selection);
    if(best&&best.gain>spec.enterMargin&&(!incumbent||best.gain>incumbent.gain+spec.switchMargin))selection=best.feature;
  }
  return {format:'conditional-learning-projection-v1',base,candidates,familiarity,known,unknown:episodes.length-known,
    attempts:episodes.length,selection,baseLoss,scoreNature:'source-reconstructed-prequential-log-loss-not-historical-provider-accuracy'};
}

export function predictLearning(inputSpec,projection,features){
  const spec=learningSpec(inputSpec),q=learningFeatures(spec,features),key=projection.selection;
  const value=key===null?null:q[key],branch=value===undefined||value===null?null:projection.candidates[key].branches[value];
  return {method:'conditional-dirichlet-counts',selection:key,condition:branch?{[key]:value}:{},
    specificity:key===null?'broad':branch?'one-feature-only':'missing-selected-feature-broad-fallback',
    otherConditionsNotValidated:true,known:projection.known,unknown:projection.unknown,
    actions:spec.actions.map(action=>{
      const conditional=branch?distribution(spec,branch,action):null;
      // A globally chosen split does not create data for an unseen branch/action.
      const d=conditional?.observed?conditional:distribution(spec,projection.base,action);
      return {action,...d,familiarity:branch?projection.candidates[key].familiarity[value][action]:projection.familiarity[action],
        domainFamiliarity:projection.familiarity[action],familiarityScope:branch?'selected-condition':'domain',
        applicability:conditional?(conditional.observed?'conditional-observations':'unseen-branch-action-broad-fallback'):'broad-observations'};
    })};
}
