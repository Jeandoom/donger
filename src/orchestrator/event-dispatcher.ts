import type { Event, FireContext } from "../domain/event.js";
import { buildPromptVars, renderPromptTemplate } from "../domain/event.js";
import { FIRING_CONTEXT_MAX_BYTES } from "../domain/event-firing.js";
import type { IncomingMessage } from "../domain/types.js";
import { wrapUntrusted } from "../domain/untrusted-content.js";
import type { Workflow } from "../domain/workflow.js";
import type { WorkflowRun } from "../domain/workflow-run.js";
import type { EventFiringStore } from "../ports/event-firing-store.js";
import type { EventStore } from "../ports/event-store.js";
import type { WorkflowRunStore } from "../ports/workflow-run-store.js";
import type { WorkflowStore } from "../ports/workflow-store.js";
import { NotFoundError, ValidationError } from "../util/errors.js";
import type { Logger } from "../util/logger.js";
import type { NotificationService } from "./notification-service.js";

export interface EventDispatcherDeps {
  eventStore: EventStore;
  workflowStore: WorkflowStore;
  runStore: WorkflowRunStore;
  firingStore: EventFiringStore;
  orchestrator: { handleMessage(msg: IncomingMessage): Promise<string | undefined> };
  /** 每次执行建独立运行会话（D1：与普通对话同一运行时、侧栏正常可见） */
  conversationStore?: {
    createWithAgent(
      userId: string,
      channelId: string,
      title: string,
      agentId: string,
    ): Promise<{ id: string }>;
  };
  /** 任务停止通道：停止时解开该会话挂起审批（abort 通道工作流执行未接，降级标记停止） */
  canceller?: { cancelPendingApprovals(conversationId: string): void };
  /** 通知内核（缺省=不发站内信） */
  notifications?: NotificationService;
  logger: Logger;
  /** 全局事件队列容量（D6 拍板=10）：超出时该次执行直接失败，原因进执行记录 */
  maxQueuePending?: number;
}

/** 全局事件队列容量（D6）：事件触发的执行共用一个队列 */
export const EVENT_QUEUE_CAPACITY = 10;

/**
 * 统一触发管线（spec 2026-10-09-events-workflows-refactor-design §4）：
 * fire = 触发记录落行（永久保留）→ 扇出 enabled 订阅者 → 全局队列入队（容量 10，溢出
 * 直接失败且原因可见）→ 全局泵认领执行（同 workflow 串行、跨 workflow 并行）。
 * 执行 = 每轮独立运行会话（createWithAgent，⚙️ 前缀）→ 变量表渲染（外部内容
 * wrapUntrusted 包装）→ orchestrator.handleMessage（unattended 强制问询）→ 状态回写。
 */
export class EventDispatcher {
  /** 全局泵守卫：至多一个 drain 循环在认领 */
  private pumping = false;

  constructor(private readonly deps: EventDispatcherDeps) {}

  private get capacity(): number {
    return this.deps.maxQueuePending ?? EVENT_QUEUE_CAPACITY;
  }

  /** 事件触发入口：三个分发器（定时/调用/系统）共用 */
  async fire(eventId: string, ctx: FireContext, source: string): Promise<void> {
    const event = await this.deps.eventStore.get(eventId);
    if (!event) return;
    const firedAt = new Date().toISOString();
    const workflows = await this.deps.workflowStore.listEnabledByEvent(eventId);
    const firing = await this.deps.firingStore.insert({
      id: crypto.randomUUID(),
      eventId,
      ownerId: event.ownerId,
      source,
      context: ctx.payload.slice(0, FIRING_CONTEXT_MAX_BYTES),
      matchedWorkflowCount: workflows.length,
      firedAt,
    });
    await this.deps.eventStore.updateRuntimeState(eventId, { lastFiredAt: firedAt });
    for (const wf of workflows) {
      await this.enqueueRun(wf, event, ctx, source, firing.id, false);
    }
    this.pump();
  }

  /**
   * 手动运行一轮（工作流详情「立即运行」）：豁免队列容量（用户显式动作），
   * 仍入队走同一泵保证同 workflow 串行。返回本次执行记录。
   */
  async manualRun(workflowId: string, ctx: FireContext): Promise<WorkflowRun> {
    const wf = await this.deps.workflowStore.get(workflowId);
    if (!wf) throw new NotFoundError("WORKFLOW_NOT_FOUND", `workflow 不存在: ${workflowId}`);
    const event = wf.eventId ? await this.deps.eventStore.get(wf.eventId) : undefined;
    const run = await this.enqueueRun(wf, event, ctx, "manual", null, true);
    this.pump();
    return run;
  }

  /**
   * 入队：容量判定只约束事件触发（D6）——超出时该次任务直接失败并落执行记录
   * （失败原因在记录中可见）+ 走 run_failed 通知。
   */
  private async enqueueRun(
    wf: Workflow,
    event: Event | undefined,
    ctx: FireContext,
    source: string,
    firingId: string | null,
    bypassCapacity: boolean,
  ): Promise<WorkflowRun> {
    const now = new Date().toISOString();
    const base = {
      id: crypto.randomUUID(),
      workflowId: wf.id,
      eventId: event?.id ?? "",
      firingId,
      eventName: source,
      context: ctx.payload,
      queuedAt: now,
    };
    if (!bypassCapacity && (await this.deps.runStore.countQueued()) >= this.capacity) {
      const err = `触发事件队列已满（容量 ${this.capacity}），本次执行未运行`;
      const run = await this.deps.runStore.insert({
        ...base,
        status: "failed",
        error: err,
        finishedAt: now,
      });
      await this.deps.workflowStore.updateRuntimeState(wf.id, {
        lastRunId: run.id,
        lastRunAt: now,
        lastError: err,
      });
      this.notify(wf, run, `「${wf.name}」触发队列已满`, err);
      return run;
    }
    return this.deps.runStore.insert({ ...base, status: "queued" });
  }

  /** 全局泵：认领「最旧 queued 且所属 workflow 无 running 行」（同 workflow 串行，跨 workflow 并行） */
  pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    void this.drain().finally(() => {
      this.pumping = false;
    });
  }

  private async drain(): Promise<void> {
    for (;;) {
      const run = await this.deps.runStore.claimNextRunnable();
      if (!run) return;
      // 异步执行不阻塞认领循环；完成后再唤泵抽同 workflow 的后续排队行
      void this.execute(run)
        .catch((e: Error) =>
          this.deps.logger.error({ runId: run.id, err: e.message }, "workflow run execute failed"),
        )
        .finally(() => this.pump());
    }
  }

  private async execute(run: WorkflowRun): Promise<void> {
    const { workflowStore, runStore, orchestrator, logger } = this.deps;
    const wf = await workflowStore.get(run.workflowId);
    const event = run.eventId ? await this.deps.eventStore.get(run.eventId) : undefined;
    if (!wf) {
      await this.failRun(run, null, "workflow 不存在");
      return;
    }
    try {
      const startedAt = new Date().toISOString();
      const title = `⚙️ ${wf.name} · ${startedAt.slice(5, 16).replace("T", " ")}`;
      const conv = this.deps.conversationStore
        ? await this.deps.conversationStore.createWithAgent(wf.ownerId, "web", title, wf.agentId)
        : undefined;
      const prompt = renderPromptTemplate(
        wf.promptTemplate,
        this.buildRenderVars(run, event, startedAt),
      );
      await runStore.updateRun(run.id, {
        status: "running",
        startedAt,
        conversationId: conv?.id ?? run.conversationId ?? null,
        renderedPrompt: prompt,
      });
      const agentConversationId = await orchestrator.handleMessage({
        channelId: "web",
        threadId: conv?.id ?? run.id,
        ...(conv ? { conversationId: conv.id } : {}),
        requesterId: wf.ownerId,
        text: prompt,
        // 无人值守触发：orchestrator 据此强制按变更前问询执行（full_access 仅限交互式会话）
        unattended: true,
      });
      const finishedAt = new Date().toISOString();
      await runStore.updateRun(run.id, {
        status: "success",
        finishedAt,
        conversationId: agentConversationId ?? conv?.id ?? null,
      });
      await workflowStore.updateRuntimeState(wf.id, {
        lastRunId: run.id,
        lastRunAt: finishedAt,
        lastError: null,
      });
      this.notify(wf, { ...run, status: "success" }, `「${wf.name}」执行成功`, "");
      logger.info({ runId: run.id, workflowId: wf.id }, "workflow run succeeded");
    } catch (e) {
      const err = (e as Error).message;
      logger.error({ runId: run.id, workflowId: wf.id, err }, "workflow run failed");
      await this.failRun(run, wf, err);
    }
  }

  /** 变量表渲染：外部内容（triggerOutput/query/data）逐项 wrapUntrusted 定界注入 */
  private buildRenderVars(run: WorkflowRun, event: Event | undefined, firedAt: string) {
    const ctx: FireContext = { payload: run.context ?? "" };
    if (event?.type === "call" && run.context) {
      try {
        const parsed = JSON.parse(run.context) as {
          query?: string;
          data?: Record<string, unknown>;
        };
        if (typeof parsed.query === "string") ctx.query = parsed.query;
        if (parsed.data && typeof parsed.data === "object") ctx.data = parsed.data;
      } catch {
        // payload 非 JSON（宽容降级形态已在前置归一）：按整体 payload 渲染
      }
    }
    const vars = buildPromptVars(ctx, firedAt);
    return {
      ...vars,
      triggerOutput: wrapUntrusted(vars.triggerOutput ?? "", "event").wrapped,
      query: wrapUntrusted(vars.query ?? "", "event:query").wrapped,
      data: wrapUntrusted(vars.data ?? "", "event:data").wrapped,
    };
  }

  private async failRun(run: WorkflowRun, wf: Workflow | null, err: string): Promise<void> {
    const finishedAt = new Date().toISOString();
    await this.deps.runStore.updateRun(run.id, {
      status: "failed",
      error: err,
      finishedAt,
    });
    if (wf) {
      await this.deps.workflowStore.updateRuntimeState(wf.id, {
        lastRunId: run.id,
        lastRunAt: finishedAt,
        lastError: err,
      });
      this.notify(wf, { ...run, status: "failed" }, `「${wf.name}」执行失败`, err);
    }
  }

  /** 运行结果 → 站内信（沿用 loop.* 通知事件键避免用户偏好迁移；通知目录文案已改工作流口径） */
  private notify(wf: Workflow, run: WorkflowRun, title: string, body: string): void {
    void this.deps.notifications
      ?.notify({
        event: run.status === "success" ? "loop.run_succeeded" : "loop.run_failed",
        recipients: [{ kind: "user", userId: wf.ownerId }],
        title,
        body: body.slice(0, 400),
        link: `/workflows/${wf.id}`,
        dedupeKey: `workflow:${wf.id}:${run.status}:${run.id}`,
      })
      .catch((e: unknown) =>
        this.deps.logger.error({ workflowId: wf.id, err: String(e) }, "workflow 通知失败"),
      );
  }

  /** 停止执行：排队中直接取消；运行中标记停止+解开挂起审批（审批拒绝后轮次收口；
   * 无挂起审批的纯 LLM 轮自然跑完但记录已判 stopped——abort 通道未接工作流执行，
   * 与任务停止的降级路径一致） */
  async stopRun(workflowId: string, runId: string): Promise<WorkflowRun> {
    const run = await this.deps.runStore.getRun(runId);
    if (!run || run.workflowId !== workflowId) {
      throw new NotFoundError("RUN_NOT_FOUND", "执行记录不存在");
    }
    if (run.status !== "queued" && run.status !== "running") {
      throw new ValidationError("RUN_NOT_ACTIVE", `当前状态 ${run.status} 不可停止`);
    }
    if (run.status === "running" && run.conversationId) {
      this.deps.canceller?.cancelPendingApprovals(run.conversationId);
    }
    const finishedAt = new Date().toISOString();
    await this.deps.runStore.updateRun(run.id, {
      status: "stopped",
      error: run.status === "queued" ? "手动停止（排队中取消）" : "手动停止",
      finishedAt,
    });
    return (await this.deps.runStore.getRun(runId)) ?? { ...run, status: "stopped", finishedAt };
  }

  /** 启动恢复：遗留 running→queued 重投（at-least-once）+ 抽积压；无任何清理（D5 永久保留） */
  async restore(): Promise<void> {
    const reset = await this.deps.runStore.resetStaleRunning();
    if (reset > 0) {
      this.deps.logger.warn({ reset }, "workflow runs: stale running rows reset to queued");
    }
    this.pump();
  }
}
