import type { SidebarPrefs, User, UserIdentity, UserRole } from "../domain/user.js";

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
  /** 检查外部 ID 是否在管理员白名单中（含 provider:externalId 前缀条目，见 domain/user.ts） */
  isAdminByExternalId(provider: string, externalId: string): Promise<boolean>;
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
  /** 更新对话模块侧栏偏好（星标置顶智能体/分组排序，全量替换；随 User JSON 持久化） */
  updateSidebarPrefs(id: string, prefs: SidebarPrefs): Promise<void>;

  // ---- 邮箱注册的密码凭证（passwordHash 存独立表，见 SqliteUserStore.migrateCredentials） ----
  /** 写入/更新密码哈希（upsert） */
  setPasswordCredential(userId: string, passwordHash: string): Promise<void>;
  /** 读取密码哈希；未设置过密码返回 undefined */
  getPasswordCredential(userId: string): Promise<string | undefined>;

  // ---- 邮箱验证状态机（设计规格 §6.1：pending → verified；24h 不验证即失效） ----
  /** 写入/刷新验证凭据（pending 状态；重复调用 = 重新发起验证，旧 token 失效） */
  setEmailVerification(userId: string, v: { token: string; expiresAt: string }): Promise<void>;
  /** 读取验证状态；无邮箱凭证返回 undefined */
  getEmailVerification(userId: string): Promise<EmailVerificationState | undefined>;
  /** 按 token 原子核销验证（未过期且未验证才成功），返回 userId；无效/过期返回 undefined */
  markEmailVerified(token: string): Promise<string | undefined>;
  /** 管理端：列出全部 pending/过期未验证账号及其验证链接路径（方案 B 线下转交的数据源） */
  listEmailVerifications(): Promise<
    Array<{
      userId: string;
      email: string | undefined;
      verified: boolean;
      expiresAt: string | null;
      token: string | null;
    }>
  >;

  // ---- 零配置引导（spec 2026-09-21-auth-module-design §3.4） ----
  /** 是否存在 admin 用户（setup 状态判定的第一条件） */
  hasAnyAdmin(): Promise<boolean>;
  /**
   * 原子创建首个 admin（setup 通道）：事务内校验「无 admin 且无 setup_completed 标记」，
   * 创建 email 身份用户（role=admin、邮箱直接置已验证）并写 setup_completed 标记。
   * 已完成初始化时返回 "exists"，不产生任何变更。
   */
  createBootstrapAdmin(input: {
    email: string;
    passwordHash: string;
  }): Promise<"created" | "exists">;
}

/** 邮箱验证状态（verified=1 后 token/expiresAt 清空） */
export interface EmailVerificationState {
  verified: boolean;
  token: string | null;
  expiresAt: string | null;
}
