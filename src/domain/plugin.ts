import { z } from "zod";

/**
 * 插件系统领域模型（specs/2026-10-11-plugin-system-design.md）。
 *
 * 三形态：capability=平台内置功能模块（代码不分发，插件化=装配+启停+依赖治理）；
 * engine=agent sdk 运行时（工件资产见 engine_runtimes 表，本表只管启停治理）；
 * pack=扩展包（技能包体系泛化，真安装/真卸载）。
 * manifest 是登记与治理声明，不是代码分发单元；文件真源=plugins/builtin/<id>/plugin.json。
 */

export const PLUGIN_KINDS = ["capability", "engine", "pack"] as const;
export type PluginKind = (typeof PLUGIN_KINDS)[number];

export const PLUGIN_SCOPES = ["agent", "platform"] as const;
export type PluginScope = (typeof PLUGIN_SCOPES)[number];

export const PluginManifestSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9.-]*$/, "id 须为小写字母开头，仅含小写字母/数字/点/连字符"),
  kind: z.enum(PLUGIN_KINDS),
  version: z.string().optional(),
  /** 核心：预装、不可卸载；可否停用由 stoppable 定（拍板①） */
  core: z.boolean().default(false),
  /** false = 不支持停用（安全/主干类拍板为 false；「仅登记」模块在启停语义实现前也为 false） */
  stoppable: z.boolean().default(true),
  scope: z.enum(PLUGIN_SCOPES).optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  /** 依赖的插件 id：启停前置校验（被依赖方禁停/依赖方未启时连带不可用） */
  requires: z.array(z.string()).default([]),
  contributes: z
    .object({
      /** 该模块注入的 agent 配置字段（AgentEditor 过滤+「模块未启用」徽标用） */
      agentConfigFields: z.array(z.string()).optional(),
      /** 受启停控制的前端导航路径（NavigationSidebar 过滤用） */
      navEntries: z.array(z.string()).optional(),
    })
    .optional(),
});
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

export type PluginStatus = "ready" | "missing" | "error";

export const PLUGIN_SOURCES = [
  "builtin", // 能力插件（随平台发版）
  "bundled", // 引擎 npm 内嵌
  "discover", // 引擎本机发现
  "remote", // 远程 URL 下载
  "local", // 本地路径直引
  "git", // 扩展包 git 安装
  "zip", // 扩展包 zip 安装
] as const;
export type PluginSource = (typeof PLUGIN_SOURCES)[number];

/** plugins 表行（治理状态）；title/description/contributes 不进库，快照时由 manifest 合并 */
export interface PluginRecord {
  id: string;
  kind: PluginKind;
  version?: string;
  core: boolean;
  stoppable: boolean;
  scope?: PluginScope;
  source: PluginSource;
  enabled: boolean;
  status: PluginStatus;
  error?: string;
  requires: string[];
  installedAt: string;
  updatedAt: string;
}

/** 快照条目 = 治理行 + manifest 展示字段合并 */
export interface PluginView extends PluginRecord {
  title: string;
  description?: string;
  contributes?: PluginManifest["contributes"];
  /** enabled 且 manifest 可解析的依赖方反查（禁停提示「被 X 依赖」） */
}

export interface PluginSnapshot {
  plugins: PluginView[];
  generatedAt: string;
}

/**
 * 停用前置校验（拍板①/依赖铁律）：返回拒绝原因清单，空数组=允许停用。
 * 规则：stoppable=false 拒；任一 enabled 依赖方存在则拒（须先停依赖方）。
 */
export function disableBlockers(all: readonly PluginView[], id: string): string[] {
  const target = all.find((p) => p.id === id);
  if (!target) return [`插件不存在：${id}`];
  const blockers: string[] = [];
  if (!target.stoppable) blockers.push(`「${target.title}」为核心/主干模块，不支持停用`);
  for (const other of all) {
    if (other.id === id || !other.enabled) continue;
    if (other.requires.includes(id)) {
      blockers.push(`被「${other.title}」依赖，须先停用依赖方`);
    }
  }
  return blockers;
}

/**
 * 装配点启停判定（M1 引擎门禁/M2 能力 gate 共用）。行缺失时 fail-open（视为启用）：
 * 对账缺行属于底账异常，不应放大为平台功能瘫痪；reconcile 负责把行补齐并在日志显性化。
 */
export function isPluginEnabled(snapshot: PluginSnapshot | undefined, id: string): boolean {
  if (!snapshot) return true;
  const row = snapshot.plugins.find((p) => p.id === id);
  return row ? row.enabled : true;
}

/** 启用依赖方是否齐备（启用某插件前校验 requires 全部 enabled；返回缺失清单） */
export function unmetRequires(all: readonly PluginView[], id: string): string[] {
  const target = all.find((p) => p.id === id);
  if (!target) return [`插件不存在：${id}`];
  return target.requires
    .filter((dep) => !all.find((p) => p.id === dep)?.enabled)
    .map((dep) => all.find((p) => p.id === dep)?.title ?? dep);
}

/** snapshot 过滤后的导航路径集（enabled 插件的 navEntries 并集；未登记路径放行） */
export function enabledNavEntries(snapshot: PluginSnapshot | undefined): Set<string> | undefined {
  if (!snapshot) return undefined;
  const disabled = new Set<string>();
  for (const p of snapshot.plugins) {
    if (p.enabled) continue;
    for (const nav of p.contributes?.navEntries ?? []) disabled.add(nav);
  }
  return disabled.size > 0 ? disabled : undefined;
}

/** sdkType → 引擎插件 id（RoutingAgentRunner 启停门禁用；specs §9.3 装配点接线图） */
export const ENGINE_PLUGIN_BY_SDK: Record<string, string> = {
  anthropic: "engine.claude",
  openai: "engine.codex",
  zcode: "engine.zcode",
};
