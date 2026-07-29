import { evaluateMatcher } from "../domain/trigger-matcher.js";
import type { LoopStore } from "../ports/loop-store.js";
import type { TriggerStore } from "../ports/trigger-store.js";
import type { WorkflowStore } from "../ports/workflow-store.js";
import type { Logger } from "../util/logger.js";
import type { LoopRunner } from "./loop-runner.js";

export interface HookRegistryDeps {
  triggerStore: TriggerStore;
  loopStore: LoopStore;
  workflowStore: WorkflowStore;
  loopRunner: LoopRunner;
  logger: Logger;
}

export interface HookHandleResult {
  status: number;
  body: string;
}

export interface HookRequest {
  method?: string;
  url?: string;
  headers: Record<string, string>;
  body: string;
}

export class HookRegistry {
  constructor(private readonly deps: HookRegistryDeps) {}

  async handle(req: HookRequest): Promise<HookHandleResult> {
    const path = extractPath(req.url);
    const t = await this.deps.triggerStore.findByHookPath(path);
    if (!t || !t.hook) return { status: 404, body: "not found" };

    const matchResult = evaluateMatcher(t.hook.matcher, { body: req.body, headers: req.headers });
    const response: HookHandleResult = {
      status: t.hook.responseStatus,
      body: t.hook.responseBody,
    };

    if (!matchResult.matched) {
      this.deps.logger.debug({ path, debug: matchResult.debug }, "hook not matched");
      return response;
    }

    // 找引用此 trigger 的 workflows 及其 enabled loops
    const workflows = (await this.deps.workflowStore.listByOwner(t.ownerId)).filter(
      (w) => w.triggerId === t.id,
    );
    for (const w of workflows) {
      const loops = (await this.deps.loopStore.listByOwner(t.ownerId)).filter(
        (l) => l.workflowId === w.id && l.enabled,
      );
      for (const l of loops) {
        // 异步触发，不阻塞 HTTP 响应
        void this.deps.loopRunner
          .fire(l.id, req.body)
          .catch((e) =>
            this.deps.logger.error({ loopId: l.id, err: (e as Error).message }, "hook fire failed"),
          );
      }
    }
    return response;
  }
}

function extractPath(url?: string): string {
  if (!url) return "";
  return url.split("?")[0];
}
