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
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { appVersionDir } from "../adapters/app-api.js";
import {
  APP_BUNDLE_MAX_ENTRIES,
  APP_BUNDLE_TOTAL_UNCOMPRESSED_MAX,
  APP_NAME_MAX,
  type AppVersionMeta,
} from "../domain/app.js";
import type { AppStore, AppVersionWithMeta } from "../ports/app-store.js";

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
  /** 会话运行时目录：app_deploy 的 dir 相对此解析（防工作区外逃逸） */
  runtimeDir: string;
  /** 会话用户：应用所有权的唯一判定依据（工具构造时闭包绑定） */
  userId: string;
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
  const { appStore, appsDir, runtimeDir, userId } = deps;

  const requireOwned = async (appId: string) => {
    const app = await appStore.get(appId);
    if (!app || app.userId !== userId) return undefined;
    return app;
  };

  /** 打包-记账-落位：产物目录 → incoming 暂存 → 分配版本号 → 重命名 → 发布 */
  const deployBundle = async (srcDir: string, appId: string): Promise<string> => {
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
      return `v${version.num}`;
    } finally {
      rmSync(incoming, { recursive: true, force: true });
    }
  };

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
        if (appId) {
          const app = await requireOwned(appId);
          if (!app) return fail(`应用不存在或不属于当前用户：${appId}（用 app_list 查看清单）`);
          if (app.manifest.runtime !== "static")
            return fail(`应用 ${appId} 的运行时 ${app.manifest.runtime} 暂不支持该部署方式`);
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
          });
          appId = app.id;
        }
        try {
          const version = await deployBundle(srcDir, appId);
          return ok(
            `发布成功：appId=${appId} 版本 ${version}\n运行路径 /apps/${appId}/（用户在「应用」中心 → 打开）\n应用为私有（仅当前用户可见）；数据读写用 /api/app-data/${appId}/<key>（Bearer 用 web 端「运行」页签发的 app-token）`,
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
        const published = await appStore.publishVersion(a.appId, a.num);
        if (!published) return fail(`版本不存在：v${a.num}（用 app_versions 查看历史）`);
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
            : entry.valueJson.slice(0, 8000) + "…（截断）",
        );
      },
    },
  ];
}

/** 装配 donger-apps SDK MCP server（会话闭包绑定用户与运行时目录） */
export function createAppToolsServer(deps: AppToolsDeps): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "donger-apps",
    version: "1.0.0",
    tools: appToolDefinitions(deps),
  });
}
