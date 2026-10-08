/**
 * 会话不可恢复识别（specs/2026-10-08-zcode-session-lifecycle-contract.md §C3）：
 * 「指针指向的会话无法接续」的引擎报错 → 统一语义，命中即清指针重开新会话
 * （recoverResume=false 防回环）。B0 反查只救空指针，坏指针靠这里兜底。
 */
export const SESSION_EXPIRED_RE = /No conversation found with session ID|Session not found:/i;

export function isSessionExpiredError(error: string | undefined | null): boolean {
  return !!error && SESSION_EXPIRED_RE.test(error);
}
