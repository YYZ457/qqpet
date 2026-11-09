// 只观察"影子是否被真的去看"：不评分、不排序、不改变任何记忆或注意力。
export function observeAssociation({store,packet,decision}){
  const candidates=packet?.payload?.continuity?.attention?.associationCandidates??[];
  if(!candidates.length||!decision?.output)return null;
  const selected=decision.output.options?.find(o=>o.id===decision.output.selected);
  if(selected?.kind!=='lookup')return null;
  const payload=selected.payload??{};
  let hit=null,kind=null;
  if(payload.ref){hit=candidates.find(c=>c.ref.id===payload.ref.id);kind='lookup-ref';}
  else if(Array.isArray(payload.terms)){
    const terms=payload.terms.map(t=>String(t).toLocaleLowerCase('zh-CN'));
    hit=candidates.find(c=>terms.some(t=>String(c.label).toLocaleLowerCase('zh-CN').includes(t)));kind='lookup-terms';
  }
  if(!hit)return null;
  const observation={decision:decision.id,candidate:hit.ref,via:hit.via,relation:hit.relation,scope:hit.scope,kind,
    meaning:'observed-only; not a score, not reinforcement'};
  try{store.recordDiagnostic({stage:'association.selected',status:'observed',
    context:{subjectId:packet.payload.continuity.subject.id,decisionId:decision.id},data:observation});}catch{}
  return observation;
}
