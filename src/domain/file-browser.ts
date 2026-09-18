import { isAbsolute, join, relative, resolve } from "node:path";

/** user scope 暴露的 4 个精确子目录（绝不放开整个 homeDir） */
export const USER_SUBDIRS = [".skills", ".agents", ".workflows", "knowledge_base"] as const;

/** 列目录时跳过的条目名 */
export const IGNORED_NAMES: ReadonlySet<string> = new Set([
  ".claude-plugin",
  ".git",
  "node_modules",
  ".DS_Store",
]);

export interface ScopeRootsContext {
  homeDir: string;
  workspaceDir: string;
  conversationId?: string;
  /** 会话绑定的智能体 id：绑定智能体的会话 cwd 为 agents/<agentId>/workspace（与 RuntimeManager 一致） */
  agentId?: string;
}

/** 计算 scope 允许的物理根（绝对路径）列表。runtime 按 agentId 或 conversationId 定根，须给其一。 */
export function scopeRoots(scope: "user" | "runtime", ctx: ScopeRootsContext): string[] {
  if (scope === "user") {
    return USER_SUBDIRS.map((d) => join(ctx.homeDir, d));
  }
  // 与 RuntimeManager 对齐：绑定智能体的会话 cwd 在 homeDir/agents/<agentId>/workspace（产物跨
  // 会话延续，mention 候选按 agent 维度取同一根）；闲聊会话在 homeDir/sessions/<conversationId>/workspace。
  if (ctx.agentId) {
    return [join(ctx.homeDir, "agents", ctx.agentId, "workspace")];
  }
  if (!ctx.conversationId) {
    throw new Error("runtime scope 需要 conversationId 或 agentId");
  }
  return [join(ctx.homeDir, "sessions", ctx.conversationId, "workspace")];
}

export type ResolvedPath = { ok: true; abs: string } | { ok: false };

/**
 * 校验 relPath resolve 后落在某个根内（纯逻辑，不读盘）。
 * 用 path.relative 判定：相对 root 的路径不以 ".." 开头、且非绝对 → 在根内。
 * 这同时挡住绝对路径、.. 穿越、编码穿越（decodeURIComponent 后再 resolve）。
 */
export function resolveWithinRoots(roots: string[], relPath: string): ResolvedPath {
  const decoded = safeDecode(relPath);
  if (isAbsolute(decoded)) return { ok: false };
  for (const root of roots) {
    const abs = resolve(root, decoded);
    const rel = relative(root, abs);
    if (rel === "" || (rel !== ".." && !rel.startsWith("..") && !isAbsolute(rel))) {
      return { ok: true, abs };
    }
  }
  return { ok: false };
}

function safeDecode(p: string): string {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}
