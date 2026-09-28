import { describe, expect, it } from "vitest";
import { handleMcpMessage, type McpToolDef, textResult } from "../../src/adapters/mcp/rpc.js";

const echoTool: McpToolDef = {
  name: "echo",
  description: "echo input",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
  handler: async (args) => textResult(`echo:${String(args.text ?? "")}`),
};

const boomTool: McpToolDef = {
  name: "boom",
  description: "throws",
  inputSchema: { type: "object" },
  handler: async () => {
    throw new Error("工具内部失败");
  },
};

const ctx = { tools: [echoTool, boomTool], serverInfo: { name: "donger", version: "0.1.0" } };

describe("handleMcpMessage（MCP Streamable HTTP JSON-RPC 最小实现）", () => {
  it("initialize：回显协议版本 + serverInfo + tools 能力", async () => {
    const { status, body } = await handleMcpMessage(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      ctx,
    );
    expect(status).toBe(200);
    const result = (body as { result: Record<string, unknown> }).result;
    expect(result.protocolVersion).toBe("2025-06-18");
    expect(result.capabilities).toEqual({ tools: {} });
    expect(result.serverInfo).toEqual({ name: "donger", version: "0.1.0" });
  });

  it("notifications/initialized → 202 无响应体", async () => {
    const { status, body } = await handleMcpMessage(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      ctx,
    );
    expect(status).toBe(202);
    expect(body).toBeUndefined();
  });

  it("tools/list 返回工具清单", async () => {
    const { body } = await handleMcpMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, ctx);
    const tools = (body as { result: { tools: Array<{ name: string }> } }).result.tools;
    expect(tools.map((t) => t.name)).toEqual(["echo", "boom"]);
    expect(tools[0]?.inputSchema).toBeDefined();
  });

  it("tools/call 正常路径与工具异常路径（isError）", async () => {
    const ok = await handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "echo", arguments: { text: "hi" } },
      },
      ctx,
    );
    expect(
      (ok.body as { result: { content: Array<{ text: string }> } }).result.content[0]?.text,
    ).toBe("echo:hi");

    const bad = await handleMcpMessage(
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "boom" } },
      ctx,
    );
    const result = (bad.body as { result: { isError?: boolean; content: Array<{ text: string }> } })
      .result;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("工具内部失败");
  });

  it("未知 method 与未知工具 → -32601；畸形请求 → 400", async () => {
    const unknown = await handleMcpMessage(
      { jsonrpc: "2.0", id: 5, method: "resources/list" },
      ctx,
    );
    expect((unknown.body as { error: { code: number } }).error.code).toBe(-32601);

    const unknownTool = await handleMcpMessage(
      { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "nope" } },
      ctx,
    );
    expect((unknownTool.body as { error: { code: number } }).error.code).toBe(-32601);

    expect((await handleMcpMessage("not-jsonrpc", ctx)).status).toBe(400);
    expect((await handleMcpMessage([], ctx)).status).toBe(400);
  });

  it("批量：请求+通知混合 → 只回请求；纯通知批 → 202", async () => {
    const mixed = await handleMcpMessage(
      [
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 7, method: "ping" },
      ],
      ctx,
    );
    expect(mixed.status).toBe(200);
    expect(mixed.body).toHaveLength(1);

    const pure = await handleMcpMessage(
      [{ jsonrpc: "2.0", method: "notifications/initialized" }],
      ctx,
    );
    expect(pure.status).toBe(202);
  });
});
