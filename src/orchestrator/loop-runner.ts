import { mkdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { validateTriggerHttpUrlDeep } from "../domain/net-target.js";
import type { Trigger } from "../domain/trigger.js";
import { evaluateMatcher } from "../domain/trigger-matcher.js";
import type { IncomingMessage } from "../domain/types.js";
import { wrapUntrusted } from "../domain/untrusted-content.js";
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
  /** 触发器 http source 是否允许内网目标（TRIGGER_ALLOW_PRIVATE_NET，默认 false） */
  allowPrivateNet?: boolean;
}

/** 触发器 http source 响应体上限：防大响应打爆内存（matcher 只需小样本即可判定） */
const TRIGGER_HTTP_MAX_BODY_BYTES = 1024 * 1024;

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
    // 属主复核（纵深）：workflow 与 loop 必须同人，防历史脏数据借他人 agent 装备运行
    if (workflow && workflow.ownerId !== loop.ownerId) {
      this.deps.logger.warn(
        { loopId, workflowId: workflow.id },
        "workflow owner mismatch, skip run",
      );
      return;
    }
    const trigger = workflow?.triggerId ? await triggerStore.get(workflow.triggerId) : undefined;
    const now = new Date().toISOString();
    const runId = crypto.randomUUID();
    // workflow.name 会拼进全局 workspaceRoot 下的运行目录，未消毒的 .. / 分隔符 = 任意位置建目录
    const safeWorkflowName = sanitizeWorkflowDirName(workflow?.name);
    const loopDir = safeWorkflowName ? join(workspaceRoot, safeWorkflowName, runId) : null;
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
      // hook body / 定时源内容是不可信外部数据（规格 §5.1）：包装定界后再插值进模板
      const prompt = renderPromptTemplate(
        workflow.promptTemplate,
        wrapUntrusted(sourceOutput, "trigger-source").wrapped,
      );
      await loopStore.updateRun(run.id, { renderedPrompt: prompt });
      if (loopDir) mkdirSync(loopDir, { recursive: true });
      const msg: IncomingMessage = {
        channelId,
        threadId: loopId,
        requesterId: loop.ownerId,
        text: prompt,
        // 无人值守触发：orchestrator 据此强制按变更前问询执行（full_access 仅限交互式会话）
        unattended: true,
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
        // SSRF 收口：仅 http/https、默认拒绝内网（含解析级复判，防通配域名挂私网地址）、
        // 手动跟随重定向（防 302 跳内网绕过）
        const validated = await validateTriggerHttpUrlDeep(
          sched.source.url,
          !!this.deps.allowPrivateNet,
        );
        if (!validated) {
          return {
            sourceOutput: "",
            matched: false,
            error:
              "source url 被拒绝：仅支持 http/https 公网目标（内网目标须 TRIGGER_ALLOW_PRIVATE_NET=true）",
          };
        }
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 10_000);
        try {
          const r = await fetch(validated, {
            method: sched.source.method,
            headers: sched.source.headers,
            ...(sched.source.body ? { body: sched.source.body } : {}),
            signal: ctrl.signal,
            redirect: "manual",
          });
          httpStatus = r.status;
          headers = Object.fromEntries(r.headers.entries());
          sourceOutput = await readBodyWithCap(r, TRIGGER_HTTP_MAX_BODY_BYTES);
        } finally {
          clearTimeout(timer);
        }
      } else {
        // file source 收口：仅允许工作区内路径（否则 /test 即任意文件读取回显）
        const { readFile } = await import("node:fs/promises");
        const root = resolve(this.deps.workspaceRoot);
        const target = resolve(root, sched.source.path);
        const inside = target === root || target.startsWith(root + sep);
        if (!inside) {
          return {
            sourceOutput: "",
            matched: false,
            error: "source path 必须位于工作区内",
          };
        }
        sourceOutput = (await readFile(target, "utf8")).slice(0, TRIGGER_HTTP_MAX_BODY_BYTES);
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

/** 带上限读取响应体：超过 cap 即截断（防大响应打爆内存） */
async function readBodyWithCap(r: Response, cap: number): Promise<string> {
  const reader = r.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let out = "";
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    out += decoder.decode(value, { stream: true });
    if (received >= cap) {
      void reader.cancel().catch(() => {});
      return `${out.slice(0, cap)}\n[truncated: response exceeded ${cap} bytes]`;
    }
  }
  out += decoder.decode();
  return out;
}

/** 运行目录名消毒：仅保留字面安全字符，空结果返回 null（调用方不建目录） */
function sanitizeWorkflowDirName(name: string | undefined): string | null {
  if (!name) return null;
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\.\./g, "_")
    .replace(/^[\s.]+|[\s.]+$/g, "")
    .trim();
  if (!cleaned || cleaned.length > 64) return null;
  return cleaned;
}
