import { join } from "node:path";
import { type Agent, appendDefaultSkill } from "../domain/agent.js";
import { canUseAgent } from "../domain/agent-policy.js";
import { toAuditEvent, userMessageAudit } from "../domain/audit.js";
import type { Conversation } from "../domain/conversation.js";
import type { GateRouter } from "../domain/gate-router.js";
import { appendMessageFiles } from "../domain/message-files.js";
import { nextStatus } from "../domain/task-state-machine.js";
import type { IncomingMessage, RunnerEvent, Task } from "../domain/types.js";
import type { User } from "../domain/user.js";
import { MemoryStore } from "../memory/memory-store.js";
import type { AgentRunner, RunOptions } from "../ports/agent-runner.js";
import type { AgentShareStore } from "../ports/agent-share-store.js";
import type { AgentStore } from "../ports/agent-store.js";
import type { AuditStore } from "../ports/audit-store.js";
import type { Channel } from "../ports/channel.js";
import type { CommentStore } from "../ports/comment-store.js";
import type { ConversationStore } from "../ports/conversation-store.js";
import type { CredentialStore } from "../ports/credential-store.js";
import type { MessageStore } from "../ports/message-store.js";
import type { RepositoryMaterializeItem } from "../ports/repository-materializer.js";
import type { SkillInstaller } from "../ports/skill-installer.js";
import type { SkillPackStore } from "../ports/skill-pack-store.js";
import type { TaskStore } from "../ports/task-store.js";
import type { UsageStore } from "../ports/usage-store.js";
import type { UserStore } from "../ports/user-store.js";
import { ForbiddenError, NotFoundError, RunnerError } from "../util/errors.js";
import { makeApprovalResolver } from "./approval-flow.js";
import { BUILTIN_ASSIST_AGENT, BUILTIN_ASSIST_AGENT_ID } from "./assist-agent.js";
import { makeCredentialResolver } from "./credential-flow.js";
import { dispatchTask } from "./dispatch-flow.js";
import { bridgeEvents } from "./event-bridge.js";
import type { GitAccessGate } from "./git-access-gate.js";
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
  /** 用户凭证保险柜：凭证门收集到的值落此，运行时注入 env */
  credentialStore: CredentialStore;
  /** 智能体存储（M13；缺省=不支持显式 agent，会话 agentId 必须为空） */
  agentStore?: AgentStore;
  /** 智能体分享/授权存储 */
  agentShareStore?: AgentShareStore;
  gitAccessGate?: GitAccessGate;
  /** 任务管理知识库根目录；未装配则任务分发关闭（行为与 P1 之前一致） */
  kbDir?: string;
  /** AI 生成子模块：技能安装器（assist 会话写技能用） */
  installer?: SkillInstaller;
  /** AI 生成子模块：技能 pack 存储（assist 会话列技能用） */
  skillPackStore?: SkillPackStore;
  /** 任务评论存储（T17.3：验收门评论落库）；未装配则评论仅随决议透传不落库 */
  commentStore?: CommentStore;
}

export class Orchestrator {
  // conversationId → taskId（该会话当前活跃任务，用于独立并发控制）
  private readonly busyConversations = new Map<string, string>();
  // userId → 活跃任务数（并发限制）
  private readonly userActiveCounts = new Map<string, number>();
  private readonly abortControllers = new Map<string, AbortController>();
  /** 同用户最大并行任务数 */
  private static readonly MAX_CONCURRENT_PER_USER = 10;

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
      const base = p.skills ? { ...runOptions, skills: p.skills } : runOptions;
      if (p.agent?.id !== BUILTIN_ASSIST_AGENT_ID) return base;
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
          kbDir: this.deps.kbDir,
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
        yield e; // 先推流（保证审计失败不阻塞推送）
        if (e.type === "text_delta") continue;
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
    }.call(this);

    const last = await bridgeEvents(
      channel,
      p.conversation.id,
      wrappedEvents,
      this.deps.messageStore,
      p.quietResult === true,
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

    // 回写 sdkSessionId（经 RuntimeManager.commit）；title 仅首轮设置
    if (capturedSessionId && capturedSessionId !== p.conversation.sdkSessionId) {
      const wasFirstTurn = !p.conversation.sdkSessionId;
      await this.deps.runtimeMgr.commit(p.conversation.id, { sdkSessionId: capturedSessionId });
      p.conversation.sdkSessionId = capturedSessionId;
      if (wasFirstTurn) {
        await this.deps.conversationStore.update(p.conversation.id, {
          title: p.task.prompt.slice(0, 30),
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
      });
    const finishTask = async (ok: boolean, error?: string, resultText = "") => {
      await store.updateStatus(
        p.task.id,
        ok ? nextStatus("running", "finish") : nextStatus("running", "fail"),
        { error },
      );
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
      await channel.send(p.threadId, { text: "📋 方案设计阶段" });
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
        });
        const decision = await channel.requestApproval(p.threadId, {
          gateId: "design",
          title: `审批门：${gates.getGate("design")?.description ?? "方案设计确认"}`,
          summary: r.resultText,
        });
        if (decision.approved) {
          await store.updateStatus(p.task.id, nextStatus("awaiting_approval", "resume"));
          break;
        }
        await store.updateStatus(p.task.id, nextStatus("awaiting_approval", "redesign"), {
          phase: "design",
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
      if (round === 0) await channel.send(p.threadId, { text: "🔨 执行阶段" });
      const execPrompt =
        round === 0
          ? hasDesign
            ? executeAfterDesign()
            : p.task.prompt
          : executeRejected(lastRejectionReason ?? "未提供原因");
      const re = await turn(execPrompt, execStep.skills, acceptStep !== undefined);
      if (re.aborted) return await this.finishCanceled(p.task, p.conversation);
      if (!re.ok) {
        await store.updateStatus(p.task.id, nextStatus("running", "fail"), { error: re.error });
        return p.conversation.id;
      }

      let summary = re.resultText;
      if (acceptStep) {
        await store.updateStatus(p.task.id, "running", { phase: "accept" });
        await channel.send(p.threadId, { text: "🔍 验收阶段" });
        const ra = await turn(acceptAsk(), acceptStep.skills);
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
      });
      const decision = await channel.requestApproval(p.threadId, {
        gateId: "acceptance",
        title: `审批门：${gates.getGate("acceptance")?.description ?? "验收确认"}`,
        summary,
      });
      if (decision.approved) {
        await store.updateStatus(p.task.id, nextStatus("awaiting_approval", "resume"));
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
    const { store, conversationStore, runner, channel } = this.deps;

    // 用户解析：按通道决定 provider + externalId（统一走 identity 模型）。
    const user = await this.resolveUser(msg);

    // "/new" 命令：创建新会话
    if (msg.text.trim().toLowerCase() === "/new") {
      await conversationStore.create(user.id, msg.channelId, "新对话");
      await channel.send(msg.threadId, { text: "✨ 已开启新对话" });
      channel.pushResult?.(msg.threadId, "success", "已开启新对话");
      return;
    }

    // 解析会话：conversationId 不存在时从本地取 latest（不再网络请求）
    const conversationId =
      msg.conversationId ?? this.getLatestConversationId(user.id, msg.channelId);
    const conversation = conversationId
      ? ((await conversationStore.get(conversationId)) ??
        (await conversationStore.create(user.id, msg.channelId, msg.text.slice(0, 30))))
      : await conversationStore.create(user.id, msg.channelId, msg.text.slice(0, 30));

    // 显式 agent 解析（M13）：会话绑了 agentId 时旁路 Planner 与 dispatcher
    let agent: Agent | undefined;
    let sharedAgentSkillOwner: User | undefined;
    let gitMaterializeItems: RepositoryMaterializeItem[] | undefined;
    if (conversation.agentId) {
      const r = await this.resolveAgentForUse(conversation.agentId, user);
      if (r.gitBlocked) {
        await channel.send(msg.threadId, { text: r.gitBlocked });
        channel.pushResult?.(conversation.id, "error", r.gitBlocked);
        return;
      }
      ({ agent, sharedAgentSkillOwner, gitMaterializeItems } = r);
    }

    // 并发控制：
    //  同一会话：串行排队（后到的排队等前序完成）
    //  同一用户：最多 MAX_CONCURRENT_PER_USER 并行（超限提示）
    if (this.isConversationBusy(conversation.id)) {
      const text = "⏳ 该会话正在处理上一条消息，请稍候…";
      await channel.send(msg.threadId, { text });
      channel.pushResult?.(conversation.id, "error", text);
      return;
    }
    if (!this.checkUserLimit(user.id)) {
      const text = "⏳ 您的并发对话已达上限（10条），请等待部分对话完成后再发新消息。";
      await channel.send(msg.threadId, { text });
      channel.pushResult?.(conversation.id, "error", text);
      return;
    }

    // 标记会话繁忙 + 用户活跃计数
    this.markBusy(conversation.id, "");
    this.registerActive(user.id);
    const runController = new AbortController();
    this.abortControllers.set(conversation.id, runController);

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
        createdAt: now,
        updatedAt: now,
      };
      await store.create(task);

      // 任务分发（P1）：会话未绑定 agent 且装配了 kbDir → 经 dispatcher 路由
      let requiresDesign = false;
      if (!conversation.agentId && this.deps.kbDir) {
        const routing = await dispatchTask({
          runner,
          runtimeMgr: this.deps.runtimeMgr,
          user,
          conversation,
          prompt: task.prompt,
          kbDir: this.deps.kbDir,
          abortSignal: runController.signal,
        });
        // "none" = 登记表无匹配智能体：任务类输入告知缺口；chat 类输入走闲聊兜底（普通对话直答）
        if (routing.agentId === "none" && routing.taskType !== "chat") {
          await store.updateStatus(task.id, "failed", {
            error: `未找到匹配的执行智能体：${routing.rationale}`,
            routingRationale: routing.rationale,
          });
          const text = `🤷 暂无能处理该任务的智能体：${routing.rationale}\n可在「任务管理知识库」登记新智能体后重试；也可让 AI 生成助手协助创建对应智能体。`;
          await channel.send(msg.threadId, { text });
          channel.pushResult?.(conversation.id, "error", text);
          return conversation.id;
        }
        if (routing.agentId !== "none") {
          const r = await this.resolveAgentForUse(routing.agentId, user);
          if (r.gitBlocked) {
            throw new RunnerError("DISPATCH_FAILED", `路由的智能体仓库未授权：${r.gitBlocked}`);
          }
          ({ agent, sharedAgentSkillOwner, gitMaterializeItems } = r);
          requiresDesign = routing.requiresDesign;
          await store.updateStatus(task.id, "planning", {
            agentId: routing.agentId,
            requiresDesign: routing.requiresDesign,
            routingRationale: routing.rationale,
          });
          // 路由反馈（V9）：dispatch 静默 30s+，明确告知任务被谁接了
          await channel.send(msg.threadId, {
            text: `📨 已分派给「${agent.name}」：${routing.rationale}`,
          });
        } else {
          // 闲聊兜底：不绑 agent，按普通对话直答
          await store.updateStatus(task.id, nextStatus("created", "plan"));
        }
      } else {
        await store.updateStatus(task.id, nextStatus("created", "plan"));
      }

      // 记忆注入：拼出 memory 上下文，交 RuntimeManager.prepare 与默认 prompt 合并
      let memoryAppend: string | undefined;
      if (memory) {
        const hits = memory.search(task.prompt).slice(0, 5);
        if (hits.length > 0) {
          const memCtx = hits.map((h) => `- ${h.summary}`).join("\n");
          memoryAppend = `## 相关记忆\n${memCtx}`;
        }
      }

      // 凭证门：缺失必需凭证 → 经对话收集到用户保险柜（runTurn 内 prepare 会带入最新 credentialsEnv）
      const missingItems = await this.deps.runtimeMgr.missingCredentialItems(user.id);
      if (missingItems.length > 0) {
        const credResolver = makeCredentialResolver(store, channel, msg.threadId);
        const provided = await credResolver({
          taskId: task.id,
          conversationId: conversation.id,
          items: missingItems,
        });
        for (const [k, v] of Object.entries(provided)) {
          if (v) await this.deps.credentialStore.setValue(user.id, k, v);
        }
      }

      // agent 绑定任务（显式选择或 dispatcher 路由）→ 三段式生命周期
      if (agent) {
        return await this.runPhases({
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
          runController,
        });
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
        { error: r.error },
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
          await this.deps.store.updateStatus(task.id, "failed", { error: errMsg });
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
