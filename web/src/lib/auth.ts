const TOKEN_KEY = "donger_jwt";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // 忽略
  }
}

export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // 忽略
  }
}

export function getUserId(): string | null {
  const token = getToken();
  if (!token) return null;
  try {
    const payload = JSON.parse(atob(token.split(".")[1] ?? ""));
    return payload.sub ?? null;
  } catch {
    return null;
  }
}

/** 带 JWT 的 fetch 封装 */
export async function apiFetch(url: string, opts?: RequestInit): Promise<Response> {
  const token = getToken();
  return fetch(url, {
    ...opts,
    headers: {
      ...opts?.headers,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}

/**
 * 带 JWT 的 fetch 重试封装（仅用于幂等 GET 加载）：页面初始并发加载偶发失败时
 * 自动重试，避免整块数据静默变空（如编辑页凭证列表、侧边栏用户信息）。
 */
export async function apiFetchRetry(
  url: string,
  opts?: RequestInit,
  retries = 2,
): Promise<Response> {
  let lastRes: Response | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    }
    try {
      const res = await apiFetch(url, opts);
      if (res.ok) return res;
      lastRes = res;
    } catch {
      // 网络异常继续重试
    }
  }
  throw lastRes ? new Error(`HTTP ${lastRes.status}`) : new Error("network error");
}

export interface CurrentUser {
  id: string;
  name: string;
  avatar?: string;
  role: string;
}

let meCache: CurrentUser | null | undefined;

/**
 * 当前登录用户（模块级缓存）：页面多处展示头像/昵称共用一次请求。
 * 未登录或请求失败返回 null；可传 true 强制刷新。
 */
export async function fetchMe(force = false): Promise<CurrentUser | null> {
  if (meCache !== undefined && !force) return meCache;
  if (!getToken()) {
    meCache = null;
    return null;
  }
  try {
    const r = await apiFetchRetry("/api/auth/me");
    const data = r.ok ? ((await r.json()) as { user?: CurrentUser }) : null;
    meCache = data?.user ?? null;
  } catch {
    return null; // 失败不缓存，下次可重试
  }
  return meCache;
}

/** 检查是否已登录 */
export function isAuthenticated(): boolean {
  return !!getToken();
}

/**
 * 登录后的回跳目标（跨窗口共享，经 localStorage）。
 * 用于分享链接等场景：进入登录页时记下 next，登录完成后回到该地址。
 */
const LOGIN_NEXT_KEY = "donger_login_next";

export function setLoginNext(next: string): void {
  try {
    localStorage.setItem(LOGIN_NEXT_KEY, next);
  } catch {
    // 忽略
  }
}

export function takeLoginNext(): string | null {
  try {
    const v = localStorage.getItem(LOGIN_NEXT_KEY);
    localStorage.removeItem(LOGIN_NEXT_KEY);
    return v;
  } catch {
    return null;
  }
}
