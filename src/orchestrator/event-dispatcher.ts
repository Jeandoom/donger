import type { Event, FireContext } from "../domain/event.js";
import { buildPromptVars, renderPromptTemplate } from "../domain/event.js";
import { FIRING_CONTEXT_MAX_BYTES } from "../domain/event-firing.js";
import {
  AGENT_EXECUTION_COMPLETED_EVENT,
  buildExecutionCompletedPayload,
  buildExecutionFilesManifest,
  EXECUTION_COMPLETION_EVENT_NAMES,
  type ExecutionCompletedFact,
  type ExecutionCompletionStatus,
  executionStatusWord,
  extractExecutionCorrelation,
  formatExecutionDuration,
  NOTIFY_WRITER_TEMPLATE,
  type NotifyRunContext,
  parseExecutionCompletedPayload,
  truncateExecutionResultText,
} from "../domain/event-payloads.js";
import type { IncomingMessage } from "../domain/types.js";
import { wrapUntrusted } from "../domain/untrusted-content.js";
import type { Workflow } from "../domain/workflow.js";
import type { WorkflowRun } from "../domain/workflow-run.js";
import type { EventFiringStore } from "../ports/event-firing-store.js";
import type { EventStore } from "../ports/event-store.js";
import type { MessageStore } from "../ports/message-store.js";
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
  /** 级联深度上限（spec 2026-10-19-execution-completion-events-design §8，缺省 5） */
  maxCascadeDepth?: number;
  /**
   * 系统事件分发回填（index.ts 构造 SystemEventDispatcher 后 setSystemEventSink 晚绑定，
   * 与 webChannelDeps.systemEvents 同款时序）：run 终态 emit 完成事件用
   */
  systemEventSink?: { dispatch(eventName: string, payload: string): Promise<void> };
  /** 消息读取：run 终态抽取最终 assistant 回复填 payload（缺省=text 置空） */
  messageStore?: MessageStore;
  /** 智能体档案：payload 的 agentName（缺省降级 agentId） */
  agentStore?: { get(id: string): Promise<{ name?: string } | undefined> };
}

/** 全局事件队列容量（D6）：事件触发的执行共用一个队列 */
export const EVENT_QUEUE_CAPACITY = 10;

/** 级联深度上限（D5）：根=0，超限拒绝入队（防 A↔B 互订/自订烧 token） */
export const MAX_CASCADE_DEPTH = 5;

/**
 * 统一触发管线（spec 2026-10-09-events-workflows-refactor-design §4）：
 * fire = 触发记录落行（永久保留）→ 扇出 enabled 订阅者 → 全局队列入队（容量 10，溢出
 * 直接失败且原因可见）→ 全局泵认领执行（同 workflow 串行、跨 workflow 并行）。
 * 执行 = 每轮独立运行会话（createWithAgent，⚙️ 前缀）→ 变量表渲染（外部内容
 * wrapUntrusted 包装）→ orchestrator.handleMessage（unattended 轮，权限模式以
 * 工作流配置为准、缺省完全权限）→ 状态回写。
 */
export class EventDispatcher {
  /** 全局泵守卫：至多一个 drain 循环在认领 */
  private pumping = false;
  // 排水期暂停认领（热发布优雅停机，spec 2026-10-16-hot-deploy-design M1）：
  // queued 行留库，新实例 restore() 重投（at-least-once 语义不变）
  private paused = false;

  constructor(private readonly deps: EventDispatcherDeps) {}

  /** 排水起点调用：泵停止认领新 queued 行；已认领在执行的轮交给排水等待自然完成 */
  pause(): void {
    this.paused = true;
  }

  private get capacity(): number {
    return this.deps.maxQueuePending ?? EVENT_QUEUE_CAPACITY;
  }

  private get maxCascadeDepth(): number {
    return this.deps.maxCascadeDepth ?? MAX_CASCADE_DEPTH;
  }

  /** 系统事件分发器晚绑定（index.ts：SystemEventDispatcher 构造在 EventDispatcher 之后） */
  setSystemEventSink(sink: NonNullable<EventDispatcherDeps["systemEventSink"]>): void {
    this.deps.systemEventSink = sink;
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
    // 完成事件载荷 → 级联链信息（runId/链深）；非完成事件为 null（链根）
    const chain = parseExecutionCompletedPayload(ctx.payload);
    for (const wf of workflows) {
      await this.enqueueRun(wf, event, ctx, source, firing.id, false, chain);
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
    const run = await this.enqueueRun(wf, event, ctx, "manual", null, true, null);
    this.pump();
    return run;
  }

  /**
   * 入队：容量判定只约束事件触发（D6）——超出时该次任务直接失败并落执行记录
   * （失败原因在记录中可见）+ 走 run_failed 通知。级联深度超限同路径截断（D5）。
   */
  private async enqueueRun(
    wf: Workflow,
    event: Event | undefined,
    ctx: FireContext,
    source: string,
    firingId: string | null,
    bypassCapacity: boolean,
    chain: ExecutionCompletedFact | null,
  ): Promise<WorkflowRun> {
    const now = new Date().toISOString();
    const nextDepth = chain ? chain.trigger.cascadeDepth + 1 : 0;
    const base = {
      id: crypto.randomUUID(),
      workflowId: wf.id,
      eventId: event?.id ?? "",
      firingId,
      eventName: source,
      context: ctx.payload,
      causedByRunId: chain?.runId ?? null,
      cascadeDepth: nextDepth,
      kind: "workflow" as const,
      queuedAt: now,
    };
    if (chain && nextDepth > this.maxCascadeDepth) {
      const err = `级联深度超限（上限 ${this.maxCascadeDepth}），已截断链式触发`;
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
      this.notify(wf, run, `「${wf.name}」级联深度超限`, err);
      return run;
    }
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
      if (this.paused) return;
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
    // 通知投递轮（notifyPolicy 派生，M2）：独立执行路径——不发完成事件、不回写 lastRun
    if (run.kind === "notify") {
      await this.executeNotifyRun(run);
      return;
    }
    const { workflowStore, runStore, orchestrator, logger } = this.deps;
    const wf = await workflowStore.get(run.workflowId);
    const event = run.eventId ? await this.deps.eventStore.get(run.eventId) : undefined;
    if (!wf) {
      await this.failRun(run, null, "workflow 不存在");
      return;
    }
    try {
      const startedAt = new Date().toISOString();
      // 反馈闭环 M1：从触发载荷白名单提取业务因果键（feedback.created → feedbackId/submitterId）
      const feedbackCorrelation = run.context ? extractExecutionCorrelation(run.context) : null;
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
      if (conv && this.deps.messageStore) {
        await this.deps.messageStore
          .add(conv.id, "user", prompt)
          .catch((e: Error) =>
            this.deps.logger.error(
              { runId: run.id, err: e.message },
              "workflow run: persist user prompt failed",
            ),
          );
      }
      const agentConversationId = await orchestrator.handleMessage({
        channelId: "web",
        threadId: conv?.id ?? run.id,
        ...(conv ? { conversationId: conv.id } : {}),
        requesterId: wf.ownerId,
        text: prompt,
        // 无人值守触发：缺省按变更前问询；权限模式以工作流配置为准
        // （2026-10-14 拍板：配置缺省 full_access，orchestrator 据消息级值预热）
        unattended: true,
        permissionMode: wf.permissionMode,
        // L2 autoDev：标记无人值守轮为自动发布链路（orchestrator 装配 git-write 放行白名单）
        ...(wf.autoDev?.enabled ? { autoDev: true } : {}),
        // 反馈闭环 M1：feedback.created 因果键透传（orchestrator 据此装配
        // donger-feedback 工具并绑定写边界）
        ...(feedbackCorrelation ? { feedbackCorrelation } : {}),
      });
      const finishedAt = new Date().toISOString();
      const finalConvId = agentConversationId ?? conv?.id ?? null;
      await runStore.updateRun(run.id, {
        status: "success",
        finishedAt,
        conversationId: finalConvId,
      });
      await workflowStore.updateRuntimeState(wf.id, {
        lastRunId: run.id,
        lastRunAt: finishedAt,
        lastError: null,
      });
      this.notify(wf, { ...run, status: "success" }, `「${wf.name}」执行成功`, "");
      // 完成事件 emit（spec 2026-10-19-execution-completion-events-design §5.1，fail-open）：
      // 先落库后分发；text=最终 assistant 回复
      const replyText = await this.lastReplyText(finalConvId);
      await this.emitExecutionCompleted(
        wf,
        { ...run, status: "success", conversationId: finalConvId },
        "success",
        { startedAt, finishedAt, error: null, text: replyText },
      );
      // 通知策略派生（2026-10-20 反馈闭环 M2）：命中 policy.on 的终态 → 派生 notify 轮
      await this.scheduleNotify(wf, "success", {
        status: "success",
        outputSummary: replyText,
        error: null,
        sourceRunId: run.id,
        sourceContext: run.context,
      });
      logger.info({ runId: run.id, workflowId: wf.id }, "workflow run succeeded");
    } catch (e) {
      const err = (e as Error).message;
      logger.error({ runId: run.id, workflowId: wf.id, err }, "workflow run failed");
      await this.failRun(run, wf, err);
    }
  }

  /** 变量表渲染：外部内容（triggerOutput/query/data）逐项 wrapUntrusted 定界注入。
   * 完成事件上下文追加简报变量（spec §6）：下游 LLM 默认收到自然语言简报而非 JSON */
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
    // 完成事件事实 → 简报变量（M1 files 恒空，清单兜底「（无）」；M2 物化后含本地路径）
    let briefing: Record<string, string> = {};
    if (event?.type === "system" && run.context) {
      const fact = parseExecutionCompletedPayload(run.context);
      if (fact) {
        const manifest = buildExecutionFilesManifest(fact.result.files);
        const corr = extractExecutionCorrelation(run.context);
        briefing = {
          workflowName: fact.workflowName,
          agentName: fact.agentName,
          statusWord: executionStatusWord(fact.status),
          durationText: formatExecutionDuration(fact.durationMs),
          outputSummary: fact.result.text,
          filesManifest: manifest || "（无）",
          // 反馈闭环 M1：因果键暴露给级联模板（平台内部 id，不属不可信外部内容）
          ...(corr ? { feedbackId: corr.feedbackId, submitterId: corr.submitterId } : {}),
        };
      }
    }
    return {
      ...vars,
      ...briefing,
      triggerOutput: wrapUntrusted(vars.triggerOutput ?? "", "event").wrapped,
      query: wrapUntrusted(vars.query ?? "", "event:query").wrapped,
      data: wrapUntrusted(vars.data ?? "", "event:data").wrapped,
      // 上游结论是不可信外部内容，与 triggerOutput 同规则定界
      outputSummary: wrapUntrusted(briefing.outputSummary ?? "", "event:output").wrapped,
      // filesManifest 为平台生成的清单文本（M2 物化时对文件名另行清洗）
      filesManifest: briefing.filesManifest ?? "",
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
      // 失败同样 emit（失败接管/监督者模式依赖）；text 置空，错误在 error 字段
      await this.emitExecutionCompleted(wf, { ...run, status: "failed" }, "failed", {
        startedAt: run.startedAt ?? run.queuedAt,
        finishedAt,
        error: err,
        text: "",
      });
      await this.scheduleNotify(wf, "failed", {
        status: "failed",
        outputSummary: "",
        error: err,
        sourceRunId: run.id,
        sourceContext: run.context,
      });
    }
  }

  /** 最终 assistant 回复文本（payload 的 result.text；读取失败置空兜底，不阻塞 emit） */
  private async lastReplyText(conversationId: string | null | undefined): Promise<string> {
    if (!conversationId || !this.deps.messageStore) return "";
    try {
      const msgs = await this.deps.messageStore.listByConversation(conversationId);
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i]?.role === "bot") return msgs[i]?.text ?? "";
      }
    } catch {
      // 转录读取失败：text 置空（spec §5.2）
    }
    return "";
  }

  /**
   * run 终态 emit 完成事件（spec §5）：同一事实以两个事件名各分发一次（智能体视角 /
   * 工作流视角，D1），SystemEventDispatcher 按 subjects/timing/owner 过滤扇出。
   * fire-and-forget 语义由 dispatch 内部保证；这里只保证 dispatch 调用本身不抛。
   */
  private async emitExecutionCompleted(
    wf: Workflow,
    run: WorkflowRun,
    status: ExecutionCompletionStatus,
    info: { startedAt: string; finishedAt: string; error: string | null; text: string },
  ): Promise<void> {
    const sink = this.deps.systemEventSink;
    if (!sink) return;
    const agent = this.deps.agentStore
      ? await this.deps.agentStore.get(wf.agentId).catch(() => undefined)
      : undefined;
    const startedMs = Date.parse(info.startedAt);
    const endedMs = Date.parse(info.finishedAt);
    const base: Omit<ExecutionCompletedFact, "event"> = {
      schemaVersion: 1,
      runId: run.id,
      agentId: wf.agentId,
      agentName: agent?.name ?? wf.agentId,
      workflowId: wf.id,
      workflowName: wf.name,
      ownerId: wf.ownerId,
      status,
      startedAt: info.startedAt,
      endedAt: info.finishedAt,
      durationMs:
        Number.isFinite(startedMs) && Number.isFinite(endedMs)
          ? Math.max(0, endedMs - startedMs)
          : 0,
      error: info.error,
      trigger: {
        // system（或 system:<事件名>）→ event（由某事件触发）；其余原样（manual/schedule/call）
        source:
          run.eventName === "system" || run.eventName.startsWith("system:")
            ? "event"
            : run.eventName,
        eventId: run.eventId || null,
        causedByRunId: run.causedByRunId ?? null,
        cascadeDepth: run.cascadeDepth ?? 0,
      },
      result: { text: truncateExecutionResultText(info.text), files: [] },
      // 反馈闭环 M1：业务因果键随信封透传（白名单提取，非 feedback 触发为 undefined）
      ...(run.context
        ? { correlation: extractExecutionCorrelation(run.context) ?? undefined }
        : {}),
    };
    for (const eventName of EXECUTION_COMPLETION_EVENT_NAMES) {
      const payload = buildExecutionCompletedPayload({ ...base, event: eventName });
      void sink
        .dispatch(eventName, payload)
        .catch((e: Error) =>
          this.deps.logger.error(
            { runId: run.id, eventName, err: e.message },
            "执行完成事件分发失败",
          ),
        );
    }
  }

  /**
   * 通知策略派生（2026-10-20 反馈闭环 M2）：主 run 终态后检查 notifyPolicy，命中则
   * 派生 notify 轮入同一队列。收件人在派生时解析完成（"correlation" 模式无法定位时
   * notify 轮直接 failed 落行——可见可排障，不空跑写手烧 token）。
   */
  private async scheduleNotify(
    wf: Workflow,
    status: ExecutionCompletionStatus,
    info: {
      status: ExecutionCompletionStatus;
      outputSummary: string;
      error: string | null;
      sourceRunId: string;
      sourceContext: string | null | undefined;
    },
  ): Promise<void> {
    const policy = wf.notifyPolicy;
    if (!policy?.enabled || !policy.on.includes(status)) return;
    let recipients: string[];
    let correlation: NotifyRunContext["correlation"] = null;
    if (policy.recipients === "owner") {
      recipients = [wf.ownerId];
    } else if (Array.isArray(policy.recipients)) {
      recipients = [...policy.recipients];
    } else {
      correlation = info.sourceContext ? extractExecutionCorrelation(info.sourceContext) : null;
      if (!correlation) {
        const now = new Date().toISOString();
        const run = await this.deps.runStore.insert({
          id: crypto.randomUUID(),
          workflowId: wf.id,
          eventId: "",
          eventName: "notify",
          status: "failed",
          error: "无法解析收件人（事件载荷无 correlation）",
          causedByRunId: info.sourceRunId,
          cascadeDepth: 0,
          kind: "notify",
          queuedAt: now,
          finishedAt: now,
        });
        void run;
        this.deps.logger.warn(
          { workflowId: wf.id, sourceRunId: info.sourceRunId },
          "notify: 无法解析收件人，通知轮置失败",
        );
        return;
      }
      recipients = [correlation.submitterId];
    }
    const ctx: NotifyRunContext = {
      recipients,
      title: policy.title ?? "",
      status,
      outputSummary: truncateExecutionResultText(info.outputSummary),
      error: info.error,
      correlation,
    };
    await this.deps.runStore.insert({
      id: crypto.randomUUID(),
      workflowId: wf.id,
      eventId: "",
      eventName: "notify",
      status: "queued",
      context: JSON.stringify(ctx),
      causedByRunId: info.sourceRunId,
      cascadeDepth: 0,
      kind: "notify",
      queuedAt: new Date().toISOString(),
    });
    this.pump();
  }

  /**
   * 通知投递轮执行：写手 agent 跑一轮产出文案 → 站内信投递（M2 仅 inapp；站外通道由
   * NotificationService 按用户偏好附带）。与业务 run 的差异：不发完成事件（杜绝「通知
   * 写手再被订阅」级联环）、不回写工作流 lastRun、自身失败不再派生通知（防递归）。
   */
  private async executeNotifyRun(run: WorkflowRun): Promise<void> {
    const { workflowStore, runStore, orchestrator, logger } = this.deps;
    const now0 = new Date().toISOString();
    const fail = async (error: string): Promise<void> => {
      await runStore.updateRun(run.id, { status: "failed", error, finishedAt: now0 });
    };
    const wf = await workflowStore.get(run.workflowId);
    if (!wf || !wf.notifyPolicy?.enabled) {
      await fail("通知策略不存在或已关闭");
      return;
    }
    let ctx: NotifyRunContext;
    try {
      ctx = JSON.parse(run.context ?? "") as NotifyRunContext;
      if (!Array.isArray(ctx.recipients) || ctx.recipients.length === 0) {
        throw new Error("empty recipients");
      }
    } catch {
      await fail("通知上下文缺失（无收件人）");
      return;
    }
    try {
      const startedAt = new Date().toISOString();
      const policy = wf.notifyPolicy;
      const writerAgentId = policy.writerAgentId ?? wf.agentId;
      const conv = this.deps.conversationStore
        ? await this.deps.conversationStore.createWithAgent(
            wf.ownerId,
            "web",
            `🔔 ${wf.name} · 结果通知 · ${startedAt.slice(5, 16).replace("T", " ")}`,
            writerAgentId,
          )
        : undefined;
      const statusWord = executionStatusWord(ctx.status);
      const prompt = renderPromptTemplate(
        policy.promptTemplate?.trim() ? policy.promptTemplate : NOTIFY_WRITER_TEMPLATE,
        {
          workflowName: wf.name,
          statusWord,
          outputSummary: wrapUntrusted(
            ctx.outputSummary || ctx.error || "（无结论）",
            "event:notify",
          ).wrapped,
          feedbackSection: ctx.correlation
            ? `【关联反馈】${ctx.correlation.feedbackId}（提交人 ${ctx.correlation.submitterId}）`
            : "",
        },
      );
      await runStore.updateRun(run.id, {
        status: "running",
        startedAt,
        conversationId: conv?.id ?? run.conversationId ?? null,
        renderedPrompt: prompt,
      });
      if (conv && this.deps.messageStore) {
        await this.deps.messageStore
          .add(conv.id, "user", prompt)
          .catch((e: Error) =>
            logger.error({ runId: run.id, err: e.message }, "notify run: persist prompt failed"),
          );
      }
      const agentConversationId = await orchestrator.handleMessage({
        channelId: "web",
        threadId: conv?.id ?? run.id,
        ...(conv ? { conversationId: conv.id } : {}),
        requesterId: wf.ownerId,
        text: prompt,
        unattended: true,
        permissionMode: wf.permissionMode,
      });
      const finishedAt = new Date().toISOString();
      const finalConvId = agentConversationId ?? conv?.id ?? null;
      await runStore.updateRun(run.id, {
        status: "success",
        finishedAt,
        conversationId: finalConvId,
      });
      const body = await this.lastReplyText(finalConvId);
      await this.deps.notifications
        ?.notify({
          event: "workflow.result_notified",
          recipients: ctx.recipients.map((userId) => ({ kind: "user" as const, userId })),
          title: ctx.title || `「${wf.name}」结果通知`,
          body: body.slice(0, 400),
          link: `/workflows/${wf.id}`,
          dedupeKey: `notify:${run.id}`,
        })
        .catch((e: unknown) =>
          logger.error({ runId: run.id, err: String(e) }, "notify run: 投递失败"),
        );
      logger.info({ runId: run.id, workflowId: wf.id }, "notify run delivered");
    } catch (e) {
      const finishedAt = new Date().toISOString();
      await runStore.updateRun(run.id, {
        status: "failed",
        error: (e as Error).message,
        finishedAt,
      });
      logger.error({ runId: run.id, err: (e as Error).message }, "notify run failed");
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
    const stopError = run.status === "queued" ? "手动停止（排队中取消）" : "手动停止";
    await this.deps.runStore.updateRun(run.id, {
      status: "stopped",
      error: stopError,
      finishedAt,
    });
    // 终止同样 emit（状态机完备，D8）；text 置空。notify 轮终止不 emit（防级联环，M2）
    const wf = await this.deps.workflowStore.get(workflowId).catch(() => undefined);
    if (wf && run.kind !== "notify") {
      await this.emitExecutionCompleted(wf, { ...run, status: "stopped" }, "stopped", {
        startedAt: run.startedAt ?? run.queuedAt,
        finishedAt,
        error: stopError,
        text: "",
      });
    }
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
