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
    // 先清扫上次崩溃留下的 running 状态
    const swept = await this.deps.loopStore.sweepOrphanedRuns("process restart");
    if (swept > 0) {
      this.deps.logger.warn({ swept }, "marked orphaned runs as failed");
    }
    const loops = await this.deps.loopStore.listEnabled();
    for (const l of loops) {
      await this.register(l);
    }
    this.deps.logger.info({ count: this.tasks.size }, "scheduler restored");
  }

  async register(loop: Loop): Promise<void> {
    // ponytail: 幂等刷新——若已注册，先 stop 旧 task 再重建。
    // 这样 trigger 编辑后 cron 变更会真正生效，调用方语义为"按当前 loop 配置保证已注册"。
    this.unregister(loop.id);
    const cronExpr = await this.resolveCron(loop);
    if (!cronExpr) return;
    const task = cron.schedule(cronExpr, () => {
      void this.fireWithSource(loop);
    });
    this.tasks.set(loop.id, task);
  }

  /** trigger 编辑后调用：重新注册所有引用该 trigger 的 enabled loops。 */
  async refreshByTrigger(triggerId: string): Promise<void> {
    const loops = await this.deps.loopStore.listEnabled();
    for (const l of loops) {
      const wf = await this.deps.workflowStore.get(l.workflowId);
      if (wf?.triggerId === triggerId) await this.register(l);
    }
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
