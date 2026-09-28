import { existsSync, rmSync, statSync } from "node:fs";
import type { IncomingMessage as HttpRequest } from "node:http";
import { join, resolve, sep } from "node:path";
import { z } from "zod";
import {
  APP_DATA_KEY_PATTERN,
  APP_DATA_MAX_KEYS,
  APP_DATA_TOTAL_MAX_BYTES,
  APP_DATA_VALUE_MAX_BYTES,
  APP_LOG_INGEST_MAX_ENTRIES,
  APP_LOG_MESSAGE_MAX,
  type AppPatchInput,
  type PlatformApp,
  parseAppPatchInput,
} from "../domain/app.js";
import type { AppStore, AppVersionWithMeta } from "../ports/app-store.js";
import { NotFoundError, PayloadTooLargeError, ValidationError } from "../util/errors.js";
import type { AppTokenService } from "./app-token-service.js";

/**
 * 平台应用 API（spec 2026-09-25-app-platform-architecture；M1 应用内核）。
 *
 * 职责切分：本模块提供细粒度 handler（skill-api.ts 同款模式，可独立测试）；
 * URL 正则与守卫登记留在 web-channel.ts / web-route-guards.ts，路由覆盖契约测试
 * 以 web-channel.ts 源码扫描为准。
 *
 * 鉴权分两面：
 *  - 属主面（/api/apps/*）：主 JWT，守卫表 owner 规则；
 *  - 运行时面（/api/app-data/*）：app-token（Bearer），handler 内经 AppTokenService
 *    校验 aud=appId——主 JWT 在此不被接受，应用代码永远拿不到属主会话凭证。
 */

export interface AppApiDeps {
  appStore: AppStore;
  /** bundle 产物根目录（= <dataDir>/apps） */
  appsDir: string;
  appToken: AppTokenService;
}

/** web-channel 注入的 HTTP 原语（保持本模块零 web-channel 依赖） */
export interface AppHttpCtx {
  userIdOf(req: HttpRequest): string | undefined;
  roleOf(req: HttpRequest): "admin" | "user";
  readBody(req: HttpRequest, maxBytes?: number): Promise<string>;
}

export interface ApiResult {
  status: number;
  json: unknown;
}

export function appVersionDir(appsDir: string, appId: string, num: number): string {
  return join(appsDir, appId, "versions", String(num));
}

// ---------------------------------------------------------------------------
// 应用 CRUD（属主面）
// ---------------------------------------------------------------------------

export async function handleListApps(
  ctx: AppHttpCtx,
  deps: AppApiDeps,
  req: HttpRequest,
): Promise<ApiResult> {
  const userId = requireUser(ctx, req);
  const apps = await deps.appStore.listByUser(userId);
  return { status: 200, json: { apps: apps.map(appView) } };
}

export async function handleGetApp(
  ctx: AppHttpCtx,
  deps: AppApiDeps,
  req: HttpRequest,
  appId: string,
): Promise<ApiResult> {
  requireUser(ctx, req);
  const app = await requireOwnedApp(deps, ctx, req, appId);
  return { status: 200, json: { app: appView(app) } };
}

export async function handlePatchApp(
  ctx: AppHttpCtx,
  deps: AppApiDeps,
  req: HttpRequest,
  appId: string,
): Promise<ApiResult> {
  requireUser(ctx, req);
  await requireOwnedApp(deps, ctx, req, appId);
  const patch = parseAppPatchInput(JSON.parse(await ctx.readBody(req))) as AppPatchInput;
  const updated = await deps.appStore.update(appId, {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.icon !== undefined ? { icon: patch.icon ?? undefined } : {}),
    ...(patch.manifest !== undefined ? { manifest: patch.manifest } : {}),
  });
  if (!updated) throw new NotFoundError("NOT_FOUND", "app not found");
  return { status: 200, json: { app: appView(updated) } };
}

export async function handleDeleteApp(
  ctx: AppHttpCtx,
  deps: AppApiDeps,
  req: HttpRequest,
  appId: string,
): Promise<ApiResult> {
  requireUser(ctx, req);
  await requireOwnedApp(deps, ctx, req, appId);
  await deps.appStore.delete(appId);
  // 产物目录随库删除（bundle 是应用状态的延伸，不删=孤儿文件泄漏磁盘）
  rmSync(join(deps.appsDir, appId), { recursive: true, force: true });
  return { status: 200, json: { ok: true } };
}

// ---------------------------------------------------------------------------
// 版本（属主面）
// ---------------------------------------------------------------------------

export async function handleListVersions(
  ctx: AppHttpCtx,
  deps: AppApiDeps,
  req: HttpRequest,
  appId: string,
): Promise<ApiResult> {
  requireUser(ctx, req);
  await requireOwnedApp(deps, ctx, req, appId);
  const versions = await deps.appStore.listVersions(appId);
  return { status: 200, json: { versions: versions.map(versionView) } };
}

/** multipart 上传通道已移除（应用发布唯一入口=会话智能体 app_deploy；spec 修订 2026-09-26） */
export async function handlePublishVersion(
  ctx: AppHttpCtx,
  deps: AppApiDeps,
  req: HttpRequest,
  appId: string,
  num: number,
): Promise<ApiResult> {
  requireUser(ctx, req);
  await requireOwnedApp(deps, ctx, req, appId);
  const app = await deps.appStore.publishVersion(appId, num);
  if (!app) throw new NotFoundError("NOT_FOUND", "version not found");
  return { status: 200, json: { app: appView(app) } };
}

/** 数据浏览器（属主面，主 JWT）：列出应用数据 KV */
export async function handleListAppData(
  ctx: AppHttpCtx,
  deps: AppApiDeps,
  req: HttpRequest,
  appId: string,
): Promise<ApiResult> {
  requireUser(ctx, req);
  await requireOwnedApp(deps, ctx, req, appId);
  const items = await deps.appStore.listData(appId);
  return {
    status: 200,
    json: {
      items: items.map((e) => ({
        key: e.key,
        sizeBytes: e.sizeBytes,
        updatedAt: e.updatedAt,
        valueJson: e.valueJson.length <= 4096 ? e.valueJson : undefined,
      })),
      totalBytes: await deps.appStore.dataTotalBytes(appId),
    },
  };
}

export async function handleDeleteAppDataByOwner(
  ctx: AppHttpCtx,
  deps: AppApiDeps,
  req: HttpRequest,
  appId: string,
  key: string,
): Promise<ApiResult> {
  requireUser(ctx, req);
  await requireOwnedApp(deps, ctx, req, appId);
  assertDataKey(key);
  const removed = await deps.appStore.deleteData(appId, key);
  if (!removed) throw new NotFoundError("NOT_FOUND", "key not found");
  return { status: 200, json: { ok: true } };
}

// ---------------------------------------------------------------------------
// 运行时面：app-token（签发在属主面，消费在运行时面）
// ---------------------------------------------------------------------------

export async function handleIssueAppToken(
  ctx: AppHttpCtx,
  deps: AppApiDeps,
  req: HttpRequest,
  appId: string,
): Promise<ApiResult> {
  const userId = requireUser(ctx, req);
  await requireOwnedApp(deps, ctx, req, appId);
  const { token, expiresIn } = await deps.appToken.issue({ userId, appId, scope: "owner" });
  return { status: 200, json: { token, expiresIn, appPath: `/apps/${appId}/` } };
}

/**
 * 运行时面数据读写：仅接受 app-token（aud=appId）。属主 scope 可写；
 * 未来 grants/anonymous scope 只读。校验失败一律 401（不区分原因，防探测）。
 */
export function makeAppDataHandlers(deps: AppApiDeps) {
  return {
    async get(req: HttpRequest, appId: string, key: string): Promise<ApiResult> {
      assertDataKey(key);
      const claims = await requireAppToken(deps, req, appId);
      if (!claims) return unauthorized();
      const entry = await deps.appStore.getData(appId, key);
      if (!entry) throw new NotFoundError("NOT_FOUND", "key not found");
      return {
        status: 200,
        json: { key: entry.key, valueJson: entry.valueJson, updatedAt: entry.updatedAt },
      };
    },
    async put(req: HttpRequest, appId: string, key: string): Promise<ApiResult> {
      assertDataKey(key);
      const claims = await requireAppToken(deps, req, appId);
      if (!claims) return unauthorized();
      if (claims.scope !== "owner") {
        return { status: 403, json: { error: "当前令牌为只读 scope" } };
      }
      let value: unknown;
      try {
        const body = JSON.parse(await readBodyCapped(req)) as { value?: unknown };
        value = body.value;
      } catch (e) {
        if (e instanceof PayloadTooLargeError) throw e;
        throw new ValidationError("INVALID_REQUEST", "body 须为 { value: ... } JSON");
      }
      const valueJson = JSON.stringify(value ?? null);
      const sizeBytes = Buffer.byteLength(valueJson);
      if (sizeBytes > APP_DATA_VALUE_MAX_BYTES) {
        throw new PayloadTooLargeError(
          "VALUE_TOO_LARGE",
          `单条数据超过 ${APP_DATA_VALUE_MAX_BYTES} 字节上限`,
        );
      }
      const existed = await deps.appStore.getData(appId, key);
      if (!existed) {
        const total = await deps.appStore.dataTotalBytes(appId);
        const count = (await deps.appStore.listData(appId)).length;
        if (total + sizeBytes > APP_DATA_TOTAL_MAX_BYTES) {
          throw new PayloadTooLargeError("QUOTA_EXCEEDED", "应用数据总量超出配额");
        }
        if (count >= APP_DATA_MAX_KEYS) {
          throw new PayloadTooLargeError("QUOTA_EXCEEDED", "应用数据条数超出配额");
        }
      }
      await deps.appStore.putData({
        appId,
        key,
        valueJson,
        sizeBytes,
        updatedAt: new Date().toISOString(),
      });
      return { status: 200, json: { ok: true } };
    },
    async del(req: HttpRequest, appId: string, key: string): Promise<ApiResult> {
      assertDataKey(key);
      const claims = await requireAppToken(deps, req, appId);
      if (!claims) return unauthorized();
      if (claims.scope !== "owner") {
        return { status: 403, json: { error: "当前令牌为只读 scope" } };
      }
      const removed = await deps.appStore.deleteData(appId, key);
      if (!removed) throw new NotFoundError("NOT_FOUND", "key not found");
      return { status: 200, json: { ok: true } };
    },
  };
}

async function requireAppToken(
  deps: AppApiDeps,
  req: HttpRequest,
  appId: string,
): Promise<{ userId: string; appId: string; scope: "owner" } | null> {
  const auth = req.headers.authorization;
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
  if (!token) return null;
  return deps.appToken.verify(token, appId);
}

/** 运行时面 401（缺失/无效/过期 token 统一口径，不区分原因防探测） */
function unauthorized(): ApiResult {
  return { status: 401, json: { error: "app-token 无效或已过期" } };
}

// ---------------------------------------------------------------------------
// 静态挂载（App Gateway RT-A；纯函数供单测）
// ---------------------------------------------------------------------------

export type AppStaticTarget =
  | { kind: "file"; absPath: string; html: boolean }
  | { kind: "spa"; absPath: string }
  | null;

/**
 * 解析 /apps/:appId/* 的静态目标。与主站 resolveStaticFile 语义差异：
 *  - 防穿越同款（resolve 后必须仍在 versionDir 内 + isFile 判定）；
 *  - SPA fallback 仅在 manifest.ui.spa 且路径末段无扩展名时触发
 *    （hash 资产缺失保持 404，暴露构建脱节而非白屏假象）；
 *  - 版本目录不存在（未发布/被删）返回 null。
 */
export function resolveAppStaticTarget(
  versionDir: string,
  spa: boolean,
  urlPath: string,
): AppStaticTarget {
  if (!existsSync(versionDir)) return null;
  const rel = urlPath === "/" || urlPath === "" ? "/index.html" : urlPath;
  const file = resolveRealFileUnder(versionDir, rel);
  if (file) return { kind: "file", absPath: file, html: file.endsWith(".html") };
  const lastSeg = rel.split("/").pop() ?? "";
  if (spa && !lastSeg.includes(".")) {
    const indexPath = join(versionDir, "index.html");
    if (isFile(indexPath)) return { kind: "spa", absPath: indexPath };
  }
  return null;
}

/** 应用静态资源的 Content-Type（比主站表更全：应用 bundle 含 woff/avif 等） */
export function appContentType(absPath: string): string {
  const ext = absPath.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    html: "text/html; charset=utf-8",
    js: "application/javascript; charset=utf-8",
    mjs: "application/javascript; charset=utf-8",
    css: "text/css; charset=utf-8",
    json: "application/json; charset=utf-8",
    map: "application/json; charset=utf-8",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    ico: "image/x-icon",
    woff: "font/woff",
    woff2: "font/woff2",
    ttf: "font/ttf",
    otf: "font/otf",
    txt: "text/plain; charset=utf-8",
    md: "text/plain; charset=utf-8",
    wasm: "application/wasm",
    webmanifest: "application/manifest+json",
    mp4: "video/mp4",
    mp3: "audio/mpeg",
    csv: "text/csv; charset=utf-8",
  };
  return map[ext] ?? "application/octet-stream";
}

// ---------------------------------------------------------------------------
// 内部
// ---------------------------------------------------------------------------

function resolveRealFileUnder(root: string, urlPath: string): string | null {
  const candidate = resolve(join(root, decodeSafe(urlPath)));
  try {
    return candidate.startsWith(resolve(root) + sep) && statSync(candidate).isFile()
      ? candidate
      : null;
  } catch {
    return null;
  }
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function isFile(abs: string): boolean {
  try {
    return statSync(abs).isFile();
  } catch {
    return false;
  }
}

function requireUser(ctx: AppHttpCtx, req: HttpRequest): string {
  const uid = ctx.userIdOf(req);
  if (!uid) throw new ValidationError("INVALID_REQUEST", "unauthorized");
  return uid;
}

async function requireOwnedApp(
  deps: AppApiDeps,
  ctx: AppHttpCtx,
  req: HttpRequest,
  appId: string,
): Promise<PlatformApp> {
  const app = await deps.appStore.get(appId);
  if (!app) throw new NotFoundError("NOT_FOUND", "app not found");
  const uid = ctx.userIdOf(req);
  if (!uid || (app.userId !== uid && ctx.roleOf(req) !== "admin")) {
    throw new NotFoundError("NOT_FOUND", "app not found");
  }
  return app;
}

function assertDataKey(key: string): void {
  if (!APP_DATA_KEY_PATTERN.test(key)) {
    throw new ValidationError("INVALID_REQUEST", "key 仅允许字母数字与 . _ -，长度 1-128");
  }
}

async function readBodyCapped(req: HttpRequest): Promise<string> {
  return new Promise((resolveP, rejectP) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk;
      // value 上限之外再放宽 8KB 头部预算（{"value":...} 包裹层）
      if (Buffer.byteLength(body) > APP_DATA_VALUE_MAX_BYTES + 8192) {
        req.destroy();
        rejectP(new PayloadTooLargeError("PAYLOAD_TOO_LARGE", "请求体过大"));
      }
    });
    req.on("end", () => resolveP(body));
  });
}

/** busboy multipart 上传通道已随 zip 上传移除（应用发布唯一入口=会话智能体） */

function appView(app: PlatformApp): Record<string, unknown> {
  return {
    id: app.id,
    name: app.name,
    description: app.description,
    icon: app.icon ?? null,
    manifest: app.manifest,
    currentVersion: app.currentVersion,
    createdAt: app.createdAt,
    updatedAt: app.updatedAt,
    runPath: app.currentVersion ? `/apps/${app.id}/` : null,
  };
}

function versionView(v: AppVersionWithMeta): Record<string, unknown> {
  return {
    num: v.num,
    bundleBytes: v.bundleBytes,
    bundleSha256: v.bundleSha256,
    fileCount: v.fileCount,
    totalBytes: v.totalBytes,
    createdAt: v.createdAt,
    isCurrent: v.isCurrent,
  };
}

// ---------------------------------------------------------------------------
// 供 web-channel 复用的运行时面入口（app-data GET/PUT/DELETE）
// ---------------------------------------------------------------------------

export interface AppRuntimeHandlers {
  get(req: HttpRequest, appId: string, key: string): Promise<ApiResult>;
  put(req: HttpRequest, appId: string, key: string): Promise<ApiResult>;
  del(req: HttpRequest, appId: string, key: string): Promise<ApiResult>;
}

export function createAppRuntimeHandlers(deps: AppApiDeps): AppRuntimeHandlers {
  return makeAppDataHandlers(deps);
}

// ---------------------------------------------------------------------------
// 应用日志（spec 修订 2026-09-29）：属主查询面 + app-token 采集面
// ---------------------------------------------------------------------------

export async function handleListAppLogs(
  ctx: AppHttpCtx,
  deps: AppApiDeps,
  req: HttpRequest,
  appId: string,
): Promise<ApiResult> {
  requireUser(ctx, req);
  await requireOwnedApp(deps, ctx, req, appId);
  const url = new URL(req.url ?? "/", "http://localhost");
  const limitRaw = Number(url.searchParams.get("limit") ?? 200);
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 200;
  const items = await deps.appStore.listLogs(appId, limit);
  return { status: 200, json: { items } };
}

/**
 * 前端日志采集：仅 app-token（Bearer 或 ?token=——sendBeacon 无法带 header）。
 * 只收 level/message；method/path/status 为网关面专属字段，不接受客户端伪造。
 * body 允许 text/plain（sendBeacon Blob 不触发 CORS 预检）。
 */
export function createAppLogIngestHandler(deps: AppApiDeps) {
  return async function ingest(req: HttpRequest, appId: string): Promise<ApiResult> {
    const auth = req.headers.authorization;
    let token = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
    if (!token) {
      token = new URL(req.url ?? "/", "http://localhost").searchParams.get("token") ?? undefined;
    }
    if (!token || !(await deps.appToken.verify(token, appId))) {
      return { status: 401, json: { error: "app-token 无效或已过期" } };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await ctxReadRaw(req));
    } catch {
      return { status: 400, json: { error: "body 须为 JSON" } };
    }
    const schema = z.object({
      entries: z
        .array(
          z.object({
            level: z.enum(["info", "warn", "error"]).default("info"),
            message: z.string().min(1).max(APP_LOG_MESSAGE_MAX),
          }),
        )
        .min(1)
        .max(APP_LOG_INGEST_MAX_ENTRIES),
    });
    const parsedBody = schema.safeParse(parsed);
    if (!parsedBody.success) {
      return {
        status: 400,
        json: {
          error: `entries 非法（1-${APP_LOG_INGEST_MAX_ENTRIES} 条，message ≤${APP_LOG_MESSAGE_MAX} 字符）`,
        },
      };
    }
    const now = new Date().toISOString();
    await deps.appStore.appendLogs(
      appId,
      parsedBody.data.entries.map((e) => ({
        source: "frontend",
        level: e.level,
        message: e.message,
        ts: now,
      })),
    );
    return { status: 200, json: { ok: true } };
  };
}

/** sendBeacon/采集用的原始 body 读取（上限 256KB，防滥用） */
function ctxReadRaw(req: HttpRequest): Promise<string> {
  return new Promise((resolveP, rejectP) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk;
      if (Buffer.byteLength(body) > 256 * 1024) {
        req.destroy();
        rejectP(new PayloadTooLargeError("PAYLOAD_TOO_LARGE", "请求体过大"));
      }
    });
    req.on("end", () => resolveP(body));
  });
}

// ---------------------------------------------------------------------------
// 应用 HTML 注入（前端日志采集 bootstrap；纯函数供单测）
// ---------------------------------------------------------------------------

/**
 * 向应用 index.html 注入错误/资源加载采集脚本：
 *  - window.error（捕获段，含资源 404）/ unhandledrejection / console.error
 *  - 缓冲 2s 或 50 条后经 sendBeacon（?token= 鉴权形态）上报 /api/app-logs/<appId>
 * 幂等（__dongerAppLogs 哨兵）；无 </head> 时前插。
 */
export function injectAppBootstrap(html: string, appId: string): string {
  const script =
    `<script>(function(){if(window.__dongerAppLogs)return;window.__dongerAppLogs=1;var A="${appId}";` +
    `var T=new URLSearchParams(location.search).get("appToken")||"";var B=[];var t=null;` +
    `function flush(){if(t){clearTimeout(t);t=null;}if(!B.length||!T)return;var e=B;B=[];` +
    `try{var b=new Blob([JSON.stringify({entries:e})],{type:"text/plain"});` +
    `if(navigator.sendBeacon)navigator.sendBeacon("/api/app-logs/"+A+"?token="+encodeURIComponent(T),b);` +
    `else fetch("/api/app-logs/"+A+"?token="+encodeURIComponent(T),{method:"POST",body:JSON.stringify({entries:e})});}catch(_){}}` +
    `function log(l,m){if(B.length>=${APP_LOG_INGEST_MAX_ENTRIES})flush();B.push({level:l,message:String(m).slice(0,${APP_LOG_MESSAGE_MAX})});if(!t)t=setTimeout(flush,2000);}` +
    `window.addEventListener("error",function(ev){if(ev.target&&(ev.target.src||ev.target.href))log("error","resource error: "+(ev.target.src||ev.target.href));else log("error",(ev.message||"error")+" @"+(ev.filename||"")+":"+(ev.lineno||0));},true);` +
    `window.addEventListener("unhandledrejection",function(ev){var r=ev.reason;log("error","unhandledrejection: "+String((r&&r.stack)||r));});` +
    `var ef=console.error;console.error=function(){try{log("error",Array.prototype.map.call(arguments,function(a){return typeof a==="string"?a:(a instanceof Error?a.stack:JSON.stringify(a))}).join(" "))}catch(_){}ef.apply(console,arguments);};` +
    `window.addEventListener("pagehide",flush);})();</script>`;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${script}</head>`);
  return `${script}${html}`;
}
