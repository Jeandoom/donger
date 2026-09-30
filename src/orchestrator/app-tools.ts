// 平台应用 MCP（donger-apps）：面向 agent 的应用开发-发布工具（M2 开发链路）。
// 会话内智能体用 app_deploy 把工作区里的静态站点产物一键发布为平台应用；
// 所有权按会话用户闭包绑定（与 kb/audit 工具同款模式），工具内复核 app.userId。
// 产物目录直拷进版本目录（不经 zip 中转），逐文件校验条目数/总量上限并计算内容哈希。

import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import { ZodError, z } from "zod";
import { appVersionDir } from "../adapters/app-api.js";
import {
  buildAppPublishedPayload,
  buildAppRolledBackPayload,
} from "../domain/event-payloads.js";
import {
  APP_BUNDLE_MAX_ENTRIES,
  APP_BUNDLE_TOTAL_UNCOMPRESSED_MAX,
  APP_DATA_KEY_PATTERN,
  APP_DATA_MAX_KEYS,
  APP_DATA_TOTAL_MAX_BYTES,
  APP_DATA_VALUE_MAX_BYTES,
  APP_NAME_MAX,
  AppManifestSchema,
} from "../domain/app.js";
import type { AppStore, AppVersionWithMeta } from "../ports/app-store.js";
import { extractZipToDir, zipDirToBuffer } from "../util/zip.js";

export type AppToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
const ok = (text: string): AppToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): AppToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

export interface AppToolsDeps {
  appStore: AppStore;
  /** 产物根目录（<dataDir>/apps）：版本目录与 incoming 暂存在其下 */
  appsDir: string;
  /** 会话运行时目录：app_deploy 的 dir 相对此解析（防工作区外逃逸）；备份导出落 runtimeDir/app-backups/ */
  runtimeDir: string;
  /** 会话用户：应用所有权的唯一判定依据（工具构造时闭包绑定） */
  userId: string;
  /**
   * app_import 允许读取的根清单（运行时目录 ∪ 本会话附件目录）——备份还原的唯一入口
   * 是用户在会话里上传附件后交由智能体还原，不存在独立的外部导入通道。
   */
  importRoots: string[];
  /**
   * 当前会话智能体（应用管家制 spec §5）：app_create/app_deploy(新建)/app_import
   * 成功即自动落责任绑定 managerAgentId=该 agent；undefined（plain 会话）=内置应用管家兜底。
   */
  agentId?: string;
  /** 进程内事件发射（app.published/app.rolled_back；fire-and-forget，调用方保证 fail-open） */
  emitEvent?: (eventName: string, payload: string) => void;
  /** 通知服务（发布/回滚告知应用 owner；fire-and-forget） */
  notifications?: {
    notify(intent: {
      event: "app.published" | "app.rolled_back";
      recipients: Array<{ kind: "user"; userId: string }>;
      title: string;
      body: string;
      link?: string;
      dedupeKey?: string;
    }): Promise<void>;
  };
}

/** 路径安全：resolve+realpath 双判（与 kb-tools safeResolveKbPath 同语义） */
function safeResolveDir(root: string, input: string): string | undefined {
  try {
    const base = resolve(root);
    const resolved = resolve(base, input);
    const rel = relative(base, resolved);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined;
    const real = realpathSync(resolved);
    const realRel = relative(realpathSync(base), real);
    if (realRel === "" || realRel.startsWith("..") || isAbsolute(realRel)) return undefined;
    return resolved;
  } catch {
    return undefined;
  }
}

interface BundleStats {
  fileCount: number;
  totalBytes: number;
  sha256: string;
}

/** 遍历产物目录：条目数/总量校验 + 内容哈希（文件相对路径与内容顺序拼接） */
function scanBundle(dir: string): BundleStats {
  const hash = createHash("sha256");
  let fileCount = 0;
  let totalBytes = 0;
  const walk = (cur: string, rel: string): void => {
    for (const entry of readdirSync(cur)) {
      const abs = join(cur, entry);
      const st = statSync(abs);
      if (st.isSymbolicLink()) continue;
      const relPath = rel ? `${rel}/${entry}` : entry;
      if (st.isDirectory()) {
        walk(abs, relPath);
      } else if (st.isFile()) {
        fileCount += 1;
        if (fileCount > APP_BUNDLE_MAX_ENTRIES) {
          throw new Error(`产物文件数超过上限 ${APP_BUNDLE_MAX_ENTRIES}`);
        }
        const content = readFileSync(abs);
        totalBytes += content.length;
        if (totalBytes > APP_BUNDLE_TOTAL_UNCOMPRESSED_MAX) {
          throw new Error("产物总量超过上限");
        }
        hash.update(relPath);
        hash.update(content);
      }
    }
  };
  walk(dir, "");
  return { fileCount, totalBytes, sha256: hash.digest("hex") };
}

function versionLine(v: AppVersionWithMeta): string {
  return `v${v.num}${v.isCurrent ? "（当前）" : ""} — 文件 ${v.fileCount}，${v.totalBytes} 字节，${v.createdAt}`;
}

export function appToolDefinitions(deps: AppToolsDeps): SdkMcpToolDefinition[] {
  const { appStore, appsDir, runtimeDir, userId, importRoots } = deps;

  const requireOwned = async (appId: string) => {
    const app = await appStore.get(appId);
    if (!app || app.userId !== userId) return undefined;
    return app;
  };

  /** 打包-记账-落位：产物目录 → incoming 暂存 → 分配版本号 → 重命名 → 发布（返回版本号） */
  const deployBundle = async (srcDir: string, appId: string): Promise<number> => {
    const stats = scanBundle(srcDir);
    const incoming = join(
      appsDir,
      appId,
      "incoming",
      `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    mkdirSync(incoming, { recursive: true });
    try {
      cpSync(srcDir, incoming, { recursive: true, verbatimSymlinks: false });
      const version = await appStore.addVersion(appId, {
        bundleBytes: stats.totalBytes,
        bundleSha256: stats.sha256,
        fileCount: stats.fileCount,
        totalBytes: stats.totalBytes,
        createdAt: new Date().toISOString(),
        createdBy: userId,
      });
      const finalDir = appVersionDir(appsDir, appId, version.num);
      rmSync(finalDir, { recursive: true, force: true });
      mkdirSync(dirname(finalDir), { recursive: true });
      cpSync(incoming, finalDir, { recursive: true });
      await appStore.publishVersion(appId, version.num);
      return version.num;
    } finally {
      rmSync(incoming, { recursive: true, force: true });
    }
  };

  // —— 事件/通知发射（应用管家制 spec §6；全部 fire-and-forget，任何异常不影响发布主流程）——
  const emit = (eventName: string, payload: string): void => {
    try {
      deps.emitEvent?.(eventName, payload);
    } catch {
      // fail-open：触发器分发异常不阻塞工具返回
    }
  };
  const notifyOwner = (intent: {
    event: "app.published" | "app.rolled_back";
    title: string;
    body: string;
    appId: string;
    dedupeKey: string;
  }): void => {
    void deps.notifications
      ?.notify({
        event: intent.event,
        recipients: [{ kind: "user", userId }],
        title: intent.title,
        body: intent.body,
        link: `/apps/${intent.appId}`,
        dedupeKey: intent.dedupeKey,
      })
      .catch(() => {
        // 通知失败不影响发布/回滚结果（站内信通道自有限流与日志）
      });
  };
  const stewardId = deps.agentId ?? null;

  return [
    {
      name: "app_list",
      description:
        "列出当前用户的应用（id/名称/当前版本/运行路径）。部署前查看已有应用，避免重复创建。",
      inputSchema: {},
      handler: async (): Promise<AppToolResult> => {
        const apps = await appStore.listByUser(userId);
        if (apps.length === 0) return ok("（暂无应用）");
        return ok(
          apps
            .map(
              (a) =>
                `- appId=${a.id}「${a.name}」${a.currentVersion !== null ? `当前 v${a.currentVersion}` : "未发布"} 运行路径 ${a.currentVersion !== null ? `/apps/${a.id}/` : "（无）"}`,
            )
            .join("\n"),
        );
      },
    },
    {
      name: "app_create",
      description:
        "创建应用壳（名称+描述；产物稍后用 app_deploy 上传）。返回 appId。仅在需要先建壳再分步开发时使用；一步到位请直接 app_deploy。",
      inputSchema: {
        name: z.string().min(1).max(APP_NAME_MAX).describe("应用名"),
        description: z.string().max(300).optional().describe("一句话描述"),
      },
      handler: async (args): Promise<AppToolResult> => {
        const a = z
          .object({
            name: z.string().min(1).max(APP_NAME_MAX),
            description: z.string().max(300).optional(),
          })
          .parse(args);
        const app = await appStore.create({
          id: `app_${crypto.randomUUID()}`,
          userId,
          name: a.name,
          description: a.description ?? "",
          manifest: { manifestVersion: 1, runtime: "static", ui: { spa: true }, access: "private" },
          ...(stewardId ? { managerAgentId: stewardId } : {}),
        });
        return ok(
          `应用已创建：appId=${app.id}「${app.name}」。开发完成后用 app_deploy（带 appId=${app.id}）发布产物。`,
        );
      },
    },
    {
      name: "app_deploy",
      description:
        "把工作区中的静态站点产物目录发布为平台应用（要求目录根含 index.html；纯前端，禁止依赖服务端运行时）。appId 缺省时按 name 创建新应用。返回运行路径 /apps/<appId>/，用户可在「应用」中心打开。",
      inputSchema: {
        dir: z.string().min(1).describe("产物目录（相对当前工作区），如 dist/ 或 my-app/"),
        appId: z.string().optional().describe("已有应用 ID（更新发布）；缺省=创建新应用"),
        name: z.string().max(60).optional().describe("新应用名（appId 缺省时必填）"),
        description: z.string().max(300).optional().describe("新应用描述"),
      },
      handler: async (args): Promise<AppToolResult> => {
        const a = z
          .object({
            dir: z.string().min(1),
            appId: z.string().optional(),
            name: z.string().max(60).optional(),
            description: z.string().max(300).optional(),
          })
          .parse(args);
        const srcDir = safeResolveDir(runtimeDir, a.dir);
        if (!srcDir) return fail(`产物目录越界或不存在：${a.dir}（须为当前工作区内已存在的目录）`);
        if (!existsSync(join(srcDir, "index.html"))) {
          return fail(`产物目录根缺少 index.html：${a.dir}（静态站点必须以 index.html 入口）`);
        }
        let appId = a.appId;
        let previousVersion: number | null = null;
        let appName = "";
        if (appId) {
          const app = await requireOwned(appId);
          if (!app) return fail(`应用不存在或不属于当前用户：${appId}（用 app_list 查看清单）`);
          if (app.manifest.runtime !== "static")
            return fail(`应用 ${appId} 的运行时 ${app.manifest.runtime} 暂不支持该部署方式`);
          previousVersion = app.currentVersion;
          appName = app.name;
        } else {
          if (!a.name || a.name.trim().length === 0) {
            return fail("新建应用需要 name（或改用 appId 指定已有应用）");
          }
          const app = await appStore.create({
            id: `app_${crypto.randomUUID()}`,
            userId,
            name: a.name.trim(),
            description: a.description ?? "",
            manifest: {
              manifestVersion: 1,
              runtime: "static",
              ui: { spa: true },
              access: "private",
            },
            ...(stewardId ? { managerAgentId: stewardId } : {}),
          });
          appId = app.id;
          appName = app.name;
        }
        try {
          const num = await deployBundle(srcDir, appId);
          // 应用管家制（spec §6）：发布事实 → 事件触发器 + owner 通知（fire-and-forget）
          emit(
            "app.published",
            buildAppPublishedPayload({
              appId,
              name: appName,
              version: num,
              previousVersion,
              publishedBy: { kind: "agent", ...(stewardId ? { agentId: stewardId } : {}) },
              managerAgentId: stewardId,
              at: new Date().toISOString(),
            }),
          );
          notifyOwner({
            event: "app.published",
            appId,
            title: `应用「${appName}」已发布 v${num}`,
            body: previousVersion === null ? "首次发布。" : `由 v${previousVersion} 更新。`,
            dedupeKey: `app:${appId}:v${num}:published`,
          });
          return ok(
            `发布成功：appId=${appId} 版本 v${num}\n运行路径 /apps/${appId}/（用户在「应用」中心 → 打开）\n应用默认私有（仅当前用户可见）；要给其他用户用，属主可在「应用详情 → 分享」开放名单/全体/匿名访问。数据读写用 /api/app-data/${appId}/<key>（Bearer 用 web 端「运行」页签发的 app-token）`,
          );
        } catch (e) {
          return fail(`发布失败：${e instanceof Error ? e.message : String(e)}`);
        }
      },
    },
    {
      name: "app_versions",
      description: "查看应用版本历史（含当前发布版本）。回滚用 app_publish 指定历史版本号。",
      inputSchema: { appId: z.string().min(1).describe("应用 ID") },
      handler: async (args): Promise<AppToolResult> => {
        const a = z.object({ appId: z.string().min(1) }).parse(args);
        const app = await requireOwned(a.appId);
        if (!app) return fail(`应用不存在或不属于当前用户：${a.appId}`);
        const versions = await appStore.listVersions(a.appId);
        if (versions.length === 0) return ok("（尚无版本）");
        return ok(versions.map(versionLine).join("\n"));
      },
    },
    {
      name: "app_publish",
      description: "把应用切换到指定历史版本（回滚/切版）。切换立即生效。",
      inputSchema: {
        appId: z.string().min(1).describe("应用 ID"),
        num: z.number().int().positive().describe("目标版本号"),
      },
      handler: async (args): Promise<AppToolResult> => {
        const a = z
          .object({ appId: z.string().min(1), num: z.number().int().positive() })
          .parse(args);
        const app = await requireOwned(a.appId);
        if (!app) return fail(`应用不存在或不属于当前用户：${a.appId}`);
        const from = app.currentVersion;
        const published = await appStore.publishVersion(a.appId, a.num);
        if (!published) return fail(`版本不存在：v${a.num}（用 app_versions 查看历史）`);
        // 切到非当前版本=回滚事实（应用管家制 spec §6.1）：事件 + owner 告警通知
        if (from !== null && from !== a.num) {
          emit(
            "app.rolled_back",
            buildAppRolledBackPayload({
              appId: a.appId,
              name: app.name,
              from,
              to: a.num,
              rolledBy: { kind: "agent", ...(stewardId ? { agentId: stewardId } : {}) },
              managerAgentId: stewardId,
              at: new Date().toISOString(),
            }),
          );
          notifyOwner({
            event: "app.rolled_back",
            appId: a.appId,
            title: `应用「${app.name}」已回滚到 v${a.num}`,
            body: `由 v${from} 切换。`,
            dedupeKey: `app:${a.appId}:rollback:${from}:${a.num}`,
          });
        }
        return ok(`已切换到 v${a.num}：/apps/${a.appId}/`);
      },
    },
    {
      name: "app_data_list",
      description: "列出应用运行时 KV 数据的 key 清单（调试应用数据用）。",
      inputSchema: { appId: z.string().min(1).describe("应用 ID") },
      handler: async (args): Promise<AppToolResult> => {
        const a = z.object({ appId: z.string().min(1) }).parse(args);
        const app = await requireOwned(a.appId);
        if (!app) return fail(`应用不存在或不属于当前用户：${a.appId}`);
        const items = await appStore.listData(a.appId);
        if (items.length === 0) return ok("（暂无数据）");
        return ok(
          items
            .map(
              (e) =>
                `- ${e.key}（${e.sizeBytes}B，${e.updatedAt}）${e.valueJson.length <= 200 ? ` = ${e.valueJson}` : ""}`,
            )
            .join("\n"),
        );
      },
    },
    {
      name: "app_data_get",
      description: "读取应用运行时 KV 数据的单个 key（调试用）。",
      inputSchema: {
        appId: z.string().min(1).describe("应用 ID"),
        key: z.string().min(1).describe("数据 key"),
      },
      handler: async (args): Promise<AppToolResult> => {
        const a = z.object({ appId: z.string().min(1), key: z.string().min(1) }).parse(args);
        const app = await requireOwned(a.appId);
        if (!app) return fail(`应用不存在或不属于当前用户：${a.appId}`);
        const entry = await appStore.getData(a.appId, a.key);
        if (!entry) return fail(`key 不存在：${a.key}`);
        return ok(
          entry.valueJson.length <= 8000
            ? entry.valueJson
            : `${entry.valueJson.slice(0, 8000)}…（截断）`,
        );
      },
    },
    {
      name: "app_logs_tail",
      description:
        "查看应用运行日志（网关请求 + 前端错误采集）。默认只看 error——发布后验证/排障用；level=all 看全部（含 info）。",
      inputSchema: {
        appId: z.string().min(1).describe("应用 ID"),
        level: z.enum(["error", "all"]).optional().describe("日志级别过滤（缺省 error）"),
      },
      handler: async (args): Promise<AppToolResult> => {
        const a = z
          .object({ appId: z.string().min(1), level: z.enum(["error", "all"]).optional() })
          .parse(args);
        const app = await requireOwned(a.appId);
        if (!app) return fail(`应用不存在或不属于当前用户：${a.appId}`);
        const rows = await appStore.listLogs(a.appId, 200);
        const errorOnly = (a.level ?? "error") === "error";
        const filtered = errorOnly ? rows.filter((r) => r.level === "error") : rows;
        const shown = filtered.slice(0, 50);
        if (shown.length === 0) return ok(errorOnly ? "（最近日志中没有 error）" : "（暂无日志）");
        const lines = shown.map((r) => {
          const src =
            r.source === "gateway"
              ? `网关 ${[r.method, r.path, r.status].filter((v) => v !== undefined).join(" ")}`
              : "前端";
          return `- [${r.ts}] ${src} ${r.level}${r.message ? `：${r.message}` : ""}`;
        });
        const more =
          filtered.length > shown.length ? `\n（另截断 ${filtered.length - shown.length} 条）` : "";
        return ok(lines.join("\n") + more);
      },
    },
    {
      name: "app_export",
      description:
        "导出应用备份（bundle+元信息+运行数据打包为 zip，落到工作区 app-backups/ 下），返回文件路径供用户下载留存。",
      inputSchema: { appId: z.string().min(1).describe("应用 ID") },
      handler: async (args): Promise<AppToolResult> => {
        const a = z.object({ appId: z.string().min(1) }).parse(args);
        const app = await requireOwned(a.appId);
        if (!app) return fail(`应用不存在或不属于当前用户：${a.appId}`);
        if (app.currentVersion === null) return fail("应用尚未发布任何版本，无可备份产物");
        const versionDir = appVersionDir(appsDir, a.appId, app.currentVersion);
        const stage = join(
          runtimeDir,
          ".tmp",
          `app-export-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        );
        mkdirSync(join(stage, "bundle"), { recursive: true });
        try {
          cpSync(versionDir, join(stage, "bundle"), { recursive: true });
          const data = await appStore.listData(a.appId);
          writeFileSync(
            join(stage, "donger-app-backup.json"),
            JSON.stringify({
              kind: "donger-app-backup",
              version: 1,
              exportedAt: new Date().toISOString(),
              sourceAppId: a.appId,
              app: { name: app.name, description: app.description, manifest: app.manifest },
              sourceVersion: app.currentVersion,
            }),
          );
          writeFileSync(join(stage, "data.json"), JSON.stringify(data));
          const zip = zipDirToBuffer(stage);
          const backupDir = join(runtimeDir, "app-backups");
          mkdirSync(backupDir, { recursive: true });
          const safeName = app.name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "app";
          const outPath = join(backupDir, `${safeName}-v${app.currentVersion}-${Date.now()}.zip`);
          writeFileSync(outPath, zip);
          return ok(
            `备份完成：${outPath}\n包含 bundle（v${app.currentVersion}，${statsLine(versionDir)}）+ ${data.length} 条运行数据。用户可从工作区文件中下载留存；还原时把该 zip 作为会话附件上传后用 app_import。`,
          );
        } finally {
          rmSync(stage, { recursive: true, force: true });
        }
      },
    },
    {
      name: "app_import",
      description:
        "从应用备份 zip 还原为新应用（仅接受本平台 app_export 产出的备份；zip 须位于当前工作区或本会话附件目录）。还原 bundle、名称/描述/清单与运行数据。",
      inputSchema: {
        path: z.string().min(1).describe("备份 zip 路径（相对当前工作区，或本会话附件目录内路径）"),
        name: z.string().max(60).optional().describe("覆盖备份中的应用名（缺省用备份内名称）"),
      },
      handler: async (args): Promise<AppToolResult> => {
        const a = z
          .object({ path: z.string().min(1), name: z.string().max(60).optional() })
          .parse(args);
        let zipPath: string | undefined;
        for (const root of importRoots) {
          const resolved = safeResolveDir(root, a.path);
          if (resolved && existsSync(resolved) && statSync(resolved).isFile()) {
            zipPath = resolved;
            break;
          }
        }
        if (!zipPath) {
          return fail(
            `备份文件不存在或越界：${a.path}（仅接受当前工作区与本会话附件目录内的 zip）`,
          );
        }
        const stage = join(
          runtimeDir,
          ".tmp",
          `app-import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        );
        mkdirSync(stage, { recursive: true });
        try {
          extractZipToDir(readFileSync(zipPath), stage);
          const metaPath = join(stage, "donger-app-backup.json");
          if (!existsSync(metaPath)) {
            return fail("不是本平台导出的应用备份（donger-app-backup.json 缺失或格式不符）");
          }
          const metaRaw = readFileSync(metaPath, "utf8");
          const meta = z
            .object({
              kind: z.literal("donger-app-backup"),
              version: z.literal(1),
              app: z.object({
                name: z.string().min(1).max(60),
                description: z.string().max(300).optional(),
                manifest: AppManifestSchema,
              }),
            })
            .parse(JSON.parse(metaRaw));
          const bundleDir = join(stage, "bundle");
          if (!existsSync(join(bundleDir, "index.html"))) {
            return fail("备份 bundle 缺少 index.html，无法还原");
          }
          const dataEntries = existsSync(join(stage, "data.json"))
            ? z
                .array(
                  z.object({
                    key: z.string().min(1),
                    valueJson: z.string(),
                    sizeBytes: z.number().int().nonnegative(),
                    updatedAt: z.string(),
                  }),
                )
                .parse(JSON.parse(readFileSync(join(stage, "data.json"), "utf8")))
            : [];
          if (dataEntries.length > APP_DATA_MAX_KEYS) {
            return fail(`备份数据条数超出配额（${dataEntries.length} > ${APP_DATA_MAX_KEYS}）`);
          }
          const dataTotal = dataEntries.reduce((s, e) => s + e.sizeBytes, 0);
          if (dataTotal > APP_DATA_TOTAL_MAX_BYTES) {
            return fail(`备份数据总量超出配额`);
          }
          const app = await appStore.create({
            id: `app_${crypto.randomUUID()}`,
            userId,
            name: a.name?.trim() || meta.app.name,
            description: meta.app.description ?? "",
            manifest: meta.app.manifest,
            ...(stewardId ? { managerAgentId: stewardId } : {}),
          });
          await deployBundle(bundleDir, app.id);
          for (const e of dataEntries) {
            if (!APP_DATA_KEY_PATTERN.test(e.key) || e.sizeBytes > APP_DATA_VALUE_MAX_BYTES)
              continue;
            await appStore.putData({ appId: app.id, ...e });
          }
          return ok(
            `还原完成：appId=${app.id}「${app.name}」v1\n运行路径 /apps/${app.id}/（用户在「应用」中心打开）\n还原运行数据 ${dataEntries.length} 条。`,
          );
        } catch (e) {
          if (e instanceof ZodError) {
            return fail("不是本平台导出的应用备份（donger-app-backup.json 缺失或格式不符）");
          }
          return fail(`还原失败：${e instanceof Error ? e.message : String(e)}`);
        } finally {
          rmSync(stage, { recursive: true, force: true });
        }
      },
    },
  ];
}

/** 版本目录统计（导出话术用） */
function statsLine(versionDir: string): string {
  try {
    const s = scanBundle(versionDir);
    return `${s.fileCount} 文件`;
  } catch {
    return "?";
  }
}

/** 装配 donger-apps SDK MCP server（会话闭包绑定用户与运行时目录） */
export function createAppToolsServer(deps: AppToolsDeps): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "donger-apps",
    version: "1.0.0",
    tools: appToolDefinitions(deps),
  });
}
