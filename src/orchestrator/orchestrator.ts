import { readdirSync } from "node:fs";
import { join } from "node:path";
import { type Agent, appendDefaultSkill } from "../domain/agent.js";
import { canUseAgent } from "../domain/agent-policy.js";
import { toAuditEvent, userMessageAudit } from "../domain/audit.js";
import type { Conversation } from "../domain/conversation.js";
import { type AgentChainConfig, resolveEntry } from "../domain/entry.js";
import type { GateRouter } from "../domain/gate-router.js";
import type { AgentGitRepository } from "../domain/git.js";
import type { KbLibrary } from "../domain/kb.js";
import { lineDiff } from "../domain/kb-diff.js";
import { canManageKb, canReadKb } from "../domain/kb-policy.js";
import type { LLMConfig } from "../domain/llm-config.js";
import { appendMentions } from "../domain/mentions.js";
import { appendMessageFiles } from "../domain/message-files.js";
import {
  type AgentPermissionMode,
  DEFAULT_PERMISSION_MODE,
  resolvePermissionMode,
} from "../domain/permission-mode.js";
import { isChatTaskType, parseRoutingDecision, type RoutingDecision } from "../domain/routing.js";
import { beginStep, completeStep, type FlowStep } from "../domain/task-flow.js";
import { nextStatus } from "../domain/task-state-machine.js";
import type { IncomingMessage, RunnerEvent, Task, TaskStatus } from "../domain/types.js";
import type { User } from "../domain/user.js";
import { wrapUntrusted } from "../domain/untrusted-content.js";
import { MemoryStore } from "../memory/memory-store.js";
import type {
  AgentRunner,
  ApprovalResolver,
  QuestionResolver,
  RunOptions,
} from "../ports/agent-runner.js";
import type { AgentShareStore } from "../ports/agent-share-store.js";
import type { AgentStore } from "../ports/agent-store.js";
import type { AuditStore } from "../ports/audit-store.js";
import type { Channel } from "../ports/channel.js";
import type { CommentStore } from "../ports/comment-store.js";
import type { ConnectorStore } from "../ports/connector-store.js";
import type { ConversationStore } from "../ports/conversation-store.js";
import type { KbLibraryStore, KbRevisionStore, KbShareStore } from "../ports/kb-store.js";
import type { CredentialSetStore } from "../ports/credential-set-store.js";
import type { MessageStore } from "../ports/message-store.js";
import type { RepositoryMaterializeItem } from "../ports/repository-materializer.js";
import type { SkillInstaller } from "../ports/skill-installer.js";
import type { SkillPackStore } from "../ports/skill-pack-store.js";
import type { TaskStore } from "../ports/task-store.js";
import type { UsageStore } from "../ports/usage-store.js";
import type { UserStore } from "../ports/user-store.js";
import { ForbiddenError, NotFoundError, RunnerError } from "../util/errors.js";
import { kbRootDir, sha256Text } from "../util/kb-files.js";
import { friendlyRunnerError } from "../util/runner-error-message.js";
import { runtimeDir } from "../util/workspace.js";
import { type ActivitySnapshot, ActivityTracker } from "./activity-tracker.js";
import { AGENT_BUILDER_AGENT, AGENT_BUILDER_ID, builderCreationAsk } from "./agent-builder.js";
import { makeApprovalResolver, makeQuestionResolver } from "./approval-flow.js";
import { BUILTIN_ASSIST_AGENT, BUILTIN_ASSIST_AGENT_ID } from "./assist-agent.js";
import { createAuditToolsServer } from "./audit-tools.js";
import { BUILTIN_AUDITOR_AGENT, BUILTIN_AUDITOR_AGENT_ID } from "./auditor-agent.js";
import { BUILTIN_CHAT_AGENT } from "./chat-agent.js";
import { buildDispatcherAgent } from "./dispatch-flow.js";
import { bridgeEvents } from "./event-bridge.js";
import type { GitAccessGate } from "./git-access-gate.js";
import { createGitPlatformToolsServer } from "./git-platform-tools.js";
import { createKbToolsServer, type KbMount } from "./kb-tools.js";
import { enqueueAutoLearn } from "./kb-auto-learn.js";
import { BUILTIN_KB_ASSISTANT_AGENT, BUILTIN_KB_ASSISTANT_ID } from "./kb-assistant-agent.js";
import { promptMissingCredentials } from "./missing-credentials-flow.js";
import { createPlatformToolsServer } from "./platform-tools.js";
import type { RuntimeManager } from "./runtime-manager.js";
import { BUILTIN_SELF_IMPROVER_AGENT_ID, buildSelfImproverAgent } from "./self-improver-agent.js";
import { BUILTIN_SKILL_FORGE_AGENT, BUILTIN_SKILL_FORGE_AGENT_ID } from "./skill-forge-agent.js";
import { guardStreamStall } from "./stream-stall-guard.js";

export interface OrchestratorDeps {
  store: TaskStore;
  userStore: UserStore;
  conversationStore: ConversationStore;
  messageStore?: MessageStore;
  usageStore: UsageStore;
  auditStore: AuditStore;
  gates: GateRouter;
  runner: AgentRunner;
  channel: Channel;
  /** 会话运行态总管：组装 RunOptions（cwd/skills/plugins/sessionStore/resume）+ 回写 sdkSessionId */
  runtimeMgr: RuntimeManager;
  /** 凭证集存储：agent 勾选 code → 当前用户已配置值（注入 env） */
  credentialSets: CredentialSetStore;
  /** 智能体存储（M13；缺省=不支持显式 agent，会话 agentId 必须为空） */
  agentStore?: AgentStore;
  /** 智能体分享/授权存储 */
  agentShareStore?: AgentShareStore;
  /** 知识库三表（spec 2026-09-22-knowledge-base-design；缺省=kb 工具回落 v1 个人目录语义） */
  kbLibraryStore?: KbLibraryStore;
  kbShareStore?: KbShareStore;
  kbRevisionStore?: KbRevisionStore;
  /** 知识库文件根（<workspaceDir>/kb）；缺省=不可挂载库 */
  workspaceDir?: string;
  /** 全局 LLM 配置（自动学习等内部 LLM 调用）；缺省=自动学习不可用 */
  llm?: LLMConfig;
  gitAccessGate?: GitAccessGate;
  /** AI 生成子模块：技能安装器（assist 会话写技能用） */
  installer?: SkillInstaller;
  /** AI 生成子模块：技能 pack 存储（assist 会话列技能用） */
  skillPackStore?: SkillPackStore;
  /** 连接器注册表（技能工坊 list_connectors 用；未装配时该工具提示不可用） */
  connectorStore?: ConnectorStore;
  /** 用户技能仓库同步（write_skill/update_skill 落盘后镜像）；缺省=不同步 */
  skillRepoSync?: { onChanged(userId: string): void };
  /** 平台进化官绑定的 donger 仓库（SELF_IMPROVE_GIT_URL；未配置=不绑仓库，agent 不可推送） */
  selfImproveGitRepository?: AgentGitRepository;
  /** 任务评论存储（T17.3：验收门评论落库）；未装配则评论仅随决议透传不落库 */
  commentStore?: CommentStore;
  /** agent 链配置（D2）：task-flow 各环节可替换为用户自建 agent，缺省系统内置 */
  agentChain?: AgentChainConfig;
  /** LLM 流停摆看门狗阈值（毫秒；undefined/0=关闭） */
  turnStallTimeoutMs?: number;
}

/** 活跃任务明细：并发额度按条目记账，满载时从中挑「最早进入挂起」的淘汰 */
interface ActiveTaskEntry {
  taskId: string;
  conversationId: string;
  /** 任务文本摘要（用户消息前 60 字），弹窗展示用 */
  taskExcerpt: string;
  /** 任务开始时间（ISO） */
  startedAt: string;
  /** 进入等人工输入（审批门/问询）的时刻（ISO）；undefined=活跃执行中 */
  pendingSince?: string;
}

export class Orchestrator {
  // conversationId → taskId（该会话当前活跃任务，用于独立并发控制）
  private readonly busyConversations = new Map<string, string>();
  // conversationId → 会话权限模式（轮启动时预热；web PATCH 即时更新，canUseTool 每次现取）
  private readonly permissionModes = new Map<string, AgentPermissionMode>();
  // 会话实时执行状态（SDK 事件流推导；观测态，不落库）
  private readonly activityTracker = new ActivityTracker();

  /** 更新会话权限模式（web PATCH 回调入口；进行中轮的下一次工具调用即生效） */
  setPermissionMode(conversationId: string, mode: AgentPermissionMode): void {
    this.permissionModes.set(conversationId, mode);
  }

  /** 会话生效权限模式（registry 未命中按变更前问询兜底） */
  private effectivePermissionMode(conversationId: string): AgentPermissionMode {
    return this.permissionModes.get(conversationId) ?? DEFAULT_PERMISSION_MODE;
  }

  /** 查询会话实时执行状态（正在思考/输出/执行什么工具）；无活跃执行时 undefined */
  getActivity(conversationId: string): ActivitySnapshot | undefined {
    return this.activityTracker.get(conversationId);
  }

  /** 活跃任务明细（并发限制 + 满载时淘汰最早挂起任务的候选表） */
  // userId → conversationId → 任务明细
  private readonly userActiveTasks = new Map<string, Map<string, ActiveTaskEntry>>();
  private readonly abortControllers = new Map<string, AbortController>();
  // conversationId → 触发补建的原任务文本（builder 干跑验证用；进程内存态，重启丢失后回退当前消息）
  private readonly builderOriginalPrompts = new Map<string, string>();
  // conversationId → builder 已 finish（待自动重派原任务；runExclusive finally 消费）
  private readonly builderFinished = new Set<string>();
  // conversationId → builder 绑定时刻（闲置超时自动解绑用；重启丢失后从下一条消息重新计时）
  private readonly builderBoundAt = new Map<string, number>();
  /** builder 绑定闲置上限：超时未完成补建视为放弃，自动解绑回归正常分发 */
  private static readonly BUILDER_BIND_TIMEOUT_MS = 10 * 60 * 1000;
  // conversationId → 会话 busy 期间排队的消息（当前任务完成后自动依序处理；进程内存态）
  private readonly pendingQueues = new Map<string, Array<{ user: User; msg: IncomingMessage }>>();
  /** 同用户最大并行任务数 */
  private static readonly MAX_CONCURRENT_PER_USER = 10;
  /** 同会话最大排队消息数（超出直接拒绝，防止刷屏堆积） */
  private static readonly MAX_QUEUED_PER_CONVERSATION = 5;

  constructor(private readonly deps: OrchestratorDeps) {}

  /** 停止指定会话当前正在执行的任务。 */
  cancelConversation(conversationId: string): boolean {
    const controller = this.abortControllers.get(conversationId);
    if (!controller || controller.signal.aborted) return false;
    controller.abort();
    // 审批门已不设超时：abort 后须同步解开挂起审批，否则 canUseTool 的 await
    // 永不返回，轮次收口（finishCanceled）会卡死在事件流上。
    this.deps.channel.cancelPendingApprovals?.(conversationId);
    return true;
  }

  /** 该用户活跃任务是否已满 */
  private checkUserLimit(userId: string): boolean {
    return (this.userActiveTasks.get(userId)?.size ?? 0) < Orchestrator.MAX_CONCURRENT_PER_USER;
  }

  /** 注册活跃任务（并发额度记账 + 淘汰候选表） */
  private registerActive(userId: string, entry: ActiveTaskEntry): void {
    let tasks = this.userActiveTasks.get(userId);
    if (!tasks) {
      tasks = new Map();
      this.userActiveTasks.set(userId, tasks);
    }
    tasks.set(entry.conversationId, entry);
  }

  /** 注销活跃任务（按会话键删除；任务已不存在时幂等） */
  private unregisterActive(userId: string, conversationId: string): void {
    this.userActiveTasks.get(userId)?.delete(conversationId);
  }

  /** 标记任务进入等人工输入（审批门/问询挂起），淘汰候选按此时间排序 */
  private markTaskPending(userId: string, conversationId: string): void {
    const entry = this.userActiveTasks.get(userId)?.get(conversationId);
    if (entry && !entry.pendingSince) entry.pendingSince = new Date().toISOString();
  }

  /** 标记任务脱离挂起（人工输入已返回） */
  private clearTaskPending(userId: string, conversationId: string): void {
    const entry = this.userActiveTasks.get(userId)?.get(conversationId);
    if (entry) entry.pendingSince = undefined;
  }

  /**
   * 并发满时的淘汰候选：该用户所有挂起任务中「最早进入挂起」的一个。
   * 只淘汰等人工输入的任务——活跃执行中的任务挤掉等于中断正在干活的 agent，不参与淘汰。
   */
  private findEvictionCandidate(userId: string): ActiveTaskEntry | undefined {
    const pendings = [...(this.userActiveTasks.get(userId)?.values() ?? [])].filter(
      (e) => e.pendingSince,
    );
    if (pendings.length === 0) return undefined;
    return pendings.reduce((a, b) => (a.pendingSince! <= b.pendingSince! ? a : b));
  }

  /** 检查会话是否繁忙 */
  private isConversationBusy(conversationId: string): boolean {
    return this.busyConversations.has(conversationId);
  }

  /** 会话是否正在处理消息（web 回调结果查询的 status 判定用） */
  isBusy(conversationId: string): boolean {
    return this.isConversationBusy(conversationId);
  }

  /** 标记会话繁忙 */
  private markBusy(conversationId: string, taskId: string): void {
    this.busyConversations.set(conversationId, taskId);
  }

  /** 解除会话繁忙 */
  private unmarkBusy(conversationId: string): void {
    this.busyConversations.delete(conversationId);
  }

  /** 获取用户最新的活跃会话ID（无IO，用于快速路由） */
  private getLatestConversationId(userId: string, channelId: string): string | null {
    // 从本地缓存取，避免每次消息都查库
    // 这个值在 conversation 创建后更新，所以只需要一个成员变量缓存
    return this.latestConvCache?.get(`${userId}:${channelId}`) ?? null;
  }

  private latestConvCache?: Map<string, string>;

  /**
   * 按通道解析/创建用户（统一身份模型）。
   * - web：requesterId 已是 users.id（JWT sub），直接 get；
   * - dingtalk：requesterId 是钉钉 staffId，作为 dingtalk provider 的 externalId；
   * - 其它（CLI 等）：internal provider。
   */
  private async resolveUser(msg: IncomingMessage): Promise<User> {
    const { userStore } = this.deps;
    if (msg.channelId === "web") {
      const webUser = await userStore.get(msg.requesterId);
      if (!webUser) {
        throw new NotFoundError("USER_NOT_FOUND", `Web 用户不存在: ${msg.requesterId}`);
      }
      return webUser;
    }
    if (msg.channelId === "dingtalk") {
      return userStore.getOrCreateByIdentity("dingtalk", msg.requesterId, msg.text.slice(0, 30));
    }
    return userStore.getOrCreateByIdentity("internal", msg.requesterId, msg.requesterId);
  }

  /**
   * 解析「将被使用」的 agent：存在性 + 使用权限（owner/admin/分享授权）+ Git 仓库就绪检查。
   * 权限不足直接抛；Git 未就绪不抛，返回 gitBlocked 由调用方决定 UX（显式选择发提示，路由落任务失败）。
   */
  private async resolveAgentForUse(
    agentId: string,
    user: User,
  ): Promise<{
    agent: Agent;
    sharedAgentSkillOwner?: User;
    gitMaterializeItems?: RepositoryMaterializeItem[];
    gitBlocked?: string;
  }> {
    // 内置协助智能体：代码常量直返，不查库不做权限检查（写入以发起用户身份）
    if (agentId === BUILTIN_ASSIST_AGENT_ID) return { agent: BUILTIN_ASSIST_AGENT };
    if (agentId === BUILTIN_KB_ASSISTANT_ID) return { agent: BUILTIN_KB_ASSISTANT_AGENT };
    if (agentId === BUILTIN_SKILL_FORGE_AGENT_ID) return { agent: BUILTIN_SKILL_FORGE_AGENT };
    if (agentId === BUILTIN_AUDITOR_AGENT_ID) return { agent: BUILTIN_AUDITOR_AGENT };
    if (agentId === AGENT_BUILDER_ID) return { agent: AGENT_BUILDER_AGENT };
    // 平台进化官：内置但仅管理员可用；绑定 donger 仓库时走与 DB agent 相同的 git 就绪检查
    if (agentId === BUILTIN_SELF_IMPROVER_AGENT_ID) {
      if (user.role !== "admin") {
        throw new ForbiddenError("AGENT_FORBIDDEN", "平台进化官仅管理员可用");
      }
      const agent = buildSelfImproverAgent(this.deps.selfImproveGitRepository);
      if (this.deps.gitAccessGate && agent.gitRepositories.length > 0) {
        const gitAccess = await this.deps.gitAccessGate.check(user, agent);
        if (!gitAccess.ready) {
          return {
            agent,
            gitBlocked:
              "请先完成平台进化官所需 Git 仓库授权（凭证集配置 donger 仓库 PAT）后再对话。",
          };
        }
        return { agent, gitMaterializeItems: gitAccess.materializeItems };
      }
      return { agent };
    }
    if (!this.deps.agentStore) {
      throw new ForbiddenError("AGENT_STORE_MISSING", "agent 存储未装配");
    }
    const agent = await this.deps.agentStore.get(agentId);
    if (!agent) {
      throw new NotFoundError("AGENT_NOT_FOUND", `智能体不存在: ${agentId}`);
    }
    const granted = this.deps.agentShareStore
      ? await this.deps.agentShareStore.isGranted(agent.id, user.id)
      : false;
    if (!canUseAgent(agent, user, granted)) {
      throw new ForbiddenError("AGENT_FORBIDDEN", "无权使用该智能体");
    }
    const sharedAgentSkillOwner =
      agent.ownerId !== user.id ? await this.deps.userStore.get(agent.ownerId) : undefined;
    if (this.deps.gitAccessGate && agent.gitRepositories.length > 0) {
      // 共享智能体的仓库凭证随分享者解析（specs/2026-09-20-agent-share-tighten-and-duplicate-design.md §2.5）
      const gitAccess = await this.deps.gitAccessGate.check(sharedAgentSkillOwner ?? user, agent);
      if (!gitAccess.ready) {
        return {
          agent,
          sharedAgentSkillOwner,
          gitBlocked: sharedAgentSkillOwner
            ? "分享者尚未完成该智能体所需 Git 仓库授权，请联系分享者配置后再对话。"
            : "请先完成智能体所需 Git 仓库授权后再对话。",
        };
      }
      return { agent, sharedAgentSkillOwner, gitMaterializeItems: gitAccess.materializeItems };
    }
    return { agent, sharedAgentSkillOwner };
  }

  /**
   * 知识库挂载清单（spec §8）：会话绑定库（canReadKb 越权抛）→ agent 绑定库（弱引用失效
   * 忽略；无读权不挂）→ 个人库兜底（恒挂载语义连续，kbId 缺省=个人库）。可写=canManageKb。
   */
  private async resolveKbMounts(
    user: User,
    conversation: Conversation,
    agent?: Agent,
  ): Promise<{ mounts: KbMount[]; defaultKbId?: string }> {
    const libs = this.deps.kbLibraryStore;
    const shareStore = this.deps.kbShareStore;
    if (!libs || !this.deps.workspaceDir) return { mounts: [] };
    const actor = { id: user.id, role: user.role };
    const isGranted = async (kbId: string): Promise<boolean> =>
      shareStore ? shareStore.isGranted(kbId, user.id) : false;
    const push = async (lib: KbLibrary): Promise<void> => {
      if (mounts.some((m) => m.kbId === lib.id)) return;
      let topDirs = "";
      try {
        topDirs = readdirSync(kbRootDir(this.deps.workspaceDir ?? ".", lib.id))
          .filter((n) => !n.startsWith("."))
          .slice(0, 12)
          .map((n) => `${n}/`)
          .join(" ");
      } catch {
        topDirs = "";
      }
      mounts.push({
        kbId: lib.id,
        name: lib.name,
        root: kbRootDir(this.deps.workspaceDir ?? ".", lib.id),
        writable: canManageKb(lib, actor),
        description: lib.description,
        systemPrompt: lib.systemPrompt,
        ownerIsUser: lib.ownerId === user.id,
        topDirs,
      });
    };

    const mounts: KbMount[] = [];
    let defaultKbId: string | undefined;
    if (conversation.kbId) {
      const lib = await libs.get(conversation.kbId);
      if (!lib) {
        throw new NotFoundError("KB_NOT_FOUND", `知识库不存在: ${conversation.kbId}`);
      }
      if (!canReadKb(lib, actor, await isGranted(lib.id))) {
        throw new ForbiddenError("KB_FORBIDDEN", "无权访问该知识库");
      }
      await push(lib);
      defaultKbId = lib.id;
    }
    // agent 绑定库（弱引用；knowledgeBaseIds 为 M3 接线字段，schema 缺省空数组）
    for (const kbId of agent?.knowledgeBaseIds ?? []) {
      const lib = await libs.get(kbId);
      if (!lib) continue;
      if (!canReadKb(lib, actor, await isGranted(lib.id))) continue;
      await push(lib);
    }
    // 兜底：个人库恒挂载（存量 kb-qa/research 无绑定时的行为连续）
    const personal = await libs.ensurePersonalLibrary(user.id);
    await push(personal);
    return { mounts, defaultKbId: defaultKbId ?? personal.id };
  }

  /** 知识库上下文注入（spec §8）：清单+各库提示词（他人库 wrapUntrusted，防属主跨用户注入）+顶层目录 */
  private kbContextPrompt(mounts: KbMount[]): string {
    if (mounts.length === 0) return "";
    const lines: string[] = ["## 可用知识库（用 kb_* 工具访问；kbId 缺省=主库）"];
    for (const m of mounts) {
      lines.push(
        `- kbId=${m.kbId}「${m.name}」${m.writable ? "（可维护）" : "（只读）"}${m.description ? `：${m.description}` : ""}`,
      );
      if (m.systemPrompt && m.systemPrompt.length > 0) {
        lines.push(
          m.ownerIsUser
            ? `  库提示词：${m.systemPrompt}`
            : String(wrapUntrusted(m.systemPrompt, `kb:${m.kbId}:systemPrompt`)),
        );
      }
      if (m.topDirs && m.topDirs.length > 0) lines.push(`  顶层目录：${m.topDirs}`);
    }
    return lines.join("\n");
  }

  /**
   * 单轮执行：prepare（含凭证 env / skills 覆盖）→ session 过期重试 → 事件桥 → 用量统计 → sessionId 回写。
   * 不做状态流转与收尾通知（调用方负责），供单轮路径与三段式阶段循环复用。
   */
  /** 阶段横幅（🔨 执行阶段/🔍 验收阶段）：过程态而非聊天内容，优先走非持久通道
   *  （web=activity 事件，前端输入区上方状态行，不落 messages 表）；无该能力的渠道退回 send */
  private async emitStageBanner(
    channel: Channel,
    conversationId: string,
    threadId: string,
    text: string,
  ): Promise<void> {
    if (channel.pushActivity) {
      channel.pushActivity(conversationId, text);
      return;
    }
    await channel.send(threadId, { text });
  }

  private async runTurn(p: {
    task: Task;
    user: User;
    conversation: Conversation;
    threadId: string;
    channelId: string;
    memoryAppend?: string;
    /** 覆盖 prepare 得到的 skills（如 dispatcher 的专用技能集）；缺省用 prepare 结果 */
    skills?: string[];
    agent?: Agent;
    sharedAgentSkillOwner?: User;
    gitMaterializeItems?: RepositoryMaterializeItem[];
    runController: AbortController;
    /** 多阶段任务的非末轮置 true：不向渠道推 result 事件（CLI/web 的回合不提前结束） */
    quietResult?: boolean;
    /** 会话标题取材文本（缺省=task.prompt）；阶段轮的 task.prompt 是阶段引导词，标题须保持用户原文 */
    titleText?: string;
    /** 内部轮（dispatcher）：不接续会话 resume、不回写 sdkSessionId（独立决策，防历史污染） */
    noResume?: boolean;
    /** 内部轮（dispatcher）：事件只落审计，不推送渠道、不持久化消息 */
    silent?: boolean;
    /** 用户显式选择的 LLM（消息级 modelRef；透传 prepare 最高优先级解析） */
    modelRef?: string;
  }): Promise<{ aborted: boolean; ok: boolean; error?: string; resultText: string }> {
    const { channel, gates } = this.deps;
    const prepareOnce = async (): Promise<RunOptions> => {
      const { context, runOptions } = await this.deps.runtimeMgr.prepare(p.user, p.conversation, {
        systemPromptAppend: p.memoryAppend,
        abortSignal: p.runController.signal,
        agent: p.agent,
        sharedAgentSkillOwner: p.sharedAgentSkillOwner,
        gitMaterializeItems: p.gitMaterializeItems,
        modelRef: p.modelRef,
      });
      let base = p.skills ? { ...runOptions, skills: p.skills } : runOptions;
      // 会话权限模式取值器：canUseTool 每次工具调用现取（轮内经 PATCH 切换立即生效）
      base = { ...base, permissionMode: () => this.effectivePermissionMode(p.conversation.id) };
      // 知识库挂载清单（spec §8）：会话绑定库 ∪ agent 绑定库 ∪ 个人库兜底（kbId 缺省=个人库，
      // 存量白名单/场景词表行为连续）；写经 onChange 落 kb_revisions；可写库根传 runner 做 Bash 写守卫（§9）
      const { mounts: kbMounts, defaultKbId: kbDefault } = await this.resolveKbMounts(
        p.user,
        p.conversation,
        p.agent,
      );
      base = {
        ...base,
        kbTools: createKbToolsServer({
          mounts: kbMounts,
          defaultKbId: kbDefault,
          onChange: async (e) => {
            const revisions = this.deps.kbRevisionStore;
            if (!revisions) return;
            const diff = e.action === "delete" ? undefined : lineDiff(e.before ?? "", e.after ?? "");
            await revisions.record({
              kbId: e.kbId,
              path: e.path,
              action: e.action,
              actorUserId: p.user.id,
              actorKind: "chat",
              conversationId: p.conversation.id,
              taskId: p.task.id,
              beforeHash: e.before !== undefined ? sha256Text(e.before) : undefined,
              afterHash: e.after !== undefined ? sha256Text(e.after) : undefined,
              ...(diff ? { diffText: diff } : {}),
              summary: `对话维护（${p.conversation.title || "会话"}）`,
            });
          },
        }),
        kbWriteGuardRoots: kbMounts.map((m) => m.root),
      };
      const kbPrompt = this.kbContextPrompt(kbMounts);
      if (kbPrompt) {
        base = {
          ...base,
          systemPromptAppend: [base.systemPromptAppend, kbPrompt].filter((s) => s && s.length > 0).join("\n\n"),
        };
      }
      // 审计读取工具（donger-audit）：内置审计智能体、技能工坊、平台进化官挂载。
      // viewer=发起用户，构造时闭包绑定——member 仅本人 / admin 全量，store L2 visible 兜底。
      if (
        p.agent?.id === BUILTIN_AUDITOR_AGENT_ID ||
        p.agent?.id === BUILTIN_SKILL_FORGE_AGENT_ID ||
        p.agent?.id === BUILTIN_SELF_IMPROVER_AGENT_ID
      ) {
        base = {
          ...base,
          auditTools: createAuditToolsServer({
            viewer: p.user,
            auditStore: this.deps.auditStore,
            conversationStore: this.deps.conversationStore,
          }),
        };
      }
      // agent 绑定了 git 仓库时注入 git 工具（donger-git）：CLI 工作区工具（reposRoot=
      // 会话 repos 目录，与后台物化共享）+ 平台 API 工具；共享智能体凭证桥按分享者现取（§2.5）
      if (p.agent && p.agent.gitRepositories.length > 0) {
        base = {
          ...base,
          gitPlatformTools: createGitPlatformToolsServer({
            user: p.user,
            agent: p.agent,
            credentialUserId: p.sharedAgentSkillOwner?.id,
            credentialSets: this.deps.credentialSets,
            reposRoot: join(context.runtimeDir, "repos"),
          }),
        };
      }
      if (p.noResume) {
        return { ...base, resume: undefined, sessionStore: undefined };
      }
      // 内置创作/构建智能体注入平台工具（write_skill / create_agent / finish_builder 等）
      const isBuiltinAuthor =
        p.agent?.id === BUILTIN_ASSIST_AGENT_ID ||
        p.agent?.id === BUILTIN_SKILL_FORGE_AGENT_ID ||
        p.agent?.id === AGENT_BUILDER_ID;
      if (!isBuiltinAuthor) return base;
      if (!this.deps.agentStore || !this.deps.installer || !this.deps.skillPackStore) {
        throw new ForbiddenError(
          "PLATFORM_TOOLS_MISSING",
          "平台工具未装配（agentStore/installer/skillPackStore）",
        );
      }
      return {
        ...base,
        platformTools: createPlatformToolsServer({
          user: p.user,
          agentStore: this.deps.agentStore,
          installer: this.deps.installer,
          packStore: this.deps.skillPackStore,
          credentialSets: this.deps.credentialSets,
          connectorStore: this.deps.connectorStore,
          skillRepoSync: this.deps.skillRepoSync,
          conversationStore: this.deps.conversationStore,
          conversationId: p.conversation.id,
          onBuilderFinish: () => this.builderFinished.add(p.conversation.id),
        }),
      };
    };
    let opts: RunOptions;
    try {
      opts = await prepareOnce();
    } catch (error) {
      // 准备阶段失败（仓库物化/平台工具装配等）此前零审计痕迹，复盘 P2-12 补记；
      // seq=-1 沿用 credential_prompt 的「执行前事件」约定。审计失败不阻断错误上抛。
      try {
        await this.deps.auditStore.record({
          conversationId: p.conversation.id,
          taskId: p.task.id,
          userId: p.user.id,
          seq: -1,
          type: "prepare_error",
          text: error instanceof Error ? error.message : String(error),
          recordedAt: new Date().toISOString(),
        });
      } catch {
        // ignore
      }
      throw error;
    }

    const innerApprovalResolver = makeApprovalResolver(
      this.deps.store,
      channel,
      p.threadId,
      gates,
      this.deps.commentStore,
    );
    // AskUserQuestion 交互桥：渠道未实现 requestUserInput 时 resolver 内部空答案降级
    const innerQuestionResolver = makeQuestionResolver(channel, p.threadId);
    // 等人工输入（审批/问询）期间打挂起标记：并发满时淘汰候选按「最早进入挂起」挑选
    const markPending = () => this.markTaskPending(p.user.id, p.conversation.id);
    const clearPending = () => this.clearTaskPending(p.user.id, p.conversation.id);
    const resolver: ApprovalResolver = async (req) => {
      markPending();
      try {
        return await innerApprovalResolver(req);
      } finally {
        clearPending();
      }
    };
    const questionResolver: QuestionResolver = async (req) => {
      markPending();
      try {
        return await innerQuestionResolver(req);
      } finally {
        clearPending();
      }
    };

    // 包装 runner 事件：捕获 session_init 的 sessionId + 审计落库（非阻塞）
    let capturedSessionId: string | undefined;
    let rawEvents: AsyncIterable<RunnerEvent>;

    // 尝试运行，如果 SDK session 过期则清空重试一次
    const SESSION_EXPIRED_RE = /No conversation found with session ID/i;
    let attemptOpts = opts;
    for (let attempt = 0; attempt < 2; attempt++) {
      rawEvents = this.deps.runner.run(
        { ...p.task, status: "running" },
        { ...attemptOpts, questionResolver },
        resolver,
      );
      // 预读第一个实际 SDK 事件判断是否 session 过期；llm_input 是审计事件，不能遮住 result 错误。
      const iterator = rawEvents[Symbol.asyncIterator]();
      const prefetched: RunnerEvent[] = [];
      let first = await iterator.next();
      while (
        !first.done &&
        (first.value.type === "llm_input" || first.value.type === "llm_output")
      ) {
        prefetched.push(first.value);
        first = await iterator.next();
      }
      if (first.done) {
        rawEvents = (async function* () {
          yield* prefetched;
        })();
        break;
      }
      if (
        attempt === 0 &&
        first.value &&
        first.value.type === "result" &&
        first.value.subtype === "error" &&
        first.value.error &&
        SESSION_EXPIRED_RE.test(first.value.error)
      ) {
        // session 过期：经 RuntimeManager 清空 sdkSessionId，重新 prepare（不带 resume）
        await this.deps.runtimeMgr.clearResume(p.conversation.id);
        p.conversation.sdkSessionId = "";
        attemptOpts = await prepareOnce();
        continue;
      }
      // 构造包含已读第一项的流
      rawEvents = (async function* () {
        yield* prefetched;
        yield first.value as RunnerEvent;
        for (;;) {
          const next = await iterator.next();
          if (next.done) return;
          yield next.value;
        }
      })();
      break;
    }
    const turnStartMs = Date.now();
    const taskId = p.task.id;
    const taskPrompt = p.task.prompt;
    let seq = 0;
    const toolStartMs = new Map<string, number>();
    const wrappedEvents = async function* (this: Orchestrator) {
      try {
        // 流首：user_message（仅审计，不入流）
        try {
          await this.deps.auditStore.record(
            userMessageAudit(taskPrompt, {
              conversationId: p.conversation.id,
              userId: p.user.id,
              taskId,
              seq,
              recordedAt: new Date().toISOString(),
            }),
          );
        } catch (e) {
          console.error("[orchestrator] 审计记录失败", e);
        }
        seq++;

        const stallMs = this.deps.turnStallTimeoutMs ?? 0;
        // 等用户作答 AskUserQuestion 是合法阻塞（AskUserQuestion 桥接挂起期间流上无事件），
        // 停摆判定对这类任务豁免——问询 resolver 超时降级必然 settle，豁免窗口有界。
        const isAwaitingUserInput = () => this.deps.runner.isAwaitingUserInput?.(taskId) ?? false;
        const guarded: AsyncIterable<RunnerEvent> =
          stallMs > 0
            ? guardStreamStall(
                rawEvents,
                stallMs,
                async () => {
                  console.error("[orchestrator] LLM 流停摆，看门狗中断本轮", p.conversation.id);
                  // 尽力留审计痕迹（seq=-1 = 执行前/外事件约定），错误沿 processMessage catch 收尾
                  try {
                    await this.deps.auditStore.record({
                      conversationId: p.conversation.id,
                      taskId,
                      userId: p.user.id,
                      seq: -1,
                      type: "result",
                      resultSubtype: "error",
                      text: `turn_stall: ${stallMs}ms 无事件，看门狗中断`,
                      recordedAt: new Date().toISOString(),
                    });
                  } catch {
                    // ignore
                  }
                },
                isAwaitingUserInput,
              )
            : rawEvents;
        for await (const e of guarded) {
          if (e.type === "session_init") capturedSessionId = e.sessionId;
          // 实时执行状态（SDK 事件推导，观测态）
          this.activityTracker.observe(p.conversation.id, e);
          // 先落审计再推送：历史（audit）永远 ≥ 实时流，按会话回放不缺事件；审计失败不阻塞推送
          if (e.type !== "text_delta" && e.type !== "thinking_delta") {
            const extra: { durationMs?: number; model?: string } = {};
            if (e.type === "tool_use") toolStartMs.set(e.toolUseId, Date.now());
            if (e.type === "tool_result") {
              const start = toolStartMs.get(e.toolUseId);
              if (start !== undefined) extra.durationMs = Date.now() - start;
            }
            if (e.type === "result") {
              extra.durationMs = Date.now() - turnStartMs;
              extra.model = opts.llm.model;
            }
            try {
              await this.deps.auditStore.record(
                toAuditEvent(
                  e,
                  {
                    conversationId: p.conversation.id,
                    userId: p.user.id,
                    taskId: taskId,
                    seq,
                    recordedAt: new Date().toISOString(),
                  },
                  extra,
                ),
              );
            } catch (err) {
              console.error("[orchestrator] 审计记录失败", err);
            }
            seq++;
          }
          yield e;
        }
      } finally {
        // 回合结束清除活动状态（result 事件已自清；此处兜底 abort/异常路径）
        this.activityTracker.end(p.conversation.id);
      }
    }.call(this);

    const last = await bridgeEvents(
      channel,
      p.conversation.id,
      wrappedEvents,
      p.silent ? undefined : this.deps.messageStore,
      p.quietResult === true,
      p.silent === true,
    );

    if (p.runController.signal.aborted) {
      return { aborted: true, ok: false, resultText: "" };
    }

    const ok = last?.type === "result" && last.subtype === "success";
    const error = last?.type === "result" && last.subtype === "error" ? last.error : undefined;

    // 用量统计：result 带 usage 就落一条（错误运行也落，subtype 无关）；失败仅日志
    if (last?.type === "result" && last.usage) {
      const u = last.usage;
      try {
        await this.deps.usageStore.record({
          taskId: p.task.id,
          userId: p.user.id,
          channelId: p.channelId,
          model: opts.llm.model,
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          cacheCreationInputTokens: u.cacheCreationInputTokens,
          cacheReadInputTokens: u.cacheReadInputTokens,
        });
      } catch (e) {
        console.error("[orchestrator] 用量记录失败", e);
      }
    }

    // 回写 sdkSessionId（经 RuntimeManager.commit）；title 仅首轮设置。内部轮（noResume）不回写
    if (!p.noResume && capturedSessionId && capturedSessionId !== p.conversation.sdkSessionId) {
      const wasFirstTurn = !p.conversation.sdkSessionId;
      await this.deps.runtimeMgr.commit(p.conversation.id, { sdkSessionId: capturedSessionId });
      p.conversation.sdkSessionId = capturedSessionId;
      if (wasFirstTurn) {
        await this.deps.conversationStore.update(p.conversation.id, {
          title: (p.titleText ?? p.task.prompt).slice(0, 30),
        });
      }
    }

    const resultText =
      last?.type === "result" ? (last.result ?? last.error ?? "(无结果)") : "(无结果)";
    // 自动学习（spec §10.3，M4）：kbAutoLearn 开启且绑库时异步沉淀，不阻塞响应、失败静默落审计
    this.maybeEnqueueAutoLearn(p, resultText, ok);
    return { aborted: false, ok, error, resultText };
  }

  /** 自动学习入队（条件过滤 + 异步；任何失败仅落 audit_events 静默） */
  private maybeEnqueueAutoLearn(
    p: {
      task: Task;
      user: User;
      conversation: Conversation;
      agent?: Agent;
    },
    resultText: string,
    ok: boolean,
  ): void {
    try {
      const libs = this.deps.kbLibraryStore;
      const revisions = this.deps.kbRevisionStore;
      const workspaceDir = this.deps.workspaceDir;
      const llm = this.deps.llm;
      if (!libs || !revisions || !workspaceDir || !llm) return;
      if (!ok || resultText.length === 0 || resultText === "(无结果)") return;
      if (p.agent?.kbAutoLearn !== true) return;
      const kbIds = p.agent.knowledgeBaseIds ?? [];
      if (kbIds.length === 0) return;
      // 候选库=调用者可管理的绑定库（异步取，避免阻塞返回）
      void (async () => {
        try {
          const actor = { id: p.user.id, role: p.user.role };
          const candidates: KbLibrary[] = [];
          for (const kbId of kbIds) {
            const lib = await libs.get(kbId);
            if (lib && canManageKb(lib, actor)) candidates.push(lib);
          }
          enqueueAutoLearn(
            {
              user: p.user,
              conversation: p.conversation,
              taskId: p.task.id,
              candidateKbs: candidates,
              workspaceDir,
              llm,
              revisionStore: revisions,
            },
            `${p.task.prompt}\n\n---\n\n${resultText}`,
          );
        } catch (e) {
          await this.recordAutoLearnError(p, e);
        }
      })();
    } catch (e) {
      void this.recordAutoLearnError(p, e);
    }
  }

  /** 学习链路失败落审计（seq=-1 执行外事件；静默不打扰用户） */
  private async recordAutoLearnError(
    p: { task: Task; user: User; conversation: Conversation },
    e: unknown,
  ): Promise<void> {
    try {
      await this.deps.auditStore.record({
        conversationId: p.conversation.id,
        taskId: p.task.id,
        userId: p.user.id,
        seq: -1,
        type: "kb_auto_learn_error",
        text: `知识库自动学习失败：${(e as Error).message}`,
        recordedAt: new Date().toISOString(),
      });
    } catch {
      // 审计失败不再传播
    }
  }

  /** abort 收尾：任务落 canceled 并通知前端（单轮与阶段循环复用）。 */
  private async finishCanceled(
    task: Task,
    conversation: Conversation,
  ): Promise<string | undefined> {
    await this.deps.store.updateStatus(task.id, "canceled").catch(() => {});
    this.deps.channel.pushResult?.(conversation.id, "error", "已停止生成");
    return conversation.id;
  }

  /** 收尾 task 上仍处于 running 的 flow step（runPhases 出口统一调用；保持 task 现有状态不变）。 */
  private async completeTaskSteps(task: Task): Promise<void> {
    if (!task.steps?.some((s) => s.status === "running")) return;
    const cur = await this.deps.store.get(task.id);
    if (!cur) return;
    await this.deps.store
      .updateStatus(task.id, cur.status, { steps: completeStep(task.steps) })
      .catch(() => {});
  }

  /** agent 链解析：配置的自定义 agent 不存在时兜底内置（启动时已 warn）。 */
  private async resolveChainAgent(
    configuredId: string | undefined,
    builtin: Agent,
  ): Promise<Agent> {
    if (!configuredId) return builtin;
    const custom = await this.deps.agentStore?.get(configuredId);
    if (!custom) {
      console.error(`[orchestrator] agentChain 配置的智能体不存在: ${configuredId}，回退内置`);
      return builtin;
    }
    return custom;
  }

  /**
   * dispatcher 路由轮（Task Flow 第一步）：走统一 runTurn 管道——
   * 事件静默落审计/usage，不推送渠道不持久化；不 resume、不回写 sdkSessionId。
   * 返回结构化路由决策；失败抛 RunnerError("DISPATCH_FAILED")。
   */
  /**
   * 当前用户可分发的 agent 集合（登记表事实源 = agents 表，读时渲染）。
   * 口径与 resolveAgentForUse 的 canUseAgent 一致：自有 ∪ 被分享 ∪ admin 全量。
   */
  private async listDispatchableAgents(user: User): Promise<Agent[]> {
    const store = this.deps.agentStore;
    if (!store) return [];
    const mine = await store.listByOwner(user.id);
    const shared = await store.listSharedWith(user.id);
    const all = user.role === "admin" ? await store.listAll() : [];
    const seen = new Set<string>();
    const out: Agent[] = [];
    for (const a of [...mine, ...shared, ...all]) {
      if (!seen.has(a.id)) {
        seen.add(a.id);
        out.push(a);
      }
    }
    return out;
  }

  private async runDispatcherTurn(p: {
    task: Task;
    user: User;
    conversation: Conversation;
    prompt: string;
    runController: AbortController;
  }): Promise<RoutingDecision> {
    if (!this.deps.agentStore) {
      throw new RunnerError("DISPATCH_FAILED", "任务分发未装配（agentStore 缺失）");
    }
    // 登记表「业务知识库」列：知识库 id → 名称（绑定库列名，spec §10.2）
    let kbNames: Map<string, string> | undefined;
    if (this.deps.kbLibraryStore) {
      kbNames = new Map(
        (await this.deps.kbLibraryStore.listAll()).map((l) => [l.id, l.name]),
      );
    }
    const dispatcher = buildDispatcherAgent(await this.listDispatchableAgents(p.user), kbNames);
    const r = await this.runTurn({
      task: { ...p.task, prompt: p.prompt },
      user: p.user,
      conversation: p.conversation,
      threadId: p.conversation.id,
      channelId: p.task.channelId,
      agent: dispatcher,
      skills: dispatcher.skills,
      noResume: true,
      silent: true,
      quietResult: true,
      runController: p.runController,
    });
    if (!r.ok) {
      throw new RunnerError("DISPATCH_FAILED", `任务分发失败：${r.error ?? "dispatcher 执行出错"}`);
    }
    try {
      return parseRoutingDecision(r.resultText);
    } catch (e) {
      throw new RunnerError("DISPATCH_FAILED", `任务分发失败：${(e as Error).message}`, e);
    }
  }

  /**
   * agent 绑定任务的生命周期：单执行轮 → done。
   * 危险操作的人工闸统一收口在工具审批门（GateRouter + canUseTool）；
   * 方案门/验收门已退役——流程性确认由 agent 按需经 skills/问询工具承载。
   */
  private async runPhases(p: {
    task: Task;
    user: User;
    conversation: Conversation;
    threadId: string;
    channelId: string;
    memoryAppend?: string;
    memory?: MemoryStore;
    agent: Agent;
    sharedAgentSkillOwner?: User;
    gitMaterializeItems?: RepositoryMaterializeItem[];
    /** 首轮提示词（如 builder 的缺口引导）；缺省用 task.prompt。不改写 task，保持原始任务入库/审计/标题 */
    firstTurnPrompt?: string;
    runController: AbortController;
    /** 用户显式选择的 LLM（消息级 modelRef） */
    modelRef?: string;
  }): Promise<string | undefined> {
    const { store, channel } = this.deps;
    await store.updateStatus(p.task.id, nextStatus("planning", "start"));
    await this.emitStageBanner(channel, p.conversation.id, p.threadId, "🔨 执行阶段");
    const r = await this.runTurn({
      // firstTurnPrompt 仅作首轮引导词注入；task.prompt 保持原文（入库/审计/标题不被污染）
      task: { ...p.task, prompt: p.firstTurnPrompt ?? p.task.prompt },
      user: p.user,
      conversation: p.conversation,
      threadId: p.threadId,
      channelId: p.channelId,
      memoryAppend: p.memoryAppend,
      skills: p.agent.skills,
      agent: p.agent,
      sharedAgentSkillOwner: p.sharedAgentSkillOwner,
      gitMaterializeItems: p.gitMaterializeItems,
      runController: p.runController,
      titleText: p.task.prompt,
      modelRef: p.modelRef,
    });

    if (r.aborted) return await this.finishCanceled(p.task, p.conversation);
    if (!r.ok) {
      await store.updateStatus(p.task.id, nextStatus("running", "fail"), { error: r.error });
      // 展示文案走友好映射，库存原始错误供诊断
      channel.pushResult?.(p.conversation.id, "error", friendlyRunnerError(r.error) || "任务失败");
      return p.conversation.id;
    }

    await store.updateStatus(p.task.id, nextStatus("running", "finish"));
    channel.pushResult?.(p.conversation.id, "success", r.resultText || "完成");
    if (p.memory) {
      p.memory.append({
        summary: p.task.prompt.slice(0, 40),
        detail: `prompt: ${p.task.prompt}\n结果: 成功\n${r.resultText}`,
      });
    }
    if ("finalizeCard" in channel && typeof channel.finalizeCard === "function") {
      await (channel as { finalizeCard: (id: string) => Promise<void> })
        .finalizeCard(p.threadId)
        .catch(() => {});
    }
    return p.conversation.id;
  }

  async handleMessage(msg: IncomingMessage): Promise<string | undefined> {
    const { conversationStore } = this.deps;

    // 用户解析：按通道决定 provider + externalId（统一走 identity 模型）。
    const user = await this.resolveUser(msg);

    // "/new" 命令：创建新会话
    if (msg.text.trim().toLowerCase() === "/new") {
      await conversationStore.create(user.id, msg.channelId, "新对话");
      await this.deps.channel.send(msg.threadId, { text: "✨ 已开启新对话" });
      this.deps.channel.pushResult?.(msg.threadId, "success", "已开启新对话");
      return;
    }

    // 解析会话：conversationId 不存在时从本地取 latest（不再网络请求）
    const conversationId =
      msg.conversationId ?? this.getLatestConversationId(user.id, msg.channelId);
    const conversation = conversationId
      ? ((await conversationStore.get(conversationId)) ??
        (await conversationStore.create(user.id, msg.channelId, msg.text.slice(0, 30))))
      : await conversationStore.create(user.id, msg.channelId, msg.text.slice(0, 30));

    // 并发控制（同会话串行）：busy 时入队，当前任务完成后自动依序处理
    if (this.isConversationBusy(conversation.id)) {
      return await this.enqueueMessage(user, msg, conversation);
    }
    return await this.runExclusive(user, msg, conversation);
  }

  /** 会话 busy 时把消息排入队列；超过上限仍拒绝。返回 conversationId。 */
  private async enqueueMessage(
    user: User,
    msg: IncomingMessage,
    conversation: Conversation,
  ): Promise<string> {
    const { channel } = this.deps;
    let queue = this.pendingQueues.get(conversation.id);
    if (!queue) {
      queue = [];
      this.pendingQueues.set(conversation.id, queue);
    }
    if (queue.length >= Orchestrator.MAX_QUEUED_PER_CONVERSATION) {
      const text = `⏳ 排队消息已达上限（${Orchestrator.MAX_QUEUED_PER_CONVERSATION} 条），请等当前任务完成后再发。`;
      await channel.send(msg.threadId, { text });
      channel.pushResult?.(conversation.id, "error", text);
      return conversation.id;
    }
    queue.push({ user, msg });
    const text = `⏳ 已排队：当前任务完成后自动处理（前方 ${queue.length - 1} 条）`;
    await channel.send(msg.threadId, { text });
    return conversation.id;
  }

  /** 独占执行一条消息：并发闸 → 处理 → 收尾（含接续处理同会话队列）。 */
  private async runExclusive(
    user: User,
    msg: IncomingMessage,
    conversation: Conversation,
  ): Promise<string | undefined> {
    const { channel } = this.deps;
    if (!this.checkUserLimit(user.id)) {
      // 满载：优先强制结束「最早进入挂起」的任务放行新任务；无挂起可淘汰才拒绝
      const victim = this.findEvictionCandidate(user.id);
      if (!victim) {
        const text = "⏳ 您的并发对话已达上限（10条），请等待部分对话完成后再发新消息。";
        await channel.send(msg.threadId, { text });
        channel.pushResult?.(conversation.id, "error", text);
        return conversation.id;
      }
      const canceledAt = new Date().toISOString();
      this.cancelConversation(victim.conversationId);
      // 立即释放额度（收口是异步的；unregisterActive 幂等，收口再删无害）
      this.unregisterActive(user.id, victim.conversationId);
      const reason = "并发已达上限，为执行新任务，系统自动结束了最早进入等待状态的任务。";
      const detail = [
        `任务内容：${victim.taskExcerpt}`,
        `开始时间：${victim.startedAt}`,
        `进入等待：${victim.pendingSince}`,
        `结束时间：${canceledAt}`,
      ].join("\n");
      await channel.send(msg.threadId, { text: `⚠️ ${reason}\n${detail}` });
      // SSE 弹窗（Web）：推给新任务所在会话，展示被强制结束任务的详情
      channel.pushEvictionNotice?.(conversation.id, {
        taskId: victim.taskId,
        conversationId: victim.conversationId,
        taskExcerpt: victim.taskExcerpt,
        startedAt: victim.startedAt,
        pendingSince: victim.pendingSince ?? canceledAt,
        canceledAt,
      });
    }

    this.markBusy(conversation.id, "");
    this.registerActive(user.id, {
      taskId: "",
      conversationId: conversation.id,
      taskExcerpt: (msg.text || conversation.title || "").slice(0, 60),
      startedAt: new Date().toISOString(),
    });
    const runController = new AbortController();
    this.abortControllers.set(conversation.id, runController);
    try {
      return await this.processMessage(user, msg, conversation, runController);
    } finally {
      this.abortControllers.delete(conversation.id);
      this.unmarkBusy(conversation.id);
      this.unregisterActive(user.id, conversation.id);
      // builder 补建完成（finish_builder）→ 原任务自动重派：复用会话排队机制接续执行
      if (this.builderFinished.delete(conversation.id)) {
        const original = this.builderOriginalPrompts.get(conversation.id);
        this.builderBoundAt.delete(conversation.id);
        if (original) {
          this.builderOriginalPrompts.delete(conversation.id);
          let queue = this.pendingQueues.get(conversation.id);
          if (!queue) {
            queue = [];
            this.pendingQueues.set(conversation.id, queue);
          }
          queue.push({
            user,
            msg: { ...msg, text: original, builderFromTaskId: msg.builderFromTaskId },
          });
        }
      }
      this.dispatchQueue(conversation.id);
    }
  }

  /** 当前任务结束后的接续：同会话队列非空则取出下一条继续独占执行。 */
  private dispatchQueue(conversationId: string): void {
    const queue = this.pendingQueues.get(conversationId);
    const next = queue?.shift();
    if (!next) {
      this.pendingQueues.delete(conversationId);
      return;
    }
    // 重新解析会话：排队期间 agentId 可能已被绑定（如 builder 转入）
    void (async () => {
      try {
        const conversation =
          (await this.deps.conversationStore.get(conversationId)) ??
          (await this.deps.conversationStore.create(
            next.user.id,
            next.msg.channelId,
            next.msg.text.slice(0, 30),
          ));
        await this.runExclusive(next.user, next.msg, conversation);
      } catch (e) {
        console.error("[orchestrator] 排队消息处理失败", e);
      }
    })();
  }

  /** 消息处理主体（在 runExclusive 的并发闸内执行；原 handleMessage 逻辑）。 */
  private async processMessage(
    user: User,
    msg: IncomingMessage,
    conversation: Conversation,
    runController: AbortController,
  ): Promise<string | undefined> {
    const { store, conversationStore, channel } = this.deps;

    // 入口解析（统一对话入口模型）：显式绑定 → direct；否则 task-flow（dispatcher 路由）
    let entry = resolveEntry(conversation, this.deps.agentChain);
    let agent: Agent | undefined;
    let sharedAgentSkillOwner: User | undefined;
    let gitMaterializeItems: RepositoryMaterializeItem[] | undefined;

    // builder 绑定闲置超时自愈：用户放弃补建（未调 finish_builder）后，绑定不得永久劫持会话。
    // 超过上限仍未完成 → 自动解绑，本条消息回归正常分发（重启丢失绑定时刻时从本条消息重新计时）。
    const builderAgentId = this.deps.agentChain?.builderAgentId ?? AGENT_BUILDER_ID;
    if (entry.flow === "direct" && entry.agentId === builderAgentId) {
      const boundAt = this.builderBoundAt.get(conversation.id) ?? Date.now();
      if (Date.now() - boundAt > Orchestrator.BUILDER_BIND_TIMEOUT_MS) {
        await conversationStore.update(conversation.id, { agentId: "" });
        conversation.agentId = "";
        this.builderBoundAt.delete(conversation.id);
        this.builderOriginalPrompts.delete(conversation.id);
        entry = resolveEntry(conversation, this.deps.agentChain);
        const text = "⏱ Agent Builder 补建会话已超时结束；本条消息将按正常任务分发处理。";
        await channel.send(msg.threadId, { text });
      } else {
        this.builderBoundAt.set(conversation.id, boundAt);
      }
    }

    if (entry.flow === "direct") {
      const r = await this.resolveAgentForUse(entry.agentId, user);
      if (r.gitBlocked) {
        await channel.send(msg.threadId, { text: r.gitBlocked });
        channel.pushResult?.(conversation.id, "error", r.gitBlocked);
        return;
      }
      ({ agent, sharedAgentSkillOwner, gitMaterializeItems } = r);
    }

    let task: Task | undefined;
    const _capturedConversationId = conversation.id;
    try {
      let memory: MemoryStore | undefined;
      try {
        memory = new MemoryStore(join(user.homeDir, "knowledge_base", "user"));
      } catch {
        memory = undefined;
      }

      const now = new Date().toISOString();
      // 附件路径按本轮 cwd 相对化注入（与 runtime-manager 的 runtimeDir 规则一致）；
      // cwd 此时尚未创建也没关系——仅用于 path.relative 计算
      const attachmentCwd = runtimeDir(
        user.homeDir,
        agent ? "agents" : "sessions",
        agent ? agent.id : conversation.id,
        "workspace",
      );
      task = {
        id: crypto.randomUUID(),
        channelId: msg.channelId,
        threadId: msg.threadId,
        requesterId: msg.requesterId,
        prompt: appendDefaultSkill(
          appendMentions(appendMessageFiles(msg.text, msg.files, attachmentCwd), msg.mentions),
          agent?.defaultSkill,
        ),
        status: "created",
        skillChain: [],
        // builder 自动重派的消息：串联回触发补建的原 task
        ...(msg.builderFromTaskId ? { builderFromTaskId: msg.builderFromTaskId } : {}),
        createdAt: now,
        updatedAt: now,
      };
      await store.create(task);
      // 回填淘汰候选表的 taskId（registerActive 时任务尚未创建）
      const activeEntry = this.userActiveTasks.get(user.id)?.get(conversation.id);
      if (activeEntry) activeEntry.taskId = task.id;

      // 任务分发（P1）：会话未绑定 agent 且装配了 agentStore → 经 dispatcher 路由（Task Flow 第一步）
      let firstTurnPrompt: string | undefined;
      let steps: FlowStep[] = task.steps ?? [];
      if (!conversation.agentId && this.deps.agentStore) {
        steps = beginStep(steps, {
          role: "dispatcher",
          agentId: this.deps.agentChain?.dispatcherAgentId ?? "builtin-dispatcher",
          conversationId: conversation.id,
          startedAt: new Date().toISOString(),
        });
        const routing = await this.runDispatcherTurn({
          task,
          user,
          conversation,
          prompt: task.prompt,
          runController,
        });
        steps = completeStep(steps, { summary: routing.rationale });
        // "none" = 登记表无匹配智能体：任务类输入转入 agent-builder 对话式补建；chat 类输入走对话兜底
        if (routing.agentId === "none" && !isChatTaskType(routing.taskType)) {
          // 不失败：会话绑定 builder（持久化，后续消息直连 builder 多轮澄清，不再过 dispatcher）
          const builder = await this.resolveChainAgent(
            this.deps.agentChain?.builderAgentId,
            AGENT_BUILDER_AGENT,
          );
          await store.updateStatus(task.id, nextStatus("created", "plan"), {
            agentId: builder.id,
            routingRationale: routing.rationale,
            steps: beginStep(steps, {
              role: "builder",
              agentId: builder.id,
              conversationId: conversation.id,
              startedAt: new Date().toISOString(),
            }),
          });
          await conversationStore.update(conversation.id, { agentId: builder.id });
          conversation.agentId = builder.id;
          this.builderBoundAt.set(conversation.id, Date.now());
          // 记录原任务供干跑验证与自动重派（后续澄清轮的 task.prompt 已不是原文）
          this.builderOriginalPrompts.set(conversation.id, task.prompt);
          await channel.send(msg.threadId, {
            text: `🧩 未找到匹配的执行智能体（${routing.rationale}），已转入 Agent Builder，协助你补建该能力：`,
          });
          agent = builder;
          // 引导词经 firstTurnPrompt 注入；task.prompt 保持用户原文（入库/审计/记忆/标题不被污染）
          firstTurnPrompt = builderCreationAsk(task.prompt, routing.rationale);
        } else if (routing.agentId !== "none") {
          let r: Awaited<ReturnType<typeof this.resolveAgentForUse>>;
          try {
            r = await this.resolveAgentForUse(routing.agentId, user);
          } catch (e) {
            const code = (e as { code?: string })?.code;
            // dispatcher 偶发输出无效 id（名称/技能名）：转译为可行动的失败提示而非裸 404
            if (code === "AGENT_NOT_FOUND") {
              await store.updateStatus(task.id, "failed", {
                error: `分发异常：dispatcher 选择了不存在的智能体 id "${routing.agentId}"，请重试`,
                steps: completeStep(steps, { status: "failed", summary: "路由到不存在 id" }),
              });
              const text = `⚠️ 分发异常：dispatcher 选择了一个不存在的智能体（${routing.agentId}），请重发任务重试。`;
              await channel.send(msg.threadId, { text });
              channel.pushResult?.(conversation.id, "error", text);
              return conversation.id;
            }
            // 权限不足（路由表登记了该 agent，但当前用户无权使用）：降级为可行动提示而非硬失败
            if (code === "AGENT_FORBIDDEN") {
              await store.updateStatus(task.id, "failed", {
                error: `分发异常：路由到智能体 ${routing.agentId} 但当前用户无权使用（属主未分享）`,
                steps: completeStep(steps, { status: "failed", summary: "路由目标无权使用" }),
              });
              const text = `⚠️ 已找到能处理该任务的智能体，但你当前无权使用它。可请智能体属主开启分享授权，或联系管理员；之后重发任务即可。`;
              await channel.send(msg.threadId, { text });
              channel.pushResult?.(conversation.id, "error", text);
              return conversation.id;
            }
            throw e;
          }
          if (r.gitBlocked) {
            throw new RunnerError("DISPATCH_FAILED", `路由的智能体仓库未授权：${r.gitBlocked}`);
          }
          ({ agent, sharedAgentSkillOwner, gitMaterializeItems } = r);
          steps = beginStep(steps, {
            role: "agent",
            agentId: agent.id,
            conversationId: conversation.id,
            startedAt: new Date().toISOString(),
          });
          await store.updateStatus(task.id, "planning", {
            agentId: routing.agentId,
            routingRationale: routing.rationale,
            steps,
          });
          // 路由反馈（V9）：明确告知任务被谁接了；带任务短 id 供 tasks files 衔接
          await channel.send(msg.threadId, {
            text: `📨 已分派给「${agent.name}」（任务 ${task.id.slice(0, 8)}）：${routing.rationale}`,
          });
        } else {
          // 闲聊兜底（chat step）：默认内置 chat agent，可经 agentChain.chatAgentId 替换
          const chatAgent = await this.resolveChainAgent(
            this.deps.agentChain?.chatAgentId,
            BUILTIN_CHAT_AGENT,
          );
          steps = beginStep(steps, {
            role: "chat",
            agentId: chatAgent.id,
            conversationId: conversation.id,
            startedAt: new Date().toISOString(),
          });
          await store.updateStatus(task.id, nextStatus("created", "plan"), {
            agentId: chatAgent.id,
            steps,
          });
          agent = chatAgent;
        }
      } else {
        // direct 入口（会话显式绑定 agent）
        if (agent) {
          steps = beginStep(steps, {
            role: "agent",
            agentId: agent.id,
            conversationId: conversation.id,
            startedAt: new Date().toISOString(),
          });
        }
        await store.updateStatus(task.id, nextStatus("created", "plan"), { steps });
      }
      task.steps = steps;

      // 会话权限模式预热：无人值守触发（定时/钩子/工作流）强制按变更前问询，
      // full_access 仅限交互式会话；会话未手动覆盖时跟随智能体默认。
      // registry 供 runner canUseTool 每次工具调用现取（轮内 PATCH 切换立即生效）。
      this.permissionModes.set(
        conversation.id,
        resolvePermissionMode(
          msg.unattended === true ? DEFAULT_PERMISSION_MODE : conversation.permissionMode,
          agent?.defaultPermissionMode,
        ),
      );

      // 记忆注入：拼出 memory 上下文，交 RuntimeManager.prepare 与默认 prompt 合并
      let memoryAppend: string | undefined;
      if (memory) {
        const hits = memory.search(task.prompt).slice(0, 5);
        if (hits.length > 0) {
          const memCtx = hits.map((h) => `- ${h.summary}`).join("\n");
          memoryAppend = `## 相关记忆\n${memCtx}`;
        }
      }

      // 凭证缺失预检：agent 勾选 + 连接器 headers 引用。共享智能体按分享者（属主）
      // 用户空间解析（specs/2026-09-20-agent-share-tighten-and-duplicate-design.md §2.5）；
      // 自有智能体按当前用户解析，未配置 → 三选问询（继续执行/暂停/重试）。
      const credentialOwnerId = sharedAgentSkillOwner?.id ?? user.id;
      const connectorCodes = agent?.connectorIds?.length
        ? await this.deps.runtimeMgr.connectorCredentialCodes(credentialOwnerId, agent.connectorIds)
        : [];
      const credentialCodes = [...new Set([...(agent?.credentials ?? []), ...connectorCodes])];
      // 共享场景跳过三选问询：被分享者无法替属主补配凭证，缺失由 prepare 的 _MISSING 兜底
      if (credentialCodes.length > 0 && !sharedAgentSkillOwner) {
        const currentTask: Task = task;
        const proceed = await promptMissingCredentials({
          task: currentTask,
          user,
          conversation,
          channel,
          threadId: msg.threadId,
          codes: credentialCodes,
          inspect: (userId, codes) => this.deps.runtimeMgr.inspectCredentials(userId, codes),
          updateTask: async (status, patch) => {
            await store.updateStatus(currentTask.id, status as TaskStatus, patch);
          },
          recordAudit: async (missing) => {
            await this.deps.auditStore.record({
              conversationId: conversation.id,
              taskId: currentTask.id,
              userId: user.id,
              seq: -1, // 预检事件（轮内 seq 从 0 起算）；-1 = 执行前问询
              type: "credential_prompt",
              text: `缺少凭证：${missing.map((m) => m.name).join("、")}`,
              toolInput: JSON.stringify({ codes: missing }),
              recordedAt: new Date().toISOString(),
            });
          },
        });
        if (!proceed) return conversation.id;
      }

      // agent 绑定任务（显式选择或 dispatcher 路由）→ 单执行轮生命周期；
      // chat 兜底走单轮（无阶段横幅），其余走 runPhases
      if (agent && steps[steps.length - 1]?.role !== "chat") {
        const convId = await this.runPhases({
          task,
          user,
          conversation,
          threadId: msg.threadId,
          channelId: msg.channelId,
          memoryAppend,
          memory,
          agent,
          sharedAgentSkillOwner,
          gitMaterializeItems,
          firstTurnPrompt,
          runController,
          modelRef: msg.modelRef,
        });
        await this.completeTaskSteps(task);
        return convId;
      }

      await store.updateStatus(task.id, nextStatus("planning", "start"));
      const r = await this.runTurn({
        task,
        user,
        conversation,
        threadId: msg.threadId,
        channelId: msg.channelId,
        memoryAppend,
        agent,
        sharedAgentSkillOwner,
        gitMaterializeItems,
        runController,
        modelRef: msg.modelRef,
      });

      if (r.aborted) return await this.finishCanceled(task, conversation);

      await store.updateStatus(
        task.id,
        r.ok ? nextStatus("running", "finish") : nextStatus("running", "fail"),
        {
          error: r.error,
          steps: completeStep(task.steps ?? [], {
            status: r.ok ? "done" : "failed",
            summary: r.resultText.slice(0, 200),
          }),
        },
      );

      // 非流式渠道：成功后回复完成标记
      if (!channel.streaming && r.ok) {
        await channel.send(msg.threadId, { text: "✅" });
      }

      // 记忆沉淀
      if (memory) {
        memory.append({
          summary: task.prompt.slice(0, 40),
          detail: `prompt: ${task.prompt}\n结果: ${r.ok ? "成功" : "失败"}\n${r.resultText}`,
        });
      }

      // 钉钉卡片：标记完成（streaming=false）
      if ("finalizeCard" in channel && typeof channel.finalizeCard === "function") {
        await (channel as { finalizeCard: (id: string) => Promise<void> })
          .finalizeCard(msg.threadId)
          .catch(() => {});
      }
      return conversation.id;
    } catch (err) {
      if (runController.signal.aborted) {
        if (task) return await this.finishCanceled(task, conversation);
        return;
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("[orchestrator] 处理失败:", errMsg);
      if (task) {
        try {
          await this.deps.store.updateStatus(task.id, "failed", {
            error: errMsg,
            steps: completeStep(task.steps ?? [], {
              status: "failed",
              summary: errMsg.slice(0, 200),
            }),
          });
        } catch {
          // ignore
        }
      }
      try {
        const display = friendlyRunnerError(errMsg);
        await this.deps.channel.send(msg.threadId, { text: `❌ 处理出错：${display}` });
        this.deps.channel.pushResult?.(conversation.id, "error", `❌ 处理出错：${display}`);
      } catch {
        // ignore
      }
    } finally {
      this.abortControllers.delete(conversation.id);
      // 无论成功失败，都解除会话繁忙 + 用户活跃计数
      this.unmarkBusy(conversation.id);
      this.unregisterActive(user.id, conversation.id);
    }
  }
}
