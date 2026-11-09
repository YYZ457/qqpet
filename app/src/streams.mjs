// 事件流：把"来源/会话/话题"统一成一条可分层的事件流路径。
// 核心只认路径，不认 QQ/微信/B站；适配器把自己的层级映射成 scene 路径即可。
// 约定：scene 用 / 或 : 分隔，最多 4 层；"同流"= 一方是另一方的前缀（祖先或后代）。
import {ensure,text} from './contracts.mjs';

const MAX_DEPTH=4,MAX_SEGMENT=64;

export function normalizeStream(scene){
  text(scene,'scene');
  const parts=String(scene).split(/[:/]+/).map(x=>x.trim()).filter(Boolean);
  ensure(parts.length>=1&&parts.length<=MAX_DEPTH,'STREAM_SHAPE','stream path must have 1..4 segments');
  parts.forEach(p=>ensure([...p].length<=MAX_SEGMENT,'STREAM_SHAPE','stream segment too long'));
  return parts;
}

export function streamInfo(scene){
  const path=normalizeStream(scene);
  return {format:'stream-v1',scene,path,source:path[0],label:path.join('·')};
}

export function streamRelation(current,candidate){
  const a=normalizeStream(current),b=normalizeStream(candidate);
  const shorter=a.length<=b.length?a:b,longer=a.length<=b.length?b:a;
  const prefix=shorter.every((seg,i)=>longer[i]===seg);
  if(prefix)return 'same-flow';
  if(a[0]===b[0])return 'sibling-flow';
  return 'other-flow';
}
