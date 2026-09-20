// 用户级技能仓库存储端口：每用户 0..1 条配置 + 最近同步状态。
// 详见 specs/2026-09-20-skill-repo-git-sync-design.md。

import type {
  SkillRepoSyncStatus,
  UserSkillRepoConfig,
  UserSkillRepoInput,
} from "../domain/user-skill-repo.js";

export interface UserSkillRepoStore {
  migrate(): void;
  get(userId: string): Promise<UserSkillRepoConfig | undefined>;
  upsert(userId: string, input: UserSkillRepoInput): Promise<void>;
  /** 解绑（清空配置）。 */
  remove(userId: string): Promise<void>;
  /** 记录最近一次同步结果（同步服务回写；失败不抛出由调用方兜底）。 */
  setSyncStatus(
    userId: string,
    patch: { at: string; status: SkillRepoSyncStatus; error?: string },
  ): Promise<void>;
}
