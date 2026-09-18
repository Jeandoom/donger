// GitAccessGate：对话前仓库访问校验（凭证桥单轨）。
// GitConnection 平台连接/grant 模型已退役（spec 2026-09-10 §8）：
// 公共仓库匿名可读即通过；私有仓库走 credentialCode 凭证桥现取，
// 用户未配值时 pendingCredential（由 Orchestrator 挂起凭证缺失问询）。

import type { Agent } from "../domain/agent.js";
import { gitPatFromValues } from "../domain/credential.js";
import {
  type AgentGitRepository,
  type GitAccessFailureReason,
  type GitAccessRequirement,
  type GitProvider,
  gitRepositoryFingerprint,
  isBlockedHost,
  parseRepositoryUrl,
} from "../domain/git.js";
import type { User } from "../domain/user.js";
import type { CredentialSetStore } from "../ports/credential-set-store.js";
import type {
  GitProcessCredential,
  RepositoryMaterializeItem,
  RepositoryMaterializer,
} from "../ports/repository-materializer.js";

export interface GitAccessCheck {
  ready: boolean;
  requirements: GitAccessRequirement[];
  materializeItems: RepositoryMaterializeItem[];
}

export class GitAccessGate {
  private readonly anonymousCache = new Map<string, { public: boolean; expiresAt: number }>();

  constructor(
    private readonly materializer: RepositoryMaterializer,
    private readonly credentialSets?: CredentialSetStore,
    private readonly cacheTtlMs = 600_000,
    /** 内网 host 守门（spec 2026-09-10 §5 R1）：缺省允许（本地部署定位） */
    private readonly allowPrivateHosts = true,
  ) {}

  async check(user: User, agent: Agent, signal?: AbortSignal): Promise<GitAccessCheck> {
    const failures: Array<{
      repository: AgentGitRepository;
      fingerprint: string;
      reason: GitAccessFailureReason;
    }> = [];
    const materializeItems: RepositoryMaterializeItem[] = [];
    for (const repository of agent.gitRepositories) {
      // host 守门：内网/元数据地址在多用户部署下默认拒绝（解析报错即视为不可用）
      const parsed = parseRepositoryUrl(repository.url);
      if (!parsed || isBlockedHost(parsed.host, this.allowPrivateHosts)) {
        failures.push({
          repository,
          fingerprint: gitRepositoryFingerprint(repository),
          reason: "provider_unavailable",
        });
        continue;
      }
      const fingerprint = gitRepositoryFingerprint(repository);
      if (await this.isPublic(repository, fingerprint, signal)) {
        materializeItems.push({ repository });
        continue;
      }
      if (repository.credentialCode) {
        const authorized = await this.checkWithCredential(repository, user, signal);
        if ("reason" in authorized)
          failures.push({ repository, fingerprint, reason: authorized.reason });
        else if ("pendingCredential" in authorized) materializeItems.push({ repository });
        else materializeItems.push({ repository, credential: authorized.credential });
        continue;
      }
      // 无 credentialCode 的非公共仓库：统一引导配置凭证（平台连接/grant 流程已退役）
      failures.push({ repository, fingerprint, reason: "access_denied" });
    }
    const requirements = groupRequirements(failures);
    return { ready: requirements.length === 0, requirements, materializeItems };
  }

  private async isPublic(
    repository: AgentGitRepository,
    fingerprint: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const cached = this.anonymousCache.get(fingerprint);
    if (cached && cached.expiresAt > Date.now()) return cached.public;
    const access = await this.materializer.checkRead(repository, undefined, signal);
    const isPublic = access.ok;
    this.anonymousCache.set(fingerprint, {
      public: isPublic,
      expiresAt: Date.now() + this.cacheTtlMs,
    });
    return isPublic;
  }

  /**
   * 凭证集 PAT 桥：credentialCode 指定时的私有仓库校验。
   * 用户未填该模板值时返回 pendingCredential——不在 Gate 硬阻断（否则会抢在凭证缺失
   * 三选问询之前），credentialCode 已并入 agent.credentials，由 Orchestrator 预检挂起问询。
   */
  private async checkWithCredential(
    repository: AgentGitRepository,
    user: User,
    signal?: AbortSignal,
  ): Promise<
    | { credential: GitProcessCredential }
    | { pendingCredential: true }
    | { reason: GitAccessFailureReason }
  > {
    const credential = await this.credentialFromTemplate(user.id, repository);
    if (!credential) return { pendingCredential: true };
    const access = await this.materializer.checkRead(repository, credential, signal);
    if (!access.ok) return { reason: access.reason };
    return { credential };
  }

  private async credentialFromTemplate(
    userId: string,
    repository: AgentGitRepository,
  ): Promise<GitProcessCredential | undefined> {
    if (!this.credentialSets) return undefined;
    const [filled] = await this.credentialSets.getFilledValues(userId, [
      repository.credentialCode as string,
    ]);
    const pat = gitPatFromValues(filled?.values);
    if (!pat) return undefined;
    return {
      username: pat.user || defaultGitUsername(repository.provider),
      accessToken: pat.accessToken,
    };
  }
}

/** 凭证模板未提供 username 键时的平台默认 HTTP 认证用户名 */
export function defaultGitUsername(provider: GitProvider): string {
  switch (provider) {
    case "github":
      return "x-access-token";
    case "jihulab":
      return "oauth2";
    case "gitee":
      return "x-token";
  }
}

function groupRequirements(
  failures: Array<{
    repository: AgentGitRepository;
    fingerprint: string;
    reason: GitAccessFailureReason;
  }>,
): GitAccessRequirement[] {
  const groups = new Map<string, GitAccessRequirement>();
  for (const failure of failures) {
    const key = `${failure.repository.provider}:${failure.reason}`;
    const group = groups.get(key) ?? {
      provider: failure.repository.provider,
      reason: failure.reason,
      repositories: [],
    };
    group.repositories.push({
      id: failure.repository.id,
      name: failure.repository.name,
      fingerprint: failure.fingerprint,
    });
    groups.set(key, group);
  }
  return [...groups.values()];
}
