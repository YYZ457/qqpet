// 原生项链：只复用旧模块的状态机/相册/信箱；不接旧 DSH token。
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Necklace} from './necklace.js';

const here=fileURLToPath(new URL('.',import.meta.url));
const dataDir=process.env.NECKLACE_DIR??resolve(here,'../../../_local/necklace');
const file=resolve(dataDir,'necklace.json');
const memory={enabled:false,store:{data:{self:{entries:[]}}}};
// 主人身份来自配置（QQ_OWNER 或 NECKLACE_OWNER_KEY），不再写死在代码里。
const ownerKey=process.env.NECKLACE_OWNER_KEY??(process.env.QQ_OWNER?`private:${process.env.QQ_OWNER}`:'private:owner');
const necklace=new Necklace({file,ownerKey,memory,experiences:{},journal:{},canReadMemory:()=>false});

export async function runNecklace(input={}){
  return necklace.request({...input,action:input.action??'status'},{actor:'agent'});
}
export function necklaceContext(){try{return necklace.context();}catch{return '';}}