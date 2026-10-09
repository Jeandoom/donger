import { evaluateMatcher } from "../domain/event-matcher.js";
import type { EventStore } from "../ports/event-store.js";
import type { Logger } from "../util/logger.js";
import type { EventDispatcher } from "./event-dispatcher.js";

export interface SystemEventDispatcherDeps {
  eventStore: EventStore;
  dispatcher: EventDispatcher;
  logger: Logger;
}

/**
 * 进程内系统事件分发（原 event-trigger-dispatcher，spec 2026-09-28-event-trigger-feedback-design
 * §5 语义不变）：事件发生时实时查订阅事件（增删改即时生效，零注册），matcher 判定
 * payload JSON 后经统一管线投递。调用方须 fire-and-forget（fail-open）：
 * 事件任何异常不得影响事件源主流程。
 */
export class SystemEventDispatcher {
  constructor(private readonly deps: SystemEventDispatcherDeps) {}

  async dispatch(eventName: string, payload: string): Promise<void> {
    const events = (await this.deps.eventStore.listAll()).filter(
      (e) => e.type === "system" && e.system?.name === eventName,
    );
    for (const e of events) {
      const match = evaluateMatcher(e.system?.matcher ?? { kind: "always" }, { body: payload });
      if (!match.matched) {
        this.deps.logger.debug(
          { eventName, eventId: e.id, debug: match.debug },
          "system event not matched",
        );
        continue;
      }
      void this.deps.dispatcher
        .fire(e.id, { payload }, "system")
        .catch((err: Error) =>
          this.deps.logger.error({ eventId: e.id, err: err.message }, "system event fire failed"),
        );
    }
  }
}
