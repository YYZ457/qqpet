// 激活模型（docs/104/105）：有界、扇出降权、情境门控、阈值截断。
// 分数不是概率；只用于排序与取舍。
export const ACTIVATION = Object.freeze({
  lambda: 1,
  mu: 0.05,
  theta: 0.01,
  rhoPerDay: 0.997,
  maxDays: 365,
  gates: Object.freeze({same: 1, sibling: 0.4, other: 0.15}),
  bindingWeights: Object.freeze({spouse: 1, family: 1, colleague: 0.8, 'member-of': 0.7, 'located-at': 0.6, 'associated-with': 0.5}),
});

export const gateFor = relation => relation === 'same-flow' ? ACTIVATION.gates.same : relation === 'sibling-flow' ? ACTIVATION.gates.sibling : ACTIVATION.gates.other;
export const bindingWeight = relation => ACTIVATION.bindingWeights[relation] ?? 0.5;

export function simScore({gate, days = 0, config = ACTIVATION}) {
  const bounded = Math.min(Math.max(days, 0), config.maxDays);
  return gate * Math.pow(config.rhoPerDay, bounded);
}

export function activation({ b = 0, strength, sim, fan, config = ACTIVATION }) {
  return b + config.lambda * strength * sim - config.mu * Math.log(1 + Math.max(0, fan));
}

export const passes = (score, config = ACTIVATION) => score >= config.theta;
