// 用户级技能仓库（纯数据 + 入参校验）：每用户 0..1 个 git 仓库，作为自建技能的
// 镜像/历史账本（非 pack source，运行时仍读本地盘）。凭证以 credentialCode 引用
// 凭证集中 kind="git" 模板，token 永不落本表。

import { z } from "zod";
import { CREDENTIAL_CODE_PATTERN } from "./credential.js";

/** 仓库地址：无凭证内嵌的 HTTPS 地址（与 CredentialTemplate.repoUrl 同规） */
export function cleanHttpsRepoUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash
    );
  } catch {
    return false;
  }
}

export const UserSkillRepoInputSchema = z.object({
  repoUrl: z.string().min(1).refine(cleanHttpsRepoUrl, "repoUrl 必须为无凭证内嵌的 HTTPS 地址"),
  credentialCode: z.string().regex(CREDENTIAL_CODE_PATTERN),
  branch: z
    .string()
    .regex(/^[\w./-]+$/, "分支名仅允许字母数字._-/")
    .max(100)
    .default("main"),
  enabled: z.boolean().default(true),
});
export type UserSkillRepoInput = z.infer<typeof UserSkillRepoInputSchema>;

export type SkillRepoSyncStatus = "ok" | "failed" | "skipped";

export interface UserSkillRepoConfig {
  userId: string;
  repoUrl: string;
  credentialCode: string;
  branch: string;
  enabled: boolean;
  lastSyncAt?: string;
  lastSyncStatus?: SkillRepoSyncStatus;
  lastSyncError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UserSkillRepoView {
  repoUrl: string;
  credentialCode: string;
  branch: string;
  enabled: boolean;
  lastSyncAt?: string;
  lastSyncStatus?: SkillRepoSyncStatus;
  lastSyncError?: string;
  createdAt: string;
  updatedAt: string;
}

export function toUserSkillRepoView(c: UserSkillRepoConfig): UserSkillRepoView {
  return {
    repoUrl: c.repoUrl,
    credentialCode: c.credentialCode,
    branch: c.branch,
    enabled: c.enabled,
    ...(c.lastSyncAt ? { lastSyncAt: c.lastSyncAt } : {}),
    ...(c.lastSyncStatus ? { lastSyncStatus: c.lastSyncStatus } : {}),
    ...(c.lastSyncError ? { lastSyncError: c.lastSyncError } : {}),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}
