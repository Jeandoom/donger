import type { User, UserIdentity, UserRole } from "../domain/user.js";

/**
 * 用户存储端口。
 * UserStore 现在以 user_identities 为唯一登录入口（getOrCreateByIdentity）。
 * 管理员判定改用 user_identities 的 externalId（isAdminByExternalId）。
 */
export interface UserStore {
  /** 获取用户 */
  get(id: string): Promise<User | undefined>;
  /** 列出所有用户 */
  list(): Promise<User[]>;

  // ---- identity ----
  /** 按 provider+externalId 查找用户；找不到就创建并绑定 identity */
  getOrCreateByIdentity(
    provider: string,
    externalId: string,
    name?: string,
    avatar?: string,
  ): Promise<User>;
  /** 检查外部 ID 是否在管理员白名单中 */
  isAdminByExternalId(externalId: string): Promise<boolean>;
  /** 通过平台 identity 查找已有用户（不创建） */
  findByIdentity(provider: string, externalId: string): Promise<User | undefined>;
  /** 为已有 User 绑定新 identity */
  addIdentity(userId: string, identity: UserIdentity): Promise<void>;
  /** 获取用户的所有 identity */
  getIdentities(userId: string): Promise<UserIdentity[]>;
  /** 更新用户头像和名称 */
  updateProfile(id: string, partial: Partial<Pick<User, "name" | "avatar">>): Promise<void>;
  /** 更新用户角色 */
  updateRole(id: string, role: UserRole): Promise<void>;
}
