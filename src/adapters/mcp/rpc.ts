/**
 * 极简 MCP（Model Context Protocol）Streamable HTTP 服务端——JSON-RPC 2.0 消息处理。
 *
 * 只实现工具型 server 需要的最小面（spec 2025-03-26/2025-06-18 兼容）：
 *   initialize / notifications/* / ping / tools/list / tools/call
 * 无状态运行：不为客户端分配 Mcp-Session-Id，GET(SSE)/DELETE 返回 405，
 * 客户端按 spec 以纯 POST JSON 工作。不引入 @modelcontextprotocol/sdk 依赖。
 *
 * 协议函数保持纯（不触 HTTP）：入参为已解析的 JSON 消息，出参为 {status, body?}，
 * HTTP 装配（鉴权、读写 body、写响应）在 web-channel.ts。
 */

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpToolResult {
  /** MCP content 数组；工具型 server 只产文本块 */
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface McpToolDef {
  name: string;
  description: string;
  /** JSON Schema（draft 2020-12） */
  inputSchema: Record<string, unknown>;
  handler(args: Record<string, unknown>): Promise<McpToolResult>;
}

export interface McpHandlerCtx {
  tools: McpToolDef[];
  serverInfo: { name: string; version: string };
  /** 客户端可读的使用说明（initialize.instructions，可选） */
  instructions?: string;
}

export function textResult(text: string, isError = false): McpToolResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

/** 响应 id：通知（无 id）不产生响应，进入 ok/err 时必有 id */
type JsonRpcId = string | number;

function ok(id: JsonRpcId, result: Record<string, unknown>): Json {
  return { jsonrpc: "2.0", id, result } as Json;
}

function err(id: JsonRpcId | null, code: number, message: string): Json {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

const ERROR_METHOD_NOT_FOUND = -32601;
const ERROR_INVALID_REQUEST = -32600;

async function handleOne(msg: JsonRpcRequest, ctx: McpHandlerCtx): Promise<Json | undefined> {
  // 通知与无 id 消息：不响应（spec：服务器不得回复 notification）
  if (msg.id === undefined || msg.id === null || msg.method.startsWith("notifications/")) {
    return undefined;
  }
  switch (msg.method) {
    case "initialize": {
      const params = (msg.params ?? {}) as { protocolVersion?: string; clientInfo?: unknown };
      return ok(msg.id, {
        protocolVersion: params.protocolVersion ?? "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: ctx.serverInfo,
        ...(ctx.instructions ? { instructions: ctx.instructions } : {}),
      });
    }
    case "ping":
      return ok(msg.id, {});
    case "tools/list":
      return ok(msg.id, {
        tools: ctx.tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    case "tools/call": {
      const params = (msg.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      const tool = ctx.tools.find((t) => t.name === params.name);
      if (!tool) {
        return err(msg.id, ERROR_METHOD_NOT_FOUND, `unknown tool: ${params.name ?? ""}`);
      }
      try {
        const result = await tool.handler(params.arguments ?? {});
        return ok(msg.id, {
          content: result.content,
          ...(result.isError ? { isError: true } : {}),
        });
      } catch (e) {
        return ok(msg.id, {
          content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
          isError: true,
        });
      }
    }
    default:
      return err(msg.id, ERROR_METHOD_NOT_FOUND, `method not supported: ${msg.method}`);
  }
}

/**
 * 处理一条 POST /mcp 的已解析消息（单条或批量）。
 * 返回 {status:202} 表示纯通知批（无响应体）；否则 200 + JSON 响应（单条或数组）。
 */
export async function handleMcpMessage(
  payload: unknown,
  ctx: McpHandlerCtx,
): Promise<{ status: 200 | 202 | 400; body?: Json }> {
  if (Array.isArray(payload)) {
    if (payload.length === 0)
      return { status: 400, body: err(null, ERROR_INVALID_REQUEST, "empty batch") };
    const responses = (
      await Promise.all(payload.map((m) => handleOne(m as JsonRpcRequest, ctx)))
    ).filter((r) => r !== undefined);
    if (responses.length === 0) return { status: 202 };
    return { status: 200, body: responses as Json };
  }
  if (typeof payload !== "object" || payload === null || !("method" in payload)) {
    return { status: 400, body: err(null, ERROR_INVALID_REQUEST, "invalid json-rpc request") };
  }
  const response = await handleOne(payload as JsonRpcRequest, ctx);
  if (response === undefined) return { status: 202 };
  return { status: 200, body: response };
}
