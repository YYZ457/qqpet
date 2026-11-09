// 最少填写：她只需要给正文；其余字段用安全默认。语义仍由她写，程序不做语义推断。
import {ensure,text} from './contracts.mjs';

const KINDS=['fact_claim','interpretation','value','preference','dream','tension','feeling','skill'];
export function rememberNote({store,id,body,kind='fact_claim',scene=null,evidence=[],confidence='tentative',status='current',anchor=null}={}){
  text(id,'note id');text(body,'note body');
  ensure(KINDS.includes(kind),'NOTE_KIND','note kind must be on the existing list');
  ensure(['tentative','uncertain','confident'].includes(confidence),'NOTE_CONFIDENCE','invalid confidence');
  ensure(['current','suspended','historical'].includes(status),'NOTE_STATUS','invalid status');
  if(scene!==null)text(scene,'scene');
  const scope=scene===null?{scenes:[],people:[],validFrom:null,validUntil:null}:{scenes:[scene],people:[],validFrom:null,validUntil:null};
  const change=evidence.length?'new_evidence':'self_report';
  const out=store.execute({requestId:`remember:${id}`,commands:[{op:'write_note',id,expectedRevision:0,kind,change,body,
    status,confidence,evidence,scope,...(anchor?{anchor}:{})}]}).at(-1);
  return out.record;
}
