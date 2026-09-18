import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type RuntimeRoot = "sessions" | "agents" | "skill_root" | "agent_root" | "workflow_root";

/** 工作区根默认值：~/.donger/workspace */
export function defaultWorkspaceDir(): string {
  return join(homedir(), ".donger", "workspace");
}

/** 每用户工作区：<workspaceDir>/users/<userId> */
export function userWorkspaceDir(workspaceDir: string, userId: string): string {
  return join(workspaceDir, "users", userId);
}

/** 运行时目录路径（不创建） */
export function runtimeDir(
  userWs: string,
  root: RuntimeRoot,
  entityName: string,
  convId: string,
): string {
  return join(userWs, root, entityName, convId);
}

/** 确保运行时目录存在（懒创建），返回其路径 */
export function ensureRuntimeDir(
  userWs: string,
  root: RuntimeRoot,
  entityName: string,
  convId: string,
): string {
  const dir = runtimeDir(userWs, root, entityName, convId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 初始化用户工作区目录树（建用户时调）。
 * 三类：定义（.skills/.agents/.workflows）/ 运行时（sessions/*_root）/ 知识（knowledge_base/*）。
 * `.skills/` 带 .claude-plugin/plugin.json，作为 local plugin 供 SDK 发现技能。
 */
export function initUserWorkspace(userWs: string): void {
  const def = [".skills", ".agents", ".workflows"];
  const runtime = ["sessions", "skill_root", "agent_root", "workflow_root"];
  const kb = ["user", "skills", "agents", "workflows", "knowledges"];
  for (const d of def) mkdirSync(join(userWs, d), { recursive: true });
  for (const d of runtime) mkdirSync(join(userWs, d), { recursive: true });
  mkdirSync(join(userWs, "knowledge_base"), { recursive: true });
  for (const d of kb) mkdirSync(join(userWs, "knowledge_base", d), { recursive: true });
  mkdirSync(join(userWs, ".skills", ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(userWs, ".skills", ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "user-skills", version: "0.0.0" }, null, 2),
    "utf8",
  );
}
