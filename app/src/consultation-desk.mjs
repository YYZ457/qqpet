import {refKey} from './contracts.mjs';
import {consultationCursor,navigationMenu} from './consultation-navigation.mjs';
const pin=r=>({id:r.id,revision:r.revision});
const same=(a,b)=>a?.id===b?.id&&a?.revision===b?.revision;

// A bounded projection of the existing query journal, not a new memory or model summary.
export function consultationDesk({read,results,subjectId,currentEvent,workspace,lastDecision,pages=[]}){
  const active=results.find(r=>same(r.decision,lastDecision));
  if(!active?.consultation)return null;
  const root=active.consultation.root,steps=[],seen=new Set();let next=active,stop='root-reached';
  while(next){
    if(steps.length>=8){stop='history-window-limit';break;}
    if(seen.has(refKey(next))){stop='cycle';break;}
    if(next.type!=='lookup_result'||next.subject!==subjectId||!same(next.anchor,currentEvent)||!same(next.workspace,workspace)
      ||!same(next.consultation?.root,root)){stop='different-or-unavailable-context';break;}
    seen.add(refKey(next));steps.push(next);
    const parent=next.consultation.parent;if(!parent)break;
    next=read(parent.id,parent.revision);if(!next)stop='missing-parent';
  }
  const candidates=new Map(),fetched=new Map();
  for(const r of [...steps].reverse()){
    for(const c of r.consultation.discovery?.items??[]){
      const key=refKey(c.ref);if(!candidates.has(key))candidates.set(key,{...c,firstSeenIn:pin(r),catalogEpoch:r.epoch??null,
        pointerMeaning:'version-pointer-as-of-firstSeenIn-query; recheck-before-assuming-current'});
    }
    for(const c of [...r.entries,...(r.states??[]),...(r.trace?.nodes??[]).filter(n=>n.ref.kind==='record')]){
      const key=refKey(c.ref);fetched.delete(key);fetched.set(key,{ref:pin(c.ref),fetchedIn:pin(r),via:r.consultation.via});
    }
  }
  const ordered=[...candidates.values()].map(c=>({...c,fullVersionFetched:fetched.has(refKey(c.ref))}));
  // Prefer handles not yet fetched; this is not a claim that they are more relevant or true.
  ordered.sort((a,b)=>Number(a.fullVersionFetched)-Number(b.fullVersionFetched));
  const cursor=consultationCursor(active),page=cursor?read(cursor.id,cursor.revision):null;
  return {root,need:active.consultation.need,continueWith:pin(active),navigation:navigationMenu({page,pages}),
    candidates:ordered.slice(0,6),fetchedRefs:[...fetched.values()].slice(-8),
    omittedCandidates:Math.max(0,ordered.length-6),omittedFetchedRefs:Math.max(0,fetched.size-8),
    visitedSteps:steps.length,historyStop:stop,
    interpretation:'retained-query-handles-not-foreground-or-new-evidence; fetched-does-not-imply-delivered-or-adopted'};
}
