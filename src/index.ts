// donger 应用入口：钉钉 + Web 双通道，共享存储。
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { ClaudeAgentRunner } from "./adapters/claude-agent-runner.js";
import { ClaudeLlmDebugRunner } from "./adapters/claude-llm-debug-runner.js";
import { CodexAgentRunner } from "./adapters/codex-agent-runner.js";
import { CodexChatBridge } from "./adapters/codex-chat-bridge.js";
import { DingTalkChannel } from "./adapters/dingtalk-channel.js";
import { GitCliRepositoryMaterializer } from "./adapters/git-cli-repository-materializer.js";
import { JwtSessionStore } from "./adapters/jwt-session-store.js";
import { LlmProviderTester } from "./adapters/llm-provider-tester.js";
import { LocalExtensionDirectoryResolver } from "./adapters/local-extension-directory-resolver.js";
import { LocalFileBrowser } from "./adapters/local-file-browser.js";
import { LocalSkillInstaller } from "./adapters/local-skill-installer.js";
import { RoutingAgentRunner } from "./adapters/routing-agent-runner.js";
import { SkillRepoSyncService } from "./adapters/skill-repo-sync.js";
import { SqliteAgentCallbackStore } from "./adapters/sqlite-agent-callback-store.js";
import { SqliteAgentShareStore } from "./adapters/sqlite-agent-share-store.js";
import { SqliteAgentStore } from "./adapters/sqlite-agent-store.js";
import { SqliteAppStore } from "./adapters/sqlite-app-store.js";
import { SqliteAuditStore } from "./adapters/sqlite-audit-store.js";
import { SqliteCommentStore } from "./adapters/sqlite-comment-store.js";
import { SqliteConnectorStore } from "./adapters/sqlite-connector-store.js";
import { SqliteConversationStore } from "./adapters/sqlite-conversation-store.js";
import { SqliteCredentialSetStore } from "./adapters/sqlite-credential-set-store.js";
import { SqliteFeedbackStore } from "./adapters/sqlite-feedback-store.js";
import { SqliteInviteStore } from "./adapters/sqlite-invite-store.js";
import {
  SqliteKbLibraryStore,
  SqliteKbRevisionStore,
  SqliteKbShareStore,
} from "./adapters/sqlite-kb-store.js";
import { SqliteLlmProviderStore } from "./adapters/sqlite-llm-provider-store.js";
import { SqliteLoopStore } from "./adapters/sqlite-loop-store.js";
import { SqliteMcpTokenStore } from "./adapters/sqlite-mcp-token-store.js";
import { SqliteMessageStore } from "./adapters/sqlite-message-store.js";
import { SqliteModuleConfigStore } from "./adapters/sqlite-module-config-store.js";
import { SqliteSkillPackStore } from "./adapters/sqlite-skill-pack-store.js";
import { SqliteSystemEventStore } from "./adapters/sqlite-system-event-store.js";
import { SqliteTaskStore } from "./adapters/sqlite-task-store.js";
import { SqliteTranscriptStore } from "./adapters/sqlite-transcript-store.js";
import { SqliteTriggerStore } from "./adapters/sqlite-trigger-store.js";
import { SqliteUsageStore } from "./adapters/sqlite-usage-store.js";
import { SqliteUserSkillRepoStore } from "./adapters/sqlite-user-skill-repo-store.js";
import { SqliteUserStore } from "./adapters/sqlite-user-store.js";
import { SqliteWorkflowStore } from "./adapters/sqlite-workflow-store.js";
import { WebChannel } from "./adapters/web-channel.js";
import { ZcodeAgentRunner } from "./adapters/zcode-agent-runner.js";
import { loadConfig } from "./config.js";
import type { AgentGitRepository } from "./domain/git.js";
import { dingTalkRobotReady, type EnvAuthSnapshot } from "./domain/module-config.js";
import { createDefaultGates } from "./orchestrator/default-gates.js";

import { GitAccessGate } from "./orchestrator/git-access-gate.js";
import { HookRegistry } from "./orchestrator/hook-registry.js";
import { LoopRunner } from "./orchestrator/loop-runner.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { sweepInterruptedTasks } from "./orchestrator/restart-sweep.js";
import { RuntimeManager } from "./orchestrator/runtime-manager.js";
import { SchedulerService } from "./orchestrator/scheduler.js";
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
  const auditStore = new SqliteAuditStore(db);
  auditStore.migrate();
  const systemEventStore = new SqliteSystemEventStore(db);
  systemEventStore.migrate();
  const commentStore = new SqliteCommentStore(db);
  commentStore.migrate();
  const feedbackStore = new SqliteFeedbackStore(db);
  feedbackStore.migrate();
  const messageStore = new SqliteMessageStore(db);
  messageStore.migrate();
  const transcriptStore = new SqliteTranscriptStore(db);
  transcriptStore.migrate();
  const mcpTokenStore = new SqliteMcpTokenStore(db);
  mcpTokenStore.migrate();

  // Agent 密钥加密器 + Agent/分享 store
  const bootAppConfig = new SqliteModuleConfigStore(
    db,
    loadOrGenerateAppSecret(db, "module_config_secret_key"),
  );
  bootAppConfig.migrate();
  if (!cfg.secretKeySeed) {
    // SECRET_KEY 与 JWT_SECRET 均未配置：生成一次性随机 seed 持久化到 app_config
    //（此前回退硬编码公开常量 = 拿到库文件即可解密全部 MCP 密钥）
    const persisted = bootAppConfig.getFlag("secret_key_seed");
    if (persisted) {
      cfg.secretKeySeed = persisted;
      log.warn("SECRET_KEY 未配置，使用首次启动生成的持久化随机密钥（建议显式配置 SECRET_KEY）");
    } else {
      cfg.secretKeySeed = randomBytes(32).toString("hex");
      bootAppConfig.setFlag("secret_key_seed", cfg.secretKeySeed);
      log.warn("SECRET_KEY 未配置，已生成并持久化随机密钥到 app_config（建议显式配置 SECRET_KEY）");
    }
  }
  const secretCipher = createSecretCipher(cfg.secretKeySeed);
  const agentStore = new SqliteAgentStore(db, secretCipher);
  agentStore.migrate();
  const agentShareStore = new SqliteAgentShareStore(db);
  agentShareStore.migrate();
  const agentCallbackStore = new SqliteAgentCallbackStore(db);
  agentCallbackStore.migrate();
  // GitConnection 体系已退役（spec 2026-09-10 §8）：平台连接表随之废弃
  db.exec("DROP TABLE IF EXISTS git_connections");
  db.exec("DROP TABLE IF EXISTS git_repository_grants");
  const repositoryMaterializer = new GitCliRepositoryMaterializer(cfg.gitCloneTimeoutMs);
  const extensionDirectoryResolver = new LocalExtensionDirectoryResolver();
  // 凭证集 store（Gate 的 PAT 桥与 RuntimeManager 注入共享同一实例）；须先于 GitAccessGate 构造
  const credentialSets = new SqliteCredentialSetStore(
    db,
    loadOrGenerateAppSecret(db, "skill_secret_key"),
  );
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

  // 平台应用三表（spec 2026-09-25-app-platform-architecture M1）：产物落 <dataDir>/apps
  //（deploy.ps1 重建目录不触及 data/，应用资产不会被清空）
  const appStore = new SqliteAppStore(db);
  appStore.migrate();
  const appsDir = join(dirname(cfg.dbPath), "apps");
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
  const gitAccessGate = new GitAccessGate(
    repositoryMaterializer,
    credentialSets,
    cfg.gitAuthCacheTtlMs,
    cfg.gitAllowPrivateHosts,
  );

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

  function createOrch(
    channel: Channel,
    skillPackStore: SqliteSkillPackStore,
    credentialSets: SqliteCredentialSetStore,
    skillInstaller: LocalSkillInstaller,
  ): Orchestrator {
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
      },
      skillPackStore,
      credentialSets,
      connectorStore,
      llmProviderStore,
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
      commentStore,
      gates: createDefaultGates(),
      // 三引擎路由（specs/2026-09-21-codex-openai-runner-design.md §6、
      // specs/2026-09-25-zcode-engine-integration.md §4.1）：
      // anthropic（缺省）→ ClaudeAgentRunner；openai → CodexAgentRunner（恒经内置桥）；
      // zcode → ZcodeAgentRunner（GLM 官方 harness，spawn app-server）
      runner: new RoutingAgentRunner(
        new ClaudeAgentRunner(createDefaultGates()),
        new CodexAgentRunner(createDefaultGates(), new CodexChatBridge()),
        new ZcodeAgentRunner(createDefaultGates()),
      ),
      channel,
      runtimeMgr,
      credentialSets,
      agentStore,
      agentShareStore,
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
      appStore,
      appsDir,
    });
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

  // 渠道 → orchestrator 登记表（web 常驻；dingtalk 经 applyDingTalkChannel 运行时装配）
  const orchestrators = new Map<string, Orchestrator>();

  // 钉钉机器人消息通道运行时控制器（授权页「应用」即生效，无需重启；spec §3.5）：
  // 配置齐全→重建通道并转移 recipients；清空/不完整→停用；配置未变→no-op
  let dtChannel: DingTalkChannel | undefined;
  let dtApplied: { appKey: string; appSecret: string; robotCode: string } | undefined;
  const applyDingTalkChannel = (
    robotCfg: { appKey: string; appSecret: string; robotCode: string } | undefined,
  ): void => {
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
    userSkillRepoStore,
    skillRepoSync,
    appStore,
    appsDir,
    appTokenSecret: jwtSecret,
    proxyConfig: cfg.appProxy,
    credentialSets,
    connectorStore,
    llmProviderStore,
    llmProviderTester: new LlmProviderTester(),
    agentStore,
    agentShareStore,
    agentCallbackStore,
    kbLibraryStore,
    kbShareStore,
    kbRevisionStore,
    callbackRateLimitPerMin: cfg.callbackRateLimitPerMin,
    gitAccessGate,
    selfImproveGitRepository: selfImproveGitRepository,
    publicBaseUrl: cfg.publicBaseUrl,
    inviteStore,
    trustProxy: cfg.trustProxy,
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
  const webOrch = createOrch(webChannel, skillPackStore, credentialSets, skillInstaller);
  webChannel.onMessage((m) => void webOrch.handleMessage(m));
  webChannel.onCancel((conversationId) => webOrch.cancelConversation(conversationId));
  orchestrators.set("web", webOrch);

  // 工作流运行时：loopRunner / scheduler / hookRegistry（依赖 webOrch，构造后回填 webChannel.deps）
  const loopRunner = new LoopRunner({
    loopStore,
    workflowStore,
    triggerStore,
    orchestrator: webOrch,
    workspaceRoot: cfg.workspaceDir,
    channelId: "web",
    logger: log,
    allowPrivateNet: cfg.triggerAllowPrivateNet,
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
  webChannelDeps.activityGetter = (conversationId) => webOrch.getActivity(conversationId);
  // 权限模式 PATCH 即时生效：通知 orchestrator 内存 registry（进行中轮的下一次工具调用即按新模式校验）
  webChannelDeps.onPermissionModeChange = (conversationId, mode) =>
    webOrch.setPermissionMode(conversationId, mode);
  // 回调链路专用投递：await 整轮，失败把错误落为 bot 消息（结果查询端点据此收敛 status）
  webChannelDeps.conversationBusyGetter = (conversationId) => webOrch.isBusy(conversationId);
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

  // 启动清扫：遗留 running/awaiting_approval 任务无续跑依据，统一标失败并补提示
  const swept = await sweepInterruptedTasks({ taskStore: store, messageStore, auditStore });
  if (swept.running > 0) log.warn({ count: swept.running }, "已将遗留 running 任务标记为中断");
  if (swept.awaitingApproval > 0)
    log.warn({ count: swept.awaitingApproval }, "已将遗留审批挂起任务标记为中断");
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
