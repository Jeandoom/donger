import { z } from "zod";

/**
 * 平台应用模型（spec docs/superpowers/specs/2026-09-25-app-platform-architecture.md §4）。
 *
 * 应用 = AppManifest（能力声明）+ Artifacts（产物）。平台不理解具体应用，只理解清单。
 * M1（应用内核）仅开放 runtime=static + access=private；split/function/task/service
 * 随容器底座与分发面逐期解锁——schema 显式拒绝未知值，扩期时只放宽不改语义。
 */

export const APP_MANIFEST_VERSION = 1 as const;

/** M1 仅静态应用；后续：split | function | task | service */
export const AppRuntimeSchema = z.enum(["static"]);
export type AppRuntime = z.infer<typeof AppRuntimeSchema>;

/**
 * 访问四档（分发面 spec §7.2）：private 仅属主；grants 名单制（shareGrants userIds）；
 * all-users 全体登录用户；public-anonymous 凭链接匿名访问（匿名只读）。
 * 放宽只加枚举值不改语义；存量 private 清单读入不受影响。
 */
export const AppAccessSchema = z.enum(["private", "grants", "all-users", "public-anonymous"]);
export type AppAccess = z.infer<typeof AppAccessSchema>;

/** grants 名单上限（防滥用；超团队规模的白名单没有意义） */
export const APP_SHARE_GRANTS_MAX = 100;

export const AppManifestSchema = z.object({
  manifestVersion: z.literal(APP_MANIFEST_VERSION),
  runtime: AppRuntimeSchema,
  /** 静态 SPA 应用：未命中文件且路径无扩展名时 fallback 到 index.html */
  ui: z
    .object({
      spa: z.boolean().default(true),
    })
    .default({ spa: true }),
  access: AppAccessSchema.default("private"),
});
export type AppManifest = z.infer<typeof AppManifestSchema>;

export interface PlatformApp {
  id: string;
  userId: string;
  name: string;
  description: string;
  icon?: string;
  manifest: AppManifest;
  /** 当前发布版本号；null=尚未上传产物（不可运行） */
  currentVersion: number | null;
  /**
   * 责任管家智能体（应用管家制 spec §3.1；弱引用单管家）。
   * 缺省/NULL=内置应用管家兜底；指向已删除或越权 agent 时读时降级为兜底。
   */
  managerAgentId?: string;
  /**
   * 出网通道绑定（spec 2026-09-29-app-proxy-credential-binding §2.2）：
   * 服务名（bundle 里的通道别名）→ type=http 连接器 id。不进 manifest——
   * 通道是运行时配置，变更不触发重新发布。未绑定服务的代理请求 503。
   */
  proxyBindings?: Record<string, string>;
  /**
   * grants 名单（分发面 spec §7.2）：access=grants 时名单内用户可签发 viewer 令牌。
   * 与通道同款运行时配置语义（不进 manifest）；access 切回 private 后名单保留，
   * 再次开放无需重录。仅属主可改。
   */
  shareGrants?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface AppVersionMeta {
  appId: string;
  num: number;
  /** 上传包原始字节数 */
  bundleBytes: number;
  bundleSha256: string;
  /** 解压后文件数（zip 炸弹防护的观测面） */
  fileCount: number;
  /** 解压后总字节数 */
  totalBytes: number;
  createdAt: string;
  createdBy: string;
}

/** 应用数据 KV 单条上限（JSON 序列化后字节数） */
export const APP_DATA_VALUE_MAX_BYTES = 256 * 1024;
/** 单应用数据总量上限（防 NAS 磁盘被单应用吃穿） */
export const APP_DATA_TOTAL_MAX_BYTES = 20 * 1024 * 1024;
/** 单应用数据条数上限 */
export const APP_DATA_MAX_KEYS = 2000;
/** 应用数据 key 约束：与守卫表 URL 段字符集一致（[\w.-]），否则路径参数无法表达 */
export const APP_DATA_KEY_PATTERN = /^[\w.-]{1,128}$/;

/** 产物体积上限：解压总 100MB / 条目 2000（应用备份与发布共用） */
export const APP_BUNDLE_TOTAL_UNCOMPRESSED_MAX = 100 * 1024 * 1024;
export const APP_BUNDLE_MAX_ENTRIES = 2000;

/** 应用名/描述长度约束 */
export const APP_NAME_MAX = 60;
export const APP_DESC_MAX = 300;

/** 出网通道服务名约束：URL 段安全（小写字母开头，小写字母数字连字符） */
export const APP_PROXY_SERVICE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
/** 单应用通道绑定上限（防滥用） */
export const APP_PROXY_MAX_BINDINGS = 8;

/**
 * 通道绑定入参校验（spec §2.2）：服务名合法 + 去重 + 数量上限；连接器 id 形态由
 * 调用方（app-api）连库校验存在性/可见性/启用——域层只做纯结构校验。
 */
export const ProxyBindingsSchema = z
  .record(z.string(), z.string())
  .refine(
    (b) => Object.keys(b).length <= APP_PROXY_MAX_BINDINGS,
    `通道绑定最多 ${APP_PROXY_MAX_BINDINGS} 条`,
  )
  .refine(
    (b) => Object.keys(b).every((s) => APP_PROXY_SERVICE_PATTERN.test(s)),
    "服务名须为小写字母开头的小写字母/数字/连字符（≤32 字符）",
  );
export type ProxyBindings = Record<string, string>;

export function parseProxyBindings(raw: unknown): ProxyBindings {
  return ProxyBindingsSchema.parse(raw);
}

export const AppPatchInputSchema = z.object({
  name: z.string().trim().min(1).max(APP_NAME_MAX).optional(),
  description: z.string().trim().max(APP_DESC_MAX).optional(),
  icon: z.string().trim().max(200).nullable().optional(),
  manifest: AppManifestSchema.optional(),
  /** 管家改派：null=交还内置应用管家兜底；字符串=agent id（owner 闭包由调用方校验） */
  managerAgentId: z.string().min(1).nullable().optional(),
  /** 出网通道绑定：整体替换语义（传 {} 清空）；连接器合法性由调用方连库校验 */
  proxyBindings: ProxyBindingsSchema.optional(),
  /** grants 名单：整体替换语义（传 [] 清空）；userId 存在性由调用方连库校验 */
  shareGrants: z.array(z.string().min(1)).max(APP_SHARE_GRANTS_MAX).optional(),
});
export type AppPatchInput = z.infer<typeof AppPatchInputSchema>;

export function parseAppPatchInput(raw: unknown): AppPatchInput {
  return AppPatchInputSchema.parse(raw);
}

/** 供列表/详情 DTO 使用的manifest 校验入口（存储读出后的防线） */
export function parseAppManifest(raw: unknown): AppManifest {
  return AppManifestSchema.parse(raw);
}

/** 应用日志（spec 修订 2026-09-29）：网关面 + 应用前端面统一入 app_logs，运行页签可实时查看 */
export const APP_LOG_MAX_PER_APP = 500;
export const APP_LOG_RETENTION_DAYS = 7;
export const APP_LOG_INGEST_MAX_ENTRIES = 50;
export const APP_LOG_MESSAGE_MAX = 2000;
export type AppLogLevel = "info" | "warn" | "error";
export type AppLogSource = "gateway" | "frontend";
