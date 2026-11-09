// Inspect stored inputs/accepted changes/real receipts; this is not hidden chain-of-thought.
import {ensure,refKey,uniqueRefs} from './contracts.mjs';
import {readReaction} from './continuity.mjs';
const ref=r=>({id:r.id,revision:r.revision});

export function readMindTrace({store,subjectId,decision}){
  uniqueRefs([decision]);
  return store.view(()=>{
    const d=store.read(decision.id,decision.revision);
    ensure(d?.type==='decision'&&d.input.payload.continuity?.subject.id===subjectId,'MISSING_REACTION','unknown own decision');
    const reaction=readReaction({store,subjectId,decision}),cards=[...d.input.payload.continuity.foreground,...d.input.payload.continuity.recalled];
    const after=store.read(reaction.stateAfter.subject.id,reaction.stateAfter.subject.revision);
    const states=after.changedStates.map(r=>store.read(r.id,r.revision));
    const action=d.action?store.read(d.action.id):null;
    const receipts=action?.receipt?[store.read(action.receipt.id,action.receipt.revision)]:[];
    return {format:'agent-mind-trace-v1',decision:ref(d),
      delivered:{currentEvent:d.currentEvent,workspace:d.workspace,mind:d.input.payload.continuity.mind??null,
        states:cards.map(c=>({ref:c.ref,historical:c.historical})),materials:d.input.payload.materials.map(m=>m.ref),
        grantedTools:d.input.payload.allowedActionTools},
      proposed:d.output.continuity.changes,
      accepted:states.map(s=>({ref:ref(s),kind:s.kind,body:s.body,scope:s.scope,nature:s.nature,reason:s.reason,basis:s.basis,
        predecessor:s.predecessor,...(s.mind?{mind:s.mind}:{})})),
      keptDelivered:cards.filter(c=>!states.some(s=>s.id===c.ref.id)).map(c=>c.ref),
      selected:reaction.choice,expressionChoice:reaction.expressionChoice,
      execution:action?{ref:ref(action),status:action.status,receipt:action.receipt,asOf:'inspection-time',receipts}:{status:'no-action-intent',receipts:[]},
      delivery:reaction.response,
      continuation:{subject:reaction.stateAfter.subject,foreground:reaction.stateAfter.foreground,changed:reaction.stateAfter.changed},
      limitations:['structured-proposal-is-not-private-reasoning','declared-basis-is-not-proof-of-causal-influence','next-input-must-be-inspected-separately']};
  });
}

export function compareMindDelivery({trace,nextPacket}){
  const context=nextPacket.payload.continuity;
  ensure(context&&context.subject.id===trace.continuation.subject.id,'SUBJECT_MISMATCH','continuation belongs to another subject');
  const presented=new Map([...context.foreground,...context.recalled].map(c=>[refKey(c.ref),c]));
  return trace.accepted.map(s=>({ref:s.ref,delivered:presented.has(refKey(s.ref)),
    historical:presented.get(refKey(s.ref))?.historical??null,
    meaning:presented.has(refKey(s.ref))?'actually-in-next-input':'not-delivered-background-or-newer-version'}));
}
