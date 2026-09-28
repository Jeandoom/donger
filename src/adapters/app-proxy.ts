import type { IncomingMessage as HttpRequest } from "node:http";
import {
  AUTH_STYLE_REQUIRED_KEYS,
  type Connector,
  type ConnectorAuthStyle,
  collectConnectorCredentialCodes,
} from "../domain/connector.js";
import {
  type CredentialValuesByCode,
  substituteCredentialRefs,
} from "../domain/connector-resolution.js";
import type { ConnectorStore } from "../ports/connector-store.js";
import type { CredentialSetStore } from "../ports/credential-set-store.js";
import { ValidationError } from "../util/errors.js";
import type { ApiResult, AppApiDeps, AppHttpCtx } from "./app-api.js";

/**
 * 应用运行时受控代理 v2（POST /api/app-proxy/:appId/:service；spec
 * 2026-09-29-app-proxy-credential-binding）。
 *
 * 动机：部署/运维类应用需调用内网服务（Jenkins/ops/jihulab 等），但目标服务均不带
 * CORS 头，沙箱 iframe（不透明源）无法直连；且外部凭证不允许进前端产物
 * （app-develop 安全红线）。v2 通道 = 应用侧服务名 × 连接器绑定：应用属主在
 * 「通道」页把服务名勾到 type=http 连接器上，凭证来自凭证集按应用属主解析、
 * 服务端替换——前端零凭证，目标 host 由连接器固定（防 SSRF），.env 零凭证键。
 *
 * 协议：请求 body = { path, query?, body?, method? }（method 仅 GET/POST，默认 GET）；
 * 响应统一包装 { status, contentType, body, location? }——上游状态码/文本体原样透传，
 * location 仅透传 Jenkins 触发构建返回的队列地址（前端取 pathname 轮询）。
 * 通道不可用（未绑定/连接器失效/凭证缺失）一律 503 带原因；鉴权：app-token
 * （Bearer，aud=appId），与 app-data 运行时面同款。
 */

const PROXY_TIMEOUT_MS = 30_000;
/** token-login JWT 复用窗口（到期前主动重登；401 兜底再登一次） */
const OPS_TOKEN_TTL_MS = 25 * 60_000;

/** path/query 白名单字符（RFC 3986 pchar 子集）；禁止 ? # 空格与 // .. 穿越 */
const SAFE_URI_PART = /^[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/;

export interface AppProxyHandlerDeps extends AppApiDeps {
  connectorStore: ConnectorStore;
  credentialSets: CredentialSetStore;
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
  // 进程内缓存（按连接器隔离，支持多通道并存）：jenkins CRUMB（CSRF）与 token-login JWT
  const crumbs = new Map<string, { value: string; field: string }>();
  const sessionTokens = new Map<string, { value: string; fetchedAt: number }>();

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

    // 通道解析：服务名 → 应用绑定 → 连接器（读时再校验：事后停用/删除/改私有即失效）
    const app = await deps.appStore.get(appId);
    if (!app) return channelUnavailable(service, "应用不存在或已删除");
    const connectorId = app.proxyBindings?.[service];
    if (!connectorId) {
      return channelUnavailable(service, "应用未绑定出网通道（属主在应用详情-通道页配置）");
    }
    const connector = await deps.connectorStore.getById(connectorId);
    if (
      !connector?.enabled ||
      connector.type !== "http" ||
      !(connector.ownerId === app.userId || connector.shareScope === "global")
    ) {
      return channelUnavailable(service, "绑定的连接器已删除/停用或不再对应用属主可见");
    }

    // 凭证解析：按应用属主取值；缺凭证/缺键 503 指路凭证页（值永不进响应）
    const codes = collectConnectorCredentialCodes(connector);
    const valuesByCode: CredentialValuesByCode = new Map();
    if (codes.length) {
      for (const f of await deps.credentialSets.getFilledValues(app.userId, codes)) {
        valuesByCode.set(f.code, f.values);
      }
    }
    const missingCreds = codes.filter((c) => !valuesByCode.has(c));
    if (missingCreds.length) {
      return channelUnavailable(
        service,
        `凭证未填写：${missingCreds.join(", ")}（应用属主到「凭证」页补齐）`,
      );
    }
    const style = connector.auth?.style ?? "none";
    const requiredKeys = AUTH_STYLE_REQUIRED_KEYS[style];
    if (requiredKeys.length) {
      const credCode = connector.auth?.credential ?? "";
      const values = valuesByCode.get(credCode) ?? {};
      const missingKeys = requiredKeys.filter((k) => !values[k]);
      if (missingKeys.length) {
        return channelUnavailable(
          service,
          `凭证 ${credCode} 缺键 ${missingKeys.join("/")}（到「凭证」页补齐）`,
        );
      }
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

    // 连接器 url 去尾斜杠防拼接出 //（服务端路径校验拒绝双斜杠）
    const base = connector.url.replace(/\/+$/, "");
    const url = `${base}${path}${query ? `?${query}` : ""}`;
    const headers = substituteCredentialRefs(connector.headers, valuesByCode).resolved;
    const result = await forwardByAuthStyle(
      connector,
      style,
      valuesByCode,
      method,
      url,
      body,
      headers,
      crumbs,
      sessionTokens,
    );
    return { status: 200, json: result };
  };
}

/** 通道不可用（未绑定/连接器失效/凭证缺失）统一 503，前端以 error 文案展示 */
function channelUnavailable(service: string, reason: string): ApiResult {
  return { status: 503, json: { error: `通道不可用: ${service}（${reason}）` } };
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

type CrumbCache = Map<string, { value: string; field: string }>;
type SessionTokenCache = Map<string, { value: string; fetchedAt: number }>;

/** 按连接器认证风格分发；调用方已保证风格必需的凭证键齐全 */
async function forwardByAuthStyle(
  connector: Connector,
  style: ConnectorAuthStyle,
  valuesByCode: CredentialValuesByCode,
  method: string,
  url: string,
  body: string | undefined,
  headers: Record<string, string>,
  crumbs: CrumbCache,
  sessionTokens: SessionTokenCache,
): Promise<UpstreamResult> {
  const withContentType = (h: Record<string, string>) =>
    body ? { ...h, "Content-Type": "application/json" } : h;
  if (style === "none") {
    const r = await doFetch(url, {
      method,
      headers: withContentType(headers),
      ...(body ? { body } : {}),
    });
    return toResult(r, await r.text());
  }
  const credCode = connector.auth?.credential ?? "";
  const values = valuesByCode.get(credCode) ?? {};
  if (style === "basic-crumb") {
    return forwardBasicCrumb(connector, values, method, url, body, headers, crumbs);
  }
  return forwardTokenLogin(connector, values, method, url, body, headers, sessionTokens);
}

// ---- basic-crumb：凭证 username/apiToken 组 Basic + CRUMB（POST 403 时重取重试一次）----
async function forwardBasicCrumb(
  connector: Connector,
  values: Record<string, string>,
  method: string,
  url: string,
  body: string | undefined,
  headers: Record<string, string>,
  crumbs: CrumbCache,
): Promise<UpstreamResult> {
  const basic = `Basic ${Buffer.from(`${values.username}:${values.apiToken}`).toString("base64")}`;
  const send = async (c: { value: string; field: string } | null) => {
    const h: Record<string, string> = { ...headers, Authorization: basic };
    if (c) h[c.field] = c.value;
    const r = await doFetch(url, { method, headers: h, ...(body ? { body } : {}) });
    return { r, text: await r.text() };
  };
  const cached = crumbs.get(connector.id) ?? null;
  let { r, text } = await send(method === "POST" ? cached : null);
  if (r.status === 403 && method === "POST") {
    // CRUMB 失效/缺失：重取后重试一次
    const cr = await doFetch(`${connector.url.replace(/\/+$/, "")}/crumbIssuer/api/json`, {
      headers: { Authorization: basic },
    });
    if (cr.ok) {
      const d = (await cr.json()) as { crumb?: string; crumbRequestField?: string };
      if (d.crumb) {
        const fresh = { value: d.crumb, field: d.crumbRequestField ?? "Jenkins-Crumb" };
        crumbs.set(connector.id, fresh);
        ({ r, text } = await send(fresh));
      }
    }
  }
  return toResult(r, text);
}

// ---- token-login：凭证 username/password 登录换 JWT（401 时重登重试一次）----
async function forwardTokenLogin(
  connector: Connector,
  values: Record<string, string>,
  method: string,
  url: string,
  body: string | undefined,
  headers: Record<string, string>,
  sessionTokens: SessionTokenCache,
): Promise<UpstreamResult> {
  const base = connector.url.replace(/\/+$/, "");
  const login = async (): Promise<string> => {
    const r = await doFetch(`${base}/api/token/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: values.username, password: values.password }),
    });
    if (!r.ok) throw new ValidationError("UPSTREAM_AUTH_FAILED", `上游登录失败 HTTP ${r.status}`);
    const d = (await r.json()) as { token?: string; access?: string };
    const token = d.token ?? d.access;
    if (!token) throw new ValidationError("UPSTREAM_AUTH_FAILED", "登录响应无 token");
    sessionTokens.set(connector.id, { value: token, fetchedAt: Date.now() });
    return token;
  };
  const cached = sessionTokens.get(connector.id);
  const token =
    cached && Date.now() - cached.fetchedAt < OPS_TOKEN_TTL_MS ? cached.value : await login();
  const send = async (t: string) => {
    const h: Record<string, string> = { ...headers, Authorization: `BEARER ${t}` };
    const r = await doFetch(url, { method, headers: h, ...(body ? { body } : {}) });
    return { r, text: await r.text() };
  };
  let { r, text } = await send(token);
  if (r.status === 401) {
    ({ r, text } = await send(await login()));
  }
  return toResult(r, text);
}
