// GitHub OAuth 登录（授权码流程）。仅取身份（scope=read:user），不涉及 repo 权限——
// 代码仓库访问凭证走独立的 credential-sets 体系，与本模块无关。
// 参考：https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_API = "https://api.github.com/user";

// 大陆网络访问 github.com/api.github.com 时延波动大，给显式超时防止登录回调挂死
const TIMEOUT_MS = 10_000;

/** 构建授权跳转 URL（纯函数）。state 由调用方生成并暂存，回调时强校验。 */
export function buildGithubAuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", "read:user");
  url.searchParams.set("state", params.state);
  return url.toString();
}

export interface GithubUserInfo {
  /** GitHub 用户数字 id（字符串化后作 externalId，终身不变） */
  id: string;
  login: string;
  /** 全名可能为空（用户未填写），调用方应回退到 login */
  name?: string;
  avatarUrl?: string;
}

/** 用授权码换 access_token。GitHub 对无效 code 也可能返回 200 + error 字段，须一并判定。 */
export async function getGithubAccessToken(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const bodyText = await res.text();
  let data: { access_token?: string; error?: string; error_description?: string };
  try {
    data = JSON.parse(bodyText) as typeof data;
  } catch {
    throw new Error(
      `GitHub access_token 获取失败: HTTP ${res.status}, 响应: ${bodyText.slice(0, 200)}`,
    );
  }
  if (!data.access_token) {
    throw new Error(
      `GitHub access_token 获取失败: HTTP ${res.status}, ${data.error ?? "unknown"}: ${data.error_description ?? ""}`,
    );
  }
  return data.access_token;
}

/** 通过 access_token 获取用户信息。 */
export async function getGithubUser(accessToken: string): Promise<GithubUserInfo> {
  // GitHub API 强制要求 User-Agent 头，缺失会 403
  const res = await fetch(USER_API, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "donger",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const bodyText = await res.text();
  let data: {
    id?: number;
    login?: string;
    name?: string | null;
    avatar_url?: string;
    message?: string;
  };
  try {
    data = JSON.parse(bodyText) as typeof data;
  } catch {
    throw new Error(`GitHub 用户信息获取失败: HTTP ${res.status}, 响应: ${bodyText.slice(0, 200)}`);
  }
  if (!data.id || !data.login) {
    throw new Error(
      `GitHub 用户信息获取失败: HTTP ${res.status}, ${data.message ?? "响应中无 id/login"}`,
    );
  }
  return {
    id: String(data.id),
    login: data.login,
    name: data.name ?? undefined,
    avatarUrl: data.avatar_url,
  };
}
