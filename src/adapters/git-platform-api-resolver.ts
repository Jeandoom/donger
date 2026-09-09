// 三平台 GitPlatformApi 装配：provider → 客户端（无状态，可复用单例）。

import type { GitProvider } from "../domain/git.js";
import type { GitPlatformApi, GitPlatformApiResolver } from "../ports/git-platform-api.js";
import type { FetchImpl } from "./git-platform-api-shared.js";
import { GiteePlatformApi } from "./gitee-platform-api.js";
import { GitHubPlatformApi } from "./github-platform-api.js";
import { GitLabPlatformApi } from "./gitlab-platform-api.js";

export function createGitPlatformApiResolver(fetchImpl?: FetchImpl): GitPlatformApiResolver {
  const clients = new Map<GitProvider, GitPlatformApi>();
  return (provider: GitProvider): GitPlatformApi | undefined => {
    const cached = clients.get(provider);
    if (cached) return cached;
    const created =
      provider === "jihulab"
        ? new GitLabPlatformApi(undefined, fetchImpl)
        : provider === "github"
          ? new GitHubPlatformApi(undefined, fetchImpl)
          : provider === "gitee"
            ? new GiteePlatformApi(undefined, fetchImpl)
            : undefined;
    if (created) clients.set(provider, created);
    return created;
  };
}
