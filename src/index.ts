// donger 应用入口：钉钉 + Web 双通道，共享存储。
import "dotenv/config";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { ClaudeAgentRunner } from "./adapters/claude-agent-runner.js";
import { DingTalkChannel } from "./adapters/dingtalk-channel.js";
import { SqliteConversationStore } from "./adapters/sqlite-conversation-store.js";
import { SqliteTaskStore } from "./adapters/sqlite-task-store.js";
import { SqliteUsageStore } from "./adapters/sqlite-usage-store.js";
import { SqliteUserStore } from "./adapters/sqlite-user-store.js";
import { WebChannel } from "./adapters/web-channel.js";
import { loadConfig } from "./config.js";
import { Planner } from "./domain/planner.js";
import type { User } from "./domain/user.js";
import { createDefaultGates } from "./orchestrator/default-gates.js";
import { Orchestrator, type OrchestratorRunOpts } from "./orchestrator/orchestrator.js";
import type { RunOptions } from "./ports/agent-runner.js";
import type { Channel } from "./ports/channel.js";
import { createWorktree } from "./util/git-worktree.js";
import { createLogger } from "./util/logger.js";

async function main(): Promise<void> {
  const cfg = loadConfig(process.env);
  const log = createLogger(cfg.logLevel, "app");
  log.info(
    { model: cfg.llm.model, dingtalk: !!cfg.dingtalk, superpowers: !!cfg.superpowersPluginPath },
    "donger 启动",
  );

  const dbDir = cfg.dbPath.replace(/[/\\][^/\\]+$/, "");
  mkdirSync(dbDir, { recursive: true });
  const db = new Database(cfg.dbPath);
  const store = new SqliteTaskStore(db);
  store.migrate();
  const usersDir = join(dbDir, "users");
  mkdirSync(usersDir, { recursive: true });
  const userStore = new SqliteUserStore(db, {
    adminStaffIds: new Set(cfg.adminStaffIds),
    usersDir,
  });
  userStore.migrate();
  const conversationStore = new SqliteConversationStore(db);
  conversationStore.migrate();
  const usageStore = new SqliteUsageStore(db);
  usageStore.migrate();

  function createOrch(channel: Channel): Orchestrator {
    return new Orchestrator({
      store,
      userStore,
      conversationStore,
      usageStore,
      planner: new Planner(),
      gates: createDefaultGates(),
      runner: new ClaudeAgentRunner(createDefaultGates()),
      channel,
      runOptsFor: async (
        task,
        plan,
        user: User,
        opts: OrchestratorRunOpts,
      ): Promise<RunOptions> => {
        const repoDir = join(user.homeDir, "repos");
        let cwd: string;
        try {
          cwd = createWorktree(repoDir, task.id);
        } catch {
          cwd = user.homeDir;
        }
        return {
          cwd,
          skills: cfg.superpowersPluginPath ? plan.skills : [],
          pluginPaths: cfg.superpowersPluginPath ? [cfg.superpowersPluginPath] : [],
          llm: cfg.llm,
          systemPromptAppend: "完成后简要汇报；高危操作（部署/发布/推送）会触发审批门。",
          resume: opts.resume,
        };
      },
    });
  }

  // Web Channel（始终启动）
  const webChannel = new WebChannel({
    port: cfg.port,
    taskStore: store,
    userStore,
    conversationStore,
  });
  const webOrch = createOrch(webChannel);
  webChannel.onMessage((m) => void webOrch.handleMessage(m));
  log.info({ channel: "web", port: cfg.port }, "就绪");
  console.log(`\n🌐 Web 客户端：http://localhost:${cfg.port}\n`);

  // 钉钉 Channel（有配置才启动）
  if (cfg.dingtalk) {
    const dtChannel = new DingTalkChannel(cfg.dingtalk);
    const dtOrch = createOrch(dtChannel);
    dtChannel.onMessage((m) => void dtOrch.handleMessage(m));
    log.info({ channel: "dingtalk" }, "就绪");
  }
}

void main();
