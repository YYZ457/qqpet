import {digest,ensure,text,uniqueRefs} from './contracts.mjs';
import {lookupPolicy} from './local-query.mjs';

// Explicit local read only. No model client, outer loop, external effects or new encounter.
export class LocalLookupSession {
  #store;#subjectId;#policy;
  constructor({store,subjectId,policy={maxReads:4,maxHits:4}}) {
    text(subjectId,'subject id');this.#store=store;this.#subjectId=subjectId;this.#policy=lookupPolicy(policy);
  }
  execute({decision}) {
    uniqueRefs([decision]);
    return this.#store.execute({requestId:`local-lookup:${digest({subject:this.#subjectId,decision,policy:this.#policy})}`,
      commands:[{op:'local_memory_lookup',subjectId:this.#subjectId,decision,policy:this.#policy}]}).at(-1);
  }
  readResult({result}) {
    uniqueRefs([result]);const record=this.#store.read(result.id,result.revision);
    ensure(record?.type==='lookup_result'&&record.subject===this.#subjectId,'MISSING_LOOKUP','unknown own lookup result');
    return record;
  }
}
