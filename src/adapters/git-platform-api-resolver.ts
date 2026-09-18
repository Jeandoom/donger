// 三平台 GitPlatformApi 装配：provider(方言) + host → 客户端实例。
// 同一方言可对应多个自建 host（自建 GitLab / Gitee 私有化 / GHE），
// 缓存 key = `provider:host`；官方域名沿用平台惯用 API 根，
// GitHub 特判：github.com → api.github.com，其余（GHE）→ https://<host>/api/v3。

import type { GitProvider } from "../domain/git.js";
import type { GitPlatformApi, GitPlatformApiResolver } from "../ports/git-platform-api.js";
import type { FetchImpl } from "./git-platform-api-shared.js";
import { GiteePlatformApi } from "./gitee-platform-api.js";
import { GitHubPlatformApi } from "./github-platform-api.js";
import { GitLabPlatformApi } from "./gitlab-platform-api.js";

/** 方言 + host → 平台 API 根（spec 2026-09-10 §4.2） */
export function resolveApiBase(provider: GitProvider, host: string): string {
  if (provider === "github") {
    return host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`;
  }
  if (provider === "gitee") {
    return host === "gitee.com" ? "https://gitee.com/api/v5" : `https://${host}/api/v5`;
  }
  return host === "jihulab.com" ? "https://jihulab.com/api/v4" : `https://${host}/api/v4`;
}

export function createGitPlatformApiResolver(fetchImpl?: FetchImpl): GitPlatformApiResolver {
  const clients = new Map<string, GitPlatformApi>();
  return (provider: GitProvider, host: string): GitPlatformApi | undefined => {
    const key = `${provider}:${host}`;
    const cached = clients.get(key);
    if (cached) return cached;
    const apiBase = resolveApiBase(provider, host);
    const created =
      provider === "jihulab"
        ? new GitLabPlatformApi(apiBase, fetchImpl)
        : provider === "github"
          ? new GitHubPlatformApi(apiBase, fetchImpl)
          : provider === "gitee"
            ? new GiteePlatformApi(apiBase, fetchImpl)
            : undefined;
    if (created) clients.set(key, created);
    return created;
  };
}
