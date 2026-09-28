import type { IncomingMessage as HttpRequest } from "node:http";
import type { AppProxyServicesConfig } from "../config.js";
import { ValidationError } from "../util/errors.js";
import type { ApiResult, AppApiDeps, AppHttpCtx } from "./app-api.js";

/**
 * 应用运行时受控代理（POST /api/app-proxy/:appId/:service）。
 *
 * 动机：部署/运维类应用需调用内网服务（Jenkins/ops/jihulab），但目标服务均不带
 * CORS 头，沙箱 iframe（不透明源）无法直连；且外部凭证不允许进前端产物
 * （app-develop 安全红线）。平台侧集中注入凭证：前端零凭证，目标 host 由
 * 服务端配置固定，代理面天然防 SSRF（host 不可控、path 白名单字符校验）。
 *
 * 协议：请求 body = { path, query?, body?, method? }（method 仅 GET/POST，默认 GET）；
 * 响应统一包装 { status, contentType, body, location? }——上游状态码/文本体原样透传，
 * location 仅透传 Jenkins 触发构建返回的队列地址（前端取 pathname 轮询）。
 * 鉴权：app-token（Bearer，aud=appId），与 app-data 运行时面同款。
 */

const PROXY_TIMEOUT_MS = 30_000;
/** ops JWT 复用窗口（到期前主动重登；401 兜底再登一次） */
const OPS_TOKEN_TTL_MS = 25 * 60_000;

/** path/query 白名单字符（RFC 3986 pchar 子集）；禁止 ? # 空格与 // .. 穿越 */
const SAFE_URI_PART = /^[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/;

export const PROXY_SERVICES = ["jihulab", "jenkins", "ops"] as const;

export interface AppProxyHandlerDeps extends AppApiDeps {
  proxyConfig: AppProxyServicesConfig;
}

interface ProxyInput {
  path?: unknown;
  query?: unknown;
  body?: unknown;
  method?: unknown;
}

interface UpstreamResult {
  status: number;
  contentType: string;
  body: string;
  location?: string;
}

export function createAppProxyHandler(deps: AppProxyHandlerDeps) {
  // 进程内缓存：jenkins CRUMB（CSRF）与 ops JWT（懒登录）
  let crumb: { value: string; field: string } | null = null;
  let opsToken: { value: string; fetchedAt: number } | null = null;

  return async function handleAppProxy(
    ctx: AppHttpCtx,
    req: HttpRequest,
    appId: string,
    service: string,
  ): Promise<ApiResult> {
    // app-token 鉴权（缺失/无效/过期统一 401，防探测）
    const auth = req.headers.authorization;
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
    const claims = token ? await deps.appToken.verify(token, appId) : null;
    if (!claims) return { status: 401, json: { error: "app-token 无效或已过期" } };

    if (!(PROXY_SERVICES as readonly string[]).includes(service)) {
      throw new ValidationError("INVALID_REQUEST", `未知代理服务: ${service}`);
    }
    const cfg = deps.proxyConfig[service as keyof AppProxyServicesConfig];
    if (!cfg) {
      return { status: 503, json: { error: `代理未启用: ${service}（平台 .env 未配置对应凭证）` } };
    }

    const input = JSON.parse(await ctx.readBody(req, 64 * 1024)) as ProxyInput;
    const path = assertSafePart(input.path, "path", true);
    const query =
      input.query === undefined || input.query === ""
        ? ""
        : assertSafePart(input.query, "query", false);
    const method = input.method === undefined ? "GET" : input.method;
    if (method !== "GET" && method !== "POST") {
      throw new ValidationError("INVALID_REQUEST", "method 仅支持 GET/POST");
    }
    const body = input.body === undefined ? undefined : JSON.stringify(input.body);

    const base = cfg.baseUrl;
    const url = `${base}${path}${query ? `?${query}` : ""}`;
    const result =
      service === "jihulab"
        ? // cfg 与 service 一一对应（上方 503 已拦缺失），仅联合类型需在此按分支收窄
          await forwardJihulab(cfg as Parameters<typeof forwardJihulab>[0], method, url, body)
        : service === "jenkins"
          ? await forwardJenkins(
              cfg as Parameters<typeof forwardJenkins>[0],
              method,
              url,
              body,
              () => crumb,
              (c) => (crumb = c),
            )
          : await forwardOps(
              cfg as Parameters<typeof forwardOps>[0],
              method,
              url,
              body,
              () => opsToken,
              (t) => (opsToken = t),
            );
    return { status: 200, json: result };
  };
}

function assertSafePart(v: unknown, name: string, requireLeadSlash: boolean): string {
  if (typeof v !== "string" || !v) throw new ValidationError("INVALID_REQUEST", `${name} 缺失`);
  if (requireLeadSlash && !v.startsWith("/")) {
    throw new ValidationError("INVALID_REQUEST", `${name} 须以 / 开头`);
  }
  if (
    v.includes("..") ||
    v.includes("//") ||
    v.includes("?") ||
    v.includes("#") ||
    !SAFE_URI_PART.test(v)
  ) {
    throw new ValidationError("INVALID_REQUEST", `${name} 含非法字符`);
  }
  return v;
}

async function doFetch(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(PROXY_TIMEOUT_MS) });
}

function toResult(r: Response, text: string): UpstreamResult {
  return {
    status: r.status,
    contentType: r.headers.get("content-type") ?? "text/plain",
    body: text,
    ...(r.headers.get("location") ? { location: r.headers.get("location") as string } : {}),
  };
}

// ---- jihulab：PRIVATE-TOKEN ----
async function forwardJihulab(
  cfg: { baseUrl: string; token: string },
  method: string,
  url: string,
  body?: string,
): Promise<UpstreamResult> {
  const r = await doFetch(url, {
    method,
    headers: {
      "PRIVATE-TOKEN": cfg.token,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body } : {}),
  });
  return toResult(r, await r.text());
}

// ---- jenkins：Basic Auth + CRUMB（403 时重取重试一次）----
async function forwardJenkins(
  cfg: { baseUrl: string; username: string; apiToken: string },
  method: string,
  url: string,
  body: string | undefined,
  getCrumb: () => { value: string; field: string } | null,
  setCrumb: (c: { value: string; field: string } | null) => void,
): Promise<UpstreamResult> {
  const basic = `Basic ${Buffer.from(`${cfg.username}:${cfg.apiToken}`).toString("base64")}`;
  const send = async (c: { value: string; field: string } | null) => {
    const headers: Record<string, string> = { Authorization: basic };
    if (c) headers[c.field] = c.value;
    if (body) headers["Content-Type"] = "application/json";
    const r = await doFetch(url, { method, headers, ...(body ? { body } : {}) });
    return { r, text: await r.text() };
  };
  let { r, text } = await send(method === "POST" ? getCrumb() : null);
  if (r.status === 403 && method === "POST") {
    // CRUMB 失效/缺失：重取后重试一次
    const cr = await doFetch(`${cfg.baseUrl}/crumbIssuer/api/json`, {
      headers: { Authorization: basic },
    });
    if (cr.ok) {
      const d = (await cr.json()) as { crumb?: string; crumbRequestField?: string };
      if (d.crumb) {
        const fresh = { value: d.crumb, field: d.crumbRequestField ?? "Jenkins-Crumb" };
        setCrumb(fresh);
        ({ r, text } = await send(fresh));
      }
    }
  }
  return toResult(r, text);
}

// ---- ops：懒登录 JWT（BEARER；401 时重登重试一次）----
async function forwardOps(
  cfg: { baseUrl: string; username: string; password: string },
  method: string,
  url: string,
  body: string | undefined,
  getToken: () => { value: string; fetchedAt: number } | null,
  setToken: (t: { value: string; fetchedAt: number } | null) => void,
): Promise<UpstreamResult> {
  const login = async (): Promise<string> => {
    const r = await doFetch(`${cfg.baseUrl}/api/token/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: cfg.username, password: cfg.password }),
    });
    if (!r.ok) throw new ValidationError("UPSTREAM_AUTH_FAILED", `ops 登录失败 HTTP ${r.status}`);
    const d = (await r.json()) as { token?: string; access?: string };
    const token = d.token ?? d.access;
    if (!token) throw new ValidationError("UPSTREAM_AUTH_FAILED", "ops 登录响应无 token");
    setToken({ value: token, fetchedAt: Date.now() });
    return token;
  };
  const cached = getToken();
  const token =
    cached && Date.now() - cached.fetchedAt < OPS_TOKEN_TTL_MS ? cached.value : await login();
  const send = async (t: string) => {
    const headers: Record<string, string> = { Authorization: `BEARER ${t}` };
    if (body) headers["Content-Type"] = "application/json";
    const r = await doFetch(url, { method, headers, ...(body ? { body } : {}) });
    return { r, text: await r.text() };
  };
  let { r, text } = await send(token);
  if (r.status === 401) {
    ({ r, text } = await send(await login()));
  }
  return toResult(r, text);
}
