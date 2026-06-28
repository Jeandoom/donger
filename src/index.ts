// donger 应用入口：装配 Orchestrator + 真实适配器，按配置选通道。
// 有 DINGTALK_* → 钉钉 Stream；否则 → CLI（本地调试）。
import "dotenv/config";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { ClaudeAgentRunner } from "./adapters/claude-agent-runner.js";
import { CliChannel } from "./adapters/cli-channel.js";
import { DingTalkChannel } from "./adapters/dingtalk-channel.js";
import { SqliteTaskStore } from "./adapters/sqlite-task-store.js";
import { SqliteUserStore } from "./adapters/sqlite-user-store.js";
import { loadConfig } from "./config.js";
import { Planner } from "./domain/planner.js";
import type { User } from "./domain/user.js";
import { createDefaultGates } from "./orchestrator/default-gates.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { createWorktree } from "./util/git-worktree.js";
import { createLogger } from "./util/logger.js";

async function main(): Promise<void> {
  const cfg = loadConfig(process.env);
  const log = createLogger(cfg.logLevel, "app");
  const channelName = cfg.dingtalk ? "dingtalk" : "cli";
  log.info(
    { model: cfg.llm.model, channel: channelName, superpowers: !!cfg.superpowersPluginPath },
    "donger 启动",
  );

  const db = new Database(cfg.dbPath);
  const store = new SqliteTaskStore(db);
  store.migrate();
  const usersDir = join(cfg.dbPath.replace(/\/[^/]+$/, ""), "users");
  mkdirSync(usersDir, { recursive: true });
  const userStore = new SqliteUserStore(db, {
    adminStaffIds: new Set(cfg.adminStaffIds),
    usersDir,
  });
  userStore.migrate();

  const gates = createDefaultGates();
  const runner = new ClaudeAgentRunner(gates);
  const channel = cfg.dingtalk ? new DingTalkChannel(cfg.dingtalk) : new CliChannel();

  const orch = new Orchestrator({
    store,
    userStore,
    planner: new Planner(),
    gates,
    runner,
    channel,
    runOptsFor: async (task, plan, user: User) => {
      // worktree 在用户目录下
      const repoDir = join(user.homeDir, "repos");
      let cwd: string;
      try {
        cwd = createWorktree(repoDir, task.id);
      } catch {
        // 用户 repos/ 还没有 git 仓库，退回用户 homeDir
        cwd = user.homeDir;
      }
      return {
        cwd,
        skills: cfg.superpowersPluginPath ? plan.skills : [],
        pluginPaths: cfg.superpowersPluginPath ? [cfg.superpowersPluginPath] : [],
        llm: cfg.llm,
        systemPromptAppend: "完成后简要汇报；高危操作（部署/发布/推送）会触发审批门。",
      };
    },
  });

  channel.onMessage((m) => {
    void orch.handleMessage(m);
  });

  log.info({ channel: channel.id }, "就绪");
}

void main();
