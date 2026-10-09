import { resolve, sep } from "node:path";
import type { Event } from "../domain/event.js";
import { evaluateMatcher } from "../domain/event-matcher.js";
import { sampleFeedbackCreatedPayload } from "../domain/event-payloads.js";
import { validateTriggerHttpUrlDeep } from "../domain/net-target.js";

/** 触发源响应体上限：防大响应打爆内存（matcher 只需小样本即可判定） */
const SOURCE_MAX_BODY_BYTES = 1024 * 1024;

export interface ProbeOptions {
  /** 定时事件 http source 是否允许内网目标（TRIGGER_ALLOW_PRIVATE_NET，默认 false） */
  allowPrivateNet?: boolean;
  /** file source 的工作区根（路径收口：仅允许工作区内） */
  workspaceRoot: string;
  /** true=matcher 不命中则 matched=false；false=抓到上下文即算命中（手动运行取上下文用） */
  gateByMatcher: boolean;
}

export interface ProbeResult {
  /** 事件上下文原文（payload；即 {{triggerOutput}} 与 matcher 判定对象） */
  sourceOutput: string;
  matched: boolean;
  debug?: unknown;
  error?: string;
}

/** 无条件定时上下文：到点即触发，携带触发时间（spec §5.1） */
export function buildTimerContext(event: Event, firedAt = new Date().toISOString()): string {
  return JSON.stringify({ event: "timer", eventName: event.name, firedAt });
}

export function buildCallContext(input: {
  query: string;
  data: Record<string, unknown>;
  method: string;
  path: string;
  firedAt?: string;
}): string {
  return JSON.stringify({ ...input, firedAt: input.firedAt ?? new Date().toISOString() });
}

/** 手动运行上下文：按事件类型给代表性样例（有条件定时现场抓取，其余给空/样例） */
export function buildManualContext(event: Event | undefined): string {
  if (!event) return "";
  if (event.type === "system") return sampleFeedbackCreatedPayload();
  if (event.type === "call") {
    return buildCallContext({
      query: "",
      data: {},
      method: "MANUAL",
      path: event.call?.path ?? "",
    });
  }
  return buildTimerContext(event);
}

/**
 * 事件源探测（原 LoopRunner.testTrigger 收口迁移）：抓取定时事件的 http/file 源并跑
 * matcher。SSRF 收口（仅 http/https、默认拒内网含解析级复判、手动跟随重定向）与
 * file 源工作区收口原样保留。
 */
export async function probeEventSource(event: Event, opts: ProbeOptions): Promise<ProbeResult> {
  if (event.type !== "schedule" || !event.schedule) {
    if (event.type === "call") {
      return {
        sourceOutput: "",
        matched: false,
        debug: { path: event.call?.path, methods: event.call?.methods },
        error: "call 类型需外部请求触发（URL 见事件详情）",
      };
    }
    if (event.type === "system") {
      const sourceOutput = sampleFeedbackCreatedPayload();
      const result = evaluateMatcher(event.system?.matcher ?? { kind: "always" }, {
        body: sourceOutput,
      });
      return { sourceOutput, matched: result.matched, debug: result.debug, error: result.error };
    }
    return { sourceOutput: "", matched: false, error: "事件配置缺失" };
  }
  const sched = event.schedule;
  if (sched.mode === "unconditional" || !sched.source) {
    return { sourceOutput: buildTimerContext(event), matched: true };
  }

  let sourceOutput = "";
  let httpStatus: number | undefined;
  let headers: Record<string, string> | undefined;
  try {
    if (sched.source.type === "http") {
      const validated = await validateTriggerHttpUrlDeep(sched.source.url, !!opts.allowPrivateNet);
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
        sourceOutput = await readBodyWithCap(r, SOURCE_MAX_BODY_BYTES);
      } finally {
        clearTimeout(timer);
      }
    } else {
      // file source 收口：仅允许工作区内路径（否则 /test 即任意文件读取回显）
      const { readFile } = await import("node:fs/promises");
      const root = resolve(opts.workspaceRoot);
      const target = resolve(root, sched.source.path);
      const inside = target === root || target.startsWith(root + sep);
      if (!inside) {
        return { sourceOutput: "", matched: false, error: "source path 必须位于工作区内" };
      }
      sourceOutput = (await readFile(target, "utf8")).slice(0, SOURCE_MAX_BODY_BYTES);
    }
  } catch (e) {
    return { sourceOutput, matched: false, error: `source fetch failed: ${(e as Error).message}` };
  }

  const result = evaluateMatcher(sched.matcher ?? { kind: "always" }, {
    body: sourceOutput,
    httpStatus,
    headers,
  });
  if (!opts.gateByMatcher) {
    return { sourceOutput, matched: true, debug: result.debug };
  }
  return { sourceOutput, matched: result.matched, debug: result.debug, error: result.error };
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
