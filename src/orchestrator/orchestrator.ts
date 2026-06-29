import type { Conversation } from "../domain/conversation.js";
import type { GateRouter } from "../domain/gate-router.js";
import type { Plan, Planner } from "../domain/planner.js";
import { nextStatus } from "../domain/task-state-machine.js";
import type { IncomingMessage, RunnerEvent, Task } from "../domain/types.js";
import type { User } from "../domain/user.js";
import { MemoryStore } from "../memory/memory-store.js";
import type { AgentRunner, RunOptions } from "../ports/agent-runner.js";
import type { Channel } from "../ports/channel.js";
import type { ConversationStore } from "../ports/conversation-store.js";
import type { TaskStore } from "../ports/task-store.js";
import type { UserStore } from "../ports/user-store.js";
import { makeApprovalResolver } from "./approval-flow.js";
import { bridgeEvents } from "./event-bridge.js";

export interface OrchestratorRunOpts {
  resume?: string;
}

export interface OrchestratorDeps {
  store: TaskStore;
  userStore: UserStore;
  conversationStore: ConversationStore;
  planner: Planner;
  gates: GateRouter;
  runner: AgentRunner;
  channel: Channel;
  runOptsFor: (
    task: Task,
    plan: Plan,
    user: User,
    opts: OrchestratorRunOpts,
  ) => Promise<RunOptions> | RunOptions;
}

export class Orchestrator {
  private readonly busyThreads = new Set<string>();

  constructor(private readonly deps: OrchestratorDeps) {}

  async handleMessage(msg: IncomingMessage): Promise<void> {
    const { store, userStore, conversationStore, planner, gates, runner, channel } = this.deps;

    if (this.busyThreads.has(msg.threadId)) {
      await channel.send(msg.threadId, { text: "⏳ 正在处理上一条消息，请稍候…" });
      return;
    }
    this.busyThreads.add(msg.threadId);

    let task: Task | undefined;
    try {
      const user = await userStore.getOrCreate(msg.requesterId, msg.requesterId);

      // "/new" 命令：创建新会话
      if (msg.text.trim().toLowerCase() === "/new") {
        await conversationStore.create(user.id, msg.channelId, "新对话");
        await channel.send(msg.threadId, { text: "✨ 已开启新对话" });
        return;
      }

      // 会话解析
      let conversation: Conversation;
      if (msg.conversationId) {
        const found = await conversationStore.get(msg.conversationId);
        if (found) {
          conversation = found;
        } else {
          conversation = await conversationStore.create(
            user.id,
            msg.channelId,
            msg.text.slice(0, 30),
          );
        }
      } else {
        const latest = await conversationStore.getLatest(user.id, msg.channelId);
        conversation =
          latest ?? (await conversationStore.create(user.id, msg.channelId, msg.text.slice(0, 30)));
      }

      // per-user 记忆
      let memory: MemoryStore | undefined;
      try {
        memory = new MemoryStore(`${user.homeDir}/memory`);
      } catch {
        memory = undefined;
      }

      const plan = planner.plan(msg.text);
      const now = new Date().toISOString();
      task = {
        id: crypto.randomUUID(),
        channelId: msg.channelId,
        threadId: msg.threadId,
        requesterId: msg.requesterId,
        prompt: msg.text,
        status: "created",
        skillChain: plan.skills,
        createdAt: now,
        updatedAt: now,
      };
      await store.create(task);

      await store.updateStatus(task.id, nextStatus("created", "plan"));
      const baseOpts = await this.deps.runOptsFor(task, plan, user, {
        resume: conversation.sdkSessionId || undefined,
      });

      // 记忆注入
      let systemPromptAppend = baseOpts.systemPromptAppend;
      if (memory) {
        const hits = memory.search(task.prompt).slice(0, 5);
        if (hits.length > 0) {
          const memCtx = hits.map((h) => `- ${h.summary}`).join("\n");
          systemPromptAppend = `${systemPromptAppend ?? ""}\n\n## 相关记忆\n${memCtx}`;
        }
      }
      const opts: RunOptions = { ...baseOpts, systemPromptAppend };

      await store.updateStatus(task.id, nextStatus("planning", "start"));
      const resolver = makeApprovalResolver(store, channel, msg.threadId, gates);

      // 包装 runner 事件：捕获 session_init 的 sessionId
      let capturedSessionId: string | undefined;
      const rawEvents = runner.run({ ...task, status: "running" }, opts, resolver);
      const wrappedEvents = (async function* () {
        for await (const e of rawEvents) {
          if (e.type === "session_init") capturedSessionId = e.sessionId;
          yield e;
        }
      })();

      const last = await bridgeEvents(channel, msg.threadId, wrappedEvents);

      const ok = last?.type === "result" && last.subtype === "success";
      const error = last?.type === "result" && last.subtype === "error" ? last.error : undefined;
      await store.updateStatus(
        task.id,
        ok ? nextStatus("running", "finish") : nextStatus("running", "fail"),
        { error },
      );

      // 回写 sdkSessionId
      if (capturedSessionId && capturedSessionId !== conversation.sdkSessionId) {
        await conversationStore.update(conversation.id, {
          sdkSessionId: capturedSessionId,
          title: !conversation.sdkSessionId ? task.prompt.slice(0, 30) : conversation.title,
        });
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
      this.busyThreads.delete(msg.threadId);
    }
  }
}
