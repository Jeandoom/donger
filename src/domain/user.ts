import { z } from "zod";

// 历史兼容：已删除 staffId 字段；既有数据的 mergedFrom 仍保留。
// 管理员判定改用 user_identities 的 externalId，见 config.ts 的 adminExternalIds。

export type UserRole = "admin" | "user";

export const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.enum(["admin", "user"]),
  homeDir: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  avatar: z.string().optional(),
  mergedFrom: z.array(z.string()).optional(),
});
export type User = z.infer<typeof UserSchema>;

/** 多通道身份绑定 */
export interface UserIdentity {
  id: string;
  userId: string;
  provider: string; // "dingtalk" | "github" | "feishu" | ...
  externalId: string; // 各平台的用户唯一标识（如 staffId、openId、GitHub 数字 id）
  unionId?: string;
  name?: string;
  avatar?: string;
  rawProfile?: string; // OAuth 返回的原始用户信息（JSON）
  createdAt: string;
}

/**
 * 管理员白名单判定：条目为裸 externalId（全平台生效）或 "provider:externalId"（限定平台）。
 * 裸写法向后兼容既有 ADMIN_EXTERNAL_IDS（历史值均为钉钉 userId/staffId）。
 */
export function isAdminExternalId(
  whitelist: ReadonlySet<string>,
  provider: string,
  externalId: string,
): boolean {
  return whitelist.has(externalId) || whitelist.has(`${provider}:${externalId}`);
}
