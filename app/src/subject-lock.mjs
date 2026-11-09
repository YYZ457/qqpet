// 一个主体同一时刻只做一件“会改她状态的事”。
// 所有会调用模型并提交决定的路径（聊天回合、任务唤醒、记忆整理、后台维护）都要经过这把锁，
// 否则两轮并发时后提交的一轮会撞上 STALE_SUBJECT，这一轮想记住的东西就丢了。
export class SubjectLock {
  #tail = Promise.resolve();
  #holder = null;
  #waiting = 0;

  run(label, fn) {
    this.#waiting++;
    const run = this.#tail.then(async () => {
      this.#waiting--;
      this.#holder = {label: String(label), since: Date.now()};
      try { return await fn(); } finally { this.#holder = null; }
    });
    this.#tail = run.catch(() => {});
    return run;
  }

  holder() { return this.#holder ? {...this.#holder} : null; }
  busy() { return this.#holder !== null || this.#waiting > 0; }
}
