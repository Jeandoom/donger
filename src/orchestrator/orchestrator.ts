import type { GateRouter } from "../domain/gate-router.js";
import type { Plan, Planner } from "../domain/planner.js";
import { nextStatus } from "../domain/task-state-machine.js";
import type { IncomingMessage, Task } from "../domain/types.js";
import type { MemoryStore } from "../memory/memory-store.js";
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
  /** 记忆存储（可选；有则任务前注入 + 任务后沉淀） */
  memory?: MemoryStore;
  /** 由装配层注入 RunOptions */
  runOptsFor: (task: Task, plan: Plan) => Promise<RunOptions> | RunOptions;
}

/**
 * 编排核心。
 * - busy lock、收到确认、通用对话（详见上方注释历史）
 * - 记忆循环（T5.2+T5.3）：任务前检索注入相关记忆；任务后自动沉淀经验
 * - 错误捕获：runner 出错不崩进程
 */
export class Orchestrator {
  private readonly busyThreads = new Set<string>();

  constructor(private readonly deps: OrchestratorDeps) {}

  async handleMessage(msg: IncomingMessage): Promise<void> {
    const { store, planner, gates, runner, channel, memory } = this.deps;

    if (this.busyThreads.has(msg.threadId)) {
      await channel.send(msg.threadId, { text: "⏳ 正在处理上一条消息，请稍候…" });
      return;
    }
    this.busyThreads.add(msg.threadId);

    let task: Task | undefined;
    try {
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

      await store.updateStatus(task.id, nextStatus("created", "plan"));
      const baseOpts = await this.deps.runOptsFor(task, plan);

      // T5.3：任务前检索记忆，注入 systemPromptAppend
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

      // T5.2：任务后自动沉淀经验
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
        // 出错也沉淀（失败经验同样有价值）
        if (memory) {
          memory.append({
            summary: task.prompt.slice(0, 40),
            detail: `prompt: ${task.prompt}\n结果: 出错\n${errMsg}`,
          });
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
