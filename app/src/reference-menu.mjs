import {canonical,ensure,refKey,uniqueRefs} from './contracts.mjs';

// A per-packet, exact menu. Keys are presentation handles, never global identities.
export function referenceMenu(table,field='references'){
 ensure(Array.isArray(table)&&table.length<=64&&['references','usedRefs'].includes(field),'REFERENCE_MENU','bounded reference menu');
 ensure(table.every(r=>typeof r.key==='string'&&/^R[1-9][0-9]*$/.test(r.key))&&new Set(table.map(r=>r.key)).size===table.length,'REFERENCE_MENU','unique exact keys');
 uniqueRefs(table.map(r=>r.ref));
 ensure(new Set(table.map(r=>refKey(r.ref))).size===table.length,'REFERENCE_MENU','one key per fixed version');
 return {field,allowedValues:table.map(r=>r.key),emptyAllowed:true,
   example:table.length?{[field]:[table[0].key]}:{[field]:[]},
   meaning:'copy exact key only; example is syntax, not a request to cite; ref.id is not a key'};
}
export function resolveReferenceKey(table,key,{types=null}={}){
 referenceMenu(table);
 ensure(typeof key==='string','REFERENCE_KEY_REQUIRED','reference must be an exact delivered short key');
 const entry=table.find(r=>r.key===key);
 ensure(entry,table.some(r=>r.ref.id===key)?'REFERENCE_KEY_REQUIRED':'UNDELIVERED_REFERENCE',
   'copy a delivered key, never a full object id or a guessed name');
 ensure(types===null||types.includes(entry.type),'REFERENCE_TYPE','reference type does not match the operation');
 return JSON.parse(canonical(entry));
}
export function referenceTargetMenu(table,type){
 referenceMenu(table);ensure(['note','personal_state'].includes(type),'REFERENCE_MENU','known editable type');
 const keys=table.filter(r=>r.type===type).map(r=>r.key);
 return {type,allowedExistingTargets:keys,existingExample:keys.length?{target:keys[0]}:null,
   createExample:{target:{id:'new-unique-object-id',expectedRevision:0}},
   meaning:'existing target must be the exact short key, not record.id or ref.id; a new object uses id plus expectedRevision=0'};
}
