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
