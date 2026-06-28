import type { User, UserRole } from "../domain/user.js";

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
}
