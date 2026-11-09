// 简单的内存滑动窗口限流 + 同一来源并发锁（防重复提交）。单进程部署适用。

export class RateLimiter {
  constructor({ limit, windowMs, now = () => Date.now() }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.hits = new Map();
  }

  /** @returns {{ok: true} | {ok: false, retryAfterSec: number}} */
  take(key) {
    const t = this.now();
    const arr = (this.hits.get(key) || []).filter((x) => t - x < this.windowMs);
    if (arr.length >= this.limit) {
      this.hits.set(key, arr);
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((this.windowMs - (t - arr[0])) / 1000)) };
    }
    arr.push(t);
    this.hits.set(key, arr);
    if (this.hits.size > 50000) this.sweep();
    return { ok: true };
  }

  sweep() {
    const t = this.now();
    for (const [k, arr] of this.hits) {
      if (!arr.some((x) => t - x < this.windowMs)) this.hits.delete(k);
    }
  }
}

export class InFlight {
  constructor() { this.keys = new Set(); }
  acquire(key) {
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    return true;
  }
  release(key) { this.keys.delete(key); }
}
