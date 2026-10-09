import cron, { type ScheduledTask } from "node-cron";
import type { Event } from "../domain/event.js";
import type { EventStore } from "../ports/event-store.js";
import type { WorkflowStore } from "../ports/workflow-store.js";
import type { Logger } from "../util/logger.js";
import { nextCronFire } from "./cron-next.js";
import type { EventDispatcher } from "./event-dispatcher.js";
import { buildTimerContext, probeEventSource } from "./event-source-probe.js";

export interface SchedulerDeps {
  eventStore: EventStore;
  workflowStore: WorkflowStore;
  dispatcher: EventDispatcher;
  logger: Logger;
  /** 定时事件 http source 是否允许内网目标（TRIGGER_ALLOW_PRIVATE_NET，默认 false） */
  allowPrivateNet?: boolean;
  workspaceRoot: string;
}

/**
 * 定时事件调度（原按 loop 注册改为按 event 注册，spec §5.1）：
 * 注册条件 = schedule 类型事件存在 enabled 订阅者（无人订阅不注册不触发）；
 * unconditional 到点直接 fire（纯定时）；conditional 抓源+matcher 判定后 fire。
 * 幂等刷新：event 编辑或订阅者启停后调用 refreshByEvent 重建 task。
 */
export class SchedulerService {
  private readonly tasks = new Map<string, ScheduledTask>();

  constructor(private readonly deps: SchedulerDeps) {}

  size(): number {
    return this.tasks.size;
  }

  async restore(): Promise<void> {
    const events = await this.deps.eventStore.listAll();
    for (const e of events) {
      if (e.type === "schedule") await this.register(e);
    }
    this.deps.logger.info({ count: this.tasks.size }, "scheduler restored");
  }

  /** 幂等注册：先 stop 旧 task 再重建（cron/订阅者变化即生效） */
  async register(event: Event): Promise<void> {
    this.unregister(event.id);
    if (event.type !== "schedule" || !event.schedule) return;
    const subscribers = await this.deps.workflowStore.listEnabledByEvent(event.id);
    if (subscribers.length === 0) return;
    const cronExpr = event.schedule.cron;
    if (!cron.validate(cronExpr)) {
      this.deps.logger.warn({ eventId: event.id, cron: cronExpr }, "invalid cron expression");
      return;
    }
    const task = cron.schedule(cronExpr, () => {
      void this.tick(event.id);
    });
    this.tasks.set(event.id, task);
    const next = nextCronFire(cronExpr);
    if (next) await this.deps.eventStore.updateRuntimeState(event.id, { nextRunAt: next });
  }

  /** 事件编辑/工作流启停后调用：重注册该事件的定时任务并刷新 nextRunAt */
  async refreshByEvent(eventId: string): Promise<void> {
    const event = await this.deps.eventStore.get(eventId);
    if (event) await this.register(event);
  }

  private async tick(eventId: string): Promise<void> {
    try {
      const event = await this.deps.eventStore.get(eventId);
      if (!event || event.type !== "schedule" || !event.schedule) return;
      const hasSubscriber = (await this.deps.workflowStore.listEnabledByEvent(eventId)).length > 0;
      if (!hasSubscriber) return;
      if (event.schedule.mode === "unconditional" || !event.schedule.source) {
        await this.deps.dispatcher.fire(eventId, { payload: buildTimerContext(event) }, "schedule");
        return;
      }
      const probe = await probeEventSource(event, {
        allowPrivateNet: this.deps.allowPrivateNet,
        workspaceRoot: this.deps.workspaceRoot,
        gateByMatcher: true,
      });
      if (probe.matched) {
        await this.deps.dispatcher.fire(eventId, { payload: probe.sourceOutput }, "schedule");
      } else {
        this.deps.logger.debug({ eventId, error: probe.error }, "cron tick: matcher not matched");
      }
    } catch (e) {
      this.deps.logger.error({ eventId, err: (e as Error).message }, "cron fire failed");
    }
  }

  unregister(eventId: string): void {
    const task = this.tasks.get(eventId);
    if (task) {
      task.stop();
      this.tasks.delete(eventId);
    }
  }

  stopAll(): void {
    for (const t of this.tasks.values()) t.stop();
    this.tasks.clear();
  }
}
