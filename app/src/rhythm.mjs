// 她的节律：只回答"现在是不是一个思考机会"，不决定她想什么、说什么。
// 纯函数：宿主提供真实时间、待处理事件、她自己的等待到期与预算；返回是否醒来与下一个拍点。
// 空转不是错误（她可以什么都不做），所以没有"按产出退避"这种替她评价的规则。
// 防自旋只靠结构：最小间隔、事件合并、等待到期即消费、预算门。

export function rhythmConfig(value = {}) {
  const beatMs = value.beatMs ?? 30 * 60 * 1000;          // 白天：自己想想的间隔
  const quietBeatMs = value.quietBeatMs ?? 30 * 60 * 1000; // 夜里：不叫她，除非有事
  const quietFrom = value.quietFromHour ?? 23;             // 本地小时
  const quietTo = value.quietToHour ?? 7;
  const dailyCallCap = value.dailyCallCap ?? 96;
  for (const [name, n] of Object.entries({ beatMs, quietBeatMs }))
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  if (!Number.isSafeInteger(dailyCallCap) || dailyCallCap < 0) throw new Error('dailyCallCap must be nonnegative');
  if (!Number.isInteger(quietFrom) || !Number.isInteger(quietTo) || quietFrom < 0 || quietFrom > 23 || quietTo < 0 || quietTo > 23)
    throw new Error('quiet hours must be local hours 0..23');
  return { beatMs, quietBeatMs, quietFrom, quietTo, dailyCallCap };
}

const isQuiet = (localHour, cfg) => cfg.quietFrom <= cfg.quietTo
  ? localHour >= cfg.quietFrom && localHour < cfg.quietTo
  : localHour >= cfg.quietFrom || localHour < cfg.quietTo;

export const rhythmInterval = (localHour, cfg) => isQuiet(localHour, cfg) ? cfg.quietBeatMs : cfg.beatMs;

// state: { lastWakeAt, nextWakeAt, pendingEvents, callsToday, clockSuspect }
export function rhythmTick({ now, localHour, state, config }) {
  const cfg = rhythmConfig(config);
  const s = { lastWakeAt: state?.lastWakeAt ?? now, nextWakeAt: state?.nextWakeAt ?? null,
    pendingEvents: state?.pendingEvents ?? 0, callsToday: state?.callsToday ?? 0, clockSuspect: state?.clockSuspect ?? false };
  for (const [name, n] of Object.entries({ now, lastWakeAt: s.lastWakeAt }))
    if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name} must be a nonnegative safe integer`);
  if (!Number.isSafeInteger(s.pendingEvents) || s.pendingEvents < 0) throw new Error('pendingEvents must be nonnegative');
  if (!Number.isSafeInteger(s.callsToday) || s.callsToday < 0) throw new Error('callsToday must be nonnegative');

  const interval = rhythmInterval(localHour, cfg);
  const held = now < s.lastWakeAt;            // 时钟倒退：不假装又过了一轮，也不静默清零历史
  const elapsed = held ? 0 : now - s.lastWakeAt;
  const scheduledDue = s.nextWakeAt !== null && !held && now >= s.nextWakeAt;
  const beatDue = !held && elapsed >= interval;
  const reason = s.pendingEvents > 0 ? 'event' : scheduledDue ? 'scheduled' : beatDue ? 'beat' : null;

  if (held) return { wake: false, reason: 'clock-rollback', clockSuspect: true, modelAllowed: false,
    state: { ...s, clockSuspect: true }, nextAt: s.lastWakeAt + interval };
  if (reason === null) return { wake: false, reason: null, clockSuspect: false, modelAllowed: false,
    state: { ...s, clockSuspect: false }, nextAt: Math.max(now, s.lastWakeAt + interval) };
  // 预算耗尽：不再按节律自觉醒来；事件与她的等待到期仍可叫醒（是否调模型由 modelAllowed 决定）。
  if (reason === 'beat' && s.callsToday >= cfg.dailyCallCap) return { wake: false, reason: 'budget', clockSuspect: false, modelAllowed: false,
    state: { ...s, clockSuspect: false }, nextAt: now + interval };

  // 醒来一次就消费到期项：同一批事件只叫一次；等待到期只消费一次。
  const nextWakeAt = s.nextWakeAt !== null && s.nextWakeAt <= now ? null : s.nextWakeAt;
  const modelAllowed = s.callsToday < cfg.dailyCallCap;
  return { wake: true, reason, modelAllowed, clockSuspect: false,
    state: { lastWakeAt: now, nextWakeAt, pendingEvents: 0, callsToday: s.callsToday, clockSuspect: false },
    nextAt: now + interval };
}
