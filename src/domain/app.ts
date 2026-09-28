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

/** M1 仅私有；后续：grants | all-users | public-anonymous */
export const AppAccessSchema = z.enum(["private"]);
export type AppAccess = z.infer<typeof AppAccessSchema>;

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

export const AppPatchInputSchema = z.object({
  name: z.string().trim().min(1).max(APP_NAME_MAX).optional(),
  description: z.string().trim().max(APP_DESC_MAX).optional(),
  icon: z.string().trim().max(200).nullable().optional(),
  manifest: AppManifestSchema.optional(),
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
