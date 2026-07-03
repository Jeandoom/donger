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