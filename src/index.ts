// donger 应用入口：钉钉 + Web 双通道，共享存储。
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { ClaudeAgentRunner } from "./adapters/claude-agent-runner.js";
import { DingTalkChannel } from "./adapters/dingtalk-channel.js";
import { JwtSessionStore } from "./adapters/jwt-session-store.js";
import { LocalFileBrowser } from "./adapters/local-file-browser.js";
import { SqliteAuditStore } from "./adapters/sqlite-audit-store.js";
import { SqliteConversationStore } from "./adapters/sqlite-conversation-store.js";
import { SqliteMessageStore } from "./adapters/sqlite-message-store.js";
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
import { createLogger } from "./util/logger.js";
import { ensureRuntimeDir } from "./util/workspace.js";
import { migrateWorkspace } from "./util/workspace-migrate.js";

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
    migrateWorkspace({
      oldDataDir,
      newDbPath: cfg.dbPath,
      newWorkspaceDir: cfg.workspaceDir,
      sentinelPath,
    });
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
    adminExternalIds: cfg.adminExternalIds,
    usersDir,
  });
  userStore.migrate();
  const conversationStore = new SqliteConversationStore(db);
  conversationStore.migrate();
  const usageStore = new SqliteUsageStore(db);
  usageStore.migrate();
  const auditStore = new SqliteAuditStore(db);
  auditStore.migrate();
  const messageStore = new SqliteMessageStore(db);
  messageStore.migrate();

  // JWT Session Store
  const jwtSecret = cfg.jwtSecret || loadOrGenerateJwtSecret(db);
  const sessionStore = new JwtSessionStore(db, jwtSecret, cfg.jwtTtlDays * 24 * 60 * 60 * 1000);
  sessionStore.migrate();

  function createOrch(channel: Channel): Orchestrator {
    return new Orchestrator({
      store,
      userStore,
      conversationStore,
      messageStore,
      usageStore,
      auditStore,
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
  const fileBrowser = new LocalFileBrowser({
    userStore,
    conversationStore,
    workspaceDir: cfg.workspaceDir,
  });

  const webChannel = new WebChannel({
    port: cfg.port,
    workspaceDir: cfg.workspaceDir,
    taskStore: store,
    userStore,
    conversationStore,
    messageStore,
    usageStore,
    auditStore,
    sessionStore,
    dingtalkConfig: cfg.dingtalk
      ? { appKey: cfg.dingtalk.appKey, appSecret: cfg.dingtalk.appSecret }
      : undefined,
    fileBrowser,
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

/** 从 DB 读取或自动生成 JWT 密钥并持久化 */
function loadOrGenerateJwtSecret(db: Database.Database): string {
  db.exec(`CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const row = db.prepare("SELECT value FROM app_config WHERE key = 'jwt_secret'").get() as
    | { value: string }
    | undefined;
  if (row) return row.value;
  const secret = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO app_config (key, value) VALUES ('jwt_secret', ?)").run(secret);
  return secret;
}

void main();
