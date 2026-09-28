import { evaluateMatcher } from "../domain/trigger-matcher.js";
import type { LoopStore } from "../ports/loop-store.js";
import type { TriggerStore } from "../ports/trigger-store.js";
import type { WorkflowStore } from "../ports/workflow-store.js";
import type { Logger } from "../util/logger.js";
import type { LoopRunner } from "./loop-runner.js";

export interface EventTriggerDispatcherDeps {
  triggerStore: TriggerStore;
  loopStore: LoopStore;
  workflowStore: WorkflowStore;
  loopRunner: LoopRunner;
  logger: Logger;
}

/**
 * 进程内事件触发分发（spec 2026-09-28-event-trigger-feedback-design §5）。
 * 与 HookRegistry 同构：事件发生时实时查订阅触发器（增删改即时生效，零注册），
 * matcher 判定 payload JSON 后按 owner 级交叉过滤找到 enabled loops 投递。
 * 调用方须 fire-and-forget（fail-open）：触发器任何异常不得影响事件源主流程。
 */
export class EventTriggerDispatcher {
  constructor(private readonly deps: EventTriggerDispatcherDeps) {}

  async dispatch(eventName: string, payload: string): Promise<void> {
    const triggers = (await this.deps.triggerStore.listAll()).filter(
      (t) => t.type === "event" && t.event?.name === eventName,
    );
    for (const t of triggers) {
      if (!t.event) continue;
      const match = evaluateMatcher(t.event.matcher, { body: payload });
      if (!match.matched) {
        this.deps.logger.debug(
          { eventName, triggerId: t.id, debug: match.debug },
          "event not matched",
        );
        continue;
      }
      // 两次 owner 级查询交叉过滤（同 HookRegistry：比每 workflow 单查 loops 快 N 倍）
      const workflows = (await this.deps.workflowStore.listByOwner(t.ownerId)).filter(
        (w) => w.triggerId === t.id,
      );
      if (workflows.length === 0) continue;
      const workflowIds = new Set(workflows.map((w) => w.id));
      const loops = (await this.deps.loopStore.listByOwner(t.ownerId)).filter(
        (l) => l.enabled && workflowIds.has(l.workflowId),
      );
      for (const l of loops) {
        void this.deps.loopRunner
          .fire(l.id, payload, eventName, t.id)
          .catch((e) =>
            this.deps.logger.error(
              { loopId: l.id, err: (e as Error).message },
              "event fire failed",
            ),
          );
      }
    }
  }
}
