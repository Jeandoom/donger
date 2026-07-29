import cron, { type ScheduledTask } from "node-cron";
import type { Loop } from "../domain/loop.js";
import type { LoopStore } from "../ports/loop-store.js";
import type { TriggerStore } from "../ports/trigger-store.js";
import type { WorkflowStore } from "../ports/workflow-store.js";
import type { Logger } from "../util/logger.js";
import type { LoopRunner } from "./loop-runner.js";

export interface SchedulerDeps {
  loopStore: LoopStore;
  workflowStore: WorkflowStore;
  triggerStore: TriggerStore;
  loopRunner: LoopRunner;
  logger: Logger;
}

export class SchedulerService {
  private readonly tasks = new Map<string, ScheduledTask>();

  constructor(private readonly deps: SchedulerDeps) {}

  size(): number {
    return this.tasks.size;
  }

  async restore(): Promise<void> {
    const loops = await this.deps.loopStore.listEnabled();
    for (const l of loops) {
      await this.register(l);
    }
    this.deps.logger.info({ count: this.tasks.size }, "scheduler restored");
  }

  async register(loop: Loop): Promise<void> {
    if (this.tasks.has(loop.id)) return;
    const cronExpr = await this.resolveCron(loop);
    if (!cronExpr) return;
    const task = cron.schedule(cronExpr, () => {
      void this.fireWithSource(loop);
    });
    this.tasks.set(loop.id, task);
  }

  private async resolveCron(loop: Loop): Promise<string | null> {
    const wf = await this.deps.workflowStore.get(loop.workflowId);
    if (!wf) return null;
    const t = await this.deps.triggerStore.get(wf.triggerId);
    if (!t || t.type !== "scheduler" || !t.scheduler) return null;
    if (!cron.validate(t.scheduler.cron)) {
      this.deps.logger.warn({ loopId: loop.id, cron: t.scheduler.cron }, "invalid cron expression");
      return null;
    }
    return t.scheduler.cron;
  }

  private async fireWithSource(loop: Loop): Promise<void> {
    try {
      const wf = await this.deps.workflowStore.get(loop.workflowId);
      if (!wf) return;
      const t = await this.deps.triggerStore.get(wf.triggerId);
      if (!t?.scheduler) return;
      const result = await this.deps.loopRunner.testTrigger(t.id);
      if (result.matched) {
        await this.deps.loopRunner.fire(loop.id, result.sourceOutput);
      } else {
        this.deps.logger.debug(
          { loopId: loop.id, error: result.error },
          "cron tick: matcher not matched",
        );
      }
    } catch (e) {
      this.deps.logger.error({ loopId: loop.id, err: (e as Error).message }, "cron fire failed");
    }
  }

  unregister(loopId: string): void {
    const task = this.tasks.get(loopId);
    if (task) {
      task.stop();
      this.tasks.delete(loopId);
    }
  }

  stopAll(): void {
    for (const t of this.tasks.values()) t.stop();
    this.tasks.clear();
  }
}
