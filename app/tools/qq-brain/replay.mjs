// 离线回放：只读历史决策，统计"联想影子是否真的被她查了"。不调模型、不写库。
// 旧包没有 associationCandidates 时，明确报告 no-data，不把 0 当成失败。
import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export function replayDatabase(dbPath){
  if(!existsSync(dbPath))return {ok:false,error:'DB_NOT_FOUND',dbPath};
  const db=new DatabaseSync(dbPath,{readOnly:true});
  try{
    const rows=db.prepare(`SELECT v.body FROM objects o JOIN versions v ON o.id=v.id AND v.revision=o.current_revision
      WHERE o.type='decision' ORDER BY v.rowid`).all();
    const metrics={dbPath,decisions:rows.length,lookups:0,withCandidates:0,shadowRef:0,shadowTerms:0,retrievalShadows:0,retrievalHits:0,noData:true};
    const candidatesOf=p=>p?.payload?.continuity?.attention?.associationCandidates??[];
    const lookupOf=d=>d?.output?.options?.find(x=>x.id===d.output.selected);
    const matches=(query,cands)=>{
      if(!query||!cands.length)return false;
      if(query.ref)return cands.some(c=>c.ref.id===query.ref.id);
      const terms=query.terms??(query.query?.terms)??(query.recall?.terms)??null;
      if(terms)return cands.some(c=>terms.some(t=>String(c.label).toLocaleLowerCase('zh-CN').includes(String(t).toLocaleLowerCase('zh-CN'))));
      if(query.person)return cands.some(c=>String(c.label).includes(query.person));
      if(query.entity)return cands.some(c=>String(c.label).includes(query.entity));
      return false;
    };
    for(const row of rows){
      const decision=JSON.parse(row.body),selected=lookupOf(decision);
      if(selected?.kind!=='lookup')continue;
      metrics.lookups++;
      const cands=candidatesOf(decision.input);if(cands.length)metrics.withCandidates++;
      if(matches(selected.payload,cands))metrics.shadowRef++;
      const retrieval=decision.input?.payload?.information?.associations?.candidates??[];
      if(retrieval.length)metrics.retrievalShadows++;
      if(matches(selected.payload,retrieval))metrics.retrievalHits++;
    }
    metrics.noData=metrics.lookups===0||(metrics.withCandidates===0&&metrics.retrievalShadows===0);
    metrics.meaning='observed conversion only; no scoring of correctness; old packets without candidates are counted as no-data';
    return metrics;
  }finally{db.close();}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const i=process.argv.indexOf('--db');
  const dbPath=resolve(i>=0?process.argv[i+1]:'_local/private-chat-v1/subject.sqlite');
  const result=replayDatabase(dbPath);
  console.log(JSON.stringify(result,null,2));
  if(!result.ok)process.exitCode=1;
}
