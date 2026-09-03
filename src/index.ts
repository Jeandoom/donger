// donger 应用入口：钉钉 + Web 双通道，共享存储。
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { ClaudeAgentRunner } from "./adapters/claude-agent-runner.js";
import { ClaudeLlmDebugRunner } from "./adapters/claude-llm-debug-runner.js";
import { DingTalkChannel } from "./adapters/dingtalk-channel.js";
import {
  GiteeAuthProvider,
  GitHubAuthProvider,
  JihuLabAuthProvider,
} from "./adapters/git-auth-providers.js";
import { GitCliRepositoryMaterializer } from "./adapters/git-cli-repository-materializer.js";
import { JwtSessionStore } from "./adapters/jwt-session-store.js";
import { LocalExtensionDirectoryResolver } from "./adapters/local-extension-directory-resolver.js";
import { LocalFileBrowser } from "./adapters/local-file-browser.js";
import { LocalSkillInstaller } from "./adapters/local-skill-installer.js";
import { SqliteAgentShareStore } from "./adapters/sqlite-agent-share-store.js";
import { SqliteAgentStore } from "./adapters/sqlite-agent-store.js";
import { SqliteAuditStore } from "./adapters/sqlite-audit-store.js";
import { SqliteConversationStore } from "./adapters/sqlite-conversation-store.js";
import { SqliteCredentialStore } from "./adapters/sqlite-credential-store.js";
import { SqliteGitConnectionStore } from "./adapters/sqlite-git-connection-store.js";
import { SqliteLoopStore } from "./adapters/sqlite-loop-store.js";
import { SqliteMessageStore } from "./adapters/sqlite-message-store.js";
import { SqliteModelConfigStore } from "./adapters/sqlite-model-config-store.js";
import { SqliteSkillPackStore } from "./adapters/sqlite-skill-pack-store.js";
import { SqliteTaskStore } from "./adapters/sqlite-task-store.js";
import { SqliteTranscriptStore } from "./adapters/sqlite-transcript-store.js";
import { SqliteTriggerStore } from "./adapters/sqlite-trigger-store.js";
import { SqliteUsageStore } from "./adapters/sqlite-usage-store.js";
import { SqliteUserStore } from "./adapters/sqlite-user-store.js";
import { SqliteWorkflowStore } from "./adapters/sqlite-workflow-store.js";
import { WebChannel } from "./adapters/web-channel.js";
import { loadConfig } from "./config.js";
import { createDefaultGates } from "./orchestrator/default-gates.js";
import { ensureDispatcherKb } from "./orchestrator/dispatch-kb.js";
import { GitAccessGate } from "./orchestrator/git-access-gate.js";
import { HookRegistry } from "./orchestrator/hook-registry.js";
import { LoopRunner } from "./orchestrator/loop-runner.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { RuntimeManager } from "./orchestrator/runtime-manager.js";
import { SchedulerService } from "./orchestrator/scheduler.js";
import type { Channel } from "./ports/channel.js";
import { loadOrGenerateAppSecret } from "./util/app-secret.js";
import { createLogger } from "./util/logger.js";
import { createSecretCipher } from "./util/secret-cipher.js";
import { migrateWorkspace } from "./util/workspace-migrate.js";

async function main(): Promise<void> {
  const cfg = loadConfig(process.env);
  const log = createLogger(cfg.logLevel, "app");
  log.info(
    { model: cfg.llm.model, dingtalk: !!cfg.dingtalk, builtin: !!cfg.builtinSkillsDir },
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
  const transcriptStore = new SqliteTranscriptStore(db);
  transcriptStore.migrate();

  // Agent 密钥加密器 + Agent/分享 store
  if (!cfg.secretKeySeed) {
    log.warn("SECRET_KEY 与 JWT_SECRET 均为空，agent MCP 密钥将使用不安全默认密钥");
  }
  const secretCipher = createSecretCipher(cfg.secretKeySeed || "donger-insecure-default");
  const agentStore = new SqliteAgentStore(db, secretCipher);
  agentStore.migrate();
  const agentShareStore = new SqliteAgentShareStore(db);
  agentShareStore.migrate();
  const gitConnectionStore = new SqliteGitConnectionStore(db, secretCipher);
  gitConnectionStore.migrate();
  const repositoryMaterializer = new GitCliRepositoryMaterializer(cfg.gitCloneTimeoutMs);
  const extensionDirectoryResolver = new LocalExtensionDirectoryResolver();
  const gitAccessGate = new GitAccessGate(
    gitConnectionStore,
    repositoryMaterializer,
    cfg.gitAuthCacheTtlMs,
  );
  const gitAuthProviders = {
    github: new GitHubAuthProvider({
      ...cfg.gitOAuth.github,
      redirectUri: cfg.publicBaseUrl
        ? `${cfg.publicBaseUrl}/api/settings/git/oauth/github/callback`
        : undefined,
    }),
    gitee: new GiteeAuthProvider({
      ...cfg.gitOAuth.gitee,
      redirectUri: cfg.publicBaseUrl
        ? `${cfg.publicBaseUrl}/api/settings/git/oauth/gitee/callback`
        : undefined,
    }),
    jihulab: new JihuLabAuthProvider({
      ...cfg.gitOAuth.jihulab,
      redirectUri: cfg.publicBaseUrl
        ? `${cfg.publicBaseUrl}/api/settings/git/oauth/jihulab/callback`
        : undefined,
    }),
  };

  // JWT Session Store
  const jwtSecret = cfg.jwtSecret || loadOrGenerateJwtSecret(db);
  const sessionStore = new JwtSessionStore(db, jwtSecret, cfg.jwtTtlDays * 24 * 60 * 60 * 1000);
  sessionStore.migrate();

  function createOrch(
    channel: Channel,
    skillPackStore: SqliteSkillPackStore,
    credentialStore: SqliteCredentialStore,
    skillInstaller: LocalSkillInstaller,
  ): Orchestrator {
    const runtimeMgr = new RuntimeManager({
      transcriptStore,
      conversationStore,
      config: {
        workspaceDir: cfg.workspaceDir,
        llm: cfg.llm,
        defaultSystemPromptAppend: "完成后简要汇报；高危操作（部署/发布/推送）会触发审批门。",
        agentLlmPresets: cfg.agentLlmPresets,
      },
      skillPackStore,
      credentialStore,
      modelConfigStore,
      installer: skillInstaller,
      builtinSkillsDir: cfg.builtinSkillsDir,
      repositoryMaterializer,
      extensionDirectoryResolver,
    });
    return new Orchestrator({
      store,
      userStore,
      conversationStore,
      messageStore,
      usageStore,
      auditStore,
      gates: createDefaultGates(),
      runner: new ClaudeAgentRunner(createDefaultGates()),
      channel,
      runtimeMgr,
      credentialStore,
      agentStore,
      agentShareStore,
      gitAccessGate,
      kbDir,
      installer: skillInstaller,
      skillPackStore,
    });
  }

  // 技能 store/installer（WebChannel 与 Orchestrator 共享同一实例）
  const skillPackStore = new SqliteSkillPackStore(db);
  skillPackStore.migrate();
  const credentialStore = new SqliteCredentialStore(
    db,
    loadOrGenerateAppSecret(db, "skill_secret_key"),
  );
  credentialStore.migrate();
  const modelConfigStore = new SqliteModelConfigStore(db, secretCipher);
  modelConfigStore.migrate();
  const skillInstaller = new LocalSkillInstaller({
    packStore: skillPackStore,
    getHomeDir: (uid) => join(usersDir, uid),
  });

  // 任务管理知识库（P1 任务分发）：幂等 seed dispatcher 目录
  const kbDir = join(cfg.workspaceDir, "kb");
  ensureDispatcherKb(kbDir);

  // 工作流模块 stores（trigger / workflow / loop）
  const triggerStore = new SqliteTriggerStore(db);
  triggerStore.migrate();
  const workflowStore = new SqliteWorkflowStore(db);
  workflowStore.migrate();
  const loopStore = new SqliteLoopStore(db);
  loopStore.migrate();

  // Web Channel（始终启动）
  const fileBrowser = new LocalFileBrowser({
    userStore,
    conversationStore,
    workspaceDir: cfg.workspaceDir,
    agentStore,
    extensionDirectoryResolver,
  });

  const webChannelDeps: import("./adapters/web-channel.js").WebChannelDeps = {
    port: cfg.port,
    host: cfg.host,
    https: cfg.https,
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
    skillPackStore,
    installer: skillInstaller,
    credentialStore,
    modelConfigStore,
    agentStore,
    agentShareStore,
    gitConnectionStore,
    gitAuthProviders,
    gitAccessGate,
    publicBaseUrl: cfg.publicBaseUrl,
    triggerStore,
    workflowStore,
    loopStore,
    agentMeta: {
      presets: cfg.agentLlmPresets,
      skillPaths: cfg.builtinSkillsDir ? [cfg.builtinSkillsDir] : [],
    },
    llm: cfg.llm,
    llmDebugRunner: new ClaudeLlmDebugRunner(),
  };
  const webChannel = new WebChannel(webChannelDeps);
  const webOrch = createOrch(webChannel, skillPackStore, credentialStore, skillInstaller);
  webChannel.onMessage((m) => void webOrch.handleMessage(m));
  webChannel.onCancel((conversationId) => webOrch.cancelConversation(conversationId));

  // 工作流运行时：loopRunner / scheduler / hookRegistry（依赖 webOrch，构造后回填 webChannel.deps）
  const loopRunner = new LoopRunner({
    loopStore,
    workflowStore,
    triggerStore,
    orchestrator: webOrch,
    workspaceRoot: cfg.workspaceDir,
    channelId: "web",
    logger: log,
  });
  const scheduler = new SchedulerService({
    loopStore,
    workflowStore,
    triggerStore,
    loopRunner,
    logger: log,
  });
  const hookRegistry = new HookRegistry({
    triggerStore,
    loopStore,
    workflowStore,
    loopRunner,
    logger: log,
  });
  // ponytail: 回填同一 deps 对象，webChannel 通过 this.deps 读取
  webChannelDeps.loopRunner = loopRunner;
  webChannelDeps.scheduler = scheduler;
  webChannelDeps.hookRegistry = hookRegistry;
  await scheduler.restore();
  log.info({ enabledLoops: scheduler.size() }, "scheduler 已恢复");

  // 进程关闭：先停 scheduler 防止新触发，再关 HTTP；500ms 超时兜底避免卡死
  const shutdown = async (signal: string) => {
    log.info({ signal }, "关闭中");
    scheduler.stopAll();
    await Promise.race([webChannel.stop(), new Promise((resolve) => setTimeout(resolve, 500))]);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  const webProtocol = cfg.https ? "https" : "http";
  log.info({ channel: "web", host: cfg.host, port: cfg.port, protocol: webProtocol }, "就绪");
  console.log(
    `\n🌐 Web 客户端监听 ${cfg.host}:${cfg.port}（本机访问 ${webProtocol}://localhost:${cfg.port}）\n`,
  );

  // 钉钉 Channel（有配置才启动）
  if (cfg.dingtalk) {
    const dtChannel = new DingTalkChannel(cfg.dingtalk);
    const dtOrch = createOrch(dtChannel, skillPackStore, credentialStore, skillInstaller);
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
