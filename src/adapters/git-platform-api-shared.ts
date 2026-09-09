// git 平台 API adapter 共享基座：fetch 包装、错误归一、分页/编码小工具。
// 错误归一约定：401/403 → 凭证无效或权限不足（附 scope 引导）；404 → 资源不存在；
// 429/5xx/网络异常 → 平台暂不可用。token 只进认证头/参数，不进错误文案。

import type { PlatformApiResult } from "../ports/git-platform-api.js";

export const API_TIMEOUT_MS = 15_000;

export type FetchImpl = typeof fetch;

/** 归一化非 2xx 响应为 PlatformApiResult（2xx 由调用方透传原文） */
export function normalizeFailure(
  status: number,
  body: string,
  provider: string,
): PlatformApiResult {
  if (status === 401 || status === 403) {
    return {
      ok: false,
      status,
      body: `${provider} API ${status}：凭证无效或权限不足（401/403，请检查 PAT 是否具备该操作的 scope/权限）`,
    };
  }
  if (status === 404) {
    return {
      ok: false,
      status,
      body: `${provider} API 404：仓库或资源不存在（也可能是私有资源无权访问）`,
    };
  }
  if (status === 429) {
    return { ok: false, status, body: `${provider} API 429：触发限流，请稍后重试` };
  }
  return {
    ok: false,
    status,
    body: `${provider} API ${status}：${body.slice(0, 500)}`,
  };
}

/** 平台 GET：2xx 透传原文；非 2xx 归一 */
export async function apiGet(
  fetchImpl: FetchImpl,
  url: string,
  headers: Record<string, string>,
  provider: string,
): Promise<PlatformApiResult> {
  let res: Response;
  try {
    res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(API_TIMEOUT_MS) });
  } catch (e) {
    return { ok: false, status: 0, body: `${provider} API 请求失败：${(e as Error).message}` };
  }
  const body = await res.text();
  if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, body };
  return normalizeFailure(res.status, body, provider);
}

/** 平台写请求（POST/PUT，JSON body）：语义同 apiGet */
export async function apiWrite(
  fetchImpl: FetchImpl,
  url: string,
  method: "POST" | "PUT",
  headers: Record<string, string>,
  body: Record<string, unknown>,
  provider: string,
): Promise<PlatformApiResult> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, status: 0, body: `${provider} API 请求失败：${(e as Error).message}` };
  }
  const text = await res.text();
  if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, body: text };
  return normalizeFailure(res.status, text, provider);
}

export function splitRepoPath(repositoryPath: string): { owner: string; repo: string } {
  const [owner = "", repo = ""] = repositoryPath.split("/");
  return { owner, repo };
}
