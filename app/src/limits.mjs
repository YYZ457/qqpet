// 记忆与上下文的容量配置：原来散落在各文件里的写死数字集中到这里。
// 默认值保持原行为；可以用环境变量（THREADLINE_*）或在代码里传 overrides 覆盖。
// 每个值都有上下限，越界直接报错，而不是悄悄截断。

const SPEC = {
  // 最近上下文 = QQ 会话面板：当前打开的聊天给完整记录，所有其他会话列在会话列表里并附最近消息预览。
  recentItems:             {env: 'THREADLINE_RECENT_ITEMS',              def: 50,     min: 1,    max: 200},   // 当前聊天最多几条
  recentBytes:             {env: 'THREADLINE_RECENT_BYTES',              def: 32000,  min: 2000, max: 120000}, // 整个会话面板的字节预算
  recentChats:             {env: 'THREADLINE_RECENT_CHATS',              def: 24,     min: 0,    max: 100},   // 会话列表最多列几个会话
  recentChatTail:          {env: 'THREADLINE_RECENT_CHAT_TAIL',          def: 8,      min: 0,    max: 50},    // 每个其他会话最多预览几条
  recentChatWindowHours:   {env: 'THREADLINE_RECENT_CHAT_WINDOW_HOURS',  def: 48,     min: 1,    max: 720},   // 多久没动静的会话不再列出（有未读的除外）
  // 前台状态卡容量（subject.maxForeground）
  foreground:              {env: 'THREADLINE_FOREGROUND',                def: 16,     min: 1,    max: 32},
  // 记忆整理窗口
  memoryWindowItems:       {env: 'THREADLINE_MEMORY_WINDOW_ITEMS',       def: 40,     min: 1,    max: 200},
  memoryDueMessages:       {env: 'THREADLINE_MEMORY_DUE_MESSAGES',       def: 50,     min: 1,    max: 1000},
  memoryDueMinutes:        {env: 'THREADLINE_MEMORY_DUE_MINUTES',        def: 120,    min: 1,    max: 10080},
  // 每轮查记忆
  lookupReads:             {env: 'THREADLINE_LOOKUP_READS',              def: 2,      min: 0,    max: 8},
  lookupHits:              {env: 'THREADLINE_LOOKUP_HITS',               def: 4,      min: 1,    max: 16},
  // 单次模型输入与调用次数
  inputBytes:              {env: 'THREADLINE_INPUT_BYTES',               def: 120000, min: 40000, max: 400000},
  callsPerTurn:            {env: 'THREADLINE_CALLS_PER_TURN',            def: 3,      min: 1,    max: 8},
  dailyCalls:              {env: 'THREADLINE_DAILY_CALLS',               def: 300,    min: 0,    max: 100000},
  // 同一个聊天里连发的几条未读合并成一轮来看（像人一样读完再回）；1 表示不合并
  burstMax:                {env: 'THREADLINE_BURST_MAX',                 def: 8,      min: 1,    max: 50},
  // 宿主提示（被丢弃的状态修改等）最多保留几条
  hostNotices:             {env: 'THREADLINE_HOST_NOTICES',              def: 8,      min: 0,    max: 32},
};

function fail(message) { const e = new Error(message); e.code = 'LIMITS_CONFIG'; throw e; }

export function resolveLimits(overrides = {}, env = process.env) {
  const out = {};
  for (const [key, spec] of Object.entries(SPEC)) {
    let value = spec.def, from = 'default';
    const raw = env?.[spec.env];
    if (raw !== undefined && raw !== '') { value = Number(raw); from = spec.env; }
    if (overrides[key] !== undefined) { value = overrides[key]; from = `overrides.${key}`; }
    if (!Number.isSafeInteger(value) || value < spec.min || value > spec.max)
      fail(`${key} (${from}) must be an integer in ${spec.min}..${spec.max}, got ${JSON.stringify(raw ?? overrides[key])}`);
    out[key] = value;
  }
  for (const key of Object.keys(overrides)) if (!SPEC[key]) fail(`unknown limit: ${key}`);
  return Object.freeze(out);
}

export const LIMIT_SPEC = Object.freeze(Object.fromEntries(Object.entries(SPEC).map(([k, v]) => [k, Object.freeze({...v})])));
