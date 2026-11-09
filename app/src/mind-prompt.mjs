import {readFileSync} from 'node:fs';
import {ensure} from './contracts.mjs';
const extension=readFileSync(new URL('../prompts/decision-mind.zh.md',import.meta.url),'utf8');
const originalKinds='feeling/appraisal/intention/tension/activity';
const expandedKinds=originalKinds+'/concern/condition/expectation/readiness';

// Compile one consistent protocol rather than appending a second, contradictory whitelist.
export function withMindInstructions(base){
  ensure(typeof base==='string'&&base.includes(originalKinds),'MIND_PROMPT_BASE','expected a personal-state protocol');
  const updated=base.replaceAll(originalKinds,expandedKinds)
    .replace('可含kind、body、status、scope、basis、reason；','可含kind、body、status、scope、basis、reason、mind；')
    .replace('可含kind、body、status、scope、basis、reason。','可含kind、body、status、scope、basis、reason、mind。')
    .replace('可含kind、body、status、scope、basis。','可含kind、body、status、scope、basis、mind。');
  ensure(updated.includes('basis、reason、mind')||updated.includes('basis、mind'),'MIND_PROMPT_BASE','state field declaration was not extended');
  return updated+'\n\n'+extension;
}
