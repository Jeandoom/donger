import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Trigger } from "../domain/trigger.js";
import { evaluateMatcher } from "../domain/trigger-matcher.js";
import type { IncomingMessage } from "../domain/types.js";
import { renderPromptTemplate } from "../domain/workflow.js";
import type { LoopStore } from "../ports/loop-store.js";
import type { TriggerStore } from "../ports/trigger-store.js";
import type { WorkflowStore } from "../ports/workflow-store.js";
import type { Logger } from "../util/logger.js";

export interface LoopRunnerDeps {
  loopStore: LoopStore;
  workflowStore: WorkflowStore;
  triggerStore: TriggerStore;
  orchestrator: { handleMessage(msg: IncomingMessage): Promise<string | undefined> };
  workspaceRoot: string;
  channelId: string;
  logger: Logger;
}

export interface TestTriggerResult {
  sourceOutput: string;
  matched: boolean;
  debug?: unknown;
  error?: string;
}

export class LoopRunner {
  private readonly running = new Set<string>();

  constructor(private readonly deps: LoopRunnerDeps) {}

  async fire(loopId: string, sourceOutput: string): Promise<void> {
    if (this.running.has(loopId)) {
      this.deps.logger.info({ loopId }, "skip: previous run still active");
      return;
    }
    this.running.add(loopId);
    try {
      await this.runOnce(loopId, sourceOutput);
    } finally {
      this.running.delete(loopId);
    }
  }

  private async runOnce(loopId: string, sourceOutput: string): Promise<void> {
    const {
      loopStore,
      workflowStore,
      triggerStore,
      orchestrator,
      workspaceRoot,
      channelId,
      logger,
    } = this.deps;
    const loop = await loopStore.get(loopId);
    if (!loop) throw new Error(`loop 不存在: ${loopId}`);
    const workflow = loop.workflowId ? await workflowStore.get(loop.workflowId) : undefined;
    const trigger = workflow?.triggerId ? await triggerStore.get(workflow.triggerId) : undefined;
    const now = new Date().toISOString();
    const runId = crypto.randomUUID();
    const loopDir = workflow ? join(workspaceRoot, workflow.name, runId) : null;
    const run = await loopStore.createRun({
      id: runId,
      loopId,
      workflowId: loop.workflowId,
      triggerId: trigger?.id ?? "",
      agentId: workflow?.agentId ?? "",
      status: "running",
      triggerOutput: sourceOutput,
      loopDir,
      startedAt: now,
    });

    if (!workflow || !trigger) {
      const err = "workflow/trigger missing";
      await loopStore.updateRun(run.id, {
        status: "failed",
        error: err,
        finishedAt: new Date().toISOString(),
      });
      await loopStore.updateRuntimeState(loopId, {
        lastRunId: run.id,
        lastRunAt: now,
        lastError: err,
      });
      return;
    }

    try {
      const prompt = renderPromptTemplate(workflow.promptTemplate, sourceOutput);
      await loopStore.updateRun(run.id, { renderedPrompt: prompt });
      if (loopDir) mkdirSync(loopDir, { recursive: true });
      const msg: IncomingMessage = {
        channelId,
        threadId: loopId,
        requesterId: loop.ownerId,
        text: prompt,
      };
      const agentConversationId = await orchestrator.handleMessage(msg);
      await loopStore.updateRun(run.id, {
        status: "success",
        finishedAt: new Date().toISOString(),
        agentConversationId: agentConversationId ?? null,
      });
      await loopStore.updateRuntimeState(loopId, {
        lastRunId: run.id,
        lastRunAt: now,
        lastError: null,
      });
    } catch (e) {
      const err = (e as Error).message;
      logger.error({ loopId, err }, "loop run failed");
      await loopStore.updateRun(run.id, {
        status: "failed",
        error: err,
        finishedAt: new Date().toISOString(),
      });
      await loopStore.updateRuntimeState(loopId, {
        lastRunId: run.id,
        lastRunAt: now,
        lastError: err,
      });
    }
  }

  async testTrigger(triggerId: string): Promise<TestTriggerResult> {
    const { triggerStore } = this.deps;
    const t: Trigger | undefined = await triggerStore.get(triggerId);
    if (!t) return { sourceOutput: "", matched: false, error: "trigger 不存在" };
    if (t.type === "hook") {
      return {
        sourceOutput: "",
        matched: false,
        debug: { hookUrl: t.hook?.path, method: "POST" },
        error: "hook 类型 trigger 需外部请求测试",
      };
    }
    const sched = t.scheduler;
    if (!sched) return { sourceOutput: "", matched: false, error: "scheduler 配置缺失" };

    let sourceOutput = "";
    let httpStatus: number | undefined;
    let headers: Record<string, string> | undefined;
    try {
      if (sched.source.type === "http") {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 10_000);
        try {
          const r = await fetch(sched.source.url, {
            method: sched.source.method,
            headers: sched.source.headers,
            body: sched.source.body,
            signal: ctrl.signal,
          });
          httpStatus = r.status;
          headers = Object.fromEntries(r.headers.entries());
          sourceOutput = await r.text();
        } finally {
          clearTimeout(timer);
        }
      } else {
        const { readFile } = await import("node:fs/promises");
        sourceOutput = await readFile(sched.source.path, "utf8");
      }
    } catch (e) {
      return {
        sourceOutput,
        matched: false,
        error: `source fetch failed: ${(e as Error).message}`,
      };
    }

    const result = evaluateMatcher(sched.matcher, { body: sourceOutput, httpStatus, headers });
    return {
      sourceOutput,
      matched: result.matched,
      debug: result.debug,
      error: result.error,
    };
  }
}
