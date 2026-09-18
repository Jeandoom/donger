import { randomUUID } from "node:crypto";
import { z } from "zod";

/**
 * 邀请注册链接（用户在设置→邀请模块生成）。
 * 注册时持有效邀请可绕过邮箱域名白名单（防 robot 的受控增长机制）。
 */
export const InviteSchema = z.object({
  id: z.string(),
  /** URL 安全随机串（注册链接 /register?invite=<token>） */
  token: z.string(),
  createdBy: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  maxUses: z.number().int().positive(),
  usedCount: z.number().int().nonnegative(),
  disabled: z.boolean(),
});
export type Invite = z.infer<typeof InviteSchema>;

/** 邀请不可用的原因（null=可用） */
export function inviteBlockReason(invite: Invite, now: Date): string | null {
  if (invite.disabled) return "邀请链接已被禁用";
  if (new Date(invite.expiresAt).getTime() <= now.getTime()) return "邀请链接已过期";
  if (invite.usedCount >= invite.maxUses) return "邀请链接使用次数已用完";
  return null;
}

/** 邮箱规范化：去空白 + 小写（注册与登录共用同一形态作 externalId）。 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * 无邀请时按域名白名单判定能否自助注册。
 * 白名单为空 = 关闭无邀请自助注册（防止漏配敞开 robot 注册口子）。
 * 条目支持 ".example.com" 通配子域（带点边界，不会误吞 notexample.com）。
 */
export function isEmailDomainAllowed(email: string, whitelist: ReadonlySet<string>): boolean {
  if (whitelist.size === 0) return false;
  const domain = (email.split("@")[1] ?? "").toLowerCase();
  if (!domain) return false;
  if (whitelist.has(domain)) return true;
  for (const entry of whitelist) {
    if (entry.startsWith(".")) {
      const bare = entry.slice(1);
      if (domain === bare || domain.endsWith(`.${bare}`)) return true;
    }
  }
  return false;
}

/** 密码强度：≥8 位且同时含字母与数字。返回错误信息（null=通过）。 */
export function passwordPolicyError(password: string): string | null {
  if (password.length < 8) return "密码至少 8 位";
  if (!/[a-zA-Z]/.test(password) || !/\d/.test(password)) return "密码需同时包含字母和数字";
  return null;
}

/** 生成邀请对象（API 层工厂）。有效期天数 1–30、单邀请最多 100 次。 */
export function buildInvite(params: {
  createdBy: string;
  expiresInDays: number;
  maxUses: number;
}): Invite {
  const now = new Date();
  const days = Math.min(Math.max(Math.trunc(params.expiresInDays), 1), 30);
  const uses = Math.min(Math.max(Math.trunc(params.maxUses), 1), 100);
  return {
    id: randomUUID(),
    token: `${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`,
    createdBy: params.createdBy,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString(),
    maxUses: uses,
    usedCount: 0,
    disabled: false,
  };
}

/** 邮箱验证窗口（裁决②：24h 不验证即失效，不宽限） */
export const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000;

/** 每账号每自然月最多生成邀请数（裁决⑤；跨月自动恢复，无需重置任务） */
export const INVITE_MONTHLY_QUOTA = 30;

/** 本月 1 日 0 点（本地时区）的 ISO 时间戳，配额计数窗口起点 */
export function monthStartIso(now: Date = new Date()): string {
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  return start.toISOString();
}

/** 邀请配额判定（纯函数）：本月已生成数达到上限即拒绝 */
export function inviteQuotaExceeded(createdThisMonth: number): boolean {
  return createdThisMonth >= INVITE_MONTHLY_QUOTA;
}
