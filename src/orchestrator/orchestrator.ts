import type { GateRouter } from "../domain/gate-router.js";
import type { Plan, Planner } from "../domain/planner.js";
import { nextStatus } from "../domain/task-state-machine.js";
import type { IncomingMessage, Task } from "../domain/types.js";
import type { User } from "../domain/user.js";
import { MemoryStore } from "../memory/memory-store.js";
import type { AgentRunner, RunOptions } from "../ports/agent-runner.js";
import type { Channel } from "../ports/channel.js";
import type { TaskStore } from "../ports/task-store.js";
import type { UserStore } from "../ports/user-store.js";
import { makeApprovalResolver } from "./approval-flow.js";
import { bridgeEvents } from "./event-bridge.js";

export interface OrchestratorDeps {
  store: TaskStore;
  userStore: UserStore;
  planner: Planner;
  gates: GateRouter;
  runner: AgentRunner;
  channel: Channel;
  runOptsFor: (task: Task, plan: Plan, user: User) => Promise<RunOptions> | RunOptions;
}

/**
 * 编排核心（per-user 隔离版）。
 * - 解析用户 → per-user memory + workspace
 * - busy lock、收到确认、通用对话、错误捕获、记忆飞轮
 */
export class Orchestrator {
  private readonly busyThreads = new Set<string>();

  constructor(private readonly deps: OrchestratorDeps) {}

  async handleMessage(msg: IncomingMessage): Promise<void> {
    const { store, userStore, planner, gates, runner, channel } = this.deps;

    if (this.busyThreads.has(msg.threadId)) {
      await channel.send(msg.threadId, { text: "⏳ 正在处理上一条消息，请稍候…" });
      return;
    }
    this.busyThreads.add(msg.threadId);

    let task: Task | undefined;
    try {
      // 非 streaming 渠道才发"收到确认"（streaming 渠道直接流式回复）
      if (!channel.streaming) {
        await channel.send(msg.threadId, { text: "👋 收到，处理中…" });
      }

      // 解析用户（首次自动创建 + homeDir 初始化）
      const user = await userStore.getOrCreate(msg.requesterId, msg.requesterId);

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
      const baseOpts = await this.deps.runOptsFor(task, plan, user);

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
      const last = await bridgeEvents(
        channel,
        msg.threadId,
        runner.run({ ...task, status: "running" }, opts, resolver),
      );

      const ok = last?.type === "result" && last.subtype === "success";
      const error = last?.type === "result" && last.subtype === "error" ? last.error : undefined;
      await store.updateStatus(
        task.id,
        ok ? nextStatus("running", "finish") : nextStatus("running", "fail"),
        { error },
      );

      // 记忆沉淀（per-user）
      if (memory) {
        const resultText =
          last?.type === "result" ? (last.result ?? last.error ?? "(无结果)") : "(无结果)";
        memory.append({
          summary: task.prompt.slice(0, 40),
          detail: `prompt: ${task.prompt}\n结果: ${ok ? "成功" : "失败"}\n${resultText}`,
        });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("[orchestrator] 处理失败:", errMsg);
      if (task) {
        try {
          await this.deps.store.updateStatus(task.id, "failed", { error: errMsg });
        } catch {
          // 标记 failed 也失败则忽略
        }
      }
      try {
        await this.deps.channel.send(msg.threadId, { text: `❌ 处理出错：${errMsg}` });
      } catch {
        // channel 也挂了则无能为力
      }
    } finally {
      this.busyThreads.delete(msg.threadId);
    }
  }
}
