import {ensure,refKey} from './contracts.mjs';
export const NAVIGATION_VIAS=['back','forward','directory','history'];
export const NAVIGATION_LIMIT=32;
const pin=r=>r?{id:r.id,revision:r.revision}:null;
const same=(a,b)=>a?.id===b?.id&&a?.revision===b?.revision;
export const isConsultationPage=r=>Boolean(r?.consultation&&
 (r.consultation.navigation?r.consultation.navigation.isPage:!NAVIGATION_VIAS.includes(r.consultation.via)
   &&!['budget-stop','superseded','different-context','source-changed'].includes(r.outcome)));
export const consultationCursor=r=>r?.consultation?.navigation?r.consultation.navigation.page:isConsultationPage(r)?pin(r):null;
export const parentPage=r=>r?.consultation?.navigation?r.consultation.navigation.parentPage:r?.consultation?.parent??null;
const label=r=>r.query.consult?.text??(r.query.consult?.target?`${r.consultation.via}: ${r.query.consult.target.id}@${r.query.consult.target.revision}`:r.consultation.via);
const card=r=>({page:pin(r),parentPage:parentPage(r),via:r.consultation.via,label:[...label(r)].slice(0,80).join(''),
  meaning:'query-page-handle-not-memory-body'});
export function navigationMenu({page,pages,offset=0}){
 const children=page?pages.filter(r=>same(parentPage(r),pin(page))):[];
 return {currentPage:pin(page),back:page?parentPage(page):null,forward:children.slice(0,8).map(card),omittedForward:Math.max(0,children.length-8),
  history:pages.slice(offset,offset+8).map(card),nextHistoryOffset:offset+8<pages.length?offset+8:null,
  nextSearchPage:page?.nextOffset!==null&&page?.query?.consult?.via==='find'?pin(page):null,
  meaning:'cached-pages-at-query-snapshot; navigation-does-not-undo-events-or-state'};
}
export function resolveNavigation({request,source,root,load,pages,subjectId,currentEvent,workspace}){
 const own=r=>r?.type==='lookup_result'&&r.subject===subjectId&&same(r.anchor,currentEvent)&&same(r.workspace,workspace)
   &&same(r.consultation?.root,root)&&isConsultationPage(r);
 const get=ref=>{const r=ref?load(ref.id,ref.revision):null;ensure(own(r),'NAVIGATION_TARGET','target must be a page of this same need and context');return r;};
 const cursor=consultationCursor(source);if(!cursor)return {page:null,outcome:'no-history',menu:navigationMenu({page:null,pages:[]})};
 const current=get(cursor);let page=current,outcome='revisited';
 if(request.via==='back'){
   const parent=parentPage(current);if(parent)page=get(parent);else outcome='at-start';
 }else if(request.via==='forward'){
   if(request.target){const target=get(request.target);ensure(same(parentPage(target),pin(current)),'NAVIGATION_TARGET','forward target must be a direct child');page=target;}
   else{const children=pages.filter(r=>same(parentPage(r),pin(current)));
     if(children.length===1)page=children[0];else outcome=children.length?'choose-branch':'no-forward';}
 }else if(request.via==='directory'){
   const seen=new Set();let node=current,found=false;
   for(let i=0;i<NAVIGATION_LIMIT;i++){
     if(seen.has(refKey(node)))break;seen.add(refKey(node));
     if(node.query.consult?.via==='find'&&node.consultation.discovery){page=node;found=true;break;}
     const parent=parentPage(node);if(!parent)break;node=get(parent);
   }
   if(!found)outcome=seen.size>=NAVIGATION_LIMIT?'history-window-limit':'no-directory';
 }else if(request.via==='history'){
   if(request.target)page=get(request.target);else outcome='history';
 }
 return {page,outcome,fromPage:pin(current),menu:navigationMenu({page,pages,offset:request.offset??0})};
}
