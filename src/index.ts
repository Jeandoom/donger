// donger 应用入口：钉钉 + Web 双通道，共享存储。
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { BufferedAuditStore } from "./adapters/buffered-audit-store.js";
import { CachedTranscriptStore } from "./adapters/cached-transcript-store.js";
import { ClaudeAgentRunner } from "./adapters/claude-agent-runner.js";
import { ClaudeLlmDebugRunner } from "./adapters/claude-llm-debug-runner.js";
import { CodexAgentRunner } from "./adapters/codex-agent-runner.js";
import { CodexChatBridge } from "./adapters/codex-chat-bridge.js";
import { DingTalkChannel } from "./adapters/dingtalk-channel.js";
import { EngineRuntimeService } from "./adapters/engine-runtime-service.js";
import { GitCliRepositoryMaterializer } from "./adapters/git-cli-repository-materializer.js";
import {
  migrateLegacyAgentHostExecAllowlists,
  seedBuiltinDenyRules,
} from "./adapters/host-exec-policy-migration.js";
import { JwtSessionStore } from "./adapters/jwt-session-store.js";
import { LlmProviderTester } from "./adapters/llm-provider-tester.js";
import { LocalExtensionDirectoryResolver } from "./adapters/local-extension-directory-resolver.js";
import { LocalFileBrowser } from "./adapters/local-file-browser.js";
import { LocalSkillInstaller } from "./adapters/local-skill-installer.js";
import { DingTalkNotificationAdapter } from "./adapters/notif-dingtalk.js";
import { WebhookNotificationAdapter } from "./adapters/notif-webhook.js";
import { RoutingAgentRunner } from "./adapters/routing-agent-runner.js";
import { SkillJobRunner } from "./adapters/skill-jobs.js";
import { SkillRepoSyncService } from "./adapters/skill-repo-sync.js";
import { SqliteAgentCallbackStore } from "./adapters/sqlite-agent-callback-store.js";
import { SqliteApprovalStore } from "./adapters/sqlite-approval-store.js";
import { SqliteAgentShareStore } from "./adapters/sqlite-agent-share-store.js";
import { SqliteAgentStore } from "./adapters/sqlite-agent-store.js";
import { SqliteAuditStore } from "./adapters/sqlite-audit-store.js";
import { SqliteCommentStore } from "./adapters/sqlite-comment-store.js";
import { SqliteConnectorStore } from "./adapters/sqlite-connector-store.js";
import { SqliteConversationStore } from "./adapters/sqlite-conversation-store.js";
import { SqliteCredentialSetStore } from "./adapters/sqlite-credential-set-store.js";
import { SqliteEngineRuntimeStore } from "./adapters/sqlite-engine-runtime-store.js";
import { SqliteEventFiringStore } from "./adapters/sqlite-event-firing-store.js";
import { SqliteReleaseRunStore } from "./adapters/sqlite-release-run-store.js";
import { ReleaseService } from "./orchestrator/release-service.js";
import { MemoryRateLimiter } from "./adapters/memory-rate-limiter.js";
import { SqliteEventStore } from "./adapters/sqlite-event-store.js";
import { SqliteFeedbackStore } from "./adapters/sqlite-feedback-store.js";
import { SqliteHostExecPolicyStore } from "./adapters/sqlite-host-exec-policy-store.js";
import { SqliteInviteStore } from "./adapters/sqlite-invite-store.js";
import {
  SqliteKbLibraryStore,
  SqliteKbRevisionStore,
  SqliteKbShareStore,
} from "./adapters/sqlite-kb-store.js";
import { SqliteLlmProviderStore } from "./adapters/sqlite-llm-provider-store.js";
import { SqliteMcpTokenStore } from "./adapters/sqlite-mcp-token-store.js";
import { SqliteMessageStore } from "./adapters/sqlite-message-store.js";
import { SqliteModuleConfigStore } from "./adapters/sqlite-module-config-store.js";
import { SqliteNotificationStore } from "./adapters/sqlite-notification-store.js";
import { SqlitePluginStore } from "./adapters/sqlite-plugin-store.js";
import { SqliteSkillPackStore } from "./adapters/sqlite-skill-pack-store.js";
import { SqliteSystemEventStore } from "./adapters/sqlite-system-event-store.js";
import { SqliteTaskStore } from "./adapters/sqlite-task-store.js";
import { SqliteTranscriptStore } from "./adapters/sqlite-transcript-store.js";
import { SqliteUsageStore } from "./adapters/sqlite-usage-store.js";
import { SqliteUserSkillRepoStore } from "./adapters/sqlite-user-skill-repo-store.js";
import { SqliteUserStore } from "./adapters/sqlite-user-store.js";
import { SqliteWorkflowRunStore } from "./adapters/sqlite-workflow-run-store.js";
import { SqliteWorkflowStore } from "./adapters/sqlite-workflow-store.js";
import { createSsh2CommandRunner } from "./adapters/ssh2-command-runner.js";
import { resolveSystemKeySeed, SystemKeyService } from "./adapters/system-key-service.js";
import { WebChannel } from "./adapters/web-channel.js";
import { setEngineCliResolver, ZcodeAgentRunner } from "./adapters/zcode-agent-runner.js";
import { loadConfig } from "./config.js";
import type { AgentGitRepository } from "./domain/git.js";
import { SSH_EGRESS_MODE_FLAG } from "./domain/host-exec-policy.js";
import { dingTalkRobotReady, type EnvAuthSnapshot } from "./domain/module-config.js";
import { ENGINE_PLUGIN_BY_SDK, isPluginEnabled } from "./domain/plugin.js";
import { CallEndpoint } from "./orchestrator/call-endpoint.js";
import { createDefaultGates } from "./orchestrator/default-gates.js";
import { EventDispatcher } from "./orchestrator/event-dispatcher.js";
import { DrainManager } from "./orchestrator/drain-manager.js";
import { GitAccessGate } from "./orchestrator/git-access-gate.js";
import { startMemoryConsolidator } from "./orchestrator/memory-consolidator.js";
import { NotificationService } from "./orchestrator/notification-service.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { autoResumeInterruptedTasks } from "./orchestrator/resume-service.js";
import { sweepInterruptedTasks } from "./orchestrator/restart-sweep.js";
import { RuntimeManager } from "./orchestrator/runtime-manager.js";
import { SchedulerService } from "./orchestrator/scheduler.js";
import { SystemEventDispatcher } from "./orchestrator/system-event-dispatcher.js";
import { startWorktreeGc } from "./orchestrator/worktree-gc.js";
import { PluginHost } from "./plugins/plugin-host.js";
import type { Channel } from "./ports/channel.js";
import { loadOrGenerateAppSecret } from "./util/app-secret.js";
import { warnIfWebDistStale } from "./util/build-fingerprint.js";
import { configureGithubProxy } from "./util/github-oauth-api.js";
import { createKbFts, migrateKbFts } from "./util/kb-fts.js";
import { migrateKnowledgeBases } from "./util/kb-migrate.js";
import { createLogger } from "./util/logger.js";
import { createSecretCipher } from "./util/secret-cipher.js";
import { backfillSetupCompletedFlag } from "./util/setup-completed-backfill.js";
import { acquireSingleInstanceLock } from "./util/single-instance.js";
import { migrateWorkspace } from "./util/workspace-migrate.js";

async function main(): Promise<void> {
  const cfg = loadConfig(process.env);
  const log = createLogger(cfg.logLevel, "app");
  // 单实例互斥：第二实例等待宽限后退出（崩溃残留锁经 pid 存活探测自动接管）
  acquireSingleInstanceLock(join(dirname(cfg.dbPath), "donger.lock"), log);
  log.info(
    { model: cfg.llm.model, dingtalk: !!cfg.dingtalk, builtin: !!cfg.builtinSkillsDir },
    "donger 启动",
  );
  // 前端构建指纹比对：dist 与源码脱节仅告警（dev 常态化重建由 CI/发布流程保障）
  warnIfWebDistStale(join(process.cwd(), "web", "dist"), log);

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
  // WAL + synchronous=NORMAL（运行时性能轮 §SQLite）：默认 DELETE journal + FULL sync 下每条
  // autocommit 多轮 fsync（Windows 单条 1-10ms），审计/消息/transcript/usage 全 store 受益；
  // 零语义变化（单进程单连接）。运维口径：库目录出现 -wal/-shm 伴生文件，备份/迁移须整目录拷贝。
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  const store = new SqliteTaskStore(db);
  store.migrate();
  const usersDir = join(cfg.workspaceDir, "users");
  mkdirSync(usersDir, { recursive: true });
  const userStore = new SqliteUserStore(db, {
    adminExternalIds: cfg.adminExternalIds,
    usersDir,
  });
  userStore.migrate();
  userStore.migrateCredentials();
  const inviteStore = new SqliteInviteStore(db);
  inviteStore.migrate();
  const conversationStore = new SqliteConversationStore(db);
  conversationStore.migrate();
  const usageStore = new SqliteUsageStore(db);
  usageStore.migrate();
  const sqliteAuditStore = new SqliteAuditStore(db);
  sqliteAuditStore.migrate();
  // 审计异步化：record 入队即回，防抖批量事务落库；读路径先 flush，保留「audit ≥ 实时流」
  const auditStore = new BufferedAuditStore(sqliteAuditStore);
  const systemEventStore = new SqliteSystemEventStore(db);
  systemEventStore.migrate();
  // 插件注册表（specs/2026-10-11-plugin-system-design.md §1.3）：迁移→对账→快照，
  // 供 web 通道导航/编辑器过滤与后续引擎/能力启停 gate 消费；对账不改 admin 启停决策
  const pluginStore = new SqlitePluginStore(db);
  pluginStore.migrate();
  const pluginHost = new PluginHost({
    builtinDir: cfg.builtinPluginsDir,
    store: pluginStore,
    log,
  });
  await pluginHost.init();
  // 引擎运行时资产（M1；10-09 引擎注册表稿收编）：工件安装/冒烟/钉版/漂移检测 +
  // zcode 解析链注册表层（env → 钉版 → 桌面候选降级显性，摘掉桌面更新悄悄换血）
  const engineRuntimeStore = new SqliteEngineRuntimeStore(db);
  engineRuntimeStore.migrate();
  const engineRuntimeService = new EngineRuntimeService({
    store: engineRuntimeStore,
    systemEvents: systemEventStore,
    enginesDir: join(dirname(cfg.dbPath), "engines"),
    log,
  });
  await engineRuntimeService.start();
  setEngineCliResolver((sdkType) => {
    const info = engineRuntimeService.resolveCliPathInfo(sdkType);
    return info ? { path: info.path, pinned: info.pinned } : undefined;
  });
  const commentStore = new SqliteCommentStore(db);
  // 审批决议落库（热发布 M3，spec 2026-10-16-hot-deploy-design §6）：请求即落库 +
  // 决议幂等 + 重启重臂；跨重启决议续跑见下方 onApprovalDecision 装配
  const approvalStore = new SqliteApprovalStore(db);
  approvalStore.migrate();
  commentStore.migrate();
  const feedbackStore = new SqliteFeedbackStore(db);
  feedbackStore.migrate();
  const messageStore = new SqliteMessageStore(db);
  messageStore.migrate();
  const sqliteTranscriptStore = new SqliteTranscriptStore(db);
  sqliteTranscriptStore.migrate();
  // 长会话全量重建·档一：宿主缓存已解析 transcript——SDK resume 每轮 load() 的
  // 全表 SELECT+逐条 parse 消掉（TTFT 线性劣化的最大痛点）；进程内唯一写者保证一致性
  const transcriptStore = new CachedTranscriptStore(sqliteTranscriptStore);
  const mcpTokenStore = new SqliteMcpTokenStore(db);
  mcpTokenStore.migrate();

  // 系统密钥（单一真源=DB）：DB 优先 → env 首次导入（过渡能力，待删）→ 双空自动生成兜底。
  // DB 有钥后 env 改动不再生效——漂移在结构上不可能发生；轮换走授权页·密钥管理。
  const bootAppConfig = new SqliteModuleConfigStore(
    db,
    loadOrGenerateAppSecret(db, "module_config_secret_key"),
  );
  bootAppConfig.migrate();
  const systemKeyBoot = resolveSystemKeySeed(db, cfg.secretKeySeed);
  if (systemKeyBoot.source === "generated") {
    log.warn("SECRET_KEY 未配置，已自动生成随机密钥并持久化到 DB（授权页·密钥管理可查看/轮换）");
  } else if (systemKeyBoot.source === "env_imported") {
    log.warn(
      "SECRET_KEY 已从环境变量导入并持久化到 DB（此后改 env 不再生效，轮换请用授权页·密钥管理）",
    );
  }
  if (systemKeyBoot.envIgnored) {
    log.warn(
      "SECRET_KEY env 与 DB 持久化密钥不一致，已忽略 env（DB 优先；如需更换请用授权页·密钥管理轮换）",
    );
  }
  const secretCipher = createSecretCipher(systemKeyBoot.seed);
  // 凭证集统一前旧格式（skill-crypto）兜底 keyHex：双读容忍 + 重加密引擎收编用
  const legacySkillKeyHex = loadOrGenerateAppSecret(db, "skill_secret_key");
  const systemKey = new SystemKeyService(db, secretCipher, legacySkillKeyHex, cfg.secretKeySeed);
  secretCipher.setFallbacks(systemKey.historyCiphers());
  const agentStore = new SqliteAgentStore(db, secretCipher);
  agentStore.migrate();
  const agentShareStore = new SqliteAgentShareStore(db);
  agentShareStore.migrate();
  const agentCallbackStore = new SqliteAgentCallbackStore(db);
  agentCallbackStore.migrate();
  // 主机执行策略（specs/2026-10-12-host-exec-policy-design.md §5）：admin 治理面 +
  // orchestrator 轮级快照读取；存量 agent 白名单迁移在 moduleConfigStore（标记位）就绪后执行
  const hostExecPolicyStore = new SqliteHostExecPolicyStore(db);
  hostExecPolicyStore.migrate();
  // GitConnection 体系已退役（spec 2026-09-10 §8）：平台连接表随之废弃
  db.exec("DROP TABLE IF EXISTS git_connections");
  db.exec("DROP TABLE IF EXISTS git_repository_grants");
  const repositoryMaterializer = new GitCliRepositoryMaterializer(cfg.gitCloneTimeoutMs);
  const extensionDirectoryResolver = new LocalExtensionDirectoryResolver();
  // 凭证集 store（Gate 的 PAT 桥与 RuntimeManager 注入共享同一实例）；须先于 GitAccessGate 构造。
  // 2026-09-30 起与系统密钥统一：migrate 幂等收编旧 skill-crypto 格式
  const credentialSets = new SqliteCredentialSetStore(db, secretCipher, legacySkillKeyHex);
  credentialSets.migrate();
  // 连接器注册表（HTTP MCP）：与 agent 密钥共用同一加密器
  const connectorStore = new SqliteConnectorStore(db, secretCipher);
  connectorStore.migrate();

  // 知识库三表（spec 2026-09-22-knowledge-base-design）+ 存量统一迁移（个人库 ensure/旧目录退役，幂等）
  const kbLibraryStore = new SqliteKbLibraryStore(db);
  kbLibraryStore.migrate();
  const kbShareStore = new SqliteKbShareStore(db);
  kbShareStore.migrate();
  const kbRevisionStore = new SqliteKbRevisionStore(db);
  kbRevisionStore.migrate();

  // 平台应用模块已于 2026-09-30 移除（方案 B GitOps 外接取代）；apps 四表与产物归档休眠保留。
  // FTS 三列式影子索引（R-A：seg=CJK 逐字切分，查询短语化；中文 0 命中修复）
  migrateKbFts(db);
  const kbFts = createKbFts(db);
  const kbMigrate = await migrateKnowledgeBases({
    libraryStore: kbLibraryStore,
    workspaceDir: cfg.workspaceDir,
    usersDir,
    log,
    kbFts,
  });
  if (kbMigrate.ensuredPersonal > 0 || kbMigrate.mergedLegacy > 0) {
    log.info(
      {
        ensuredPersonal: kbMigrate.ensuredPersonal,
        mergedLegacy: kbMigrate.mergedLegacy,
        renameFailed: kbMigrate.renameFailed,
      },
      "知识库统一迁移完成",
    );
  }
  if (kbMigrate.renameFailed > 0) {
    log.warn(`${kbMigrate.renameFailed} 个用户的旧 knowledge_base/ 目录 rename 失败，下次启动重试`);
  }
  const gitAccessGate = new GitAccessGate(credentialSets, cfg.gitAllowPrivateHosts);

  // JWT Session Store
  const jwtSecret = cfg.jwtSecret || loadOrGenerateJwtSecret(db);
  const sessionStore = new JwtSessionStore(db, jwtSecret, cfg.jwtTtlDays * 24 * 60 * 60 * 1000);
  sessionStore.migrate();

  // 授权/代理模块配置存储（spec 2026-09-21-auth-module-design）：三方配置单一真源=module_configs
  const moduleConfigStore = new SqliteModuleConfigStore(
    db,
    loadOrGenerateAppSecret(db, "module_config_secret_key"),
  );
  moduleConfigStore.migrate();
  // 存量迁移（幂等，全局标记位防重启复活）：agent 级 hostExecAllowlist → agent 作用域策略规则
  await migrateLegacyAgentHostExecAllowlists({
    agents: agentStore,
    policies: hostExecPolicyStore,
    flags: moduleConfigStore,
    log,
  });
  // 内置 deny 黑名单播种（幂等一次；admin 删除不复活）
  await seedBuiltinDenyRules({ policies: hostExecPolicyStore, flags: moduleConfigStore, log });
  // 首启一次性迁移：.env 三方配置 → DB（幂等；迁移后运行时只读 DB，.env 三方段不再被读取）
  const envSnapshot: EnvAuthSnapshot = {};
  const migrating: string[] = [];
  if (cfg.dingtalk) {
    envSnapshot.dingtalk = {
      appKey: cfg.dingtalk.appKey,
      appSecret: cfg.dingtalk.appSecret,
      robotCode: cfg.dingtalk.robotCode,
      ...(cfg.dingtalk.cardTemplateId ? { cardTemplateId: cfg.dingtalk.cardTemplateId } : {}),
      ...(cfg.dingtalkLoginRedirectUri.trim()
        ? { redirectUriOverride: cfg.dingtalkLoginRedirectUri.trim() }
        : {}),
    };
    migrating.push("dingtalk");
  }
  if (cfg.githubOAuth) {
    envSnapshot.github = {
      clientId: cfg.githubOAuth.clientId,
      clientSecret: cfg.githubOAuth.clientSecret,
      ...(cfg.githubLoginRedirectUri.trim()
        ? { redirectUriOverride: cfg.githubLoginRedirectUri.trim() }
        : {}),
    };
    migrating.push("github");
  }
  if (cfg.emailSignupAllowedDomains.size > 0 || !cfg.emailLoginEnabled) {
    envSnapshot.email = {
      signupAllowedDomains: [...cfg.emailSignupAllowedDomains],
      loginEnabled: cfg.emailLoginEnabled,
    };
    migrating.push("email");
  }
  if (cfg.githubProxyUrl.trim()) {
    envSnapshot.proxy = { githubOauthProxyUrl: cfg.githubProxyUrl.trim() };
    migrating.push("proxy");
  }
  const firstBootMigration = !moduleConfigStore.getFlag("auth_env_migrated");
  moduleConfigStore.migrateFromEnv(envSnapshot);
  if (firstBootMigration) {
    log.info(
      { migrated: migrating.join(",") || "无" },
      "三方授权 env→DB 一次性迁移完成（此后运行时只读 DB）",
    );
  }
  // GitHub OAuth 代理启动配置改读 DB（运行时重配见 PUT /api/admin/proxy）
  configureGithubProxy(moduleConfigStore.getProxy()?.githubOauthProxyUrl);
  // setup_completed 补写（spec 2026-09-21-user-management-design §2.3）：存量 admin 库
  // 封死「admin 清零重开 setup 引导被公开抢占」的数据面路径（幂等）
  if (await backfillSetupCompletedFlag(userStore, moduleConfigStore)) {
    log.info("setup_completed 标记已补写（存量 admin 库，防 setup 引导重开）");
  }

  // 应用管家制（spec §6）：app 工具事件 → 触发器管线的晚绑定槽（dispatcher 依赖 loopRunner，
  // 而 loopRunner 依赖 orchestrator，只能在本函数外创建后回填）
  const eventEmitRef: { current?: (eventName: string, payload: string) => void } = {};

  function createOrch(
    channel: Channel,
    skillPackStore: SqliteSkillPackStore,
    credentialSets: SqliteCredentialSetStore,
    skillInstaller: LocalSkillInstaller,
  ): Orchestrator {
    // 插件启停判定（M2 能力 gate；快照缺失/行缺失由 isPluginEnabled fail-open 兜底）
    const pluginGate = (id: string) => isPluginEnabled(pluginHost.snapshot(), id);
    const runtimeMgr = new RuntimeManager({
      transcriptStore,
      conversationStore,
      config: {
        workspaceDir: cfg.workspaceDir,
        llm: cfg.llm,
        // 临时文件指引：一周内 3 个不同任务各自踩中「bash /tmp 写、原生 python 读不到」
        // 的 MSYS 路径映射坑（复盘 P2-11）；env 无法修复字面 /tmp，只能靠约定引导
        defaultSystemPromptAppend: [
          "完成后简要汇报；高危操作（部署/发布/推送）会触发审批门。",
          "临时文件一律放当前工作目录的 .tmp/ 下并用相对路径引用，不要用 /tmp（Windows 原生 python 看不到 Git Bash 的 /tmp）。",
        ].join("\n"),
        agentLlmPresets: cfg.agentLlmPresets,
        sessionIdleRollHours: cfg.sessionIdleRollHours,
        // 要害路径读守卫（2026-09-24 审计 H1/D3）：数据库目录+平台安装根（含 .env、
        // .deploy、源码）对 agent Bash/Read 拒绝；本人工作区经 allowRead 豁免
        sensitivePaths: [dirname(cfg.dbPath), process.cwd()],
        // 渗出闸额外放行域（M2-8/INV-8）：与 llm.baseUrl 域、内置 localhost 系并集
        egressAllowDomains: cfg.egressAllowDomains,
      },
      skillPackStore,
      credentialSets,
      connectorStore,
      llmProviderStore,
      installer: skillInstaller,
      builtinSkillsDir: cfg.builtinSkillsDir,
      repositoryMaterializer,
      // 会话级 git worktree 隔离（2026-10-14 并行会话分支冲突轮）：默认开，false 回退共享目录
      sessionWorktree: cfg.gitSessionWorktree,
      extensionDirectoryResolver,
      isPluginEnabled: pluginGate,
    });
    const orch = new Orchestrator({
      store,
      userStore,
      conversationStore,
      messageStore,
      usageStore,
      auditStore,
      commentStore,
      // zcode 会话指针条目落 transcript（sdkSessionId 丢失时反查自愈，spec 2026-09-29 M3）
      transcriptStore,
      notificationService,
      gates: createDefaultGates(),
      // 三引擎路由（specs/2026-09-21-codex-openai-runner-design.md §6、
      // specs/2026-09-25-zcode-engine-integration.md §4.1）：
      // anthropic（缺省）→ ClaudeAgentRunner；openai → CodexAgentRunner（恒经内置桥）；
      // zcode → ZcodeAgentRunner（GLM 官方 harness，spawn app-server）。
      // 第 4 参=引擎启停门禁（M1）：停用引擎的会话轮 fail-closed 显性报错
      runner: new RoutingAgentRunner(
        new ClaudeAgentRunner(createDefaultGates()),
        new CodexAgentRunner(createDefaultGates(), new CodexChatBridge()),
        new ZcodeAgentRunner(createDefaultGates()),
        (sdkType) =>
          isPluginEnabled(pluginHost.snapshot(), ENGINE_PLUGIN_BY_SDK[sdkType] ?? "engine.claude"),
      ),
      channel,
      runtimeMgr,
      credentialSets,
      sshRunner,
      hostExecPolicies: hostExecPolicyStore,
      approvalStore,
      // SSH 出站档位（旁门治理 M2）：app_config flag 现取（同步读），改即生效
      sshEgressMode: () =>
        moduleConfigStore.getFlag(SSH_EGRESS_MODE_FLAG) === "deny" ? "deny" : "ask",
      // 记忆通道模式 + 平台环境约束（知识体系轮 P1）：app_config 现取（同步读），改即生效
      memoryChannelMode: () => {
        const v = moduleConfigStore.getFlag("memory.channel");
        return v === "legacy" || v === "off" ? v : "curated";
      },
      platformEnvNotes: () => moduleConfigStore.getFlag("platform.envNotes"),
      // 平台约束候选池（知识体系轮 P3）：萃取器追加候选，admin 审阅合并
      platformNotesStore: {
        appendCandidate: (content: string, conversationId: string) => {
          const key = "platform.envNotes.candidates";
          let list: Array<{ content: string; conversationId: string; createdAt: string }> = [];
          try {
            list = JSON.parse(moduleConfigStore.getFlag(key) ?? "[]") as typeof list;
          } catch {
            list = [];
          }
          if (content.trim())
            list.push({
              content: content.trim(),
              conversationId,
              createdAt: new Date().toISOString(),
            });
          moduleConfigStore.setFlag(key, JSON.stringify(list.slice(-50)));
        },
      },
      agentStore,
      agentShareStore,
      isPluginEnabled: pluginGate,
      kbLibraryStore,
      kbShareStore,
      kbRevisionStore,
      workspaceDir: cfg.workspaceDir,
      kbFts,
      llm: cfg.llm,
      gitAccessGate,
      installer: skillInstaller,
      skillPackStore,
      connectorStore,
      skillRepoSync,
      selfImproveGitRepository,
      agentChain: cfg.agentChain,
      turnStallTimeoutMs: cfg.turnStallTimeoutMs,
      eventEmit: (eventName, payload) => {
        const dispatch = eventEmitRef.current;
        if (dispatch) dispatch(eventName, payload);
      },
    });
    // 排水拒入闸：全部渠道实例（web/钉钉）统一注入，排水期 handleMessage 拒入新消息
    orch.setDrainGate(drain);
    return orch;
  }

  // 技能 store/installer（WebChannel 与 Orchestrator 共享同一实例）
  const skillPackStore = new SqliteSkillPackStore(db);
  skillPackStore.migrate();
  const llmProviderStore = new SqliteLlmProviderStore(db, secretCipher);
  llmProviderStore.migrate();
  const skillInstaller = new LocalSkillInstaller({
    packStore: skillPackStore,
    getHomeDir: (uid) => join(usersDir, uid),
    credentialSets,
  });

  // 用户技能仓库（自建技能 git 镜像同步）：配置存储 + 同步服务（WebChannel 与 Orchestrator 共享）
  const userSkillRepoStore = new SqliteUserSkillRepoStore(db);
  userSkillRepoStore.migrate();
  const skillRepoSync = new SkillRepoSyncService({
    repoStore: userSkillRepoStore,
    packStore: skillPackStore,
    credentialSets,
    getHomeDir: (uid) => join(usersDir, uid),
  });

  // 平台进化官绑定的 donger 仓库（SELF_IMPROVE_GIT_URL；未配=undefined，实现/推送环节不可用）
  const selfImproveGitRepository: AgentGitRepository | undefined = cfg.selfImproveGit
    ? {
        id: "donger-self",
        name: "donger",
        provider: cfg.selfImproveGit.provider,
        url: cfg.selfImproveGit.url,
        required: true,
        shallow: true,
        syncMode: "fastForward",
        ...(cfg.selfImproveGit.credentialCode
          ? { credentialCode: cfg.selfImproveGit.credentialCode }
          : {}),
      }
    : undefined;

  // agent 链配置校验（D2）：自定义 dispatcher/builder/chat agent 须已登记，缺失仅告警（运行时兜底内置）
  for (const [env, id] of [
    ["DISPATCHER_AGENT_ID", cfg.agentChain.dispatcherAgentId],
    ["BUILDER_AGENT_ID", cfg.agentChain.builderAgentId],
    ["CHAT_AGENT_ID", cfg.agentChain.chatAgentId],
  ] as const) {
    if (id && !(await agentStore.get(id))) {
      log.warn({ env, agentId: id }, "agentChain 配置的智能体不存在，运行时将回退系统内置");
    }
  }

  // 自动化模块 stores（event / workflow / run / firing；迁移顺序有约束，spec §9：
  // event 吸收 triggers → workflow 吸收 loops → run 搬运 loop_runs+trigger_queue 并收尾 DROP）
  const eventStore = new SqliteEventStore(db);
  eventStore.migrate();
  const workflowStore = new SqliteWorkflowStore(db);
  workflowStore.migrate();
  const workflowRunStore = new SqliteWorkflowRunStore(db);
  workflowRunStore.migrate();
  const eventFiringStore = new SqliteEventFiringStore(db);
  eventFiringStore.migrate();
  // L2 自动发布执行记录（spec 2026-10-16-feedback-auto-dev-deploy-l2-design §4.5）
  const releaseRunStore = new SqliteReleaseRunStore(db);
  releaseRunStore.migrate();

  // 通知模块（spec 2026-09-28-notification-module-design）：站内信 + 订阅偏好 + 站外通道
  const notificationStore = new SqliteNotificationStore(db, secretCipher);
  notificationStore.migrate();
  const notificationService = new NotificationService({
    store: notificationStore,
    adapters: [
      new DingTalkNotificationAdapter(() => moduleConfigStore?.getDingTalk()),
      new WebhookNotificationAdapter({ allowPrivateNet: cfg.triggerAllowPrivateNet }),
    ],
    getIdentities: (userId) => userStore.getIdentities(userId),
  });

  // Web Channel（始终启动）
  const fileBrowser = new LocalFileBrowser({
    userStore,
    conversationStore,
    workspaceDir: cfg.workspaceDir,
    agentStore,
    extensionDirectoryResolver,
  });

  // 渠道 → orchestrator 登记表（web 常驻；dingtalk 经 applyDingTalkChannel 运行时装配）
  const orchestrators = new Map<string, Orchestrator>();

  // 排水管理器（热发布优雅停机，spec 2026-10-16-hot-deploy-design M1）：早建晚绑——
  // 此处先创建供 createOrch 注入拒入闸；hooks 在 scheduler/eventDispatcher 装配完成后绑定
  const drain = new DrainManager();

  // 钉钉机器人消息通道运行时控制器（授权页「应用」即生效，无需重启；spec §3.5）：
  // 配置齐全→重建通道并转移 recipients；清空/不完整→停用；配置未变→no-op
  let dtChannel: DingTalkChannel | undefined;
  let dtApplied: { appKey: string; appSecret: string; robotCode: string } | undefined;
  const applyDingTalkChannel = (
    robotCfg: { appKey: string; appSecret: string; robotCode: string } | undefined,
  ): void => {
    // 插件 gate（M2）：channel.dingtalk 停用 → 视为未配置（装配 no-op；已装配通道走
    // 下方 undefined 分支 stop+摘除；重新启用后下次 apply 恢复装配）
    if (!isPluginEnabled(pluginHost.snapshot(), "channel.dingtalk")) {
      robotCfg = undefined;
    }
    if (
      robotCfg &&
      dtChannel &&
      dtApplied &&
      dtApplied.appKey === robotCfg.appKey &&
      dtApplied.appSecret === robotCfg.appSecret &&
      dtApplied.robotCode === robotCfg.robotCode
    ) {
      return;
    }
    const old = dtChannel;
    const next = robotCfg ? new DingTalkChannel(robotCfg) : undefined;
    if (next) {
      const orch = createOrch(next, skillPackStore, credentialSets, skillInstaller);
      // recipients 移交：换通道后旧会话回信不因记忆表丢失而 NO_RECIPIENT
      if (old) for (const [k, v] of old.recipients) next.recipients.set(k, v);
      next.onMessage((m) => void orch.handleMessage(m));
      orchestrators.set("dingtalk", orch);
      log.info({ channel: "dingtalk" }, "机器人通道已应用");
    } else if (old) {
      orchestrators.delete("dingtalk");
      log.info({ channel: "dingtalk" }, "机器人通道已停用");
    }
    old?.stop();
    dtChannel = next;
    dtApplied = robotCfg;
  };

  const webChannelDeps: import("./adapters/web-channel.js").WebChannelDeps = {
    port: cfg.port,
    host: cfg.host,
    https: cfg.https,
    workspaceDir: cfg.workspaceDir,
    taskStore: store,
    userStore,
    systemEventStore,
    conversationStore,
    messageStore,
    usageStore,
    auditStore,
    commentStore,
    feedbackStore,
    sessionStore,
    mcpTokenStore,
    cliToken: cfg.cliToken || undefined,
    moduleConfigStore,
    dingtalkChannelController: { apply: applyDingTalkChannel },
    setupToken: cfg.setupToken || undefined,
    fileBrowser,
    skillPackStore,
    installer: skillInstaller,
    skillJobs: new SkillJobRunner(skillInstaller, { skillRepoSync }),
    userSkillRepoStore,
    skillRepoSync,
    credentialSets,
    hostExecPolicies: hostExecPolicyStore,
    connectorStore,
    llmProviderStore,
    systemKey,
    llmProviderTester: new LlmProviderTester(),
    agentStore,
    agentShareStore,
    agentCallbackStore,
    kbLibraryStore,
    kbShareStore,
    kbRevisionStore,
    kbFts,
    callbackRateLimitPerMin: cfg.callbackRateLimitPerMin,
    gitAccessGate,
    selfImproveGitRepository: selfImproveGitRepository,
    publicBaseUrl: cfg.publicBaseUrl,
    inviteStore,
    trustProxy: cfg.trustProxy,
    eventStore,
    workflowStore,
    workflowRunStore,
    eventFiringStore,
    notificationService,
    agentMeta: {
      presets: cfg.agentLlmPresets,
      skillPaths: cfg.builtinSkillsDir ? [cfg.builtinSkillsDir] : [],
    },
    llm: cfg.llm,
    llmDebugRunner: new ClaudeLlmDebugRunner(),
    pluginHost,
    engineRuntimeService,
  };
  // SSH 命令通道（donger-host 工具的生产执行器）；须在 createOrch 调用前就绪（deps 传参）
  const sshRunner = createSsh2CommandRunner();
  const webChannel = new WebChannel(webChannelDeps);
  const webOrch = createOrch(webChannel, skillPackStore, credentialSets, skillInstaller);
  webChannel.onMessage((m) => void webOrch.handleMessage(m));
  webChannel.onCancel((conversationId) => webOrch.cancelConversation(conversationId));
  orchestrators.set("web", webOrch);

  // 记忆闲时整理器（知识体系轮 P5）：低峰（无 running task）执行归档/索引重排，
  // 动作记 memory-consolidation 修订；索引超限 warn 通知库属主
  const stopMemoryConsolidator = startMemoryConsolidator({
    kbLibraryStore: kbLibraryStore,
    workspaceDir: cfg.workspaceDir,
    revisionStore: kbRevisionStore,
    // 低峰判定：无 running task（整理动作含文件重命名，避开执行高峰）
    idleCheck: async () => {
      const running = await store.listByStatus("running");
      return running.length === 0;
    },
    intervalMs: 3_600_000,
    notify: (input: { userId: string; title: string; body: string; link: string }) => {
      void notificationService
        .notify({
          event: "system.announcement",
          recipients: [{ kind: "user", userId: input.userId }],
          title: input.title,
          body: input.body,
          link: input.link,
          dedupeKey: `memory-consolidation:${input.userId}:${new Date().toISOString().slice(0, 10)}`,
        })
        .catch(() => undefined);
    },
  });

  // 会话 worktree 清道夫（2026-10-14 并行会话分支冲突轮）：回收归档/超龄会话的
  // 独立 worktree（干净才删，未提交工作/未合并分支由 git 拒绝自动保留）
  const stopWorktreeGc = startWorktreeGc({
    workspaceDir: cfg.workspaceDir,
    conversationStore,
    intervalMs: 3_600_000,
  });

  // 自动化运行时：统一触发管线（eventDispatcher）+ 三分发器（依赖 webOrch，构造后回填
  // webChannel.deps；spec 2026-10-09-events-workflows-refactor-design §4）
  const eventDispatcher = new EventDispatcher({
    eventStore,
    workflowStore,
    runStore: workflowRunStore,
    firingStore: eventFiringStore,
    messageStore,
    orchestrator: webOrch,
    conversationStore: conversationStore,
    canceller: webChannel,
    logger: log,
    maxQueuePending: cfg.triggerQueueMaxPending,
    notifications: notificationService,
    // 完成事件 emit（spec 2026-10-19-execution-completion-events-design §5）：
    // 终态抽取最终回复 + 智能体名；systemEvents 构造后 setSystemEventSink 回填
    messageStore,
    agentStore,
  });
  const scheduler = new SchedulerService({
    eventStore,
    workflowStore,
    dispatcher: eventDispatcher,
    logger: log,
    allowPrivateNet: cfg.triggerAllowPrivateNet,
    workspaceRoot: cfg.workspaceDir,
  });
  const callEndpoint = new CallEndpoint({
    eventStore,
    dispatcher: eventDispatcher,
    logger: log,
  });
  // 进程内系统事件分发（feedback.created 等；发射方=web-channel 反馈创建，fail-open）。
  // 插件 gate（M2）：workflows 停用 → 不向触发管线分发（页面写路径另在 web-channel 409）
  const workflowsEnabled = () => isPluginEnabled(pluginHost.snapshot(), "workflows");
  const systemEvents = new SystemEventDispatcher({
    eventStore,
    dispatcher: eventDispatcher,
    logger: log,
  });
  // run 终态 emit 完成事件的回填通道（构造顺序解环：dispatcher 先于 systemEvents）
  eventDispatcher.setSystemEventSink(systemEvents);
  // 应用管家制（spec §6）：orchestrator 的 app 工具事件晚绑定到 dispatcher
  eventEmitRef.current = (eventName, payload) => {
    if (!workflowsEnabled()) return;
    void systemEvents
      .dispatch(eventName, payload)
      .catch((e: Error) => log.error({ eventName, err: e.message }, "app event dispatch failed"));
  };
  // L2 自动发布服务（spec 2026-10-16-feedback-auto-dev-deploy-l2-design §4.5）：
  // 轮询 autoDev workflow 绑定仓库的 [autofix] MR → 策略评估 → 自动合并；宿主管线结果
  // 经 /api/internal/release-result 回收（web-channel 接线）。kill-switch=DONGER_AUTODEV_DISABLED。
  const releaseService = new ReleaseService({
    workflowStore,
    agentStore,
    credentialSets,
    releaseRunStore,
    feedbackStore,
    notifications: notificationService,
    rateLimiter: new MemoryRateLimiter(),
    logger: log,
    disabled: () => cfg.autodevDisabled,
    pollIntervalMs: 60_000,
  });
  releaseService.start();
  // ponytail: 回填同一 deps 对象，webChannel 通过 this.deps 读取
  webChannelDeps.scheduler = scheduler;
  // 插件 gate（M2）：event-sources 停用 → 外呼入口/事件源探测不装配（/hooks 免认证面收口）
  if (isPluginEnabled(pluginHost.snapshot(), "event-sources")) {
    webChannelDeps.callEndpoint = callEndpoint;
    webChannelDeps.eventProbe = {
      allowPrivateNet: cfg.triggerAllowPrivateNet,
      workspaceRoot: cfg.workspaceDir,
    };
  }
  webChannelDeps.eventDispatcher = eventDispatcher;
  webChannelDeps.systemEvents = systemEvents;
  // L2 宿主管线回报闭环（/api/internal/release-result；token 空=端点关闭）
  webChannelDeps.releaseResultHandler = releaseService;
  webChannelDeps.releaseHookToken = cfg.releaseHookToken;
  webChannelDeps.releaseRunStore = releaseRunStore;
  webChannelDeps.activityGetter = (conversationId) => webOrch.getActivity(conversationId);
  // 排水 hooks 晚绑定（热发布优雅停机）：常驻组件至此全部就绪；webChannel 侧的
  // 503 拒入/health 排水标志读同一实例（webChannelDeps.drain 构造后回填，运行时动态读取）
  drain.setHooks({
    stopBackgroundJobs: () => {
      stopWorktreeGc();
      stopMemoryConsolidator();
      scheduler.stopAll();
      eventDispatcher.pause();
    },
    broadcastDraining: (status) => webChannel.broadcastDraining(status),
    activeTurnCount: () => {
      let count = 0;
      for (const orch of orchestrators.values()) count += orch.activeTurnCount();
      return count;
    },
    queuedMessageCount: () => {
      let count = 0;
      for (const orch of orchestrators.values()) count += orch.queuedMessageCount();
      return count;
    },
    flushQueues: async (reason) => {
      await Promise.all([...orchestrators.values()].map((o) => o.flushPendingQueues(reason)));
    },
    // 排水超时兜底（热发布 M2）：在途轮标 interrupted，新实例启动后自动续跑
    markInterrupted: async () => {
      let count = 0;
      for (const orch of orchestrators.values()) {
        count += await orch.interruptActiveTurns("服务更新排水超时");
      }
      return count;
    },
  });
  webChannelDeps.drain = drain;
  // 权限模式 PATCH 即时生效：通知 orchestrator 内存 registry（进行中轮的下一次工具调用即按新模式校验）
  webChannelDeps.onPermissionModeChange = (conversationId, mode) =>
    webOrch.setPermissionMode(conversationId, mode);
  // 回调链路专用投递：await 整轮，失败把错误落为 bot 消息（结果查询端点据此收敛 status）
  webChannelDeps.conversationBusyGetter = (conversationId) => webOrch.isBusy(conversationId);
  // 审批决议落库（热发布 M3）：幂等落库在 respond 路由内；这里接决议后置效果——
  // 审计落痕 + approval.decided 通知（两条路径都发）+ 跨重启续跑（hadResolver=false）
  webChannelDeps.approvalStore = approvalStore;
  webChannelDeps.onApprovalDecision = async (d) => {
    try {
      const row = await approvalStore.get(d.approvalId);
      const task = row ? await store.get(row.taskId) : undefined;
      // 审计落痕（此前批/拒完全无痕，M3 补全）
      if (row) {
        await auditStore
          .record({
            conversationId: d.conversationId,
            taskId: row.taskId,
            userId: d.responderId ?? task?.requesterId ?? "unknown",
            seq: -1,
            type: "approval_decision",
            text: `审批${d.approved ? "通过" : "驳回"}：${row.title}`,
            toolInput: JSON.stringify({
              gateId: row.gateId,
              approved: d.approved,
              ...(d.reason ? { reason: d.reason } : {}),
              ...(d.responderId ? { responderId: d.responderId } : {}),
            }),
            recordedAt: new Date().toISOString(),
          })
          .catch(() => {});
      }
      // 决议侧通知（此前只有请求侧 approval.requested）
      if (task) {
        void notificationService
          .notify({
            event: "approval.decided",
            recipients: [{ kind: "user", userId: task.requesterId }],
            title: `审批已${d.approved ? "通过" : "驳回"}：${row?.title ?? ""}`,
            body: d.reason ? String(d.reason).slice(0, 400) : "",
            link: `/?conv=${d.conversationId}`,
            dedupeKey: `approval-decided:${d.approvalId}`,
          })
          .catch((e) => console.error("[web] 审批决议通知失败", e));
      }
      // 跨重启续跑：内存 resolver 已续原轮的（hadResolver=true）不重复触发
      if (!d.hadResolver && row) {
        let reqInput: unknown;
        try {
          reqInput = row.payload ? (JSON.parse(row.payload) as { input?: unknown }).input : undefined;
        } catch {
          reqInput = undefined;
        }
        await webOrch.resumeAfterApproval({
          taskId: row.taskId,
          gateId: row.gateId,
          gateTitle: row.title,
          approved: d.approved,
          ...(d.reason ? { reason: d.reason } : {}),
          ...(d.adoptPrefix ? { adoptPrefix: d.adoptPrefix } : {}),
          ...(reqInput !== undefined ? { reqInput } : {}),
          ...(row.tool ? { tool: row.tool } : {}),
        });
      }
    } catch (e) {
      console.error("[web] 审批决议后置处理失败", e);
    }
  };
  webChannelDeps.callbackSubmit = async (msg) => {
    const conversationId = msg.conversationId ?? msg.threadId;
    try {
      await webOrch.handleMessage(msg);
    } catch (e) {
      await messageStore
        .add(conversationId, "bot", `回调执行失败：${(e as Error).message}`)
        .catch((err) => console.error("[web] 落回调失败消息异常", err));
    }
  };
  // 自动化恢复：workflows 停用时不恢复定时器与执行队列（触发管线整体静默；
  // 重新启用需重启进程恢复——启停语义在插件页提示）
  if (workflowsEnabled()) {
    await scheduler.restore();
    // 执行队列恢复：崩溃遗留 running→queued 重投（at-least-once）+ 抽积压；记录永久保留（D5）
    await eventDispatcher.restore();
    log.info({ scheduledEvents: scheduler.size() }, "scheduler 已恢复");
  } else {
    log.warn("工作流模块已停用：定时触发器与执行队列未恢复（重启进程后恢复）");
  }

  // 进程关闭（热发布优雅停机，spec 2026-10-16-hot-deploy-design M1）：
  // 排水（stopBackgroundJobs 停常驻 → 广播发布中 → 等在途轮自然完成，超时标 interrupted）
  // → 审计冲刷 → 关 HTTP。compose stop_grace_period 必须 > DONGER_DRAIN_TIMEOUT_MS（SIGKILL 纯兜底）
  const shutdown = async (signal: string) => {
    log.info({ signal }, "关闭中（先排水）");
    try {
      await drain.beginDrain({ timeoutMs: cfg.drainTimeoutMs, reason: `signal:${signal}` });
    } catch (e) {
      log.error({ err: e instanceof Error ? e.message : String(e) }, "排水异常，强制进入关停");
    }
    releaseService.stop();
    // 审计缓冲冲刷：停新触发后、关 HTTP 前把排队事件落库（收口一个刷盘周期的崩溃丢失窗口）
    await Promise.race([auditStore.flush(), new Promise((resolve) => setTimeout(resolve, 1000))]);
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

  // 钉钉 Channel 启动装配（此后授权页「应用」经 applyDingTalkChannel 运行时换血；
  // 配置来源=module_configs，首启迁移已保证 env 有值则 DB 有值）
  {
    const dt = moduleConfigStore.getDingTalk();
    applyDingTalkChannel(
      dt && dingTalkRobotReady(dt)
        ? { appKey: dt.appKey, appSecret: dt.appSecret, robotCode: dt.robotCode ?? "" }
        : undefined,
    );
  }

  // 启动清扫（热发布 M2）：running 孤儿→interrupted（暂停语义），zcode 被杀轮补录；
  // awaiting_approval→failed（M3 审批落库后改为重臂存活）
  const swept = await sweepInterruptedTasks({
    taskStore: store,
    messageStore,
    auditStore,
    approvalStore,
    conversationStore,
    userStore,
  });
  if (swept.interrupted > 0) log.warn({ count: swept.interrupted }, "已将遗留 running 任务标记为中断");
  if (swept.approvalRearmed > 0)
    log.warn({ count: swept.approvalRearmed }, "遗留审批挂起任务已重臂（决议后自动续跑）");
  if (swept.approvalFailed > 0)
    log.warn({ count: swept.approvalFailed }, "遗留审批挂起任务无落库行，已标失败");

  // 中断自动续跑（热发布 M2）：interrupted 轮以合成指令续跑（复用原 task 行，D3）；
  // 不可续跑（非 Web/归档/工作流会话/超上限/开关关）→ 标失败并通知重发
  const resumed = await autoResumeInterruptedTasks({
    taskStore: store,
    conversationStore,
    messageStore,
    auditStore,
    submit: (msg) => {
      void webOrch.handleMessage(msg).catch((e) => console.error("[resume] 续跑轮失败", e));
    },
    autoResume: cfg.autoResumeInterrupted,
  });
  if (resumed.resumed > 0) log.warn({ count: resumed.resumed }, "已自动恢复中断任务");
  if (resumed.abandoned > 0) log.warn({ count: resumed.abandoned }, "中断任务未续跑，已标失败");
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
