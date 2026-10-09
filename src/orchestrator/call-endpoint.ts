import { evaluateMatcher } from "../domain/event-matcher.js";
import type { EventStore } from "../ports/event-store.js";
import type { Logger } from "../util/logger.js";
import type { EventDispatcher } from "./event-dispatcher.js";
import { buildCallContext } from "./event-source-probe.js";

export interface CallEndpointDeps {
  eventStore: EventStore;
  dispatcher: EventDispatcher;
  logger: Logger;
}

export interface CallHandleResult {
  status: number;
  body: string;
}

export interface CallRequest {
  method?: string;
  url?: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * 调用事件入口（原 hook-registry，spec §5.3）：/hooks/<随机路径> 免认证外部回调，
 * GET 与 POST 同时代理（D3：随机路径+既有双限流兜底，不加 token）。
 * payload 归一为 {query, data, method, path, firedAt} JSON：
 * - POST：body 须为 {"query":"...","data":{}}；非 JSON 宽容降级（整体作为 query、data 空）
 * - GET：?query=... 之外的全部查询参数收进 data（平铺 k=v）
 * 匹配器判定对象=归一后 JSON；未命中不触发（静默，同旧行为）。任何异常不得外泄内部细节。
 */
export class CallEndpoint {
  constructor(private readonly deps: CallEndpointDeps) {}

  async handle(req: CallRequest): Promise<CallHandleResult> {
    const path = extractPath(req.url);
    const event = await this.deps.eventStore.findByCallPath(path);
    if (!event?.call) return { status: 404, body: "not found" };
    const method = (req.method ?? "POST").toUpperCase();
    const allowed = event.call.methods?.includes(method as "GET" | "POST") ?? method === "POST";
    if (!allowed) return { status: 405, body: "method not allowed" };

    const { query, data } = normalizeCallPayload(method, req.url, req.body);
    const context = buildCallContext({ query, data, method, path });
    const matchResult = evaluateMatcher(event.call.matcher, {
      body: context,
      headers: req.headers,
    });
    const response: CallHandleResult = {
      status: event.call.responseStatus,
      body: event.call.responseBody,
    };
    if (!matchResult.matched) {
      this.deps.logger.debug({ path, debug: matchResult.debug }, "call event not matched");
      return response;
    }
    // 异步触发不阻塞 HTTP 响应；fire=触发记录+入队+泵抽（忙时排队不丢）
    void this.deps.dispatcher
      .fire(event.id, { payload: context, query, data }, "call")
      .catch((e: Error) =>
        this.deps.logger.error({ eventId: event.id, err: e.message }, "call event fire failed"),
      );
    return response;
  }
}

function extractPath(url?: string): string {
  if (!url) return "";
  return url.split("?")[0] ?? "";
}

/** GET/POST payload 归一（宽容解析）；data 值尝试 JSON 解析，失败保留字符串 */
export function normalizeCallPayload(
  method: string,
  url: string | undefined,
  body: string,
): { query: string; data: Record<string, unknown> } {
  if (method === "GET") {
    const qs = url?.split("?")[1] ?? "";
    const params = new URLSearchParams(qs);
    const query = params.get("query") ?? "";
    const data: Record<string, unknown> = {};
    for (const [k, v] of params.entries()) {
      if (k === "query") continue;
      data[k] = tryParse(v);
    }
    return { query, data };
  }
  try {
    const parsed = JSON.parse(body) as { query?: unknown; data?: unknown };
    return {
      query: typeof parsed.query === "string" ? parsed.query : "",
      data:
        parsed.data && typeof parsed.data === "object" && !Array.isArray(parsed.data)
          ? (parsed.data as Record<string, unknown>)
          : {},
    };
  } catch {
    // 宽容降级：非 JSON body 整体作为 query（外部系统最简接入）
    return { query: body, data: {} };
  }
}

function tryParse(v: string): unknown {
  if (v === "") return "";
  try {
    return JSON.parse(v) as unknown;
  } catch {
    return v;
  }
}
