import type { GateRouter } from "../domain/gate-router.js";
import type { Plan, Planner } from "../domain/planner.js";
import { nextStatus } from "../domain/task-state-machine.js";
import type { IncomingMessage, Task } from "../domain/types.js";
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

/** 编排核心：串起状态机 + Planner + GateRouter + runner + channel，处理一条入口消息的完整生命周期。 */
export class Orchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  async handleMessage(msg: IncomingMessage): Promise<void> {
    const { store, planner, gates, runner, channel } = this.deps;
    const plan = planner.plan(msg.text);
    const now = new Date().toISOString();
    const task: Task = {
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

    if (plan.intent === "unknown" || plan.skills.length === 0) {
      await channel.send(msg.threadId, { text: "暂未识别到可处理的任务类型。" });
      await store.updateStatus(task.id, nextStatus("created", "cancel"));
      return;
    }

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
  }
}
