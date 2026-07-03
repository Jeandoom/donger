import { z } from "zod";

export type UserRole = "admin" | "user";

export const UserSchema = z.object({
  id: z.string(),
  staffId: z.string(),
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
  provider: string;     // "dingtalk" | "feishu" | "qq" | ...
  externalId: string;   // 各平台的用户唯一标识（如 staffId、openId）
  unionId?: string;
  name?: string;
  avatar?: string;
  rawProfile?: string;  // OAuth 返回的原始用户信息（JSON）
  createdAt: string;
}
