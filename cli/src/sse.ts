import { ApiError, errorKind } from "./api.js";
import type { SSEEvent } from "./types.js";

/**
 * 解析 SSE 文本缓冲区为事件数组，返回未完结的剩余部分。
 * 纯函数：chunk 边界、keep-alive 注释、多事件块都在单测覆盖。
 */
export function parseSSEBuffer(buffer: string): { events: SSEEvent[]; rest: string } {
  const events: SSEEvent[] = [];
  let rest = buffer;
  for (;;) {
    const idx = rest.indexOf("\n\n");
    if (idx < 0) break;
    const block = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    const event = parseBlock(block);
    if (event) events.push(event);
  }
  return { events, rest };
}

function parseBlock(block: string): SSEEvent | null {
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith(":")) continue; // keep-alive 注释
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return null;
  try {
    const parsed = JSON.parse(dataLines.join("\n")) as SSEEvent;
    return typeof parsed?.type === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 订阅后端会话 SSE 流（后端 EventSource 兼容：认证走 ?token= 查询参数）。
 * yield 每个 SSE 事件；连接关闭或 signal 中止时结束。
 */
export async function* streamSSE(
  url: string,
  token: string,
  signal?: AbortSignal,
): AsyncGenerator<SSEEvent> {
  const sep = url.includes("?") ? "&" : "?";
  const res = await fetch(`${url}${sep}token=${encodeURIComponent(token)}`, {
    headers: { Accept: "text/event-stream" },
    signal,
  });
  if (!res.ok || !res.body) {
    throw new ApiError(
      errorKind(res.status),
      res.status,
      `SSE 连接失败：${res.status} ${res.statusText}`,
    );
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = parseSSEBuffer(buffer);
      buffer = rest;
      for (const e of events) yield e;
    }
  } finally {
    reader.releaseLock();
  }
}
