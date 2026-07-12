import { join } from "node:path";
import type { AppConfig } from "./config.js";
import type { Task } from "./domain/types.js";
import type { User } from "./domain/user.js";
import type { RunOptions } from "./ports/agent-runner.js";
import { ensureRuntimeDir } from "./util/workspace.js";

export interface BuildRunOptionsArgs {
  cfg: AppConfig;
  user: User;
  task: Task;
  convId: string;
}

/** 构造 RunOptions：cwd 绑会话运行时目录（懒创建），写入边界 = 用户工作区，pluginPaths 含用户 .skills。 */
export function buildRunOptions(args: BuildRunOptionsArgs): RunOptions {
  const { cfg, user, convId } = args;
  // 会话运行时（当前无 entity，走 sessions/<convId>；M13 起按最外层实体分流）
  const cwd = ensureRuntimeDir(user.homeDir, "sessions", "plain", convId);
  // 技能 Pack 由 RuntimeManager 按"启用 Pack"装配（见 runtime-manager.ts）；smoke 路径仅占位。
  const pluginPaths: string[] = [join(user.homeDir, ".skills")];
  return {
    cwd,
    skills: [],
    pluginPaths,
    llm: cfg.llm,
    systemPromptAppend: "完成后简要汇报；高危操作（部署/发布/推送）会触发审批门。",
    workspaceRoot: user.homeDir,
  };
}
