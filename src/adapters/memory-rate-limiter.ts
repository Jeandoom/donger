import type { RateLimiter } from "../ports/rate-limiter.js";

/**
 * 内存滑动窗口限流（单实例部署够用）。
 * 惰性清理：hit/count 时顺带清该 key 的过期点，防 Map 无界增长。
 */
export class MemoryRateLimiter implements RateLimiter {
  /** key → 命中时间戳（毫秒） */
  private readonly buckets = new Map<string, number[]>();

  hit(key: string, windowMs: number, max: number): boolean {
    const now = Date.now();
    const hits = (this.buckets.get(key) ?? []).filter((t) => now - t < windowMs);
    hits.push(now);
    this.buckets.set(key, hits);
    return hits.length <= max;
  }

  count(key: string, windowMs: number): number {
    const now = Date.now();
    const hits = (this.buckets.get(key) ?? []).filter((t) => now - t < windowMs);
    this.buckets.set(key, hits);
    return hits.length;
  }
}
