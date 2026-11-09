import {ensure} from './contracts.mjs';

// 缓存友好序列化：内容不变，只把"变化频率低"的字段排到前面。
// 目的：让模型请求的前缀在连续回合间尽量保持相同，从而复用服务商的提示缓存。
// 这不是语义变更：stableFirstCanonical(x) 与 canonical(x) 解析后是同一个对象；
// digest/packetId 仍使用 canonical()，账本指纹、引用与版本不受影响。
export const SERIALIZATION = 'stable-first-v1';

// 顶层顺序：会话稳定 → 轮次稳定 → 本轮易变。数组内顺序不动。
const TOP_RANK = new Map([
  ['format', 0], ['allowedActionTools', 0], ['identity', 0], ['legacyCatalog', 0],
  ['memoryAccess', 1], ['workspace', 1],
  ['continuity', 2], ['operationInterface', 2],
]);
const TOP_ORDER = ['format', 'allowedActionTools', 'identity', 'legacyCatalog',
  'memoryAccess', 'workspace', 'continuity', 'operationInterface'];

// 嵌套顺序：只登记需要提前的稳定字段；未登记的键默认作为易变字段排在后面（层内按字母序）。
const NESTED_RANK = new Map([
  ['memoryAccess.consultation', 2], ['memoryAccess.remainingReads', 3],
  ['continuity.attention', 0], ['continuity.detail', 1], ['continuity.foreground', 1],
  ['continuity.maxForeground', 1], ['continuity.mind', 1], ['continuity.recalled', 1],
  ['continuity.lastReaction', 3], ['continuity.pendingObservations', 3], ['continuity.subject', 3],
  ['continuity.attention.directory', 1], ['continuity.attention.entries', 1],
  ['continuity.attention.frame', 1], ['continuity.attention.kind', 1],
  ['continuity.attention.materialSupport', 1], ['continuity.attention.omittedRelations', 1],
  ['continuity.attention.pathDepthLimited', 1], ['continuity.attention.pathScanLimited', 1],
  ['continuity.attention.recoverySupport', 1],
  ['continuity.attention.focusSupport', 3], ['continuity.attention.materials', 3],
  ['continuity.attention.processes', 3], ['continuity.attention.questions', 3],
  ['continuity.attention.relations', 3], ['continuity.attention.residences', 3],
  ['continuity.attention.selection', 3], ['continuity.attention.staleRelations', 3],
  ['continuity.attention.validSelection', 3],
  ['operationInterface.tools', 1],
  ['operationInterface.existing', 3], ['operationInterface.basisMenu', 3],
  ['operationInterface.currentObservation', 3],
]);

function rankOf(parentPath, key) {
  if (!parentPath) return TOP_RANK.get(key) ?? 3;
  const full = parentPath + '.' + key;
  if (NESTED_RANK.has(full)) return NESTED_RANK.get(full);
  if (NESTED_RANK.has(parentPath)) return NESTED_RANK.get(parentPath);
  return 3;
}

function compare(parentPath, a, b) {
  const ra = rankOf(parentPath, a), rb = rankOf(parentPath, b);
  if (ra !== rb) return ra - rb;
  if (!parentPath) {
    const ia = TOP_ORDER.indexOf(a), ib = TOP_ORDER.indexOf(b);
    if (ia !== ib) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

function encode(value, path) {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return JSON.stringify(value);
  if (type === 'number') { ensure(Number.isFinite(value), 'INVALID_INPUT', 'nonfinite number'); return JSON.stringify(value); }
  ensure(type === 'object', 'INVALID_INPUT', 'JSON values only');
  if (Array.isArray(value)) return '[' + value.map(item => encode(item, path)).join(',') + ']';
  ensure(Object.getPrototypeOf(value) === Object.prototype, 'INVALID_INPUT', 'JSON values only');
  const keys = Object.keys(value).sort((a, b) => compare(path, a, b));
  return '{' + keys.map(key => JSON.stringify(key) + ':' + encode(value[key], path ? path + '.' + key : key)).join(',') + '}';
}

// 与 canonical() 输出同一对象、只改变字段顺序；可安全用于请求消息字节。
export function stableFirstCanonical(value) { return encode(value, ''); }

// 两个消息串的公共前缀字符数（用于本地估算缓存可复用长度与诊断记录）。
export function stablePrefixChars(a, b) {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i] === b[i]) i++;
  return i;
}
