import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

/**
 * 内置 Responses↔Chat 协议桥（specs/2026-09-21-codex-openai-runner-design.md §7.0 修正）。
 *
 * 背景：codex 0.155+ 已硬移除 wire_api="chat"（仅剩 Responses 线协议），而国内 OpenAI
 * 协议平台（智谱/DeepSeek/Kimi 等）只提供 chat/completions——两侧无法直连。本桥在服务
 * 进程内起一个 127.0.0.1 专属 HTTP 端点，把 codex 发出的 Responses 请求翻译成上游
 * chat/completions（SSE 双向翻译），使任意 OpenAI 协议端点可被 codex 引擎消费。
 *
 * 同一端点第二职责（M2）：把 donger 的 in-process 平台工具台（platform/git/kb/audit，
 * Claude SDK 专属形态）以 Streamable HTTP MCP server 形态挂载给 codex，路径含 run-token
 * 鉴权；审批门命中（git-write/authoring/deploy 的 MCP 写工具）在桥内静态拒绝——openai
 * 会话无交互审批通道（决策点 ①A fail-closed）。
 *
 * 安全红利：上游 baseUrl/key 只注册在桥内（内存 Map），经 env_http_headers 引用的
 * run-token 仅用于鉴权——上游凭证不进 codex 子进程 env，不落 agent 可达面（防线 1）。
 */

/** 单次运行注册的上游端点（baseUrl 为 chat/completions 形态根，如 https://api.deepseek.com/v1） */
export interface ChatUpstreamConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** in-process MCP server 实例的最小结构面（Claude SDK createSdkMcpServer 产物即满足） */
export interface McpServerLike {
  connect(transport: unknown): Promise<void>;
  close?(): Promise<void>;
}

/** 审批门检查回调：返回命中的 gateId/force 或 undefined（复用 GateRouter.match 语义） */
export type McpGateCheck = (
  tool: string,
  input: Record<string, unknown>,
) => { gateId: string; force?: boolean } | undefined;

interface McpMount {
  runToken: string;
  serverName: string;
  transport: StreamableHTTPServerTransport;
  gateCheck?: McpGateCheck;
}

const MAX_BODY_BYTES = 64 * 1024 * 1024;
const BRIDGE_AUTH_HEADER = "x-donger-bridge";

// —— 请求翻译：Responses → chat/completions ——

type JsonRecord = Record<string, unknown>;

export interface ChatCompletionRequest {
  model: string;
  messages: Array<JsonRecord>;
  tools?: Array<JsonRecord>;
  tool_choice?: unknown;
  parallel_tool_calls?: unknown;
  stream: boolean;
  stream_options?: { include_usage: boolean };
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block as JsonRecord;
      if (typeof b.text === "string") parts.push(b.text);
    }
  }
  return parts.join("");
}

/**
 * 把 Responses 请求体翻译为 chat/completions 请求体。
 * input 支持字符串与 item 数组两种形态；reasoning/item_reference 等无 chat 对应的
 * item 跳过（chat 侧无状态回放不需要它们）。tools 仅映射 function 类型。
 */
export function translateResponsesRequestToChat(
  body: JsonRecord,
  fallbackModel: string,
): ChatCompletionRequest {
  const messages: Array<JsonRecord> = [];
  const instructions = typeof body.instructions === "string" ? body.instructions : "";
  if (instructions) messages.push({ role: "system", content: instructions });

  const input = body.input;
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    for (const raw of input) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as JsonRecord;
      const type = item.type;
      if (type === "message" || type === undefined) {
        const role = typeof item.role === "string" ? item.role : "user";
        const normalized = role === "developer" ? "system" : role;
        messages.push({ role: normalized, content: contentText(item.content) });
      } else if (type === "function_call") {
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: item.call_id,
              type: "function",
              function: { name: item.name, arguments: item.arguments ?? "{}" },
            },
          ],
        });
      } else if (type === "function_call_output") {
        const output = item.output;
        messages.push({
          role: "tool",
          tool_call_id: item.call_id,
          content: typeof output === "string" ? output : JSON.stringify(output ?? ""),
        });
      }
      // reasoning / web_search_call / item_reference 等：跳过
    }
  }

  const tools: Array<JsonRecord> = [];
  if (Array.isArray(body.tools)) {
    for (const raw of body.tools) {
      if (!raw || typeof raw !== "object") continue;
      const tool = raw as JsonRecord;
      if (tool.type === "function" && typeof tool.name === "string") {
        tools.push({
          type: "function",
          function: {
            name: tool.name,
            ...(typeof tool.description === "string" ? { description: tool.description } : {}),
            ...(tool.parameters !== undefined ? { parameters: tool.parameters } : {}),
          },
        });
      }
      // 非 function 工具（web_search 等服务端工具）：无 chat 对应，跳过
    }
  }

  const model = typeof body.model === "string" && body.model ? body.model : fallbackModel;
  return {
    model,
    messages,
    ...(tools.length ? { tools } : {}),
    ...(body.tool_choice !== undefined ? { tool_choice: body.tool_choice } : {}),
    ...(body.parallel_tool_calls !== undefined
      ? { parallel_tool_calls: body.parallel_tool_calls }
      : {}),
    stream: true,
    stream_options: { include_usage: true },
  };
}

// —— 响应翻译：chat/completions SSE → Responses SSE ——

export interface TranslatorEvent {
  payload: JsonRecord;
}

/**
 * 流式翻译器：喂入上游 chat chunk（JSON 对象），产出 Responses SSE 事件载荷序列。
 * 有状态：message/reasoning/function_call 的 output_item.added 只发一次，
 * delta 增量转发，finish 时补 output_item.done 与 response.completed。
 */
export class ChatToResponsesTranslator {
  private readonly responseId: string;
  private readonly emittedItems: Array<JsonRecord> = [];
  private outputIndex = 0;
  private messageId: string | null = null;
  private messageText = "";
  private reasoningId: string | null = null;
  /** 上游 tool_calls index → 桥内 function_call item 状态 */
  private readonly calls = new Map<
    number,
    { id: string; callId: string; name: string; arguments: string; done: boolean }
  >();
  private usage: JsonRecord | null = null;

  constructor(responseId = `resp_${randomUUID().replaceAll("-", "")}`) {
    this.responseId = responseId;
  }

  /** 首个事件：response.created（SSE 流开头发出） */
  createdEvent(): JsonRecord {
    return { type: "response.created", response: { id: this.responseId } };
  }

  /** 喂一个上游 chat SSE chunk，返回要下发的 Responses 事件载荷 */
  handleChunk(chunk: JsonRecord): JsonRecord[] {
    const events: JsonRecord[] = [];
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    for (const rawChoice of choices) {
      if (!rawChoice || typeof rawChoice !== "object") continue;
      const choice = rawChoice as JsonRecord;
      const delta = (choice.delta ?? {}) as JsonRecord;

      if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
        if (this.reasoningId === null) {
          this.reasoningId = `rs_${this.outputIndex}`;
          const item = { id: this.reasoningId, type: "reasoning", summary: [] };
          this.emittedItems.push(item);
          events.push({
            type: "response.output_item.added",
            output_index: this.outputIndex,
            item,
          });
          this.outputIndex += 1;
        }
        events.push({
          type: "response.reasoning_summary_text.delta",
          item_id: this.reasoningId,
          output_index: this.outputIndex - 1,
          delta: delta.reasoning_content,
        });
      }

      if (typeof delta.content === "string" && delta.content) {
        if (this.messageId === null) {
          this.messageId = `msg_${this.outputIndex}`;
          const item = {
            id: this.messageId,
            type: "message",
            role: "assistant",
            status: "in_progress",
            content: [],
          };
          this.emittedItems.push(item);
          events.push({
            type: "response.output_item.added",
            output_index: this.outputIndex,
            item,
          });
          this.outputIndex += 1;
        }
        this.messageText += delta.content;
        events.push({
          type: "response.output_text.delta",
          item_id: this.messageId,
          output_index: this.outputIndex - 1,
          delta: delta.content,
        });
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const rawCall of delta.tool_calls) {
          if (!rawCall || typeof rawCall !== "object") continue;
          const call = rawCall as JsonRecord;
          const index = typeof call.index === "number" ? call.index : 0;
          let state = this.calls.get(index);
          const fn = (call.function ?? {}) as JsonRecord;
          if (!state) {
            state = {
              id: `fc_${index}`,
              callId: typeof call.id === "string" && call.id ? call.id : `call_${index}`,
              name: typeof fn.name === "string" ? fn.name : "",
              arguments: "",
              done: false,
            };
            this.calls.set(index, state);
            const item = {
              id: state.id,
              type: "function_call",
              call_id: state.callId,
              name: state.name,
              arguments: "",
              status: "in_progress",
            };
            this.emittedItems.push(item);
            events.push({
              type: "response.output_item.added",
              output_index: this.outputIndex,
              item,
            });
            this.outputIndex += 1;
          }
          if (typeof call.id === "string" && call.id) state.callId = call.id;
          if (typeof fn.name === "string" && fn.name) state.name = fn.name;
          if (typeof fn.arguments === "string" && fn.arguments) {
            state.arguments += fn.arguments;
            events.push({
              type: "response.function_call_arguments.delta",
              item_id: state.id,
              output_index: this.outputIndex - 1,
              delta: fn.arguments,
            });
          }
        }
      }
    }

    if (chunk.usage && typeof chunk.usage === "object") {
      this.usage = chunk.usage as JsonRecord;
    }
    return events;
  }

  /** 上游流结束：补齐各 item 的 done 事件 + response.completed */
  finish(): JsonRecord[] {
    const events: JsonRecord[] = [];
    for (const [, call] of [...this.calls.entries()].sort((a, b) => a[0] - b[0])) {
      if (call.done) continue;
      call.done = true;
      events.push({
        type: "response.function_call_arguments.done",
        item_id: call.id,
        arguments: call.arguments,
      });
      const doneItem = {
        id: call.id,
        type: "function_call",
        call_id: call.callId,
        name: call.name,
        arguments: call.arguments,
        status: "completed",
      };
      events.push({
        type: "response.output_item.done",
        output_index: this.indexOfItem(call.id),
        item: doneItem,
      });
      // completed.output 引用同一对象：更新为完成形态（codex 从 response.completed 读最终输出）
      this.replaceItem(call.id, doneItem);
    }
    if (this.messageId !== null) {
      events.push({
        type: "response.output_text.done",
        item_id: this.messageId,
        text: this.messageText,
      });
      const doneItem = {
        id: this.messageId,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: this.messageText }],
      };
      events.push({
        type: "response.output_item.done",
        output_index: this.indexOfItem(this.messageId),
        item: doneItem,
      });
      this.replaceItem(this.messageId, doneItem);
    }
    if (this.reasoningId !== null) {
      const doneItem = { id: this.reasoningId, type: "reasoning", summary: [] };
      events.push({
        type: "response.output_item.done",
        output_index: this.indexOfItem(this.reasoningId),
        item: doneItem,
      });
      this.replaceItem(this.reasoningId, doneItem);
    }
    events.push({
      type: "response.completed",
      response: {
        id: this.responseId,
        output: this.emittedItems,
        ...(this.usage ? { usage: mapChatUsageToResponses(this.usage) } : {}),
      },
    });
    return events;
  }

  /** 上游失败：终止流（codex 侧映射为 turn.failed） */
  failedEvent(code: string, message: string): JsonRecord {
    return {
      type: "response.failed",
      response: { id: this.responseId, error: { code, message } },
    };
  }

  private indexOfItem(itemId: string): number {
    return this.emittedItems.findIndex((item) => (item as JsonRecord).id === itemId);
  }

  private replaceItem(itemId: string, doneItem: JsonRecord): void {
    const index = this.indexOfItem(itemId);
    if (index >= 0) this.emittedItems[index] = doneItem;
  }
}

/** chat usage → responses usage（字段映射，缺失容错） */
export function mapChatUsageToResponses(usage: JsonRecord): JsonRecord {
  const promptDetails = (usage.prompt_tokens_details ?? {}) as JsonRecord;
  const completionDetails = (usage.completion_tokens_details ?? {}) as JsonRecord;
  const inputTokens = numberOr(usage.prompt_tokens, 0);
  const outputTokens = numberOr(usage.completion_tokens, 0);
  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: numberOr(promptDetails.cached_tokens, 0) },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: numberOr(completionDetails.reasoning_tokens, 0) },
    total_tokens: inputTokens + outputTokens,
  };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

// —— HTTP 桥本体 ——

export class CodexChatBridge {
  private server: Server | null = null;
  private startPromise: Promise<number> | null = null;
  private readonly upstreams = new Map<string, ChatUpstreamConfig>();
  private readonly mcpMounts = new Map<string, McpMount>();

  /** 懒启动：绑定 127.0.0.1 随机端口，返回端口号（幂等） */
  ensureStarted(): Promise<number> {
    if (this.port()) return Promise.resolve(this.port() as number);
    if (!this.startPromise) {
      this.startPromise = new Promise((resolve, reject) => {
        const server = createServer((req, res) => {
          void this.handle(req, res).catch((error: unknown) => {
            if (!res.headersSent) {
              res.writeHead(500, { "content-type": "application/json" });
            }
            res.end(JSON.stringify({ error: { message: String(error) } }));
          });
        });
        // 长流式响应：关闭默认请求超时（上游生成可能远超 5 分钟）
        server.requestTimeout = 0;
        server.headersTimeout = 30_000;
        server.on("error", (error) => {
          this.startPromise = null;
          this.server = null;
          reject(error);
        });
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (!address || typeof address === "string") {
            reject(new Error("codex bridge listen 失败：非法地址"));
            return;
          }
          this.server = server;
          resolve(address.port);
        });
      });
    }
    return this.startPromise;
  }

  private port(): number | null {
    const address = this.server?.address();
    return address && typeof address !== "string" ? address.port : null;
  }

  registerUpstream(token: string, config: ChatUpstreamConfig): void {
    this.upstreams.set(token, config);
  }

  unregisterUpstream(token: string): void {
    this.upstreams.delete(token);
  }

  /**
   * 把 in-process MCP server 实例挂载为 Streamable HTTP MCP 端点（stateless 模式），
   * 路径含 run-token 鉴权。返回给 codex config.mcp_servers 用的完整 URL。
   */
  async mountMcp(
    runToken: string,
    serverName: string,
    instance: McpServerLike,
    gateCheck?: McpGateCheck,
  ): Promise<string> {
    const port = await this.ensureStarted();
    // stateful 会话模式：initialize 发 mcp-session-id，后续请求凭会话路由
    //（stateless 模式要求每请求新建 transport+实例，per-run 挂载不适用）
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
    });
    await instance.connect(transport as never);
    this.mcpMounts.set(mcpMountKey(runToken, serverName), {
      runToken,
      serverName,
      transport,
      gateCheck,
    });
    return `http://127.0.0.1:${port}/mcp/${runToken}/${serverName}`;
  }

  /** 运行结束卸载该 run 的全部挂载（transport 关闭；实例为 per-run 构造，随后自然 GC） */
  async unmountAllMcp(runToken: string): Promise<void> {
    for (const [key, mount] of [...this.mcpMounts.entries()]) {
      if (mount.runToken !== runToken) continue;
      this.mcpMounts.delete(key);
      try {
        await mount.transport.close();
      } catch {
        // 已断开/重复关闭忽略
      }
    }
  }

  mcpMountCountForTests(): number {
    return this.mcpMounts.size;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.startPromise = null;
    this.upstreams.clear();
    for (const key of [...this.mcpMounts.keys()]) this.mcpMounts.delete(key);
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  upstreamCountForTests(): number {
    return this.upstreams.size;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "";
    if (url.startsWith("/mcp/")) {
      await this.handleMcp(req, res, url);
      return;
    }
    if (req.method !== "POST" || !url.endsWith("/responses")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }
    const token = req.headers[BRIDGE_AUTH_HEADER];
    const upstream = typeof token === "string" ? this.upstreams.get(token) : undefined;
    if (!upstream) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "bridge auth failed" } }));
      return;
    }

    const body = await readBody(req);
    let parsed: JsonRecord;
    try {
      parsed = JSON.parse(body.toString("utf8")) as JsonRecord;
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid json body" } }));
      return;
    }

    const chatRequest = translateResponsesRequestToChat(parsed, upstream.model);
    if (process.env.DONGER_BRIDGE_DEBUG) {
      console.error(
        "[codex-bridge] responses→chat tools:",
        JSON.stringify(
          chatRequest.tools?.map((t) => (t as { function?: { name?: string } }).function?.name),
        ),
        "upstream stream requested:",
        (parsed as { stream?: unknown }).stream,
      );
    }
    const translator = new ChatToResponsesTranslator();
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    writeSse(res, translator.createdEvent());

    const abort = new AbortController();
    req.on("close", () => abort.abort());
    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetch(`${upstream.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${upstream.apiKey}`,
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify(chatRequest),
        signal: abort.signal,
      });
    } catch (error) {
      // 客户端主动断开（codex abort）属正常收尾，不写失败事件
      if (abort.signal.aborted) {
        res.end();
        return;
      }
      writeSse(res, translator.failedEvent("upstream_error", `上游连接失败：${String(error)}`));
      res.end();
      return;
    }

    if (!upstreamResponse.ok || !upstreamResponse.body) {
      const detail = await upstreamResponse.text().catch(() => "");
      writeSse(
        res,
        translator.failedEvent(
          String(upstreamResponse.status),
          sanitizeUpstreamError(upstreamResponse.status, detail),
        ),
      );
      res.end();
      return;
    }

    const parser = new SseDataParser((data) => {
      if (data === "[DONE]") return;
      try {
        const chunk = JSON.parse(data) as JsonRecord;
        for (const event of translator.handleChunk(chunk)) writeSse(res, event);
      } catch {
        // 非 JSON 行忽略（部分网关会夹带注释行）
      }
    });
    try {
      const reader = upstreamResponse.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.feed(Buffer.from(value).toString("utf8"));
      }
    } catch {
      // 上游中断：按已完成内容收尾（codex 收到 completed 即正常落账）
    }
    for (const event of translator.finish()) writeSse(res, event);
    res.end();
  }

  /** MCP 挂载请求处理：审批门拦截 tools/call，其余透传 StreamableHTTP transport */
  private async handleMcp(req: IncomingMessage, res: ServerResponse, url: string): Promise<void> {
    // /mcp/<runToken>/<serverName>
    const rest = url.slice("/mcp/".length);
    const slash = rest.indexOf("/");
    const runToken = slash > 0 ? rest.slice(0, slash) : "";
    const serverName = slash > 0 ? decodeURIComponent(rest.slice(slash + 1)) : "";
    const mount = this.mcpMounts.get(mcpMountKey(runToken, serverName));
    if (!mount) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "mcp mount not found" } }));
      return;
    }

    if (req.method !== "POST") {
      // stateless 模式无服务端主动推送：GET/DELETE 交 transport 处理（其会回 405）
      await mount.transport.handleRequest(req, res).catch(() => {});
      return;
    }

    const body = await readBody(req);
    let parsed: JsonRecord;
    try {
      parsed = JSON.parse(body.toString("utf8")) as JsonRecord;
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid json body" } }));
      return;
    }

    // 审批门静态拒绝（决策点 ①A）：git-write/authoring 等写工具在 openai 会话无人工通道
    if (parsed.method === "tools/call" && mount.gateCheck) {
      const params = (parsed.params ?? {}) as JsonRecord;
      const toolName = typeof params.name === "string" ? params.name : "";
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const gated = mount.gateCheck(`mcp__${mount.serverName}__${toolName}`, args);
      if (gated) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: parsed.id ?? null,
            result: {
              content: [
                {
                  type: "text",
                  text: `操作被拒绝：${gated.gateId} 门要求人工审批，OpenAI 引擎会话无交互审批通道（fail-closed）。如需执行请在 Claude 引擎会话中完成。`,
                },
              ],
              isError: true,
            },
          }),
        );
        return;
      }
    }

    await mount.transport.handleRequest(req, res, parsed).catch(() => {});
  }
}

/** 只回分类信息 + 截断后的上游错误摘要（不透传完整 body，防内网信息回显） */
function sanitizeUpstreamError(status: number, detail: string): string {
  let message = `上游返回 ${status}`;
  try {
    const parsed = JSON.parse(detail) as JsonRecord;
    const error = (parsed.error ?? {}) as JsonRecord;
    if (typeof error.message === "string" && error.message) message += `：${error.message}`;
  } catch {
    if (detail) message += `：${detail.slice(0, 200)}`;
  }
  return message.slice(0, 500);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function writeSse(res: ServerResponse, payload: JsonRecord): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/** SSE data 行解析：容忍跨 chunk 断行与 CRLF */
export class SseDataParser {
  private buffer = "";
  private current = "";

  constructor(private readonly onData: (data: string) => void) {}

  feed(text: string): void {
    this.buffer += text.replace(/\r\n/g, "\n");
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.startsWith("data:")) {
        this.current += (this.current ? "\n" : "") + line.slice(5).trim();
      } else if (line === "" && this.current) {
        this.onData(this.current);
        this.current = "";
      }
      newline = this.buffer.indexOf("\n");
    }
  }
}

function mcpMountKey(runToken: string, serverName: string): string {
  return `${runToken}/${serverName}`;
}
