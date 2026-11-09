import {canonical,digest,ensure,refKey,text,uniqueRefs} from './contracts.mjs';
import {learningSpec,learningFeatures,replayLearning,predictLearning} from './conditional-learning.mjs';
import {failureMetadata} from './debug-contract.mjs';

const ref=r=>({id:r.id,revision:r.revision});
const FORMAT='agent-learning-book-v1';
const exact=(x,keys,label)=>ensure(x&&Object.getPrototypeOf(x)===Object.prototype&&Object.keys(x).every(k=>keys.includes(k)),
  'LEARNING_SHAPE',`${label} has unsupported fields`);
function json(body,maxBytes=16384){
  ensure(typeof body==='string'&&Buffer.byteLength(body)<=maxBytes,'LEARNING_LIMIT','bounded learning source required');
  try{return JSON.parse(body);}catch{ensure(false,'LEARNING_SOURCE','structured host learning source required');}
}
function requireRecord(store,r,type){
  uniqueRefs([r]);const value=store.read(r.id,r.revision);
  ensure(value?.type===type,'LEARNING_SOURCE','pinned source has wrong type or does not exist');return value;
}
function contextRecord(store,spec,r){
  const record=requireRecord(store,r,'event'),data=json(record.body);
  exact(data,['format','domain','subject','features'],'context');
  ensure(record.origin==='observed'&&data.format==='learning-context-v1'&&data.domain===spec.domain&&data.subject===spec.subject,
    'LEARNING_CONTEXT','explicit host-observed own-domain context required');
  return {record,features:learningFeatures(spec,data.features)};
}
function rawEpisode(store,spec,entry){
  exact(entry,['action','corrections'],'source entry');
  ensure(Array.isArray(entry.corrections)&&entry.corrections.length<=32,'LEARNING_LIMIT','bounded correction chain');
  const action=requireRecord(store,entry.action,'action');
  ensure(action.revision===2&&action.status!=='proposed'&&action.receipt&&action.tool===spec.tool,
    'LEARNING_SOURCE','final action of the declared tool required');
  exact(action.args,['choice','context'],'learning action args');
  ensure(spec.actions.includes(action.args.choice),'LEARNING_SOURCE','unregistered action choice');
  const proposal=requireRecord(store,{id:action.id,revision:1},'action');
  ensure(canonical(proposal.args)===canonical(action.args)&&proposal.inputRefs.some(r=>refKey(r)===refKey(action.args.context)),
    'LEARNING_LINEAGE','execution must pin its context in the original action inputs');
  const context=contextRecord(store,spec,action.args.context),receipt=requireRecord(store,action.receipt,'event'),data=json(receipt.body);
  exact(data,['format','domain','subject','action','context','executed','outcome'],'receipt');
  ensure(receipt.origin==='tool_receipt'&&data.format==='learning-result-v1'&&data.domain===spec.domain&&data.subject===spec.subject
    &&refKey(data.action??{})===refKey(proposal)&&refKey(data.context??{})===refKey(context.record),
    'LEARNING_LINEAGE','host result must belong to this exact action and context');
  ensure(context.record.recordedAt<=proposal.recordedAt&&proposal.recordedAt<=receipt.recordedAt,
    'LEARNING_TIME','recorded context/action/result order is invalid');
  ensure(typeof data.executed==='boolean'&&(data.outcome===null||spec.outcomes.includes(data.outcome))
    &&(data.executed||data.outcome===null),'LEARNING_EPISODE','invalid execution/outcome');
  ensure(!['cancelled','interrupted'].includes(action.status)||data.outcome===null,'LEARNING_EPISODE','partial/cancelled results remain unknown');
  let outcome=data.outcome,executed=data.executed,previous=ref(receipt);
  const evidence=[ref(context.record),ref(receipt)],correctionKeys=new Set();
  for(const r of entry.corrections){
    const c=requireRecord(store,r,'event'),d=json(c.body);
    exact(d,['format','domain','subject','action','previous','executed','outcome','reason'],'correction');
    ensure(c.origin==='observed'&&d.format==='learning-correction-v1'&&d.domain===spec.domain&&d.subject===spec.subject
      &&refKey(d.action??{})===refKey(action)&&refKey(d.previous??{})===refKey(previous)&&c.recordedAt>=requireRecord(store,previous,'event').recordedAt,
      'LEARNING_CORRECTION','explicit ordered host correction required');
    text(d.reason,'correction reason');ensure(d.reason.length<=512,'LEARNING_LIMIT','short correction reason required');
    ensure(typeof d.executed==='boolean'&&(d.outcome===null||spec.outcomes.includes(d.outcome))&&(d.executed||d.outcome===null),
      'LEARNING_CORRECTION','invalid corrected result');
    ensure(!correctionKeys.has(refKey(r)),'LEARNING_DUPLICATE','repeated correction');correctionKeys.add(refKey(r));
    executed=d.executed;outcome=d.outcome;previous=ref(c);evidence.push(ref(c));
  }
  return {sample:{key:action.id,features:context.features,action:action.args.choice,executed,outcome},evidence,
    receipt:ref(receipt),context:ref(context.record),effectiveSource:previous};
}

// Opt-in host adapter. Uses the EXISTING versioned notes/events/transactions; no new database.
// The book is machine-readable skill bookkeeping. Only compact semantic cards go to decisions.
export class ExperienceLearningSession {
  #store;#id;#spec;
  constructor({store,id,spec}){
    text(id,'learning book id');ensure(id.length<=120,'LEARNING_LIMIT','short learning book id');
    this.#store=store;this.#id=id;this.#spec=learningSpec(spec);
    ensure(store.read(this.#spec.subject)?.type==='subject','MISSING_SUBJECT','explicit existing subject required');
  }
  #diagnostic(stage,status,data={}){this.#store.recordDiagnostic({stage:`learning.${stage}`,status,context:{subjectId:this.#spec.subject},data});}
  #derive(entries){
    ensure(Array.isArray(entries)&&entries.length<=this.#spec.maxEpisodes,'LEARNING_CAPACITY','book capacity reached; retain sources, do not silently evict');
    const records=entries.map(e=>rawEpisode(this.#store,this.#spec,e));
    ensure(entries.reduce((n,e)=>n+e.corrections.length,0)<=32,'LEARNING_CAPACITY','book correction capacity reached');
    return {projection:replayLearning(this.#spec,records.map(x=>x.sample)),evidence:uniqueRefs(records.flatMap(x=>x.evidence)),records};
  }
  #load(rev){
    const record=this.#store.read(this.#id,rev);if(!record)return null;
    ensure(record.type==='note'&&record.kind==='skill'&&record.status==='current','LEARNING_BOOK','learning ledger note required');
    ensure(record.revision<=this.#spec.maxEpisodes+33,'LEARNING_LIMIT','bounded ledger version chain required');
    const data=json(record.body,262144);exact(data,['format','spec','entries','projection','previous','change'],'book');
    ensure(data.format===FORMAT&&canonical(data.spec)===canonical(this.#spec),'LEARNING_BOOK','book identity or pinned configuration changed');
    // Audit append-only source history. Old source versions cannot be overwritten by summary edits.
    let child={record,data};
    for(let revision=record.revision;revision>=1;revision--){
      const {record:current,data:c}=child;
      ensure(c.format===FORMAT&&canonical(c.spec)===canonical(this.#spec),'LEARNING_BOOK','historical identity mismatch');
      ensure(Array.isArray(c.entries)&&c.entries.length<=this.#spec.maxEpisodes&&c.change&&['initialize','observe','correct'].includes(c.change.kind),
        'LEARNING_BOOK','bounded source history and known change required');
      if(revision===1){ensure(c.previous===null&&c.entries.length===0&&c.change.kind==='initialize','LEARNING_BOOK','invalid ledger origin');break;}
      const parent=this.#store.read(this.#id,revision-1),p=json(parent.body,262144);
      ensure(Array.isArray(p.entries),'LEARNING_BOOK','historical source history missing');
      ensure(refKey(c.previous??{})===refKey(parent),'LEARNING_BOOK','missing predecessor');
      if(c.change.kind==='observe'){
        ensure(c.entries.length===p.entries.length+1&&canonical(c.entries.slice(0,-1))===canonical(p.entries)
          &&refKey(c.change.source)===refKey(c.entries.at(-1).action)&&c.entries.at(-1).corrections.length===0,
          'LEARNING_BOOK','observation must append exactly one source');
      }else{
        ensure(c.change.kind==='correct'&&c.entries.length===p.entries.length,'LEARNING_BOOK','unsupported ledger revision');
        let changed=0;
        for(let i=0;i<c.entries.length;i++){
          if(canonical(c.entries[i])===canonical(p.entries[i]))continue;changed++;
          ensure(refKey(c.entries[i].action)===refKey(p.entries[i].action)&&c.entries[i].corrections.length===p.entries[i].corrections.length+1
            &&canonical(c.entries[i].corrections.slice(0,-1))===canonical(p.entries[i].corrections)
            &&refKey(c.change.source)===refKey(c.entries[i].corrections.at(-1)), 'LEARNING_BOOK','correction must append one source');
        }
        ensure(changed===1,'LEARNING_BOOK','exactly one episode correction required');
      }
      child={record:parent,data:p};
    }
    const rebuilt=this.#derive(data.entries);
    ensure(canonical(rebuilt.projection)===canonical(data.projection)&&canonical(rebuilt.evidence)===canonical(record.evidence),
      'LEARNING_BOOK','saved projection/source roots do not match replay');
    return {record,data,...rebuilt};
  }
  #write(previous,entries,change){
    const derived=this.#derive(entries),payload={format:FORMAT,spec:this.#spec,entries,projection:derived.projection,
      previous:previous?ref(previous.record):null,change};
    ensure(Buffer.byteLength(canonical(payload))<=262144,'LEARNING_CAPACITY','bounded bookkeeping capacity reached');
    const result=this.#store.execute({requestId:`learning:${digest({id:this.#id,previous:payload.previous,payload})}`,
      commands:[{op:'write_note',id:this.#id,expectedRevision:previous?.record.revision??0,kind:'skill',body:canonical(payload),
        change:change.kind==='initialize'?'self_report':change.kind==='observe'?'new_evidence':'reinterpretation',
        confidence:'tentative',evidence:derived.evidence,scope:{scenes:[],people:[this.#spec.subject],validFrom:null,validUntil:null}}]}).at(-1).record;
    this.#diagnostic('committed','ok',{changeCount:1,writes:[{id:result.id,revision:result.revision,type:'note'}],reason:change.kind});
    return result;
  }
  initialize(){const existing=this.#store.view(()=>this.#load());return existing?.record??this.#write(null,[],{kind:'initialize'});}
  observe({action}){
    try{
      const old=this.#store.view(()=>this.#load());ensure(old,'LEARNING_BOOK','initialize before observing');
      const entry={action:uniqueRefs([action])[0],corrections:[]};rawEpisode(this.#store,this.#spec,entry);
      const duplicate=old.data.entries.find(e=>e.action.id===action.id);
      if(duplicate){ensure(refKey(duplicate.action)===refKey(action),'LEARNING_DUPLICATE','same action with another version');
        this.#diagnostic('replayed','replayed',{reason:'same-action-no-new-sample'});return old.record;}
      return this.#write(old,[...old.data.entries,entry],{kind:'observe',source:entry.action});
    }catch(error){this.#diagnostic('rejected','rejected',failureMetadata(error));throw error;}
  }
  correct({event}){
    try{
      const old=this.#store.view(()=>this.#load());ensure(old,'LEARNING_BOOK','initialize before correcting');
      const r=uniqueRefs([event])[0];
      if(old.data.entries.some(e=>e.corrections.some(x=>refKey(x)===refKey(r))))return old.record;
      const correction=requireRecord(this.#store,r,'event'),d=json(correction.body);
      const index=old.data.entries.findIndex(e=>refKey(e.action)===refKey(d.action??{}));
      ensure(index>=0,'LEARNING_CORRECTION','correction must target an existing attempt');
      const entries=old.data.entries.map((e,i)=>i===index?{...e,corrections:[...e.corrections,r]}:e);
      return this.#write(old,entries,{kind:'correct',source:r});
    }catch(error){this.#diagnostic('rejected','rejected',failureMetadata(error));throw error;}
  }
  inspect({revision}={}){return this.#store.view(()=>{
    const book=this.#load(revision);ensure(book,'LEARNING_BOOK','unknown ledger');
    return {ref:ref(book.record),spec:JSON.parse(canonical(this.#spec)),projection:book.projection,
      sources:book.records.map((x,i)=>({action:book.data.entries[i].action,context:x.context,receipt:x.receipt,effectiveSource:x.effectiveSource,
        correctionCount:book.data.entries[i].corrections.length})),evidence:book.evidence};
  });}
  material({context}){
    const state=this.#store.view(()=>{
      const book=this.#load();ensure(book,'LEARNING_BOOK','initialize before prediction');
      const q=contextRecord(this.#store,this.#spec,context),prediction=predictLearning(this.#spec,book.projection,q.features);
      const applicability={'conditional-observations':'这些结果来自上述分组条件','broad-observations':'这些是较宽范围的结果',
        'unseen-branch-action-broad-fallback':'当前分组下还没试过此做法，暂列较宽范围的结果'};
      const rows=prediction.actions.map(x=>`${x.action}：已知结果${x.observed}次（${this.#spec.outcomes.map(o=>`${o} ${x.counts[o]}次`).join('，')}）；${x.familiarityScope==='selected-condition'?'这类条件下':'本领域'}实际使用${x.familiarity}次；${applicability[x.applicability]}。`);
      const resolution=prediction.specificity==='one-feature-only'?'只区分了上述一种条件':prediction.specificity==='broad'?'目前仅保留较宽的经验概括':'缺少已采用的分组条件，暂用较宽的经验概括';
      const body=[`在${this.#spec.domain}中的经验线索（来源${book.record.id}@${book.record.revision}，不是行为指令）：`,
        `当前已观察条件：${canonical(q.features)}；分组条件：${canonical(prediction.condition)}。`,...rows,
        `未知或未执行的结果${prediction.unknown}次未计为失败。未出现的条件、其他工具和其他领域未验证；熟悉不等于有效，也不等于你愿意采用。`,
        `${resolution}。可继续、检查、求助或暂放；详细来源可按引用查阅。`].join('\n');
      return {book,query:q,body,prediction,id:`${this.#id}:card:${digest({context}).slice(0,20)}`};
    });
    const old=this.#store.read(state.id),evidence=[ref(state.book.record),ref(state.query.record)];
    ensure(!old||old.type==='note'&&old.kind==='skill'&&old.evidence.some(r=>r.id===this.#id),'LEARNING_BOOK','card id belongs to another record');
    let card=old;
    if(!old||old.body!==state.body||canonical(old.evidence)!==canonical(evidence)){
      card=this.#store.execute({requestId:`learning-card:${digest({id:state.id,body:state.body,evidence,expected:old?.revision??0})}`,
        commands:[{op:'assert_current',ref:ref(state.book.record)},{op:'assert_current',ref:ref(state.query.record)},
          {op:'write_note',id:state.id,expectedRevision:old?.revision??0,kind:'skill',body:state.body,change:'reinterpretation',
            evidence,confidence:'tentative',scope:{scenes:[state.query.record.scene],people:[this.#spec.subject],validFrom:null,validUntil:null}}]}).at(-1).record;
    }
    this.#diagnostic('delivered','ok',{source:ref(state.book.record),bytes:Buffer.byteLength(card.body),reason:'compact-candidate-not-directive'});
    return {ref:ref(card),book:ref(state.book.record),context:ref(state.query.record),prediction:state.prediction,body:card.body};
  }
  prepare({session,currentEvent,...args}){
    const material=this.material({context:currentEvent});
    const packet=session.prepare({...args,currentEvent,materials:[...(args.materials??[]),{ref:material.ref,aspect:'knowledge'}]});
    ensure(packet.payload.continuity?.subject.id===this.#spec.subject,'SUBJECT_MISMATCH','learning decision belongs to another subject');
    return {packet,material};
  }
  commit({session,prepared,...args}){
    const {packet,material}=prepared,card=requireRecord(this.#store,material.ref,'note');
    ensure(packet.payload.continuity?.subject.id===this.#spec.subject&&packet.payload.materials.some(m=>refKey(m.ref)===refKey(card))
      &&refKey(packet.payload.current)===refKey(material.context)&&card.evidence.some(r=>refKey(r)===refKey(material.book))&&material.book.id===this.#id,
      'LEARNING_BINDING','learning material and current decision must be bound');
    return session.commit({...args,packet,guardRefs:[material.book]});
  }
}
