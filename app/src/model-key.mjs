// Generic model credential loader.
// Priority: DEEPSEEK_API_KEY -> <data>/secrets/deepseek.key
// This skeleton does not ship a provider-specific DPAPI helper.
import {existsSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';

const KEY_SHAPE=/^sk-[A-Za-z0-9_-]{12,}$/;
export function plainKeyPath(env=process.env){
  if(env.BRAIN_KEY_FILE)return resolve(env.BRAIN_KEY_FILE);
  if(env.AGENT_DATA)return resolve(env.AGENT_DATA,'secrets','deepseek.key');
  return null;
}
export function studyKey({env=process.env}={}){
  const direct=String(env.DEEPSEEK_API_KEY??'').trim();
  if(KEY_SHAPE.test(direct))return direct;
  const file=plainKeyPath(env);
  if(file&&existsSync(file)){
    const value=readFileSync(file,'utf8').trim();
    if(KEY_SHAPE.test(value))return value;
  }
  const error=new Error('model key required: set DEEPSEEK_API_KEY or write data/secrets/deepseek.key');
  error.code='MODEL_KEY_REQUIRED';
  throw error;
}
