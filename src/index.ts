// donger 应用入口：钉钉 + Web 双通道，共享存储。
import "dotenv/config";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import type { AppConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { ClaudeAgentRunner } from "./adapters/claude-agent-runner.js";
import { DingTalkChannel } from "./adapters/dingtalk-channel.js";
import { SqliteConversationStore } from "./adapters/sqlite-conversation-store.js";
import { SqliteTaskStore } from "./adapters/sqlite-task-store.js";
import { SqliteUsageStore } from "./adapters/sqlite-usage-store.js";
import { SqliteUserStore } from "./adapters/sqlite-user-store.js";
import { WebChannel } from "./adapters/web-channel.js";
import { Planner } from "./domain/planner.js";
import type { User } from "./domain/user.js";
import { createDefaultGates } from "./orchestrator/default-gates.js";
import { Orchestrator, type OrchestratorRunOpts } from "./orchestrator/orchestrator.js";
import type { RunOptions } from "./ports/agent-runner.js";
import type { Channel } from "./ports/channel.js";
import { ensureRuntimeDir } from "./util/workspace.js";
import { migrateWorkspace } from "./util/workspace-migrate.js";
import { createLogger } from "./util/logger.js";

export interface BuildRunOptionsArgs {
  cfg: AppConfig;
  user: User;
  task: { id: string };
  convId: string;
}

/** 构造 RunOptions：cwd 绑会话运行时目录（懒创建），写入边界 = 用户工作区，pluginPaths 含用户 .skills。 */
export function buildRunOptions(args: BuildRunOptionsArgs): RunOptions {
  const { cfg, user, convId } = args;
  // 会话运行时（当前无 entity，走 sessions/<convId>；M13 起按最外层实体分流）
  const cwd = ensureRuntimeDir(user.homeDir, "sessions", "plain", convId);
  const pluginPaths: string[] = [join(user.homeDir, ".skills")];
  if (cfg.superpowersPluginPath) pluginPaths.push(cfg.superpowersPluginPath);
  return {
    cwd,
    skills: cfg.superpowersPluginPath ? [] : [],
    pluginPaths,
    llm: cfg.llm,
    systemPromptAppend: "完成后简要汇报；高危操作（部署/发布/推送）会触发审批门。",
    workspaceRoot: user.homeDir,
  };
}

async function main(): Promise<void> {
  const cfg = loadConfig(process.env);
  const log = createLogger(cfg.logLevel, "app");
  log.info(
    { model: cfg.llm.model, dingtalk: !!cfg.dingtalk, superpowers: !!cfg.superpowersPluginPath },
    "donger 启动",
  );

  // 自动迁移旧 data/ → ~/.donger/（幂等）
  const oldDataDir = join(process.cwd(), "data");
  const sentinelPath = join(dirname(cfg.dbPath), ".migrated");
  try {
    migrateWorkspace({ oldDataDir, newDbPath: cfg.dbPath, newWorkspaceDir: cfg.workspaceDir, sentinelPath });
  } catch (e) {
    log.warn({ err: e }, "旧 data/ 迁移跳过（非致命）");
  }

  const dbDir = dirname(cfg.dbPath);
  mkdirSync(dbDir, { recursive: true });
  const db = new Database(cfg.dbPath);
  const store = new SqliteTaskStore(db);
  store.migrate();
  const usersDir = join(cfg.workspaceDir, "users");
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
        _task,
        plan,
        user: User,
        opts: OrchestratorRunOpts,
      ): Promise<RunOptions> => {
        const cwd = ensureRuntimeDir(user.homeDir, "sessions", "plain", opts.conversationId);
        const pluginPaths: string[] = [join(user.homeDir, ".skills")];
        if (cfg.superpowersPluginPath) pluginPaths.push(cfg.superpowersPluginPath);
        return {
          cwd,
          skills: cfg.superpowersPluginPath ? plan.skills : [],
          pluginPaths,
          llm: cfg.llm,
          systemPromptAppend: "完成后简要汇报；高危操作（部署/发布/推送）会触发审批门。",
          resume: opts.resume,
          workspaceRoot: user.homeDir,
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
    usageStore,
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
