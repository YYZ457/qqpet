import {digest, ensure, refKey, text, uniqueRefs} from './contracts.mjs';
import {associate} from './algorithms.mjs';

export const MEMORY_TOOLS = Object.freeze([
  {name:'memory.read', description:'按id与可选版本查阅保留的经历或个人笔记，不自动加深记忆'},
  {name:'memory.search', description:'用明确词项查找自己的保留记录；当前仅有精确词项基线'},
  {name:'memory.associate', description:'从已读材料沿有效关联寻找候选；分数不代表事实可信度，返回不等于采用'},
  {name:'memory.write_note', description:'提出带版本、来源及变化类型的个人笔记更新'},
  {name:'memory.record_use', description:'记录本次交互确实回想或应用了已读材料；曝光不算'},
  {name:'action.propose', description:'在获准工具范围内提出行动意图，等待执行器回执；不代表已执行'}
]);

// Bound to a turn snapshot. External observations and execution receipts are not model-write tools.
export class MemoryToolSession {
  #store; #event; #workspace; #seen; #actions;
  constructor({store,currentEvent,workspace,deliveredRefs=[],allowedActionTools=[]}) {
    uniqueRefs([currentEvent,workspace,...deliveredRefs]);
    ensure(store.read(currentEvent.id,currentEvent.revision)?.type==='event','REFERENCE_TYPE','turn needs an event');
    ensure(store.read(workspace.id,workspace.revision)?.type==='workspace','REFERENCE_TYPE','turn needs a workspace');
    this.#store=store; this.#event=currentEvent; this.#workspace=workspace;
    this.#seen=new Set([...deliveredRefs,currentEvent].map(refKey)); this.#actions=new Set(allowedActionTools);
  }
  #requireSeen(refs) {
    for(const ref of uniqueRefs(refs))ensure(this.#seen.has(refKey(ref)),'UNREAD_REFERENCE','read a material before using or citing it',ref);
  }
  call({id,name,args={}}) {
    try {
      text(id,'call id');
      ensure(args && Object.getPrototypeOf(args) === Object.prototype,'INVALID_INPUT','tool arguments must be an object');
      ensure(this.#store.read(this.#workspace.id)?.revision===this.#workspace.revision,'STALE_SESSION','workspace changed; start a new session');
      const requestId=`tool:${digest({event:this.#event,id})}`;
      let result;
      switch(name){
        case 'memory.read': {
          const record=this.#store.read(args.id,args.revision);
          ensure(!record||['event','note'].includes(record.type),'REFERENCE_TYPE','only experiences and personal notes are exposed here');
          if(record)this.#seen.add(refKey(record));
          result={found:Boolean(record),record}; break;
        }
        case 'memory.search': result=this.#store.search(args); break;
        case 'memory.associate':
          ensure(Array.isArray(args.seeds) && args.seeds.length <= 32,'INVALID_INPUT','supply up to 32 seeds');
          this.#requireSeen(args.seeds.map(seed=>seed?.ref));
          ensure(Number.isInteger(args.maxDepth) && args.maxDepth>=0 && args.maxDepth<=4,'INVALID_INPUT','session depth must be 0..4');
          ensure(Number.isInteger(args.maxExpansions) && args.maxExpansions>=0 && args.maxExpansions<=2000,'INVALID_INPUT','session expansion budget must be 0..2000');
          result=associate({...args,edges:this.#store.activeAssociationEdges()}); break;
        case 'memory.write_note':
          this.#requireSeen(args.evidence??[]);
          [result]=this.#store.execute({requestId,commands:[{...args,op:'write_note'}]});
          this.#seen.add(refKey(result.record)); break;
        case 'memory.record_use':
          this.#requireSeen([args.memory]);
          [result]=this.#store.execute({requestId,commands:[{op:'record_use',memory:args.memory,encounter:this.#event,reason:args.reason}]}); break;
        case 'action.propose':
          ensure(this.#actions.has(args.tool),'TOOL_NOT_GRANTED','action tool is not granted for this session');
          this.#requireSeen(args.inputRefs??[]);
          [result]=this.#store.execute({requestId,commands:[{...args,op:'propose_action',workspace:this.#workspace}]}); break;
        default: ensure(false,'TOOL_NOT_GRANTED','tool is not exposed to the model');
      }
      return {ok:true,result};
    }catch(error){
      if(!error.code||!error.details)throw error;
      return {ok:false,error:{code:error.code,message:error.message,details:error.details}};
    }
  }
}
