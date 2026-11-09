import {createHash} from 'node:crypto';

export class ContractError extends Error {
  constructor(code, message, details = {}) {
    super(message); this.name = 'ContractError'; this.code = code; this.details = details;
  }
}
export function ensure(ok, code, message, details) {
  if (!ok) throw new ContractError(code, message, details);
}
export function text(value, name) {
  ensure(typeof value === 'string' && value.trim().length > 0, 'INVALID_INPUT', `${name} must be nonempty text`);
  return value;
}
export function time(value, name = 'time') {
  ensure(Number.isSafeInteger(value) && value >= 0, 'INVALID_INPUT', `${name} must be nonnegative integer milliseconds`);
  return value;
}
export function revision(value) {
  ensure(Number.isSafeInteger(value) && value >= 0, 'INVALID_INPUT', 'invalid revision'); return value;
}
export function oneOf(value, choices, name) {
  ensure(choices.includes(value), 'INVALID_INPUT', `invalid ${name}`); return value;
}
function normalize(value,path='root') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') { ensure(Number.isFinite(value), 'INVALID_INPUT', 'nonfinite number',{path}); return value; }
  if (Array.isArray(value)) return value.map((v,i)=>normalize(v,path+'['+i+']'));
  ensure(value && Object.getPrototypeOf(value) === Object.prototype, 'INVALID_INPUT', 'JSON values only',{path,kind:Object.prototype.toString.call(value),keys:value&&typeof value==='object'?Object.keys(value):[]});
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key],path+'.'+key)]));
}
export const canonical = value => JSON.stringify(normalize(value));
export const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
export const refKey = ref => `${ref.id}@${ref.revision}`;
export function uniqueRefs(refs) {
  ensure(Array.isArray(refs) && refs.length <= 256, 'INVALID_INPUT', 'too many or invalid references');
  return [...new Map(refs.map(ref => {
    ensure(ref && Object.getPrototypeOf(ref) === Object.prototype, 'INVALID_INPUT', 'reference must be an object');
    text(ref.id, 'reference id'); revision(ref.revision);
    ensure(ref.revision > 0, 'INVALID_INPUT', 'references must pin a version');
    return [refKey(ref), {id: ref.id, revision: ref.revision}];
  })).values()];
}
