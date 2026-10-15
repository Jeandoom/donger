// GitAccessGate：对话前仓库就绪预检（纯本地，不发任何网络请求）。
// 2026-10-15 预检去网络化：公共/私有判定与凭证有效性不再 ls-remote 前置探测——
// 未配置的凭证由通用凭证预检（agent.credentials 三选问询）承接；已配但失效/私有仓
// 未绑凭证由物化层现取现败，补救引导见 runtime-manager 的物化失败分类。
// 本地仅保留两件事：URL/host 配置校验（内网守门 spec 2026-09-10 §5 R1）与
// 凭证模板值解析（credentialCode → PAT，随 materializeItems 下发）。

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
} from "../ports/repository-materializer.js";

export interface GitAccessCheck {
  ready: boolean;
  requirements: GitAccessRequirement[];
  materializeItems: RepositoryMaterializeItem[];
}

export class GitAccessGate {
  constructor(
    private readonly credentialSets?: CredentialSetStore,
    /** 内网 host 守门（spec 2026-09-10 §5 R1）：缺省允许（本地部署定位） */
    private readonly allowPrivateHosts = true,
  ) {}

  async check(user: User, agent: Agent): Promise<GitAccessCheck> {
    const failures: Array<{
      repository: AgentGitRepository;
      fingerprint: string;
      reason: GitAccessFailureReason;
    }> = [];
    const materializeItems: RepositoryMaterializeItem[] = [];
    for (const repository of agent.gitRepositories) {
      const parsed = parseRepositoryUrl(repository.url);
      if (!parsed || isBlockedHost(parsed.host, this.allowPrivateHosts)) {
        failures.push({
          repository,
          fingerprint: fingerprintOf(repository),
          reason: "provider_unavailable",
        });
        continue;
      }
      const credential = repository.credentialCode
        ? await this.credentialFromTemplate(user.id, repository)
        : undefined;
      // 未填值不阻断（credential 为 undefined）：公开仓库匿名可读；私有仓库由物化层
      // 报错并给补救引导，未配置的问询由通用凭证预检按 agent.credentials 承接
      materializeItems.push(credential ? { repository, credential } : { repository });
    }
    const requirements = groupRequirements(failures);
    return { ready: requirements.length === 0, requirements, materializeItems };
  }

  private async credentialFromTemplate(
    userId: string,
    repository: AgentGitRepository,
  ): Promise<GitProcessCredential | undefined> {
    if (!this.credentialSets || !repository.credentialCode) return undefined;
    const [filled] = await this.credentialSets.getFilledValues(userId, [repository.credentialCode]);
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

/** URL 解析失败时 gitRepositoryFingerprint 会抛错；指纹缺省回落原文，保预检不炸 */
function fingerprintOf(repository: AgentGitRepository): string {
  try {
    return gitRepositoryFingerprint(repository);
  } catch {
    return repository.url;
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
