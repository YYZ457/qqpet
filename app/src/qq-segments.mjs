// QQ 消息段 -> 可读文本；只做结构转换，不替她解释内容。
export function segmentsText(segs = []) {
  return (Array.isArray(segs) ? segs : []).map(s => {
    if (s?.type === 'text') return s.data?.text ?? '';
    if (s?.type === 'image') return '[图片]';
    if (s?.type === 'face') return '[表情]';
    if (s?.type === 'record') return '[语音]';
    if (s?.type === 'forward') return '[转发消息]';
    if (s?.type === 'json') return '[卡片消息]';
    if (s?.type === 'at') return `@${s.data?.qq ?? ''}`;
    return '';
  }).join('').trim();
}
