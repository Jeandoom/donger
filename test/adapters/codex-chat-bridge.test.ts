import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  ChatToResponsesTranslator,
  CodexChatBridge,
  mapChatUsageToResponses,
  SseDataParser,
  translateResponsesRequestToChat,
} from "../../src/adapters/codex-chat-bridge.js";

describe("translateResponsesRequestToChat", () => {
  it("instructions→system、字符串 input→单条 user 消息", () => {
    const chat = translateResponsesRequestToChat(
      { model: "m1", instructions: "sys", input: "hi" },
      "fallback",
    );
    expect(chat.model).toBe("m1");
    expect(chat.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]);
    expect(chat.stream).toBe(true);
    expect(chat.stream_options).toEqual({ include_usage: true });
  });

  it("message/function_call/function_call_output 完整回放，reasoning 跳过", () => {
    const chat = translateResponsesRequestToChat(
      {
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "看下文件" }] },
          { type: "reasoning", summary: [] },
          {
            type: "function_call",
            call_id: "call_1",
            name: "shell",
            arguments: '{"command":["ls"]}',
          },
          { type: "function_call_output", call_id: "call_1", output: "a.txt" },
        ],
      },
      "fallback",
    );
    expect(chat.messages).toEqual([
      { role: "user", content: "看下文件" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "shell", arguments: '{"command":["ls"]}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "a.txt" },
    ]);
  });

  it("function 工具映射为 chat tools，非 function 类型跳过", () => {
    const chat = translateResponsesRequestToChat(
      {
        input: "hi",
        tools: [
          { type: "function", name: "shell", description: "run", parameters: { type: "object" } },
          { type: "web_search" },
        ],
      },
      "fallback",
    );
    expect(chat.tools).toEqual([
      {
        type: "function",
        function: { name: "shell", description: "run", parameters: { type: "object" } },
      },
    ]);
  });
});

describe("ChatToResponsesTranslator", () => {
  it("文本增量：added 只发一次、delta 转发、finish 补 done+completed", () => {
    const t = new ChatToResponsesTranslator("resp_1");
    expect(t.createdEvent().type).toBe("response.created");
    const e1 = t.handleChunk({ choices: [{ delta: { content: "你" } }] });
    const e2 = t.handleChunk({ choices: [{ delta: { content: "好" } }] });
    expect(e1.map((e) => e.type)).toEqual([
      "response.output_item.added",
      "response.output_text.delta",
    ]);
    expect(e1[1]).toMatchObject({ delta: "你" });
    expect(e2.map((e) => e.type)).toEqual(["response.output_text.delta"]);
    const end = t.finish();
    expect(end.map((e) => e.type)).toEqual([
      "response.output_text.done",
      "response.output_item.done",
      "response.completed",
    ]);
    const completed = end.find((e) => e.type === "response.completed") as {
      response: { output: Array<{ type: string; content?: unknown }> };
    };
    const message = completed.response.output.find((o) => o.type === "message");
    expect(message?.content).toEqual([{ type: "output_text", text: "你好" }]);
  });

  it("reasoning_content→reasoning item；tool_calls 分片累积；usage 映射进 completed", () => {
    const t = new ChatToResponsesTranslator("resp_2");
    t.handleChunk({ choices: [{ delta: { reasoning_content: "思考" } }] });
    const added1 = t.handleChunk({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: "call_9", function: { name: "shell", arguments: '{"a"' } },
            ],
          },
        },
      ],
    });
    t.handleChunk({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ":1}" } }] } }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 3 },
        completion_tokens_details: { reasoning_tokens: 2 },
      },
    });
    const end = t.finish();
    const added = [...added1.filter((e) => e.type === "response.output_item.added")];
    expect(added.map((e) => (e as { item: { type: string } }).item.type)).toEqual([
      "function_call",
    ]);
    const argDeltas = end.filter((e) => e.type === "response.function_call_arguments.delta");
    expect(argDeltas).toEqual([]);
    const argDone = end.find((e) => e.type === "response.function_call_arguments.done") as {
      arguments: string;
    };
    expect(argDone.arguments).toBe('{"a":1}');
    const completed = end.find((e) => e.type === "response.completed") as {
      response: { usage: Record<string, unknown> };
    };
    expect(completed.response.usage).toEqual(
      mapChatUsageToResponses({
        prompt_tokens: 10,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 3 },
        completion_tokens_details: { reasoning_tokens: 2 },
      }),
    );
    expect(completed.response.usage).toMatchObject({
      input_tokens: 10,
      output_tokens: 5,
      input_tokens_details: { cached_tokens: 3 },
      output_tokens_details: { reasoning_tokens: 2 },
      total_tokens: 15,
    });
  });

  it("failedEvent 透传 code+message（codex 侧映射 turn.failed）", () => {
    const t = new ChatToResponsesTranslator();
    const event = t.failedEvent("401", "bad key");
    expect(event).toMatchObject({
      type: "response.failed",
      response: { error: { code: "401", message: "bad key" } },
    });
  });
});

describe("SseDataParser", () => {
  it("跨 chunk 断行与 CRLF 容错", () => {
    const out: string[] = [];
    const parser = new SseDataParser((data) => out.push(data));
    parser.feed('data: {"a');
    parser.feed('":1}\r\n\r\ndata: [DONE]\n\n');
    expect(out).toEqual(['{"a":1}', "[DONE]"]);
  });
});

describe("CodexChatBridge（端到端：responses 请求 → 假上游 chat SSE → responses SSE）", () => {
  const servers: Server[] = [];
  const bridges: CodexChatBridge[] = [];

  afterEach(async () => {
    for (const bridge of bridges.splice(0)) await bridge.close();
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  function startFakeUpstream(): Promise<{ server: Server; port: number; seen: unknown }> {
    const seen: { current?: unknown } = {};
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        seen.current = JSON.parse(body);
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "OK" } }] })}\n\n`);
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 1 } })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const port = (server.address() as { port: number }).port;
        servers.push(server);
        resolve({ server, port, seen: seen as unknown });
      });
    });
  }

  it("鉴权失败 401；成功路径产出 created→delta→completed 且上游请求为 chat 形态", async () => {
    const upstream = await startFakeUpstream();
    const bridge = new CodexChatBridge();
    bridges.push(bridge);
    const port = await bridge.ensureStarted();

    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      body: "{}",
    });
    expect(noAuth.status).toBe(401);

    bridge.registerUpstream("tok", {
      baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
      apiKey: "sk-test",
      model: "test-model",
    });

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { "x-donger-bridge": "tok", "content-type": "application/json" },
      body: JSON.stringify({ instructions: "sys", input: "hi", model: "glm-x" }),
    });
    expect(response.ok).toBe(true);
    const text = await response.text();
    const events = text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as { type: string });
    expect(events[0]?.type).toBe("response.created");
    expect(events.map((e) => e.type)).toContain("response.output_text.delta");
    expect(events.at(-1)?.type).toBe("response.completed");

    expect(
      (upstream.seen as { current?: { model: string; messages: unknown[] } }).current,
    ).toMatchObject({
      model: "glm-x",
    });
    const messages = (upstream.seen as { current?: { messages: Array<{ role: string }> } }).current
      ?.messages;
    expect(messages?.[0]).toEqual({ role: "system", content: "sys" });
  });

  it("上游 4xx → response.failed 且错误信息截断回传", async () => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        void body;
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Invalid API key" } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const upstreamPort = (server.address() as { port: number }).port;

    const bridge = new CodexChatBridge();
    bridges.push(bridge);
    const port = await bridge.ensureStarted();
    bridge.registerUpstream("tok", {
      baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      apiKey: "k",
      model: "m",
    });

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { "x-donger-bridge": "tok" },
      body: "{}",
    });
    const text = await response.text();
    expect(text).toContain("response.failed");
    expect(text).toContain("Invalid API key");
  });
});

describe("CodexChatBridge MCP 挂载（真实 MCP 客户端回环）", () => {
  const bridges: CodexChatBridge[] = [];

  afterEach(async () => {
    for (const bridge of bridges.splice(0)) await bridge.close();
  });

  async function mountTestServer(options?: {
    gateCheck?: Parameters<CodexChatBridge["mountMcp"]>[3];
  }) {
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { z } = await import("zod");
    const bridge = new CodexChatBridge();
    bridges.push(bridge);
    const instance = new McpServer({ name: "donger-test", version: "1.0.0" });
    instance.registerTool(
      "echo",
      { inputSchema: { text: z.string() } },
      async ({ text }: { text: string }) => ({ content: [{ type: "text", text }] }),
    );
    instance.registerTool("danger_write", { inputSchema: {} }, async () => ({
      content: [{ type: "text", text: "不应到达" }],
    }));
    const url = await bridge.mountMcp(
      "run-tok",
      "donger-test",
      instance as never,
      options?.gateCheck,
    );
    return { bridge, url };
  }

  it("tools/list + tools/call 全链路", async () => {
    const { url } = await mountTestServer();
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/streamableHttp.js"
    );
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["echo", "danger_write"]),
    );
    const result = await client.callTool({ name: "echo", arguments: { text: "ping" } });
    expect(result).toMatchObject({ content: [{ type: "text", text: "ping" }] });
    await client.close();
  });

  it("审批门命中 → isError 拒绝结果，工具实现不执行", async () => {
    const { url } = await mountTestServer({
      gateCheck: (tool) =>
        tool === "mcp__donger-test__danger_write"
          ? { gateId: "authoring", force: true }
          : undefined,
    });
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/streamableHttp.js"
    );
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    const denied = (await client.callTool({ name: "danger_write", arguments: {} })) as {
      isError?: boolean;
      content?: Array<{ text?: string }>;
    };
    expect(denied.isError).toBe(true);
    expect(denied.content?.[0]?.text).toContain("authoring");
    const allowed = await client.callTool({ name: "echo", arguments: { text: "fine" } });
    expect(allowed).toMatchObject({ content: [{ type: "text", text: "fine" }] });
    await client.close();
  });

  it("未知 run-token 的挂载路径 404", async () => {
    await mountTestServer();
    const bridge = bridges[0] as CodexChatBridge;
    const port = await bridge.ensureStarted();
    const response = await fetch(`http://127.0.0.1:${port}/mcp/wrong-token/donger-test`, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(404);
  });
});
