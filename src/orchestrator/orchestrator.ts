import type { GateRouter } from "../domain/gate-router.js";
import type { Plan, Planner } from "../domain/planner.js";
import { nextStatus } from "../domain/task-state-machine.js";
import type { IncomingMessage, RunnerEvent, Task } from "../domain/types.js";
import type { AgentRunner, RunOptions } from "../ports/agent-runner.js";
import type { Channel } from "../ports/channel.js";
import type { TaskStore } from "../ports/task-store.js";
import { makeApprovalResolver } from "./approval-flow.js";
import { bridgeEvents } from "./event-bridge.js";

export interface OrchestratorDeps {
  store: TaskStore;
  planner: Planner;
  gates: GateRouter;
  runner: AgentRunner;
  channel: Channel;
  /** 由装配层注入 RunOptions（Orchestrator 不知 cwd/llm/worktree 细节） */
  runOptsFor: (task: Task, plan: Plan) => Promise<RunOptions> | RunOptions;
}

/**
 * 编排核心：串起状态机 + Planner + GateRouter + runner + channel，处理一条入口消息的完整生命周期。
 * - 同 thread 正在处理时拒绝新消息（提示「正在处理」）
 * - 收到消息立即确认（「收到，处理中」），再启动 agent
 * - 所有消息都走 agent（编码→superpowers；其他→普通对话）
 * - runner 出错时捕获，回错误消息 + 标记 failed，不让进程崩溃
 */
export class Orchestrator {
  private readonly busyThreads = new Set<string>();

  constructor(private readonly deps: OrchestratorDeps) {}

  async handleMessage(msg: IncomingMessage): Promise<void> {
    const { store, planner, gates, runner, channel } = this.deps;

    // busy lock：同 thread 正在处理 → 提示，不重复启动
    if (this.busyThreads.has(msg.threadId)) {
      await channel.send(msg.threadId, { text: "⏳ 正在处理上一条消息，请稍候…" });
      return;
    }
    this.busyThreads.add(msg.threadId);

    let task: Task | undefined;
    try {
      // 立即确认收到（在 agent 启动前，提升用户体验）
      await channel.send(msg.threadId, { text: "👋 收到，处理中…" });

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

      // 所有任务都走 agent（编码→superpowers skill 包；其他→普通 GLM 对话）
      await store.updateStatus(task.id, nextStatus("created", "plan"));
      const opts = await this.deps.runOptsFor(task, plan);
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
    } catch (err) {
      // 防止 runner / LLM / 工具错误导致整个进程崩溃
      const msg2 = err instanceof Error ? err.message : String(err);
      console.error("[orchestrator] 处理失败:", msg2);
      if (task) {
        try {
          await this.deps.store.updateStatus(task.id, "failed", { error: msg2 });
        } catch {
          // 标记 failed 也失败则忽略
        }
      }
      try {
        await this.deps.channel.send(msg.threadId, { text: `❌ 处理出错：${msg2}` });
      } catch {
        // channel 也挂了则无能为力
      }
    } finally {
      this.busyThreads.delete(msg.threadId);
    }
  }
}
