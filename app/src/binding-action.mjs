// 她确认一条绑定：动作仍然只是"提案"，由宿主原子执行 write_binding + 回执。
// 窄入口：只接受 remember-binding、已有实体、白名单关系；不自绑；不自动从共现生成。
import {ensure,refKey,text} from './contracts.mjs';

const RELATIONS=['spouse','family','colleague','member-of','located-at','associated-with'];
const SYMMETRIC=new Set(['spouse','family','associated-with']);

export function bindingCommands({store,action,eventId,body,occurredAt}={}){
  ensure(action?.type==='action'&&action.tool==='remember-binding','BINDING_ACTION','a remember-binding action is required');
  ensure(action.status==='proposed','BINDING_ACTION','only a proposed action can be executed');
  const args=action.args;
  ensure(args&&Object.getPrototypeOf(args)===Object.prototype,'BINDING_ACTION','binding args must be an object');
  const keys=Object.keys(args);ensure(keys.every(k=>['from','to','relation','label'].includes(k)),'BINDING_ACTION','binding args are from/to/relation/label');
  const from=store.read(args.from?.id,args.from?.revision),to=store.read(args.to?.id,args.to?.revision);
  ensure(from?.type==='entity'&&to?.type==='entity','BINDING_ACTION','from/to must be existing entities');
  ensure(from.status==='current'&&to.status==='current','BINDING_ACTION','both entities must be current');
  ensure(from.id!==to.id,'SELF_BINDING','an entity cannot be bound to itself');
  ensure(RELATIONS.includes(args.relation),'BINDING_ACTION','binding relation must be on the whitelist');
  const label=args.label??null;if(label!==null){text(label,'binding label');ensure([...label].length<=200,'BINDING_LABEL','binding label too long');}
  const symmetric=SYMMETRIC.has(args.relation);
  const evidence=(action.inputRefs??[]).filter(r=>{const value=store.read(r.id,r.revision);return value&&['event','note'].includes(value.type);});
  text(eventId,'receipt event id');text(body,'receipt body');
  return [
    {op:'write_binding',id:`${action.id}:binding`,expectedRevision:0,from:{id:from.id,revision:from.revision},to:{id:to.id,revision:to.revision},
      relation:args.relation,direction:symmetric?'symmetric':'forward',label,source:'self',evidence,status:'active'},
    {op:'record_receipt',actionId:action.id,expectedRevision:action.revision,status:'succeeded',eventId,body,
      source:{system:'binding',key:eventId},actor:'host',occurredAt:occurredAt??Date.now()},
  ];
}
