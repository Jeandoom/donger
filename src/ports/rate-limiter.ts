/** 限流端口（设计规格 §6.3）：滑动窗口计数。内存实现单实例够用，接口留分布式实现位。 */
export interface RateLimiter {
  /**
   * 记一次并判断是否放行：key 在 windowMs 窗口内的计数（含本次）超过 max 时拒绝。
   * 拒绝的请求也计数（持续打窗口会持续拒绝）。
   */
  hit(key: string, windowMs: number, max: number): boolean;
  /** 只读查询：key 在 windowMs 窗口内的当前计数（不新增） */
  count(key: string, windowMs: number): number;
}

/** 限流键约定："<用途>:<主体>"，如 signup:1.2.3.4、login-fail:user@x.com、llm-debug:<userId> */
export const RateLimitKeys = {
  signup(ip: string): string {
    return `signup:${ip}`;
  },
  loginFail(email: string): string {
    return `login-fail:${email}`;
  },
  llmDebug(userId: string): string {
    return `llm-debug:${userId}`;
  },
} as const;
