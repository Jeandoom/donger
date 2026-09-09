import { join } from "node:path";
import { type Agent, appendDefaultSkill } from "../domain/agent.js";
import { canUseAgent } from "../domain/agent-policy.js";
import { toAuditEvent, userMessageAudit } from "../domain/audit.js";
import type { Conversation } from "../domain/conversation.js";
import { type AgentChainConfig, resolveEntry } from "../domain/entry.js";
import type { GateRouter } from "../domain/gate-router.js";
import { appendMessageFiles } from "../domain/message-files.js";
import { isChatTaskType, parseRoutingDecision, type RoutingDecision } from "../domain/routing.js";
import { beginStep, completeStep, type FlowStep } from "../domain/task-flow.js";
import { nextStatus } from "../domain/task-state-machine.js";
import type { IncomingMessage, RunnerEvent, Task, TaskStatus } from "../domain/types.js";
import type { User } from "../domain/user.js";
import { MemoryStore } from "../memory/memory-store.js";
import type { AgentRunner, RunOptions } from "../ports/agent-runner.js";
import type { AgentShareStore } from "../ports/agent-share-store.js";
import type { AgentStore } from "../ports/agent-store.js";
import type { AuditStore } from "../ports/audit-store.js";
import type { Channel } from "../ports/channel.js";
import type { CommentStore } from "../ports/comment-store.js";
import type { ConversationStore } from "../ports/conversation-store.js";
import type { CredentialSetStore } from "../ports/credential-set-store.js";
import type { MessageStore } from "../ports/message-store.js";
import type { RepositoryMaterializeItem } from "../ports/repository-materializer.js";
import type { SkillInstaller } from "../ports/skill-installer.js";
import type { SkillPackStore } from "../ports/skill-pack-store.js";
import type { TaskStore } from "../ports/task-store.js";
import type { UsageStore } from "../ports/usage-store.js";
import type { UserStore } from "../ports/user-store.js";
import { ForbiddenError, NotFoundError, RunnerError } from "../util/errors.js";
import { AGENT_BUILDER_AGENT, AGENT_BUILDER_ID, builderCreationAsk } from "./agent-builder.js";
import { makeApprovalResolver } from "./approval-flow.js";
import { BUILTIN_ASSIST_AGENT, BUILTIN_ASSIST_AGENT_ID } from "./assist-agent.js";
import { BUILTIN_CHAT_AGENT } from "./chat-agent.js";
import { buildDispatcherAgent } from "./dispatch-flow.js";
import { bridgeEvents } from "./event-bridge.js";
import type { GitAccessGate } from "./git-access-gate.js";
import { createGitPlatformToolsServer } from "./git-platform-tools.js";
import { promptMissingCredentials } from "./missing-credentials-flow.js";
import {
  acceptAsk,
  designFirstAsk,
  designRejected,
  executeAfterDesign,
  executeRejected,
  resolvePhases,
} from "./phase-flow.js";
import { createPlatformToolsServer } from "./platform-tools.js";
import type { RuntimeManager } from "./runtime-manager.js";

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
  gitAccessGate?: GitAccessGate;
  /** AI 生成子模块：技能安装器（assist 会话写技能用） */
  installer?: SkillInstaller;
  /** AI 生成子模块：技能 pack 存储（assist 会话列技能用） */
  skillPackStore?: SkillPackStore;
  /** 任务评论存储（T17.3：验收门评论落库）；未装配则评论仅随决议透传不落库 */
  commentStore?: CommentStore;
  /** agent 链配置（D2）：task-flow 各环节可替换为用户自建 agent，缺省系统内置 */
  agentChain?: AgentChainConfig;
}

export class Orchestrator {
  // conversationId → taskId（该会话当前活跃任务，用于独立并发控制）
  private readonly busyConversations = new Map<string, string>();
  // userId → 活跃任务数（并发限制）
  private readonly userActiveCounts = new Map<string, number>();
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
    return true;
  }

  /** 检查用户并发数是否超限 */
  private checkUserLimit(userId: string): boolean {
    const count = this.userActiveCounts.get(userId) ?? 0;
    return count < Orchestrator.MAX_CONCURRENT_PER_USER;
  }

  /** 注册用户活跃任务 */
  private registerActive(userId: string): void {
    const count = this.userActiveCounts.get(userId) ?? 0;
    this.userActiveCounts.set(userId, count + 1);
  }

  /** 注销用户活跃任务 */
  private unregisterActive(userId: string): void {
    const count = this.userActiveCounts.get(userId) ?? 0;
    this.userActiveCounts.set(userId, Math.max(0, count - 1));
  }

  /** 检查会话是否繁忙 */
  private isConversationBusy(conversationId: string): boolean {
    return this.busyConversations.has(conversationId);
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
    if (agentId === AGENT_BUILDER_ID) return { agent: AGENT_BUILDER_AGENT };
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
      const gitAccess = await this.deps.gitAccessGate.check(user, agent);
      if (!gitAccess.ready) {
        return {
          agent,
          sharedAgentSkillOwner,
          gitBlocked: "请先完成智能体所需 Git 仓库授权后再对话。",
        };
      }
      return { agent, sharedAgentSkillOwner, gitMaterializeItems: gitAccess.materializeItems };
    }
    return { agent, sharedAgentSkillOwner };
  }

  /**
   * 单轮执行：prepare（含凭证 env / skills 覆盖）→ session 过期重试 → 事件桥 → 用量统计 → sessionId 回写。
   * 不做状态流转与收尾通知（调用方负责），供单轮路径与三段式阶段循环复用。
   */
  private async runTurn(p: {
    task: Task;
    user: User;
    conversation: Conversation;
    threadId: string;
    channelId: string;
    memoryAppend?: string;
    /** 覆盖 prepare 得到的 skills（阶段循环按 phase 指定）；缺省用 prepare 结果 */
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
  }): Promise<{ aborted: boolean; ok: boolean; error?: string; resultText: string }> {
    const { channel, gates } = this.deps;
    const prepareOnce = async (): Promise<RunOptions> => {
      const { runOptions } = await this.deps.runtimeMgr.prepare(p.user, p.conversation, {
        systemPromptAppend: p.memoryAppend,
        abortSignal: p.runController.signal,
        agent: p.agent,
        sharedAgentSkillOwner: p.sharedAgentSkillOwner,
        gitMaterializeItems: p.gitMaterializeItems,
      });
      let base = p.skills ? { ...runOptions, skills: p.skills } : runOptions;
      // agent 绑定了 git 仓库时注入 git 平台元数据工具（donger-git，只读；凭证按访问者现取）
      if (p.agent && p.agent.gitRepositories.length > 0) {
        base = {
          ...base,
          gitPlatformTools: createGitPlatformToolsServer({
            user: p.user,
            agent: p.agent,
            credentialSets: this.deps.credentialSets,
          }),
        };
      }
      if (p.noResume) {
        return { ...base, resume: undefined, sessionStore: undefined };
      }
      // 内置创作/构建智能体注入平台工具（write_skill / create_agent / finish_builder 等）
      const isBuiltinAuthor =
        p.agent?.id === BUILTIN_ASSIST_AGENT_ID || p.agent?.id === AGENT_BUILDER_ID;
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
          conversationStore: this.deps.conversationStore,
          conversationId: p.conversation.id,
          onBuilderFinish: () => this.builderFinished.add(p.conversation.id),
        }),
      };
    };
    const opts = await prepareOnce();

    const resolver = makeApprovalResolver(
      this.deps.store,
      channel,
      p.threadId,
      gates,
      this.deps.commentStore,
    );

    // 包装 runner 事件：捕获 session_init 的 sessionId + 审计落库（非阻塞）
    let capturedSessionId: string | undefined;
    let rawEvents: AsyncIterable<RunnerEvent>;

    // 尝试运行，如果 SDK session 过期则清空重试一次
    const SESSION_EXPIRED_RE = /No conversation found with session ID/i;
    let attemptOpts = opts;
    for (let attempt = 0; attempt < 2; attempt++) {
      rawEvents = this.deps.runner.run({ ...p.task, status: "running" }, attemptOpts, resolver);
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

      for await (const e of rawEvents) {
        if (e.type === "session_init") capturedSessionId = e.sessionId;
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
    return { aborted: false, ok, error, resultText };
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
    const dispatcher = buildDispatcherAgent(await this.listDispatchableAgents(p.user));
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
   * agent 绑定任务的三段式生命周期（spec §5）：
   * design（可选）→ 方案门 → execute → accept（可选）→ 验收门 → done。
   * 门在阶段边界直调 channel.requestApproval；驳回用同 task 续跑（resume 链经 runTurn 逐轮回写）。
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
    requiresDesign: boolean;
    /** 首个执行轮的提示词（如 builder 的缺口引导）；缺省用 task.prompt。不改写 task，保持原始任务入库/审计/标题 */
    firstTurnPrompt?: string;
    runController: AbortController;
  }): Promise<string | undefined> {
    const { store, channel, gates } = this.deps;
    const plan = resolvePhases(p.agent.skills, p.requiresDesign);
    const hasDesign = plan.steps[0]?.phase === "design";
    const execStep = plan.steps.find((s) => s.phase === "execute");
    const acceptStep = plan.steps.find((s) => s.phase === "accept");
    if (!execStep) {
      // 契约上 resolvePhases 恒有 execute；防御性兜底
      await store.updateStatus(p.task.id, "failed", { error: "阶段解析缺失 execute" });
      return p.conversation.id;
    }
    const turn = (prompt: string, skills: string[], quietTurn = false) =>
      this.runTurn({
        task: { ...p.task, prompt },
        user: p.user,
        conversation: p.conversation,
        threadId: p.threadId,
        channelId: p.channelId,
        memoryAppend: p.memoryAppend,
        skills,
        agent: p.agent,
        sharedAgentSkillOwner: p.sharedAgentSkillOwner,
        gitMaterializeItems: p.gitMaterializeItems,
        runController: p.runController,
        quietResult: quietTurn,
        titleText: p.task.prompt,
      });
    const finishTask = async (ok: boolean, error?: string, resultText = "") => {
      await store.updateStatus(
        p.task.id,
        ok ? nextStatus("running", "finish") : nextStatus("running", "fail"),
        { error },
      );
      // acceptanceGate 路径的轮次全部静默，回合终态由此统一收束（前端/CLI 的回合在此结束）
      if (plan.acceptanceGate) {
        channel.pushResult?.(
          p.conversation.id,
          ok ? "success" : "error",
          resultText || error || (ok ? "完成" : "失败"),
        );
      }
      if (!channel.streaming && ok) await channel.send(p.threadId, { text: "✅" });
      if (p.memory) {
        p.memory.append({
          summary: p.task.prompt.slice(0, 40),
          detail: `prompt: ${p.task.prompt}\n结果: ${ok ? "成功" : "失败"}\n${resultText}`,
        });
      }
      if ("finalizeCard" in channel && typeof channel.finalizeCard === "function") {
        await (channel as { finalizeCard: (id: string) => Promise<void> })
          .finalizeCard(p.threadId)
          .catch(() => {});
      }
      return p.conversation.id;
    };

    // —— 方案设计 + 方案门（requiresDesign=true）——
    if (hasDesign) {
      await store.updateStatus(p.task.id, "planning", { phase: "design" });
      await channel.send(p.threadId, {
        text: `📋 方案设计阶段（skills: ${plan.steps[0]?.skills.join("、") || "无，按系统提示出方案"}）`,
      });
      let prompt = designFirstAsk(p.task.prompt);
      for (;;) {
        // 方案轮非末轮：静默 result（后续还有 execute/accept）
        const r = await turn(prompt, plan.steps[0]?.skills ?? [], true);
        if (r.aborted) return await this.finishCanceled(p.task, p.conversation);
        if (!r.ok) {
          await store.updateStatus(p.task.id, "failed", { error: r.error });
          return p.conversation.id;
        }
        await store.updateStatus(p.task.id, nextStatus("planning", "request_approval"), {
          phase: "design",
          pendingGate: {
            gateId: "design",
            title: `审批门：${gates.getGate("design")?.description ?? "方案设计确认"}`,
            requestedAt: new Date().toISOString(),
          },
        });
        const decision = await channel.requestApproval(p.threadId, {
          gateId: "design",
          title: `审批门：${gates.getGate("design")?.description ?? "方案设计确认"}`,
          summary: r.resultText,
        });
        if (decision.approved) {
          await store.updateStatus(p.task.id, nextStatus("awaiting_approval", "resume"), {
            pendingGate: undefined,
          });
          break;
        }
        await store.updateStatus(p.task.id, nextStatus("awaiting_approval", "redesign"), {
          phase: "design",
          pendingGate: undefined,
        });
        prompt = designRejected(decision.reason ?? "未提供原因");
      }
    }

    // —— 执行 + 自验 + 验收门（驳回重跑循环）——
    let rejectionCount = p.task.rejectionCount ?? 0;
    let lastRejectionReason: string | undefined;
    for (let round = 0; ; round++) {
      if (round === 0 && !hasDesign) {
        await store.updateStatus(p.task.id, nextStatus("planning", "start"));
      }
      await store.updateStatus(p.task.id, "running", { phase: "execute" });
      if (round === 0) {
        await channel.send(p.threadId, {
          text: `🔨 执行阶段（skills: ${execStep.skills.join("、") || "默认"}）`,
        });
      }
      const execPrompt =
        round === 0
          ? hasDesign
            ? executeAfterDesign()
            : (p.firstTurnPrompt ?? p.task.prompt)
          : executeRejected(lastRejectionReason ?? "未提供原因");
      // 验收门存在时 execute/accept 轮都静默：回合贯穿到验收门决议，不在中途提前结束
      const re = await turn(execPrompt, execStep.skills, plan.acceptanceGate);
      if (re.aborted) return await this.finishCanceled(p.task, p.conversation);
      if (!re.ok) {
        await store.updateStatus(p.task.id, nextStatus("running", "fail"), { error: re.error });
        return p.conversation.id;
      }

      let summary = re.resultText;
      if (acceptStep) {
        await store.updateStatus(p.task.id, "running", { phase: "accept" });
        await channel.send(p.threadId, {
          text: `🔍 验收阶段（skills: ${acceptStep.skills.join("、") || "默认"}）`,
        });
        const ra = await turn(acceptAsk(), acceptStep.skills, true);
        if (ra.aborted) return await this.finishCanceled(p.task, p.conversation);
        if (!ra.ok) {
          await store.updateStatus(p.task.id, nextStatus("running", "fail"), { error: ra.error });
          return p.conversation.id;
        }
        summary = ra.resultText;
      }

      if (!plan.acceptanceGate) {
        return await finishTask(true, undefined, summary);
      }
      await store.updateStatus(p.task.id, nextStatus("running", "request_approval"), {
        phase: "accept",
        pendingGate: {
          gateId: "acceptance",
          title: `审批门：${gates.getGate("acceptance")?.description ?? "验收确认"}`,
          requestedAt: new Date().toISOString(),
        },
      });
      const decision = await channel.requestApproval(p.threadId, {
        gateId: "acceptance",
        title: `审批门：${gates.getGate("acceptance")?.description ?? "验收确认"}`,
        summary,
      });
      if (decision.approved) {
        await store.updateStatus(p.task.id, nextStatus("awaiting_approval", "resume"), {
          pendingGate: undefined,
        });
        return await finishTask(true, undefined, summary);
      }
      rejectionCount += 1;
      lastRejectionReason = decision.reason ?? "";
      await store.updateStatus(p.task.id, nextStatus("awaiting_approval", "resume"), {
        rejectionCount,
      });
    }
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
      const text = "⏳ 您的并发对话已达上限（10条），请等待部分对话完成后再发新消息。";
      await channel.send(msg.threadId, { text });
      channel.pushResult?.(conversation.id, "error", text);
      return conversation.id;
    }

    this.markBusy(conversation.id, "");
    this.registerActive(user.id);
    const runController = new AbortController();
    this.abortControllers.set(conversation.id, runController);
    try {
      return await this.processMessage(user, msg, conversation, runController);
    } finally {
      this.abortControllers.delete(conversation.id);
      this.unmarkBusy(conversation.id);
      this.unregisterActive(user.id);
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
      task = {
        id: crypto.randomUUID(),
        channelId: msg.channelId,
        threadId: msg.threadId,
        requesterId: msg.requesterId,
        prompt: appendDefaultSkill(appendMessageFiles(msg.text, msg.files), agent?.defaultSkill),
        status: "created",
        skillChain: [],
        // builder 自动重派的消息：串联回触发补建的原 task
        ...(msg.builderFromTaskId ? { builderFromTaskId: msg.builderFromTaskId } : {}),
        createdAt: now,
        updatedAt: now,
      };
      await store.create(task);

      // 任务分发（P1）：会话未绑定 agent 且装配了 agentStore → 经 dispatcher 路由（Task Flow 第一步）
      let requiresDesign = false;
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
          requiresDesign = routing.requiresDesign;
          steps = beginStep(steps, {
            role: "agent",
            agentId: agent.id,
            conversationId: conversation.id,
            startedAt: new Date().toISOString(),
          });
          await store.updateStatus(task.id, "planning", {
            agentId: routing.agentId,
            requiresDesign: routing.requiresDesign,
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

      // 记忆注入：拼出 memory 上下文，交 RuntimeManager.prepare 与默认 prompt 合并
      let memoryAppend: string | undefined;
      if (memory) {
        const hits = memory.search(task.prompt).slice(0, 5);
        if (hits.length > 0) {
          const memCtx = hits.map((h) => `- ${h.summary}`).join("\n");
          memoryAppend = `## 相关记忆\n${memCtx}`;
        }
      }

      // 凭证缺失预检：agent 勾选但当前用户未配置 → 三选问询（继续执行/暂停/重试）。
      // code 按执行者用户空间解析：owner 勾选只声明需求，访问者用自己的同名凭证。
      if (agent?.credentials?.length) {
        const currentTask: Task = task;
        const proceed = await promptMissingCredentials({
          task: currentTask,
          user,
          conversation,
          channel,
          threadId: msg.threadId,
          codes: agent.credentials,
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

      // agent 绑定任务（显式选择或 dispatcher 路由）→ 三段式生命周期；
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
          requiresDesign,
          firstTurnPrompt,
          runController,
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
        await this.deps.channel.send(msg.threadId, { text: `❌ 处理出错：${errMsg}` });
        this.deps.channel.pushResult?.(conversation.id, "error", `❌ 处理出错：${errMsg}`);
      } catch {
        // ignore
      }
    } finally {
      this.abortControllers.delete(conversation.id);
      // 无论成功失败，都解除会话繁忙 + 用户活跃计数
      this.unmarkBusy(conversation.id);
      this.unregisterActive(user.id);
    }
  }
}
