import { z } from "zod";

/**
 * 存储形态（读容忍）：路径原样字符串，unmarshal 永不因形态拒读（agents 毒记录教训）。
 * 绝对路径存量条目由运行时 resolver 降级 unavailable（specs/2026-09-21-extension-dir-relative-path-design.md §2.2）。
 */
export const AgentExtensionDirectorySchema = z.object({
  id: z.string().min(1),
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[^/\\]+$/),
  path: z.string().min(1).max(512),
  access: z.enum(["readOnly", "readWrite"]).default("readWrite"),
});

export type AgentExtensionDirectory = z.infer<typeof AgentExtensionDirectorySchema>;

/** Windows 盘符（C:/ C:\） */
const DRIVE_RE = /^[A-Za-z]:[/\\]/;
/** POSIX 根 / UNC（\\host\share） / 协议相对（//host/share） */
const ROOTED_RE = /^[/\\]{1,2}/;

/**
 * 扩展目录仅允许相对路径：拒绝对路径三形态与任何 `..` 上跳分量。
 * 归一（\ → /）后逐段判断；duplicate 过滤存量条目与单测复用。
 */
export function isRelativeExtensionPath(path: string): boolean {
  if (path.length === 0 || path.length > 512) return false;
  if (DRIVE_RE.test(path) || ROOTED_RE.test(path)) return false;
  return !path.split(/[/\\]+/).includes("..");
}

/** 存储归一：统一 / 分隔，便于跨平台比对与展示 */
export function normalizeExtensionPath(path: string): string {
  return path.replace(/\\/g, "/");
}

/**
 * 写入形态（写严格）：仅相对路径，\ 归一为 / 后落库。
 * POST（parseAgentInput）与 PATCH 预检共用；运行时 resolver 仍会做锚点内复判兜底。
 */
export const AgentExtensionDirectoryInputSchema = AgentExtensionDirectorySchema.extend({
  path: z
    .string()
    .min(1)
    .max(512)
    .transform(normalizeExtensionPath)
    .refine(
      isRelativeExtensionPath,
      "扩展目录必须是相对路径（相对你的工作区根目录），不允许绝对路径或 .. 上跳",
    ),
});

/** id/name 去重的数组级校验（存储与写入两形态共用） */
function dedupeChecks(items: Array<AgentExtensionDirectory>, ctx: z.RefinementCtx): void {
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (ids.has(item.id)) {
      ctx.addIssue({ code: "custom", path: [index, "id"], message: "目录 id 重复" });
    }
    const name = item.name.toLowerCase();
    if (names.has(name)) {
      ctx.addIssue({ code: "custom", path: [index, "name"], message: "目录显示名重复" });
    }
    ids.add(item.id);
    names.add(name);
  }
}

export const AgentExtensionDirectoriesSchema = z
  .array(AgentExtensionDirectorySchema)
  .superRefine(dedupeChecks)
  .default([]);

export const AgentExtensionDirectoriesInputSchema = z
  .array(AgentExtensionDirectoryInputSchema)
  .superRefine(dedupeChecks)
  .default([]);
