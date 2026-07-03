import type { User, UserIdentity, UserRole } from "../domain/user.js";

/**
 * 用户存储端口。
 * getOrCreate：首次见到 staffId → 自动创建（含 homeDir 初始化 repos/+memory/）；已存在 → 返回。
 */
export interface UserStore {
  getOrCreate(staffId: string, name: string): Promise<User>;
  get(id: string): Promise<User | undefined>;
  getByStaffId(staffId: string): Promise<User | undefined>;
  updateRole(id: string, role: UserRole): Promise<void>;
  list(): Promise<User[]>;

  // ---- 新增 ----
  /** 通过平台 identity 查找用户 */
  findByIdentity(provider: string, externalId: string): Promise<User | undefined>;
  /** 为已有 User 绑定新 identity */
  addIdentity(userId: string, identity: UserIdentity): Promise<void>;
  /** 获取用户的所有 identity */
  getIdentities(userId: string): Promise<UserIdentity[]>;
  /** 合并两个用户的数据（sourceId → targetId） */
  mergeUsers(sourceId: string, targetId: string): Promise<void>;
  /** 更新用户头像和名称 */
  updateProfile(id: string, partial: Partial<Pick<User, "name" | "avatar">>): Promise<void>;
}
