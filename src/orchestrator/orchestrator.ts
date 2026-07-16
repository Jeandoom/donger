import { join } from "node:path";
import { appendDefaultSkill, type Agent } from "../domain/agent.js";
import { canUseAgent } from "../domain/agent-policy.js";
import { toAuditEvent, userMessageAudit } from "../domain/audit.js";
import type { GateRouter } from "../domain/gate-router.js";
import { appendMessageFiles } from "../domain/message-files.js";
import { nextStatus } from "../domain/task-state-machine.js";
import type { IncomingMessage, RunnerEvent, Task } from "../domain/types.js";
import type { User } from "../domain/user.js";
import { MemoryStore } from "../memory/memory-store.js";
import type { AgentRunner } from "../ports/agent-runner.js";
import type { AgentShareStore } from "../ports/agent-share-store.js";
import type { AgentStore } from "../ports/agent-store.js";
import type { AuditStore } from "../ports/audit-store.js";
import type { Channel } from "../ports/channel.js";
import type { ConversationStore } from "../ports/conversation-store.js";
import type { CredentialStore } from "../ports/credential-store.js";
import type { MessageStore } from "../ports/message-store.js";
import type { RepositoryMaterializeItem } from "../ports/repository-materializer.js";
import type { TaskStore } from "../ports/task-store.js";
import type { UsageStore } from "../ports/usage-store.js";
import type { UserStore } from "../ports/user-store.js";
import { ForbiddenError, NotFoundError } from "../util/errors.js";
import { makeApprovalResolver } from "./approval-flow.js";
import { makeCredentialResolver } from "./credential-flow.js";
import { bridgeEvents } from "./event-bridge.js";
import type { GitAccessGate } from "./git-access-gate.js";
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

  /** 更新最新会话缓存 */
  private updateLatestConvCache(userId: string, channelId: string, conversationId: string): void {
    if (!this.latestConvCache) {
      this.latestConvCache = new Map();
    }
    this.latestConvCache.set(`${userId}:${channelId}`, conversationId);
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

  async handleMessage(msg: IncomingMessage): Promise<void> {
    const { store, userStore, conversationStore, gates, runner, channel } = this.deps;

    // 用户解析：按通道决定 provider + externalId（统一走 identity 模型）。
    const user = await this.resolveUser(msg);

    // "/new" 命令：创建新会话
    if (msg.text.trim().toLowerCase() === "/new") {
      await conversationStore.create(user.id, msg.channelId, "新对话");
      await channel.send(msg.threadId, { text: "✨ 已开启新对话" });
      return;
    }

    // 解析会话：conversationId 不存在时从本地取 latest（不再网络请求）
    const conversationId =
      msg.conversationId ?? this.getLatestConversationId(user.id, msg.channelId);
    const conversation = conversationId
      ? ((await conversationStore.get(conversationId)) ??
        (await conversationStore.create(user.id, msg.channelId, msg.text.slice(0, 30))))
      : await conversationStore.create(user.id, msg.channelId, msg.text.slice(0, 30));

    // 显式 agent 解析（M13）：会话绑了 agentId 时旁路 Planner，校验使用权限
    let agent: Agent | undefined;
    let gitMaterializeItems: RepositoryMaterializeItem[] | undefined;
    if (conversation.agentId) {
      if (!this.deps.agentStore) {
        throw new ForbiddenError("AGENT_STORE_MISSING", "agent 存储未装配");
      }
      agent = await this.deps.agentStore.get(conversation.agentId);
      if (!agent) {
        throw new NotFoundError("AGENT_NOT_FOUND", `智能体不存在: ${conversation.agentId}`);
      }
      const granted = this.deps.agentShareStore
        ? await this.deps.agentShareStore.isGranted(agent.id, user.id)
        : false;
      if (!canUseAgent(agent, user, granted)) {
        throw new ForbiddenError("AGENT_FORBIDDEN", "无权使用该智能体");
      }
      if (this.deps.gitAccessGate && agent.gitRepositories.length > 0) {
        const gitAccess = await this.deps.gitAccessGate.check(user, agent);
        if (!gitAccess.ready) {
          await channel.send(msg.threadId, { text: "请先完成智能体所需 Git 仓库授权后再对话。" });
          return;
        }
        gitMaterializeItems = gitAccess.materializeItems;
      }
    }

    // 并发控制：
    //  同一会话：串行排队（后到的排队等前序完成）
    //  同一用户：最多 MAX_CONCURRENT_PER_USER 并行（超限提示）
    if (this.isConversationBusy(conversation.id)) {
      await channel.send(msg.threadId, { text: "⏳ 该会话正在处理上一条消息，请稍候…" });
      return;
    }
    if (!this.checkUserLimit(user.id)) {
      await channel.send(msg.threadId, {
        text: "⏳ 您的并发对话已达上限（10条），请等待部分对话完成后再发新消息。",
      });
      return;
    }

    // 标记会话繁忙 + 用户活跃计数
    this.markBusy(conversation.id, "");
    this.registerActive(user.id);
    const runController = new AbortController();
    this.abortControllers.set(conversation.id, runController);

    let task: Task | undefined;
    const capturedConversationId = conversation.id;
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

      await store.updateStatus(task.id, nextStatus("created", "plan"));

      // 记忆注入：拼出 memory 上下文，交 RuntimeManager.prepare 与默认 prompt 合并
      let memoryAppend: string | undefined;
      if (memory) {
        const hits = memory.search(task.prompt).slice(0, 5);
        if (hits.length > 0) {
          const memCtx = hits.map((h) => `- ${h.summary}`).join("\n");
          memoryAppend = `## 相关记忆\n${memCtx}`;
        }
      }

      let { runOptions: opts } = await this.deps.runtimeMgr.prepare(user, conversation, {
        systemPromptAppend: memoryAppend,
        abortSignal: runController.signal,
        agent,
        gitMaterializeItems,
      });

      // 凭证门：缺失必需凭证 → 经对话收集到用户保险柜 → 重 prepare 拿最新 credentialsEnv
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
        opts = (
          await this.deps.runtimeMgr.prepare(user, conversation, {
            systemPromptAppend: memoryAppend,
            abortSignal: runController.signal,
            agent,
            gitMaterializeItems,
          })
        ).runOptions;
      }

      await store.updateStatus(task.id, nextStatus("planning", "start"));
      const resolver = makeApprovalResolver(store, channel, msg.threadId, gates);

      // 包装 runner 事件：捕获 session_init 的 sessionId + 审计落库（非阻塞）
      let capturedSessionId: string | undefined;
      let rawEvents: AsyncIterable<RunnerEvent>;

      // 尝试运行，如果 SDK session 过期则清空重试一次
      const SESSION_EXPIRED_RE = /No conversation found with session ID/i;
      let attemptOpts = opts;
      for (let attempt = 0; attempt < 2; attempt++) {
        rawEvents = runner.run({ ...task, status: "running" }, attemptOpts, resolver);
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
          await this.deps.runtimeMgr.clearResume(conversation.id);
          const refreshed = await this.deps.runtimeMgr.prepare(user, conversation, {
            systemPromptAppend: memoryAppend,
            abortSignal: runController.signal,
            agent,
            gitMaterializeItems,
          });
          attemptOpts = refreshed.runOptions;
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
      const taskId = task.id;
      const taskPrompt = task.prompt;
      let seq = 0;
      const toolStartMs = new Map<string, number>();
      const wrappedEvents = async function* (this: Orchestrator) {
        // 流首：user_message（仅审计，不入流）
        try {
          await this.deps.auditStore.record(
            userMessageAudit(taskPrompt, {
              conversationId: conversation.id,
              userId: user.id,
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
                  conversationId: conversation.id,
                  userId: user.id,
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
        conversation.id,
        wrappedEvents,
        this.deps.messageStore,
      );

      if (runController.signal.aborted) {
        await store.updateStatus(task.id, "canceled");
        channel.pushResult?.(conversation.id, "error", "已停止生成");
        return;
      }

      const ok = last?.type === "result" && last.subtype === "success";
      const error = last?.type === "result" && last.subtype === "error" ? last.error : undefined;
      await store.updateStatus(
        task.id,
        ok ? nextStatus("running", "finish") : nextStatus("running", "fail"),
        { error },
      );

      // 用量统计：result 带 usage 就落一条（错误运行也落，subtype 无关）；失败仅日志
      if (last?.type === "result" && last.usage) {
        const u = last.usage;
        try {
          await this.deps.usageStore.record({
            taskId: task.id,
            userId: user.id,
            channelId: msg.channelId,
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

      // 回写 sdkSessionId（经 RuntimeManager.commit）
      if (capturedSessionId && capturedSessionId !== conversation.sdkSessionId) {
        await this.deps.runtimeMgr.commit(conversation.id, { sdkSessionId: capturedSessionId });
        // title 更新仍走 conversationStore（RuntimeManager M1 不接管 title）
        if (!conversation.sdkSessionId) {
          await conversationStore.update(conversation.id, { title: task.prompt.slice(0, 30) });
        }
      }

      // 非流式渠道：成功后回复完成标记
      if (!channel.streaming && ok) {
        await channel.send(msg.threadId, { text: "✅" });
      }

      // 记忆沉淀
      if (memory) {
        const resultText =
          last?.type === "result" ? (last.result ?? last.error ?? "(无结果)") : "(无结果)";
        memory.append({
          summary: task.prompt.slice(0, 40),
          detail: `prompt: ${task.prompt}\n结果: ${ok ? "成功" : "失败"}\n${resultText}`,
        });
      }

      // 钉钉卡片：标记完成（streaming=false）
      if ("finalizeCard" in channel && typeof channel.finalizeCard === "function") {
        await (channel as { finalizeCard: (id: string) => Promise<void> })
          .finalizeCard(msg.threadId)
          .catch(() => {});
      }
    } catch (err) {
      if (runController.signal.aborted) {
        if (task) {
          await this.deps.store.updateStatus(task.id, "canceled").catch(() => {});
        }
        this.deps.channel.pushResult?.(conversation.id, "error", "已停止生成");
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
